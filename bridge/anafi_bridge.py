#!/usr/bin/env python3
"""
Emberwatch bridge for the Parrot ANAFI (incl. ANAFI Extended), run on Linux/WSL.

Connect this machine to the drone's Wi-Fi, start the backend, then:

    source ~/anafi-env/bin/activate
    set -a; source .env; set +a                # INGEST_TOKEN for the backend
    python3 bridge/anafi_bridge.py --backend http://127.0.0.1:8787

What it does, all at once:
  * Live view window with a telemetry overlay; reconnects automatically.
  * Telemetry (~1 Hz) -> POST /api/ingest/telemetry, in the contract shape
    (raw numbers, every key present, None = unknown).
  * Live video (~15 fps JPEG) -> POST /api/ingest/frame, relayed by the
    backend to the dashboard's ANAFI-01 panel.
  * Fire detection on the camera feed (~5 Hz): a YOLOv8 fire/smoke model, plus
    the Emberwatch QR test marker (bridge/make_test_marker.py) that stands in
    for a large fire and carries its details. Three consecutive QR hits, or
    five same-spot YOLO fire hits (smoke only with --detect-smoke), start a
    detection episode -> POST /api/ingest/detection with the frame and the
    fire's ground position, computed from drone position, altitude, heading,
    camera tilt and where the fire sits in the frame.
  * Camera auto-tilt: the gimbal re-aims to keep a detected fire centred.
  * --demo-flight: take off, climb ~1 m, fly a small circle, return to the
    start and land. Asks for confirmation first; type x + Enter, press 'l' in
    the video window, or Ctrl+C at any time to land immediately.

Indoors the ANAFI has no GPS: positions are then the --home point (default
the Sam Ibrahim Building, UTSC) plus the offsets of the moves this script
commanded.

Files in --out-dir (default ./anafi_out), replaced atomically:
    telemetry.json / telemetry.jsonl, snapshot.jpg / snapshot.json, detections.jsonl
"""

import argparse
import base64
import http.client
import json
import math
import os
import queue
import secrets
import sys
import threading
import time
import urllib.parse
from datetime import datetime, timezone

# Olympe's renderer needs GLX; under Wayland/WSLg PyOpenGL otherwise picks EGL and the import fails
os.environ.setdefault("PYOPENGL_PLATFORM", "glx")

try:
    import cv2
    import numpy as np
    import olympe
    from olympe.messages import gimbal
    from olympe.messages.ardrone3.Piloting import Landing, TakeOff, moveBy
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
        "  pip install -r bridge/requirements.txt"
    )

from wind_measurement import WindMeasurement, wind_vector

try:
    # The numerical estimate is optional and must be confirmed by actual
    # aircraft events. Import availability alone says nothing about hardware.
    from olympe.messages.flight_data import Command as FlightDataCommand
    from olympe.messages.flight_data.Event import State as FlightDataState
    from olympe.messages.flight_data.Event import WindSpeed
except ImportError:
    FlightDataCommand = WindSpeed = FlightDataState = None

try:
    # Classic ANAFI's warning is independently useful even when its firmware
    # does not implement the newer numerical flight_data feature.
    from olympe.messages.ardrone3.PilotingState import WindStateChanged
except ImportError:
    WindStateChanged = None

DEFAULT_DRONE_IP = "192.168.42.1"  # ANAFI's address on its own Wi-Fi network
WINDOW = "ANAFI live"
FRAME_TIMEOUT = 3.0  # seconds without frames before we consider the stream stalled
DEFAULT_OUT_DIR = "anafi_out"


def fc_wind(north, east):
    """Olympe flight_data WindSpeed NED components -> (speed_mps, direction_deg).

    Convention: the vector is the wind's velocity — it points where the wind
    blows TOWARD — so direction_deg = atan2(east, north) in degrees clockwise
    from north, matching the dashboard's TOWARD convention.
    A zero vector returns (0.0, None): no wind means no direction to point.
    """
    return wind_vector(north, east)
TELEMETRY_INTERVAL = 1.0  # seconds between published telemetry samples (contract: 1-2 Hz)
SNAPSHOT_FILE_INTERVAL = 3.0
VIDEO_WIDTH = 960
VIDEO_JPEG_QUALITY = 70
DETECTION_JPEG_QUALITY = 85
DEFAULT_HOME = (43.7866, -79.1903)  # Sam Ibrahim Building, UTSC
DEFAULT_MODEL = os.path.expanduser("~/emberwatch-models/fire-smoke-yolov8n.pt")
QR_PREFIX = "EW1:"
DEFAULT_PERSON_MODEL = os.path.expanduser("~/emberwatch-models/yolov8n.pt")  # COCO: class "person"

# Person search (see docs/PERSON_SEARCH.md)
PERSON_EVERY_N = 2            # run the person model on every 2nd detector pass (~2.5 Hz)
PERSON_MIN_HITS = 2           # a track needs this many hits before it is reported
PERSON_POST_S = 2.0           # one observation per track at most this often
PERSON_TRACK_END_S = 5.0
PERSON_CROP_PX = 160
OUTBOX_MAX = 500              # observations kept on disk while the backend is unreachable

# Detection episode rules
DETECT_HZ = 5.0
EPISODE_UPDATE_S = 5.0        # re-post an ongoing fire this often
EPISODE_END_S = 15.0          # unseen this long -> the episode is over
OVERLAY_TTL_S = 1.0

# Demo flight limits
MAX_CLIMB_M = 2.0
MAX_RADIUS_M = 2.0
MIN_BATTERY_PCT = 30
CIRCLE_SEGMENTS = 8

olympe.log.update_config({"loggers": {"olympe": {"level": "ERROR"}}})


def utc_iso(ts):
    """Epoch seconds -> ISO 8601 UTC with an explicit Z (the backend rejects bare local times)."""
    return (datetime.fromtimestamp(ts, timezone.utc)
            .isoformat(timespec="milliseconds").replace("+00:00", "Z"))


def dest_point(lat, lon, bearing_deg, dist_m):
    """Point dist_m from (lat, lon) along bearing_deg (flat-earth; fine at drone ranges)."""
    b = math.radians(bearing_deg)
    dlat = dist_m * math.cos(b) / 111320.0
    dlon = dist_m * math.sin(b) / (111320.0 * math.cos(math.radians(lat)))
    return lat + dlat, lon + dlon


from fire_detection import DEFAULT_CONF, FireDetector, confirm_hits, parse_marker, same_spot
from flight_recording import FlightRecorder


# ---------------------------------------------------------------- publishing

