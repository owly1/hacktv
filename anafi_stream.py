#!/usr/bin/env python3
"""
Live camera viewer for the Parrot ANAFI (incl. ANAFI Extended) over Wi-Fi.

Connect your Ubuntu 22.04 machine to the drone's Wi-Fi, then run:
    python3 anafi_stream.py

The window keeps showing the live feed for as long as you're connected, with a
telemetry overlay (battery, flight state, altitude, speed, attitude, GPS, Wi-Fi signal).
If the link drops, it shows a "waiting" screen and reconnects automatically.
Press 'q' or Esc in the video window to quit.
"""

import argparse
import math
import os
import queue
import threading
import time

# Olympe's renderer needs GLX; under Wayland/WSLg PyOpenGL otherwise picks EGL and the import fails
os.environ.setdefault("PYOPENGL_PLATFORM", "glx")

try:
    import cv2
    import numpy as np
    import olympe
    from olympe.messages.ardrone3.PilotingState import (
        AltitudeChanged,
        AttitudeChanged,
        FlyingStateChanged,
        GpsLocationChanged,
        SpeedChanged,
    )
    from olympe.features.video.pdraw import (
        Callbacks,
        StreamInfo,
        StreamInfoDefault,
        video_frame_type,
    )
    from olympe.messages.ardrone3.GPSSettingsState import GPSFixStateChanged
    from olympe.messages.common.CommonState import BatteryStateChanged, WifiSignalChanged
except ImportError as e:
    raise SystemExit(
        f"Missing dependency: {e.name}\n"
        "Activate the venv and install requirements:\n"
        "  source ~/anafi-env/bin/activate\n"
        "  pip install -r requirements.txt"
    )

DEFAULT_DRONE_IP = "192.168.42.1"  # ANAFI's address on its own Wi-Fi network
WINDOW = "ANAFI live"
FRAME_TIMEOUT = 3.0  # seconds without frames before we consider the stream stalled

olympe.log.update_config({"loggers": {"olympe": {"level": "ERROR"}}})


