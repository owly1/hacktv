#!/usr/bin/env python3
"""Read-only ANAFI observation bridge. Run on Linux with tested Olympe installation.
No takeoff, landing, movement, camera-orientation, dispatch or flight-plan command.
Grounded ANAFI Extended reception tested 17 October 2026; see docs/PI_OBSERVER_CONTEXT.md.
Flight and simultaneous controller operation were not tested.
"""
import argparse
import base64
import json
import logging
import math
import os
import queue
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def post_json(base, token, path, value):
    req = urllib.request.Request(base + path, data=json.dumps(value).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + token}, method="POST")
    with urllib.request.urlopen(req, timeout=5) as response:
        return response.status


def post_jpeg(base, token, jpeg, captured_at):
    req = urllib.request.Request(base + "/api/ingest/frame", data=jpeg,
        headers={"Content-Type": "image/jpeg", "Authorization": "Bearer " + token,
                 "X-Captured-At": captured_at}, method="POST")
    with urllib.request.urlopen(req, timeout=5) as response:
        return response.status


def numeric(value, lower, upper):
    if isinstance(value, (int, float)) and math.isfinite(value) and lower <= value <= upper:
        return value
    return None


def camera_fps(value):
    rate = float(value)
    if not math.isfinite(rate) or not .5 <= rate <= 15:
        raise argparse.ArgumentTypeError("camera FPS must be between 0.5 and 15")
    return rate


def camera_width(value):
    width = int(value)
    if width != 0 and not 320 <= width <= 1920:
        raise argparse.ArgumentTypeError("camera width must be 0 (native) or 320-1920 pixels")
    return width