class Publisher:
    """Writes files to --out-dir and, if configured, POSTs to the backend.

    Each calling thread gets its own keep-alive HTTP connection, so 15 fps
    video does not pay a TCP handshake per frame.
    """

    def __init__(self, out_dir, backend=None, token=None):
        """Initialize local evidence, per-thread HTTP state and the persistent person outbox."""
        self.out_dir = out_dir
        self.token = token
        self.url = urllib.parse.urlsplit(backend) if backend else None
        self.local = threading.local()
        self.last_error = None
        self.last_snapshot_file = 0.0
        self.recorder = None
        self.frame_uploads = queue.Queue(maxsize=1)
        self.closing = threading.Event()
        os.makedirs(out_dir, exist_ok=True)
        # Store-and-forward: person observations that could not be delivered, oldest first.
        # Kept on disk so a bridge restart during an outage loses nothing.
        self.outbox_path = os.path.join(out_dir, "person_outbox.jsonl")
        self.outbox_lock = threading.Lock()
        self.outbox = []
        if os.path.exists(self.outbox_path):
            with open(self.outbox_path, encoding="utf-8") as f:
                self.outbox = [json.loads(line) for line in f if line.strip()][-OUTBOX_MAX:]
            if self.outbox:
                print(f"[*] {len(self.outbox)} stored person observations waiting to be delivered")

    def start_recording(self):
        """Start a local flight recorder without coupling disk writes to flight control."""
        if self.recorder is None:
            self.recorder = FlightRecorder(self.out_dir)
            threading.Thread(target=self._upload_frames, daemon=True, name='frame-upload').start()
            print(f'[*] Flight video and diagnostics: {self.recorder.path}', flush=True)

    def _upload_frames(self):
        """Upload queued camera frames on a worker so slow HTTP cannot block decoding."""
        while not self.closing.is_set():
            try:
                jpeg, captured_at, overlay = self.frame_uploads.get(timeout=.2)
            except queue.Empty:
                continue
            self._post_frame(jpeg, captured_at, overlay)

    def _post_frame(self, jpeg, captured_at, overlay):
        """Send one JPEG with its capture time and detection overlay."""
        self._post("/api/ingest/frame", jpeg, "image/jpeg",
                   {"X-Captured-At": utc_iso(captured_at), "X-Detections": json.dumps(overlay)})

    def diagnostic(self, kind, data):
        """Append SDK/control diagnostics to the active local recording."""
        if self.recorder is not None:
            self.recorder.event(kind, data)

    def close(self):
        """Stop background publishing and finish the local recording."""
        self.closing.set()
        if self.recorder is not None:
            self.recorder.close()

    # -- files
    def _write_atomic(self, name, data):
        """Replace one evidence file via a temporary file in the output directory."""
        path = os.path.join(self.out_dir, name)
        tmp = path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)  # readers never see a half-written file

    def _append(self, name, obj):
        """Append a JSON record to the named local evidence log."""
        with open(os.path.join(self.out_dir, name), "a", encoding="utf-8") as f:
            f.write(json.dumps(obj) + "\n")

    # -- http
    def _conn(self):
        """Return this thread's reusable HTTP connection, creating it when needed."""
        conn = getattr(self.local, "conn", None)
        if conn is None:
            cls = http.client.HTTPSConnection if self.url.scheme == "https" else http.client.HTTPConnection
            conn = self.local.conn = cls(self.url.hostname, self.url.port, timeout=5)
        return conn

    def _post(self, path, body, content_type="application/json", headers=None):
        """POST a payload with bounded retries; retain response status for outbox decisions."""
        if not self.url:
            return None
        hdrs = {"Authorization": f"Bearer {self.token}", "Content-Type": content_type, **(headers or {})}
        for attempt in (1, 2):  # one retry on a dropped keep-alive connection
            try:
                conn = self._conn()
                conn.request("POST", path, body=body, headers=hdrs)
                resp = conn.getresponse()
                data = resp.read()
                self.local.status = resp.status
                if resp.status >= 400:
                    try:
                        why = json.loads(data).get("error", "")
                    except ValueError:
                        why = ""
                    self._log_error(f"{path}: HTTP {resp.status} {why}")
                    return None
                if self.last_error:
                    print(f"[+] Backend ingest OK again ({path})")
                    self.last_error = None
                return json.loads(data) if data else {}
            except (OSError, http.client.HTTPException) as e:
                self.local.conn = None
                self.local.status = None  # network failure, not a rejection
                if attempt == 2:
                    self._log_error(f"{path}: {e!r}")
        return None

    def _log_error(self, msg):
        """Report a changed publishing error without flooding the terminal."""
        if msg != self.last_error:  # don't spam the same failure every second
            print(f"[!] Backend ingest failed - {msg}")
            self.last_error = msg

    # -- payloads
    def telemetry(self, sample):
        """Persist and publish telemetry, flushing queued person observations when the link returns."""
        self.diagnostic('telemetry', sample)
        line = json.dumps(sample)
        self._write_atomic("telemetry.json", (line + "\n").encode())
        self._append("telemetry.jsonl", sample)
        if self._post("/api/ingest/telemetry", line.encode()) is not None and self.outbox:
            self.flush_outbox()  # the link is back: deliver what was stored

    # -- person search: small alert first, crop after, store-and-forward on failure
    def person(self, obs, crop_jpeg=None):
        """Record a person observation, send its alert/crop, and queue failed deliveries on disk."""
        self._append("people.jsonl", obs)
        item = {"obs": obs, "crop_b64": base64.b64encode(crop_jpeg).decode() if crop_jpeg else None}
        if self.url and not self._send_person(item):
            with self.outbox_lock:
                self.outbox.append(item)
                del self.outbox[:-OUTBOX_MAX]
                self._save_outbox()
            print(f"[!] Person observation stored for later ({len(self.outbox)} waiting)")

    def _send_person(self, item):
        """True when the backend has it (or rejected it for good); False to retry later."""
        res = self._post("/api/ingest/person", json.dumps(item["obs"]).encode())
        if res is None:
            status = getattr(self.local, "status", None)
            return status is not None and 400 <= status < 500 and status != 429
        if item.get("crop_b64"):
            self._post(f"/api/ingest/person/crop?obs_id={urllib.parse.quote(item['obs']['obs_id'])}",
                       base64.b64decode(item["crop_b64"]), "image/jpeg")
        if res.get("new_lead"):
            print(f"[!!] New rescue lead: Target {res.get('lead_number')} ({res.get('status')})")
        return True

    def flush_outbox(self):
        """Retry queued person observations oldest first and persist the remaining queue."""
        with self.outbox_lock:
            sent = 0
            while self.outbox and self._send_person(self.outbox[0]):
                self.outbox.pop(0)
                sent += 1
            self._save_outbox()
        if sent:
            print(f"[+] Delivered {sent} stored person observations (the backend marks them delayed)")

    def _save_outbox(self):
        """Atomically save the bounded person retry queue."""
        self._write_atomic("person_outbox.jsonl",
                           "".join(json.dumps(i) + "\n" for i in self.outbox).encode())

    def frame(self, jpeg, captured_at, overlay):
        """Record a camera frame and queue its newest upload without blocking flight supervision."""
        if self.recorder is not None:
            self.recorder.frame(jpeg, captured_at)
            # Keep recording at camera speed even if HTTP ingest stalls. A
            # one-frame mailbox drops stale uploads, never queues latency.
            try:
                self.frame_uploads.get_nowait()
            except queue.Empty:
                pass
            self.frame_uploads.put_nowait((jpeg, captured_at, overlay))
        else:
            self._post_frame(jpeg, captured_at, overlay)
        if captured_at - self.last_snapshot_file >= SNAPSHOT_FILE_INTERVAL:
            self.last_snapshot_file = captured_at
            self._write_atomic("snapshot.jpg", jpeg)
            self._write_atomic("snapshot.json", (json.dumps(
                {"captured_at": utc_iso(captured_at), "bytes": len(jpeg), "file": "snapshot.jpg"}) + "\n").encode())

    def detection(self, payload):
        """Log and submit a fire sighting, returning the backend acknowledgement."""
        self._append("detections.jsonl", {k: v for k, v in payload.items() if k != "frame_jpeg_base64"})
        return self._post("/api/ingest/detection", json.dumps(payload).encode())

    def flight(self, phase, message="", step=None, steps=None):
        """Publish a timestamped flight-phase event to local evidence and the dashboard."""
        print(f"[flight] {phase}{f' {step}/{steps}' if step else ''} {message}")
        event = {"at": utc_iso(time.time()), "phase": phase, "message": message, "step": step, "steps": steps}
        self._append('flight.jsonl', event)
        self.diagnostic('flight', event)
        self._post("/api/ingest/flight", json.dumps(event).encode())