class AnafiViewer:
    def __init__(self, ip, stream_name=None):
        self.ip = ip
        self.stream_name = stream_name
        self.drone = None
        # Small queue: we always want the newest frame, not a backlog (keeps latency low)
        self.frame_queue = queue.Queue(maxsize=2)
        self.last_frame_time = 0.0
        self.running = True
        self.connected = False
        self.lock = threading.Lock()
        self.telemetry = {}
        self.status = ("Starting ...", "")
        self.warned_format = False

    # ---------- telemetry ----------

    def _state(self, msg):
        """Last value the drone sent for msg, or None if it hasn't sent one yet."""
        try:
            return self.drone.get_state(msg)
        except Exception:
            return None

    def _poll_telemetry(self):
        t = {}
        if (s := self._state(BatteryStateChanged)) is not None:
            t["Battery"] = f"{s['percent']} %"
        if (s := self._state(FlyingStateChanged)) is not None:
            t["State"] = s["state"].name
        if (s := self._state(AltitudeChanged)) is not None:
            t["Altitude"] = f"{s['altitude']:.1f} m"
        if (s := self._state(SpeedChanged)) is not None:
            ground = math.hypot(s["speedX"], s["speedY"])
            t["Speed"] = f"{ground:.1f} m/s  (vert {-s['speedZ']:+.1f})"  # speedZ is positive downward
        if (s := self._state(AttitudeChanged)) is not None:
            t["Attitude"] = (f"R {math.degrees(s['roll']):+.0f}  P {math.degrees(s['pitch']):+.0f}  "
                             f"Y {math.degrees(s['yaw']):+.0f} deg")
        fix = self._state(GPSFixStateChanged)
        gps = self._state(GpsLocationChanged)
        if gps is not None and gps["latitude"] != 500.0:  # 500 = no position yet
            t["GPS"] = f"{gps['latitude']:.6f}, {gps['longitude']:.6f}"
        elif fix is not None:
            t["GPS"] = "fixed" if fix["fixed"] else "no fix"
        if (s := self._state(WifiSignalChanged)) is not None:
            t["Wi-Fi"] = f"{s['rssi']} dBm"
        self.telemetry = t

    def _draw_telemetry(self, img, fps):
        lines = [f"FPS: {fps:.1f}"] + [f"{k}: {v}" for k, v in self.telemetry.items()]
        scale = max(img.shape[0] / 720, 0.5) * 0.6
        line_h = int(32 * scale / 0.6)
        width = int(440 * scale / 0.6)
        x0, y0 = 10, 10
        overlay = img.copy()
        cv2.rectangle(overlay, (x0, y0), (x0 + width, y0 + line_h * len(lines) + 12), (0, 0, 0), -1)
        cv2.addWeighted(overlay, 0.45, img, 0.55, 0, img)
        for i, line in enumerate(lines):
            y = y0 + line_h * (i + 1)
            cv2.putText(img, line, (x0 + 10, y), cv2.FONT_HERSHEY_SIMPLEX, scale,
                        (0, 255, 0), max(1, int(2 * scale / 0.6)), cv2.LINE_AA)

    # ---------- Olympe streaming callbacks (run in Olympe's thread) ----------

    def _yuv_frame_cb(self, yuv_frame):
        yuv_frame.ref()
        if self.frame_queue.full():
            try:
                self.frame_queue.get_nowait().unref()  # drop the oldest frame
            except queue.Empty:
                pass
        try:
            self.frame_queue.put_nowait(yuv_frame)
        except queue.Full:
            yuv_frame.unref()

    def _flush_cb(self, stream):
        self._drain_queue()
        return True

    def _drain_queue(self):
        while True:
            try:
                self.frame_queue.get_nowait().unref()
            except queue.Empty:
                break

    # ---------- connection management (background thread) ----------

    def _set_status(self, text, hint=""):
        self.status = (text, hint)

    def _connect(self):
        print(f"[*] Connecting to drone at {self.ip} ...")
        self._set_status(f"Connecting to drone at {self.ip} ...",
                         "Make sure this PC is on the drone's Wi-Fi (ANAFI-xxxxxxx)")
        drone = olympe.Drone(self.ip)
        # Olympe enforces a 45 s minimum timeout per attempt; the outer loop does the retrying
        if not drone.connect(retry=1):
            print("[!] Connection failed, retrying...")
            self._set_status(f"Can't reach drone at {self.ip} - retrying",
                             "Make sure this PC is on the drone's Wi-Fi (ANAFI-xxxxxxx)")
            try:
                drone.disconnect()
                drone.destroy()
            except Exception:
                pass
            return False

        self._set_status("Connected - starting video stream ...")
        if not self._start_video(drone):
            print("[!] Could not start video stream, retrying...")
            self._set_status("Connected, but the video stream failed to start - retrying")
            drone.disconnect()
            drone.destroy()
            return False

        with self.lock:
            self.drone = drone
            self.connected = True
            self.last_frame_time = time.time() + 5  # grace period for the decoder's first frame
        print("[+] Connected — streaming video.")
        self._set_status("Connected - waiting for first video frame ...")
        return True

    def _start_video(self, drone):
        # Olympe 8's play() asks for a stream named "Front camera", which the classic
        # ANAFI / ANAFI Extended doesn't expose. Ask for the drone's default stream instead
        # (plus a specific one by name if --stream was given).
        def raw_callbacks():
            cb = Callbacks(media_type=(video_frame_type.raw.value, None))
            cb.video_frame = self._yuv_frame_cb
            cb.flush = self._flush_cb
            return [cb]

        streams = [StreamInfoDefault(callbacks=raw_callbacks())]
        if self.stream_name:
            streams.insert(0, StreamInfo(name=self.stream_name, callbacks=raw_callbacks()))
        return drone.streaming.play_multiple_stream(streams_list=streams)

    def _disconnect(self):
        with self.lock:
            drone, self.drone = self.drone, None
            self.connected = False
        if drone is None:
            return
        try:
            drone.streaming.stop()
        except Exception:
            pass
        try:
            drone.disconnect()
            drone.destroy()
        except Exception:
            pass
        self._drain_queue()

    def _connection_loop(self):
        while self.running:
            try:
                self._connection_step()
            except Exception as e:
                # Never let this thread die silently — that leaves the window stuck on "Waiting"
                print(f"[!] Error: {e!r} — reconnecting...")
                self._set_status("Error - reconnecting", repr(e)[:80])
                self._disconnect()
                self.telemetry = {}
                time.sleep(2)
        self._disconnect()

    def _connection_step(self):
        if not self.connected:
            if not self._connect():
                time.sleep(2)
            return
        # Watchdog: reconnect if the link drops or frames stop arriving
        link_ok = self.drone is not None and self.drone.connected
        stalled = time.time() - self.last_frame_time > FRAME_TIMEOUT
        if not link_ok or stalled:
            reason = "lost connection" if not link_ok else "no video frames"
            print(f"[!] {reason} — reconnecting...")
            self._set_status(f"Reconnecting ({reason}) ...")
            self._disconnect()
            self.telemetry = {}
            time.sleep(1)
            return
        self._poll_telemetry()
        time.sleep(0.25)

    # ---------- display (main thread — required by OpenCV/GTK) ----------

    def _to_bgr(self, yuv_frame):
        fmt = yuv_frame.format()
        flag = {
            olympe.VDEF_I420: cv2.COLOR_YUV2BGR_I420,
            olympe.VDEF_NV12: cv2.COLOR_YUV2BGR_NV12,
        }.get(fmt)
        if flag is None:
            if not self.warned_format:
                print(f"[!] Unsupported video frame format: {fmt}")
                self.warned_format = True
            return None
        return cv2.cvtColor(yuv_frame.as_ndarray(), flag)

    def _waiting_screen(self):
        text, hint = self.status
        img = np.zeros((480, 854, 3), dtype=np.uint8)
        cv2.putText(img, text, (40, 220), cv2.FONT_HERSHEY_SIMPLEX, 0.8,
                    (200, 200, 200), 2, cv2.LINE_AA)
        cv2.putText(img, hint, (40, 270), cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                    (140, 140, 140), 1, cv2.LINE_AA)
        return img

    def run(self):
        threading.Thread(target=self._connection_loop, daemon=True).start()
        cv2.namedWindow(WINDOW, cv2.WINDOW_NORMAL)
        cv2.resizeWindow(WINDOW, 1280, 720)

        fps, frames, t0 = 0.0, 0, time.time()
        last_shown = 0.0
        try:
            while self.running:
                try:
                    yuv_frame = self.frame_queue.get(timeout=0.1)
                except queue.Empty:
                    # Show status until video arrives (or after it stops for a moment)
                    if not self.connected or time.time() - last_shown > 1.0:
                        cv2.imshow(WINDOW, self._waiting_screen())
                else:
                    try:
                        img = self._to_bgr(yuv_frame)
                    finally:
                        yuv_frame.unref()
                    if img is not None:
                        self.last_frame_time = last_shown = time.time()
                        frames += 1
                        if time.time() - t0 >= 1.0:
                            fps, frames, t0 = frames / (time.time() - t0), 0, time.time()
                        self._draw_telemetry(img, fps)
                        cv2.imshow(WINDOW, img)

                key = cv2.waitKey(1) & 0xFF
                if key in (ord("q"), 27):
                    break
                if cv2.getWindowProperty(WINDOW, cv2.WND_PROP_VISIBLE) < 1:
                    break  # window closed with the X button
        except KeyboardInterrupt:
            pass
        finally:
            print("[*] Shutting down...")
            self.running = False
            self._disconnect()
            cv2.destroyAllWindows()


def main():
    parser = argparse.ArgumentParser(description="Live ANAFI camera viewer")
    parser.add_argument("--ip", default=DEFAULT_DRONE_IP,
                        help=f"drone IP (default {DEFAULT_DRONE_IP}; "
                             "use 192.168.53.1 if going through a Skycontroller)")
    parser.add_argument("--stream", default=None,
                        help="video stream name to request (default: the drone's default "
                             "stream, 'DefaultVideo' on the classic ANAFI)")
    args = parser.parse_args()
    AnafiViewer(args.ip, args.stream).run()


if __name__ == "__main__":
    main()