def prepare_image(frame, cv2, sdk, width=640):
    image = frame.as_ndarray()
    fmt = frame.format()
    if fmt == sdk.VDEF_I420:
        image = cv2.cvtColor(image, cv2.COLOR_YUV2BGR_I420)
    elif fmt == sdk.VDEF_NV12:
        image = cv2.cvtColor(image, cv2.COLOR_YUV2BGR_NV12)
    else:
        raise ValueError("unsupported raw pixel format")
    height, source_width = image.shape[:2]
    if width and source_width != width:
        image = cv2.resize(image, (width, max(1, round(height * width / source_width))))
    return image


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ip", default="192.168.42.1")
    parser.add_argument("--controller", choices=["direct", "skycontroller3"], default="direct")
    parser.add_argument("--backend", default="http://127.0.0.1:8787")
    parser.add_argument("--drone-id", default="ANAFI-01")
    parser.add_argument("--camera", action="store_true", help="Send JPEG camera frames; requires OpenCV, not WebRTC video")
    parser.add_argument("--camera-transport", choices=["snapshot", "frame"], default="snapshot",
                        help="frame sends raw JPEGs to the team's existing camera relay")
    parser.add_argument("--camera-fps", type=camera_fps, default=.5,
                        help="Maximum camera send rate, 0.5-15 FPS (default 0.5)")
    parser.add_argument("--camera-width", type=camera_width, default=640,
                        help="JPEG width; 0 preserves native decoded size for calibration (default 640)")
    args = parser.parse_args()
    token = os.environ.get("INGEST_TOKEN")
    if not token:
        raise SystemExit("Set INGEST_TOKEN in the environment. Do not pass it as a command-line argument.")
    if not args.backend.startswith("https://") and not args.backend.startswith(("http://127.0.0.1:", "http://localhost:")):
        raise SystemExit("Use HTTPS or a loopback backend URL.")
    os.environ.setdefault("PYOPENGL_PLATFORM", "glx")
    import olympe
    # SDK INFO events can include aircraft Wi-Fi settings; retain warnings only.
    logging.getLogger("olympe").setLevel(logging.WARNING)
    from olympe.messages.common.CommonState import BatteryStateChanged
    from olympe.messages.ardrone3.PilotingState import AltitudeChanged, SpeedChanged, PositionChanged
    if args.camera:
        import cv2
        import olympe_deps as od
        from olympe.features.video.pdraw import Callbacks, StreamInfoDefault
    controller_class = olympe.Anafi if args.controller == "direct" else olympe.SkyController3
    controller = controller_class(args.ip)
    frames = queue.Queue(maxsize=1)
    stop = threading.Event()
    snapshot_worker = None

    def read_state(message):
        try:
            return controller.get_state(message)
        except Exception:
            return {}

    def raw_frame(frame):
        if stop.is_set():
            return
        frame.ref()
        try:
            frames.put_nowait((frame, utc_now()))
        except queue.Full:
            frame.unref()

    def release_queued_frames(_stream=None):
        # Pdraw flush/drain waits for retained frames to be released.
        while True:
            try:
                frame, _ = frames.get_nowait()
            except queue.Empty:
                return True
            frame.unref()

    def snapshots():
        last_attempt = 0
        interval = 1 / args.camera_fps
        while not stop.is_set():
            try:
                frame, captured_at = frames.get(timeout=.5)
            except queue.Empty:
                continue
            try:
                attempted_at = time.monotonic()
                if attempted_at - last_attempt < interval:
                    continue
                # Bound encoding/network attempts even if a backend request fails.
                # The single-frame queue drops excess input instead of building lag.
                last_attempt = attempted_at
                image = prepare_image(frame, cv2, olympe, args.camera_width)
                ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 70])
                if ok:
                    if args.camera_transport == "frame":
                        post_jpeg(args.backend.rstrip("/"), token, bytes(encoded), captured_at)
                    else:
                        post_json(args.backend.rstrip("/"), token, "/api/ingest/snapshot", {
                            "provenance": "live", "mime_type": "image/jpeg", "captured_at": captured_at,
                            "data": base64.b64encode(encoded).decode("ascii")})
            except Exception:
                print("Snapshot not delivered; check camera format, network and server configuration.")
            finally:
                frame.unref()

    connected = False
    try:
        if not controller.connect():
            raise SystemExit("ANAFI connection failed. Do not infer a live link from this bridge running.")
        connected = True
        if args.camera:
            snapshot_worker = threading.Thread(target=snapshots, daemon=True)
            snapshot_worker.start()
            # A classic ANAFI can advertise DefaultVideo but leave decoded-frame
            # metadata unnamed. Register a default stream for both cases.
            stream = StreamInfoDefault(has_renderer=False, callbacks=[Callbacks(
                media_type=(od.VDEF_FRAME_TYPE_RAW, None), video_frame=raw_frame,
                flush=release_queued_frames, drain=release_queued_frames,
            )])
            if not controller.streaming.play_multiple_stream(streams_list=[stream]):
                print("Camera stream unavailable; telemetry reception continues.")
        print("Observation bridge running. Flight remains with the pilot. Ctrl+C stops observation only.")
        while controller.drone_connection_state():
            battery, altitude, speed, position = [read_state(x) for x in (BatteryStateChanged, AltitudeChanged, SpeedChanged, PositionChanged)]
            vx, vy = speed.get("speedX"), speed.get("speedY")
            ground_speed = math.hypot(vx, vy) if isinstance(vx, (int, float)) and isinstance(vy, (int, float)) else None
            payload = {"provenance": "live", "drone_id": args.drone_id, "observed_at": utc_now(),
                       "battery_pct": numeric(battery.get("percent"), 0, 100),
                       "altitude_m": numeric(altitude.get("altitude"), -50, 10000),
                       "ground_speed_mps": numeric(ground_speed, 0, 100),
                       "latitude": numeric(position.get("latitude"), -90, 90),
                       "longitude": numeric(position.get("longitude"), -180, 180)}
            # SDK position sentinel (500) becomes null; never turn missing GPS into (0, 0).
            try:
                post_json(args.backend.rstrip("/"), token, "/api/ingest/telemetry", payload)
            except (urllib.error.URLError, TimeoutError):
                print("Telemetry not acknowledged; backend may be offline. No fabricated replacement sent.")
            time.sleep(1)
        print("Drone link lost; observation stopped.")
    except KeyboardInterrupt:
        print("Observation stopped by operator. No flight command sent.")
    finally:
        stop.set()
        release_queued_frames()
        if snapshot_worker is not None:
            snapshot_worker.join(timeout=6)
        if args.camera and connected:
            controller.streaming.stop()
        release_queued_frames()
        if connected:
            controller.disconnect()


if __name__ == "__main__":
    main()