# ---------------------------------------------------------------- detection

class PersonDetector:
    """People in the camera frame: a COCO YOLO model's "person" class.

    Visible-light model by default. For the thermal stream of an ANAFI USA /
    Thermal, pass a thermal-trained model with --person-model and --sensor thermal.
    """

    def __init__(self, model_path, conf):
        """Load the configured YOLO person class; disable detection if loading fails."""
        self.conf = conf
        self.model = None
        self.cls = None
        try:
            from ultralytics import YOLO
            self.model = YOLO(model_path)
            ids = [k for k, v in self.model.names.items() if v == "person"]
            self.cls = ids[0] if ids else None
            if self.cls is None:
                print(f"[!] Person model {model_path} has no 'person' class; person search off")
                self.model = None
            else:
                print(f"[*] Person model loaded: {model_path}")
        except Exception as e:
            print(f"[!] Person model unavailable ({e!r}); person search off")

    def detect(self, bgr):
        """Return normalized person boxes and raw model scores for one BGR frame."""
        if self.model is None:
            return []
        result = self.model(bgr, imgsz=640, conf=self.conf, classes=[self.cls], verbose=False)[0]
        return [{"bbox": [round(v, 4) for v in box], "score": round(float(score), 3)}
                for box, score in zip(result.boxes.xyxyn.tolist(), result.boxes.conf.tolist())]


def iou(a, b):
    """Return intersection-over-union for two normalized rectangles."""
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


# ---------------------------------------------------------------- bridge

class AnafiBridge:
    def __init__(self, args, publisher, detector, person_detector=None):
        """Initialize the aircraft link, frame queues, telemetry and optional detection/flight state."""
        self.args = args
        self.person_detector = person_detector
        self.person_tracks = []  # dict(id, bbox, hits, last_seen, last_post)
        self.person_pass = 0
        self.controller_kind = getattr(args, "controller", "direct")
        self.ip = args.ip or ("192.168.53.1" if self.controller_kind == "skycontroller3" else DEFAULT_DRONE_IP)
        self.publisher = publisher
        if (getattr(args, 'execute', False) or getattr(args, 'demo_flight', False)) and hasattr(publisher, 'start_recording'):
            self.publisher.start_recording()
        self.detector = detector
        self.drone = None
        # Small queue: we always want the newest frame, not a backlog (keeps latency low)
        self.frame_queue = queue.Queue(maxsize=2)
        self.last_frame_time = 0.0
        self.running = True
        self.connected = False
        self.lock = threading.Lock()
        self.telemetry = None  # latest sample in the ingest-contract shape; None when not connected
        self.fps = 0.0
        self.latest_bgr = None  # (image, SDK callback receipt time), before queue/conversion delay
        self.status = ("Starting ...", "")
        self.warned_format = False
        # indoor position: metres north/east of --home from commanded moves
        self.home = (args.home_lat, args.home_lon)
        self.odo_n = self.odo_e = 0.0
        # detection state
        self.hits = 0
        self.last_hit_box = None
        self.last_hit_identity = None
        self.episode = None  # dict(id, last_seen, last_post)
        self.overlay = []    # boxes drawn on the window + sent with each video frame
        self.overlay_time = 0.0
        self.last_gimbal_cmd = 0.0
        # flight state
        self.flight_phase = None
        self.abort_flight = threading.Event()
        self._wind_subscriptions = []
        self._wind_tracker = WindMeasurement(sdk_available=all(
            item is not None for item in (FlightDataCommand, FlightDataState, WindSpeed)))

    # ---------- telemetry ----------

    def _state(self, msg):
        """Last value the drone sent for msg, or None if it hasn't sent one yet."""
        try:
            return self.drone.get_state(msg)
        except Exception:
            return None

    def measured_wind_snapshot(self):
        """Return only a fresh vector received on this aircraft connection, never a cache refresh."""
        if not self.connected:
            return None
        return self._wind_tracker.snapshot(time.monotonic())

    def measured_wind_reason(self):
        """Report the precise missing measurement before forecast code uses real wind."""
        if not self.connected:
            return 'Aircraft is disconnected; measured wind is unavailable'
        return self._wind_tracker.reason(time.monotonic())

    def _gimbal_pitch(self):
        s = self._state(gimbal.attitude)
        if not isinstance(s, dict):
            return None
        if 0 in s and isinstance(s[0], dict):  # multi-instance message, keyed by gimbal_id
            s = s[0]
        try:
            pitch = float(s["pitch_absolute"])
            return pitch if math.isfinite(pitch) else None
        except (KeyError, TypeError, ValueError):
            return None

    def _position(self, gps):
        """(lat, lon, source): GPS when the drone has a fix, else home + commanded offsets."""
        if gps is not None and gps["latitude"] != 500.0:  # 500 = no position yet
            return gps["latitude"], gps["longitude"], "gps"
        lat, lon = dest_point(*self.home, 0.0, self.odo_n)
        lat, lon = dest_point(lat, lon, 90.0, self.odo_e)
        return lat, lon, "home+odometry"

    def _poll_telemetry(self):
        """Snapshot the drone state as one /api/ingest/telemetry body (None = unknown)."""
        t = {
            "drone_id": self.args.drone_id,
            "observed_at": utc_iso(time.time()),
            "provenance": "live",
            "battery_pct": None,
            "altitude_m": None,
            "ground_speed_mps": None,
            "vertical_speed_mps": None,
            "latitude": None,
            "longitude": None,
            "state": None,
            "gps_fix": None,
            "attitude_deg": None,
            "extra": {"wifi_rssi_dbm": None, "video_fps": round(self.fps, 1), "heading_deg": None,
                      "gimbal_pitch_deg": self._gimbal_pitch(), "position_source": None,
                      "flight_phase": self.flight_phase,
                      # flight-controller wind estimate (None until the drone streams it)
                      "fc_wind_speed_mps": None, "fc_wind_direction_deg": None,
                      "fc_wind_available": None, "fc_wind_state": None},
        }
        if (s := self._state(BatteryStateChanged)) is not None:
            t["battery_pct"] = s["percent"]
        if (s := self._state(FlyingStateChanged)) is not None:
            t["state"] = s["state"].name  # landed, takingoff, hovering, flying, landing, ...
        if (s := self._state(AltitudeChanged)) is not None:
            t["altitude_m"] = round(s["altitude"], 2)
        if (s := self._state(SpeedChanged)) is not None:
            t["ground_speed_mps"] = round(math.hypot(s["speedX"], s["speedY"]), 2)
            t["vertical_speed_mps"] = round(-s["speedZ"], 2)  # speedZ is positive downward
        if (s := self._state(AttitudeChanged)) is not None:
            t["attitude_deg"] = {axis: round(math.degrees(s[axis]), 1)
                                 for axis in ("roll", "pitch", "yaw")}
            t["extra"]["heading_deg"] = round(math.degrees(s["yaw"]) % 360, 1)
        if (s := self._state(GPSFixStateChanged)) is not None:
            t["gps_fix"] = bool(s["fixed"])
        lat, lon, source = self._position(self._state(GpsLocationChanged))
        t["latitude"], t["longitude"] = round(lat, 7), round(lon, 7)
        t["extra"]["position_source"] = source
        if (s := self._state(WifiSignalChanged)) is not None:
            t["extra"]["wifi_rssi_dbm"] = s["rssi"]
        wind = self.measured_wind_snapshot()
        wind_status = self._wind_tracker.diagnostics(time.monotonic())
        t['extra'].update({'fc_wind_available': wind_status['available'],
                          'fc_wind_supported': wind_status['supported'],
                          'fc_wind_observed_at': wind_status['observed_at'],
                          'fc_wind_age_s': wind_status['age_s']})
        if wind is not None:
            t['extra']['fc_wind_speed_mps'] = wind['speed_mps']
            t['extra']['fc_wind_direction_deg'] = wind['direction_deg']
        if WindStateChanged is not None and (s := self._state(WindStateChanged)) is not None:
            try:
                v = s["state"]
                # enum member on most paths, raw string on others — take either
                t["extra"]["fc_wind_state"] = getattr(v, "name", v)  # ok / warning / critical
            except (KeyError, TypeError):
                pass
        self.telemetry = t

    def _overlay_lines(self):
        """Build status and measurement lines for the optional local video window."""
        lines = [f"FPS: {self.fps:.1f}"]
        t = self.telemetry
        if not t:
            return lines
        if t["battery_pct"] is not None:
            lines.append(f"Battery: {t['battery_pct']} %")
        if t["state"] is not None:
            lines.append(f"State: {t['state']}" + (f"  [{self.flight_phase}]" if self.flight_phase else ""))
        if t["altitude_m"] is not None:
            lines.append(f"Altitude: {t['altitude_m']:.1f} m")
        if t["ground_speed_mps"] is not None:
            lines.append(f"Speed: {t['ground_speed_mps']:.1f} m/s  "
                         f"(vert {t['vertical_speed_mps']:+.1f})")
        if (a := t["attitude_deg"]) is not None:
            lines.append(f"Attitude: R {a['roll']:+.0f}  P {a['pitch']:+.0f}  Y {a['yaw']:+.0f} deg")
        lines.append(f"Pos ({t['extra']['position_source']}): {t['latitude']:.6f}, {t['longitude']:.6f}")
        if (rssi := t["extra"]["wifi_rssi_dbm"]) is not None:
            lines.append(f"Wi-Fi: {rssi} dBm")
        if (w := t["extra"]["fc_wind_speed_mps"]) is not None:
            d = t["extra"]["fc_wind_direction_deg"]
            wind_line = f"Wind (FC est.): {w:.1f} m/s" + (f" toward {d:.0f} deg" if d is not None else "")
            if (ws := t["extra"]["fc_wind_state"]) is not None and ws != "ok":
                wind_line += f"  [{ws.upper()}]"
            lines.append(wind_line)
        if self.episode:
            lines.append("FIRE DETECTED")
        return lines

    def _draw_overlay(self, img):
        """Draw detection boxes and status text on the displayed BGR frame."""
        h, w = img.shape[:2]
        if time.time() - self.overlay_time < OVERLAY_TTL_S:
            for d in self.overlay:
                x1, y1, x2, y2 = d["bbox"]
                p1, p2 = (int(x1 * w), int(y1 * h)), (int(x2 * w), int(y2 * h))
                cv2.rectangle(img, p1, p2, (0, 80, 255), 3)
                cv2.putText(img, f"{d['label']} {d['confidence']:.2f}", (p1[0], max(20, p1[1] - 8)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 80, 255), 2, cv2.LINE_AA)
        lines = self._overlay_lines()
        scale = max(h / 720, 0.5) * 0.6
        line_h = int(32 * scale / 0.6)
        width = int(520 * scale / 0.6)
        x0, y0 = 10, 10
        shade = img.copy()
        cv2.rectangle(shade, (x0, y0), (x0 + width, y0 + line_h * len(lines) + 12), (0, 0, 0), -1)
        cv2.addWeighted(shade, 0.45, img, 0.55, 0, img)
        for i, line in enumerate(lines):
            color = (0, 80, 255) if line == "FIRE DETECTED" else (0, 255, 0)
            cv2.putText(img, line, (x0 + 10, y0 + line_h * (i + 1)), cv2.FONT_HERSHEY_SIMPLEX, scale,
                        color, max(1, int(2 * scale / 0.6)), cv2.LINE_AA)

    # ---------- fire geolocation ----------

    def _locate(self, hit, frame_shape):
        """Ground position of the detected fire from the camera ray, or the QR marker's size."""
        t = self.telemetry or {}
        extra = t.get("extra") or {}
        lat, lon = t.get("latitude"), t.get("longitude")
        heading = extra.get("heading_deg") or 0.0
        pitch = extra.get("gimbal_pitch_deg")
        pitch = -45.0 if pitch is None else pitch
        alt = max(t.get("altitude_m") or 0.0, 0.3)  # camera is ~0.3 m up even when landed
        h, w = frame_shape[:2]
        hfov = math.radians(self.args.hfov)
        vfov = 2 * math.atan(math.tan(hfov / 2) * h / w)
        x1, y1, x2, y2 = hit["bbox"]
        u, v = (x1 + x2) / 2, (y1 + y2) / 2
        alpha = math.degrees(math.atan((u - 0.5) * 2 * math.tan(hfov / 2)))  # right of centre
        beta = math.degrees(math.atan((v - 0.5) * 2 * math.tan(vfov / 2)))   # below centre
        bearing = (heading + alpha) % 360
        depression = -pitch + beta
        if hit["source"] == "qr-test" and hit.get("marker_side_px"):
            # The printed marker's known size gives range directly (pinhole camera model).
            size_m = (hit["details"] or {}).get("marker_size_m") or self.args.marker_size
            focal_px = (hit["frame_w"] / 2) / math.tan(hfov / 2)
            slant = size_m * focal_px / hit["marker_side_px"]
            distance = math.sqrt(max(slant ** 2 - alt ** 2, 0.0)) if slant > alt else slant * 0.5
            method = "marker-size"
        elif depression > 2.0:
            distance = min(alt / math.tan(math.radians(depression)), 500.0)
            method = "camera-ray"
        else:
            distance = min(alt * 5, 150.0)  # camera near the horizon: ground intercept is undefined
            method = "camera-bearing"
        flat, flon = dest_point(lat, lon, bearing, distance) if lat is not None else (None, None)
        footprint_w = 2 * max(distance, 1.0) * math.tan(hfov / 2) * (x2 - x1)
        return {
            "fire": {"latitude": None if flat is None else round(flat, 7),
                     "longitude": None if flon is None else round(flon, 7),
                     "distance_m": round(distance, 1), "bearing_deg": round(bearing, 1),
                     "position_source": f"{extra.get('position_source')}+{method}"},
            "drone": {"latitude": lat, "longitude": lon, "altitude_m": t.get("altitude_m"),
                      "heading_deg": heading, "gimbal_pitch_deg": pitch, "state": t.get("state")},
            "est_area_ha": round(float(math.pi * (footprint_w / 2) ** 2 / 10000), 4),
        }

    # ---------- camera auto-tilt ----------

    def _aim_gimbal(self, pitch):
        """Adjust camera pitch toward a detected fire when automatic aiming is enabled."""
        if self.drone is None:
            return
        try:
            self.drone(gimbal.set_target(
                gimbal_id=0, control_mode="position",
                yaw_frame_of_reference="none", yaw=0.0,
                pitch_frame_of_reference="absolute", pitch=float(max(-90.0, min(0.0, pitch))),
                roll_frame_of_reference="none", roll=0.0,
                _no_expect=True))
        except Exception as e:
            print(f"[!] Gimbal command failed: {e!r}")

    def _track(self, hit, frame_shape):
        """Nudge the camera tilt so the detection moves to the vertical centre."""
        if self.args.no_auto_gimbal or time.time() - self.last_gimbal_cmd < 0.5:
            return
        current = self._gimbal_pitch()
        if current is None:
            return
        h, w = frame_shape[:2]
        vfov = math.degrees(2 * math.atan(math.tan(math.radians(self.args.hfov) / 2) * h / w))
        error = ((hit["bbox"][1] + hit["bbox"][3]) / 2 - 0.5) * vfov  # +ve: target below centre
        if abs(error) > 3.0:
            self.last_gimbal_cmd = time.time()
            self._aim_gimbal(current - 0.6 * error)

    # ---------- detection loop (own thread) ----------

    def _detect_loop(self):
        """Process the latest image at the bounded detector rate while the bridge runs."""
        period = 1.0 / DETECT_HZ
        while self.running:
            started = time.time()
            frame = self.latest_bgr
            if frame is not None and self.connected and started - frame[1] < 1.0:
                try:
                    self._detect_step(*frame)
                except Exception as e:
                    print(f"[!] Detection error: {e!r}")
            time.sleep(max(0.0, period - (time.time() - started)))

    def _detect_step(self, img, captured):
        """Run person/fire detection, confirm an episode and publish current fire evidence."""
        if self.person_detector is not None:
            self.person_pass += 1
            if self.person_pass % PERSON_EVERY_N == 0:
                try:
                    self._person_step(img, captured)
                except Exception as e:
                    print(f"[!] Person detection error: {e!r}")
        hit = self.detector.detect(img, captured_at=captured)
        now = time.time()
        if hit is None:
            self.hits = 0
            self.last_hit_box = None
            if self.episode and now - self.episode["last_seen"] > EPISODE_END_S:
                print(f"[*] Fire episode {self.episode['id']} ended (not seen for {EPISODE_END_S:.0f} s)")
                self.episode = None
            return
        self.overlay = [{k: hit[k] for k in ("source", "label", "confidence", "bbox")}]
        self.overlay_time = now
        identity = (hit['source'], hit['label'], hit.get('qr_text'))
        if identity != self.last_hit_identity:
            # A different scenario needs its own confirmation and episode;
            # in particular Tiny cannot inherit Alpha's fire location/history.
            self.hits = 0
            self.last_hit_box = None
            self.episode = None
            self.last_hit_identity = identity
        if hit.get('qr_tracking') in ('optical-flow', 'visual-template'):
            if self.episode is not None:
                self.episode['last_seen'] = now
            return  # Cached text may maintain an episode, never open/publish one.
        self.hits = self.hits + 1 if self.hits == 0 or same_spot(hit, self.last_hit_box) else 1
        self.last_hit_box = hit["bbox"]
        self._track(hit, img.shape)
        if self.hits < confirm_hits(hit):
            return
        new = self.episode is None
        if new:
            self.episode = {"id": f"ep-{int(now)}-{secrets.token_hex(3)}", "last_post": 0.0}
            print(f"[!!] FIRE DETECTED ({hit['source']}, {hit['label']} {hit['confidence']:.2f}) "
                  f"- episode {self.episode['id']}")
        self.episode["last_seen"] = now
        if not new and now - self.episode["last_post"] < EPISODE_UPDATE_S:
            return
        self.episode["last_post"] = now
        where = self._locate(hit, img.shape)
        details = hit["details"] or {"name": f"Detected {hit['label']}", "area_ha": where["est_area_ha"]}
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, DETECTION_JPEG_QUALITY])
        self.publisher.detection({
            "detected_at": utc_iso(captured),
            "episode_id": self.episode["id"],
            "source": hit["source"],
            "label": hit["label"],
            "confidence": hit["confidence"],
            "bbox": [round(v, 4) for v in hit["bbox"]],
            "fire": where["fire"],
            "drone": where["drone"],
            "details": details,
            "frame_jpeg_base64": base64.b64encode(buf.tobytes()).decode() if ok else None,
        })

    # ---------- person search ----------

    def _person_step(self, img, captured):
        """Track people across frames; report each track with the pose it was seen from."""
        boxes = self.person_detector.detect(img)
        now = time.time()
        self.person_tracks = [t for t in self.person_tracks if now - t["last_seen"] < PERSON_TRACK_END_S]
        for det in boxes:
            track = max(self.person_tracks, key=lambda t: iou(t["bbox"], det["bbox"]), default=None)
            if track is None or iou(track["bbox"], det["bbox"]) < 0.3:
                track = {"id": f"pt-{int(now)}-{secrets.token_hex(2)}", "hits": 0, "last_post": 0.0}
                self.person_tracks.append(track)
            track.update(bbox=det["bbox"], last_seen=now, score=det["score"])
            track["hits"] += 1
            self.overlay = [*[o for o in self.overlay if o.get("label") != "person"],
                            {"source": "yolo", "label": "person", "confidence": det["score"], "bbox": det["bbox"]}]
            self.overlay_time = now
            if track["hits"] >= PERSON_MIN_HITS and now - track["last_post"] >= PERSON_POST_S:
                if self._report_person(track, det, img, captured):
                    track["last_post"] = now

    def _report_person(self, track, det, img, captured):
        """Build a posed live person observation and a small JPEG crop; reject incomplete poses."""
        t = self.telemetry or {}
        extra = t.get("extra") or {}
        pitch = extra.get("gimbal_pitch_deg")
        heading = extra.get("heading_deg")
        if t.get("latitude") is None or not t.get("altitude_m") or pitch is None or heading is None:
            return False  # without a full pose the detection cannot be placed on the ground
        h, w = img.shape[:2]
        x1, y1, x2, y2 = det["bbox"]
        pad_x, pad_y = (x2 - x1) * 0.3, (y2 - y1) * 0.3
        crop = img[int(max(0, y1 - pad_y) * h):int(min(1, y2 + pad_y) * h),
                   int(max(0, x1 - pad_x) * w):int(min(1, x2 + pad_x) * w)]
        crop_jpeg = None
        if crop.size:
            scale = PERSON_CROP_PX / max(crop.shape[:2])
            if scale < 1:
                crop = cv2.resize(crop, (max(1, int(crop.shape[1] * scale)), max(1, int(crop.shape[0] * scale))))
            ok, buf = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 80])
            crop_jpeg = buf.tobytes() if ok else None
        obs = {
            "obs_id": f"{self.args.drone_id}-{int(captured * 1000)}-{secrets.token_hex(3)}",
            "observed_at": utc_iso(captured),
            "provenance": "live",
            "sensor": self.args.sensor,
            "label": "person",
            "detector": os.path.basename(self.args.person_model)[:40],
            "detector_score": det["score"],
            "track_id": track["id"],
            "bbox": det["bbox"],
            "drone": {"latitude": t["latitude"], "longitude": t["longitude"], "altitude_m": t["altitude_m"],
                      "heading_deg": heading, "gimbal_pitch_deg": pitch,
                      "position_source": extra.get("position_source") or "gps"},
            "camera": {"hfov_deg": self.args.hfov, "aspect": w / h},
        }
        self.publisher.person(obs, crop_jpeg)
        return True

    # ---------- video publishing (own thread) ----------

    def _video_loop(self):
        """Encode recent camera frames for recording and asynchronous dashboard delivery."""
        period = 1.0 / self.args.video_fps
        last_sent = None
        while self.running:
            started = time.time()
            frame = self.latest_bgr
            if frame is not None and frame[1] != last_sent and self.connected:
                last_sent = frame[1]
                img = frame[0]
                width = getattr(self.args, "video_width", VIDEO_WIDTH)
                if width and img.shape[1] > width:
                    img = cv2.resize(img, (width, int(img.shape[0] * width / img.shape[1])),
                                     interpolation=cv2.INTER_AREA)
                ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, VIDEO_JPEG_QUALITY])
                if ok:
                    fresh = time.time() - self.overlay_time < OVERLAY_TTL_S
                    try:
                        self.publisher.frame(buf.tobytes(), frame[1], self.overlay if fresh else [])
                    except Exception as e:
                        print(f"[!] Video publish error: {e!r}")
            time.sleep(max(0.0, period - (time.time() - started)))

    def _telemetry_loop(self):
        """Periodically sample and publish state while the aircraft is connected."""
        while self.running:
            if self.connected and self.telemetry:
                try:
                    self.publisher.telemetry(self.telemetry)
                except Exception as e:
                    print(f"[!] Telemetry publish error: {e!r}")
            time.sleep(TELEMETRY_INTERVAL)

    # ---------- demo flight (own thread) ----------

    def _flight_ok(self, expectation, what):
        """Wait for a legacy demo SDK expectation and raise if its command did not succeed."""
        if not expectation.wait().success():
            raise RuntimeError(f"{what} did not complete")

    def _move(self, dx, dz, dpsi, what):
        """Relative move; keeps the indoor odometry in step with what was commanded."""
        if self.abort_flight.is_set():
            raise InterruptedError
        heading = math.radians((self.telemetry or {}).get("extra", {}).get("heading_deg") or 0.0)
        self._flight_ok(self.drone(moveBy(dx, 0.0, dz, dpsi)
                                   >> FlyingStateChanged(state="hovering", _timeout=15)), what)
        self.odo_n += dx * math.cos(heading)
        self.odo_e += dx * math.sin(heading)

    def _abort_listener(self):
        """Listen for the terminal landing command during the older demo flight."""
        try:
            for line in sys.stdin:
                if line.strip().lower() in ("x", "l", "land", "abort"):
                    break
        except Exception:
            pass
        if self.flight_phase not in (None, "landed"):
            print("[!] Abort requested - landing now")
            self.abort_flight.set()

    def _demo_flight(self):
        """Run the typed-confirmed takeoff/circle demo and request landing on completion or failure."""
        climb = min(self.args.climb, MAX_CLIMB_M)
        radius = min(self.args.radius, MAX_RADIUS_M)
        while self.running and not (self.connected and self.telemetry):
            time.sleep(0.5)
        if not self.running:
            return
        t = self.telemetry
        self.flight_phase = "preflight"
        self.publisher.flight("preflight", f"climb {climb} m, circle radius {radius} m")
        if (t["battery_pct"] or 0) < MIN_BATTERY_PCT:
            self.publisher.flight("error", f"battery {t['battery_pct']}% below {MIN_BATTERY_PCT}%")
            self.flight_phase = None
            return
        if t["state"] != "landed":
            self.publisher.flight("error", f"drone must be landed to start (state {t['state']})")
            self.flight_phase = None
            return
        print("\n=== DEMO FLIGHT ===")
        print(f"Take off, climb {climb} m, fly a {radius} m-radius circle, return and land.")
        print("Clear the area. During the flight: type x + Enter, press 'l' in the video window,")
        print("or Ctrl+C to land immediately.")
        answer = input("Type FLY and press Enter to take off (anything else cancels): ").strip()
        if answer != "FLY":
            self.publisher.flight("aborted", "cancelled at the confirmation prompt")
            self.flight_phase = None
            return
        threading.Thread(target=self._abort_listener, daemon=True).start()
        side = 2 * radius * math.sin(math.pi / CIRCLE_SEGMENTS)
        try:
            self.odo_n = self.odo_e = 0.0
            self.flight_phase = "takeoff"
            self.publisher.flight("takeoff")
            self._flight_ok(self.drone(TakeOff() >> FlyingStateChanged(state="hovering", _timeout=20)),
                            "take-off")
            if not self.args.no_auto_gimbal:
                self._aim_gimbal(-45.0)  # look ahead-and-down so the camera sees the ground
            self.flight_phase = "climb"
            self.publisher.flight("climb", f"+{climb} m")
            self._move(0.0, -climb, 0.0, "climb")
            # Regular polygon: each side is flown straight, then the heading turns
            # 360/N degrees (moveBy's rotation never bends the move itself), so the
            # last side ends exactly where the first began.
            for i in range(1, CIRCLE_SEGMENTS + 1):
                self.flight_phase = "circle"
                self.publisher.flight("circle", f"segment {side:.2f} m", step=i, steps=CIRCLE_SEGMENTS)
                self._move(side, 0.0, 2 * math.pi / CIRCLE_SEGMENTS, f"circle segment {i}")
            self.flight_phase = "return"
            self.publisher.flight("return", "back over the take-off point")
        except InterruptedError:
            self.publisher.flight("aborted", "operator abort")
        except Exception as e:
            self.publisher.flight("error", str(e))
        finally:
            self._land()

    def _land(self):
        if self.drone is None:
            return
        self.flight_phase = "landing"
        self.publisher.flight("landing")
        # The legacy terminal demo must use the same evidence requirements as
        # BOSCO; a completed wait or sent Landing command is not a landing.
        from qr_orbit_bridge import SensorAges, OlympeOrbitDriver
        listener = SensorAges(self.drone, self.publisher)
        previous = getattr(self, 'sensor_ages', None)
        self.sensor_ages = listener
        confirmed = False
        try:
            listener.subscribe()
            confirmed = OlympeOrbitDriver(self).land()
        except Exception as e:
            print(f"[!] Landing command error: {e!r}")
        finally:
            try:
                listener.unsubscribe()
            except Exception:
                pass
            self.sensor_ages = previous
        self.flight_phase = "landed" if confirmed else "error"
        self.publisher.flight(self.flight_phase, "aircraft confirmed landed" if confirmed else
                              "LANDING UNCONFIRMED: inspect aircraft state; pilot intervention required")

    # ---------- Olympe streaming callbacks (run in Olympe's thread) ----------

    def _yuv_frame_cb(self, yuv_frame):
        received_at = time.time()
        yuv_frame.ref()
        if self.frame_queue.full():
            try:
                self.frame_queue.get_nowait()[0].unref()  # drop the oldest frame
            except queue.Empty:
                pass
        try:
            self.frame_queue.put_nowait((yuv_frame, received_at))
        except queue.Full:
            yuv_frame.unref()

    def _flush_cb(self, stream):
        """Release queued SDK frames before the stream flush completes."""
        self._drain_queue()
        return True

    def _drain_queue(self):
        while True:
            try:
                self.frame_queue.get_nowait()[0].unref()
            except queue.Empty:
                break

    # ---------- connection management (background thread) ----------

    def _set_status(self, text, hint=""):
        """Update connection text and print transitions for the operator."""
        self.status = (text, hint)

    def _connect(self):
        """Create the selected SDK connection and initialize camera/state reception."""
        target = "Skycontroller 3" if self.controller_kind == "skycontroller3" else "drone"
        hint = ("Check the controller USB data link and aircraft pairing" if self.controller_kind == "skycontroller3"
                else "Make sure this PC is on the drone's Wi-Fi (ANAFI-xxxxxxx)")
        print(f"[*] Connecting to {target} at {self.ip} ...")
        self._set_status(f"Connecting to {target} at {self.ip} ...", hint)
        factory = olympe.SkyController3 if self.controller_kind == "skycontroller3" else olympe.Anafi
        drone = factory(self.ip)
        # Olympe enforces a 45 s minimum timeout per attempt; the outer loop does the retrying
        if not drone.connect(retry=1):
            print("[!] Connection failed, retrying...")
            self._set_status(f"Can't reach {target} at {self.ip} - retrying", hint)
            try:
                drone.disconnect()
                drone.destroy()
            except Exception:
                pass
            return False

        if self.controller_kind == "skycontroller3":
            # A USB controller connection alone is not proof of an aircraft link.
            deadline = time.monotonic() + 8
            while self.running and drone.connected and not drone.drone_connection_state() and time.monotonic() < deadline:
                time.sleep(.1)
            if not self.running or not drone.connected or not drone.drone_connection_state():
                print("[!] Controller connected, but aircraft pairing is unavailable.")
                self._set_status("Controller has no aircraft connection", hint)
                drone.disconnect()
                drone.destroy()
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
        self._probe_wind_capability(drone)
        if self.args.gimbal_pitch is not None:
            self._aim_gimbal(self.args.gimbal_pitch)
        return True

    def _probe_wind_capability(self, drone):
        """Subscribe before requesting state; only received events establish support and freshness."""
        self._stop_wind_monitor()
        tracker = self._wind_tracker = WindMeasurement(sdk_available=all(
            item is not None for item in (FlightDataCommand, FlightDataState, WindSpeed)))
        if not tracker.sdk_available:
            return

        def state_received(event, scheduler):
            """Capture availability/capability reports without reading or refreshing an SDK cache."""
            tracker.receive_state(event.args)

        def vector_received(event, scheduler):
            """Stamp the numerical vector's actual receipt once on the owning connection."""
            tracker.receive_vector(event.args, time.monotonic(), time.time())

        try:
            for callback, message in ((state_received, FlightDataState), (vector_received, WindSpeed)):
                subscriber = drone.subscribe(callback, message(_policy='wait'))
                self._wind_subscriptions.append((drone, subscriber))
            drone(FlightDataCommand.GetState(include_default_capabilities=True)).wait(_timeout=5)
            # Command acknowledgement can precede the State event. The event
            # latch is installed above, so a fast response cannot be missed.
            tracker.state_received.wait(timeout=1.)
            print(f"[+] FC wind supported: {tracker.supported}; available: {tracker.available}")
        except Exception as e:
            print(f"[!] FC wind capability probe unavailable: {e!r}")

    def _stop_wind_monitor(self):
        """Detach callbacks from their original connection before replacing aircraft state."""
        for drone, subscriber in getattr(self, '_wind_subscriptions', []):
            try:
                drone.unsubscribe(subscriber)
            except Exception:
                pass
        self._wind_subscriptions = []

    def _aircraft_link(self):
        """Return the aircraft endpoint used by a direct or controller connection."""
        if self.drone is None or not self.drone.connected:
            return False
        if self.controller_kind == "skycontroller3":
            return bool(self.drone.drone_connection_state())
        return True

    def _start_video(self, drone):
        """Register raw-frame callbacks and start the compatible classic-ANAFI stream."""
        # Olympe 8's play() asks for a stream named "Front camera", which the classic
        # ANAFI / ANAFI Extended doesn't expose. Ask for the drone's default stream instead
        # (plus a specific one by name if --stream was given).
        def raw_callbacks():
            """Construct SDK raw-frame callbacks for this bridge's frame queue."""
            cb = Callbacks(media_type=(video_frame_type.raw.value, None))
            cb.video_frame = self._yuv_frame_cb
            cb.flush = self._flush_cb
            return [cb]

        streams = [StreamInfoDefault(callbacks=raw_callbacks())]
        if self.args.stream:
            streams.insert(0, StreamInfo(name=self.args.stream, callbacks=raw_callbacks()))
        return drone.streaming.play_multiple_stream(streams_list=streams)

    def _disconnect(self):
        """Stop streaming, release retained frames and close the SDK connection."""
        self._stop_wind_monitor()
        self._wind_tracker = WindMeasurement(sdk_available=all(
            item is not None for item in (FlightDataCommand, FlightDataState, WindSpeed)))
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
        """Maintain reception across connection failures while the bridge remains active."""
        while self.running:
            try:
                self._connection_step()
            except Exception as e:
                # Never let this thread die silently — that leaves the window stuck on "Waiting"
                print(f"[!] Error: {e!r} — reconnecting...")
                self._set_status("Error - reconnecting", repr(e)[:80])
                self._disconnect()
                self.telemetry = None
                time.sleep(2)
        self._disconnect()

    def _connection_step(self):
        """Perform one connected-session iteration and detect a stalled camera/link."""
        if not self.connected:
            if not self._connect():
                time.sleep(2)
            return
        # Watchdog: reconnect if the link drops or frames stop arriving
        link_ok = self._aircraft_link()
        stalled = time.time() - self.last_frame_time > FRAME_TIMEOUT
        if not link_ok or stalled:
            reason = "lost connection" if not link_ok else "no video frames"
            print(f"[!] {reason} — reconnecting...")
            self._set_status(f"Reconnecting ({reason}) ...")
            self._disconnect()
            self.telemetry = None
            time.sleep(1)
            return
        self._poll_telemetry()
        time.sleep(0.25)

    # ---------- display (main thread — required by OpenCV/GTK) ----------

    def _to_bgr(self, yuv_frame):
        """Convert an SDK I420/NV12 decoded frame into an OpenCV BGR image."""
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
        """Draw the disconnected/waiting state in the optional local window."""
        text, hint = self.status
        img = np.zeros((480, 854, 3), dtype=np.uint8)
        cv2.putText(img, text, (40, 220), cv2.FONT_HERSHEY_SIMPLEX, 0.8,
                    (200, 200, 200), 2, cv2.LINE_AA)
        cv2.putText(img, hint, (40, 270), cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                    (140, 140, 140), 1, cv2.LINE_AA)
        return img

    def _request_landing(self):
        """Set the abort flag and request controlled landing from the active aircraft."""
        if self.flight_phase not in (None, "landed", "landing"):
            print("[!] Landing requested from the video window")
            self.abort_flight.set()

    def run(self):
        workers = [self._connection_loop, self._telemetry_loop, self._video_loop, self._detect_loop]
        if self.args.demo_flight:
            workers.append(self._demo_flight)
        for target in workers:
            threading.Thread(target=target, daemon=True).start()
        show = not self.args.no_window
        if show:
            cv2.namedWindow(WINDOW, cv2.WINDOW_NORMAL)
            cv2.resizeWindow(WINDOW, 1280, 720)

        frames, t0 = 0, time.time()
        last_shown = 0.0
        try:
            while self.running:
                try:
                    yuv_frame, received_at = self.frame_queue.get(timeout=0.1)
                except queue.Empty:
                    # Show status until video arrives (or after it stops for a moment)
                    if show and (not self.connected or time.time() - last_shown > 1.0):
                        cv2.imshow(WINDOW, self._waiting_screen())
                else:
                    try:
                        img = self._to_bgr(yuv_frame)
                    finally:
                        yuv_frame.unref()
                    if img is not None:
                        now = last_shown = time.time()
                        self.last_frame_time = received_at
                        frames += 1
                        if now - t0 >= 1.0:
                            self.fps, frames, t0 = frames / (now - t0), 0, now
                        self.latest_bgr = (img, received_at)  # Queue delay must not make an old image fresh.
                        if show:
                            view = img.copy()
                            self._draw_overlay(view)
                            cv2.imshow(WINDOW, view)

                if show:
                    key = cv2.waitKey(1) & 0xFF
                    if key == ord("l"):
                        self._request_landing()
                    if key in (ord("q"), 27):
                        break
                    if cv2.getWindowProperty(WINDOW, cv2.WND_PROP_VISIBLE) < 1:
                        break  # window closed with the X button
        except KeyboardInterrupt:
            pass
        finally:
            print("[*] Shutting down...")
            if self.flight_phase not in (None, "landed"):
                self.abort_flight.set()
                self._land()  # never leave the drone in the air when the bridge exits
            self.running = False
            self._disconnect()
            if hasattr(self.publisher, 'close'):
                self.publisher.close()
            if show:
                cv2.destroyAllWindows()


def video_width_arg(value):
    """Accept zero for native video or validate a positive output-width limit."""
    width = int(value)
    if width != 0 and not 320 <= width <= 3840:
        raise argparse.ArgumentTypeError("Video width must be 0 (native) or 320-3840 pixels")
    return width


def argument_parser():
    """Define shared bridge, receiver, detector and legacy flight CLI options."""
    parser = argparse.ArgumentParser(description="Emberwatch ANAFI bridge: video, telemetry, fire detection")
    parser.add_argument("--controller", choices=("direct", "skycontroller3"), default="direct",
                        help="SDK connection class; skycontroller3 requires a controller USB network link")
    parser.add_argument("--ip", default=None,
                        help="target IP (default: 192.168.42.1 direct, 192.168.53.1 skycontroller3)")
    parser.add_argument("--stream", default=None,
                        help="video stream name to request (default: the drone's default "
                             "stream, 'DefaultVideo' on the classic ANAFI)")
    parser.add_argument("--out-dir", default=DEFAULT_OUT_DIR,
                        help=f"where telemetry/snapshot/detection files are written (default {DEFAULT_OUT_DIR})")
    parser.add_argument("--backend", default=os.environ.get("EMBERWATCH_URL"),
                        help="Emberwatch backend URL, e.g. http://127.0.0.1:8787 (default: "
                             "$EMBERWATCH_URL; files only if unset). Token is read from $INGEST_TOKEN")
    parser.add_argument("--drone-id", default="ANAFI-01")
    parser.add_argument("--home-lat", type=float, default=DEFAULT_HOME[0],
                        help="position used when the drone has no GPS fix (default: Sam Ibrahim Building, UTSC)")
    parser.add_argument("--home-lon", type=float, default=DEFAULT_HOME[1])
    parser.add_argument("--model", default=os.environ.get("EMBERWATCH_MODEL", DEFAULT_MODEL),
                        help="YOLO fire/smoke weights (bridge/setup.sh downloads them)")
    parser.add_argument("--conf", type=float, default=DEFAULT_CONF,
                        help=f"minimum fire/smoke confidence (default {DEFAULT_CONF})")
    parser.add_argument("--detect-smoke", action="store_true",
                        help="also alert on smoke-only detections (off by default: prone to false alarms)")
    parser.add_argument("--no-yolo", action="store_true", help="QR test marker only (skip the fire model)")
    parser.add_argument("--person-model", default=os.environ.get("EMBERWATCH_PERSON_MODEL", DEFAULT_PERSON_MODEL),
                        help="YOLO model with a 'person' class for the person search (default: COCO yolov8n)")
    parser.add_argument("--person-conf", type=float, default=0.4, help="minimum person detector score (default 0.4)")
    parser.add_argument("--no-person", action="store_true", help="turn the person search off")
    parser.add_argument("--sensor", choices=("visible", "thermal"), default="visible",
                        help="which camera stream this is (ANAFI USA/Thermal: thermal)")
    parser.add_argument("--hfov", type=float, default=69.0, help="camera horizontal field of view, degrees")
    parser.add_argument("--marker-size", type=float, default=0.18,
                        help="printed QR marker side in metres, used for range (default 0.18)")
    parser.add_argument("--gimbal-pitch", type=float, default=None,
                        help="aim the camera to this pitch (degrees, negative = down) on connect")
    parser.add_argument("--no-auto-gimbal", action="store_true", help="don't re-aim the camera at detections")
    parser.add_argument("--video-fps", type=float, default=15.0, help="frames/s sent to the dashboard")
    parser.add_argument("--video-width", type=video_width_arg, default=VIDEO_WIDTH,
                        help="dashboard JPEG width cap; 0 preserves native pixels for camera calibration")
    parser.add_argument("--no-window", action="store_true", help="run without the local video window")
    parser.add_argument("--demo-flight", action="store_true",
                        help="take off, climb, fly a small circle, return and land (asks to confirm)")
    parser.add_argument("--climb", type=float, default=1.0, help=f"demo climb in metres (max {MAX_CLIMB_M})")
    parser.add_argument("--radius", type=float, default=1.0, help=f"demo circle radius in metres (max {MAX_RADIUS_M})")
    return parser


def main():
    """Parse bridge options, construct publishers/detectors and run the aircraft receiver."""
    args = argument_parser().parse_args()

    token = os.environ.get("INGEST_TOKEN")
    if args.backend and not token:
        raise SystemExit("--backend needs the ingest token: export INGEST_TOKEN=... "
                         "(the value from the backend's .env)")
    publisher = Publisher(args.out_dir, args.backend, token)
    detector = FireDetector(args.model, args.conf, use_yolo=not args.no_yolo, detect_smoke=args.detect_smoke)
    print(f"[*] Writing telemetry, snapshots and detections to {os.path.abspath(args.out_dir)}")
    if args.backend:
        print(f"[*] Posting to backend at {args.backend}")
    person_detector = None if args.no_person else PersonDetector(args.person_model, args.person_conf)
    AnafiBridge(args, publisher, detector, person_detector).run()


if __name__ == "__main__":
    main()
