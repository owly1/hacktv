#!/usr/bin/env python3
"""Grounded QR rehearsal on the laptop. Reads the camera; cannot control flight.

Uses only GET requests to the dashboard. No Olympe/flight driver is imported.
"""
import argparse
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import time
from urllib.parse import urlparse
from urllib.request import Request, urlopen

import cv2
import numpy as np

from qr_orbit_core import Limits, Marker, Trigger


class Rehearsal:
    def __init__(self, backend, expected, image=None):
        """Configure a motor-free selected-QR rehearsal using live snapshots or a labeled test image."""
        self.backend, self.image = backend, image
        self.expected, self.limits = expected, Limits()
        self.trigger = Trigger(expected, self.limits)
        self.lock = threading.RLock()
        self.jpeg, self.last_capture, self.token = None, None, None
        self.mode = "test image" if image else "live drone camera"
        self.detected, self.error, self.started = False, None, None
        self.reader = cv2.QRCodeDetector()
        self.stop = threading.Event()

    def action(self, action):
        """Apply browser arm/reset actions only to the simulated rehearsal state."""
        with self.lock:
            if action == "reset":
                self.trigger, self.started = Trigger(self.expected, self.limits), None
            elif action == "arm":
                self.trigger.arm(time.monotonic())
            elif action == "cancel":
                self.trigger.cancel("rehearsal cancelled")
                self.started = None
            else:
                raise ValueError("Unknown rehearsal action")

    def state(self):
        """Return recognition, freshness and animation progress with flight commands explicitly disabled."""
        with self.lock:
            age = None if self.last_capture is None else max(0, time.time()-self.last_capture)
            return {"mode": self.mode, "state": self.trigger.state, "reason": self.trigger.reason,
                    "qr_recognized": self.detected and age is not None and age < 2,
                    "camera_age_s": None if age is None else round(age, 1), "error": self.error,
                    "progress": 0 if self.started is None else min(1, (time.monotonic()-self.started)/30),
                    "radius_m": self.limits.radius_m, "height_m": self.limits.height_m,
                    "flight_commands_possible": False}

    def camera(self):
        """Obtain the labeled test image or a fresh authenticated backend snapshot."""
        if self.image:
            image = cv2.imread(str(self.image))
            if image is None:
                raise ValueError("Test image could not be read")
            image = cv2.copyMakeBorder(image, 80, 80, 80, 80, cv2.BORDER_CONSTANT, value=(255, 255, 255))
            return image, time.time()
        if self.token is None:
            with urlopen(self.backend+"/api/session", timeout=2) as response:
                self.token = json.load(response)["token"]
        request = Request(self.backend+"/api/snapshot", headers={"Authorization": "Bearer "+self.token})
        with urlopen(request, timeout=2) as response:
            captured = datetime.fromisoformat(response.headers["X-Captured-At"].replace("Z", "+00:00")).timestamp()
            data = response.read(8_000_001)
        if len(data) > 8_000_000:
            raise ValueError("Camera image exceeds size limit")
        image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError("Camera did not return a decoded JPEG")
        return image, captured

    def poll(self):
        """Decode new frames and advance the simulated trigger/path without constructing an SDK driver."""
        while not self.stop.is_set():
            try:
                image, captured = self.camera()
                text, points, _ = self.reader.detectAndDecode(image)
                now = time.monotonic()
                at = now - (time.time()-captured)
                with self.lock:
                    self.last_capture = captured
                    self.error = None if 0 <= time.time()-captured < 2 else "Camera is stale; no new QR observations can count."
                    self.detected = bool(text == self.expected and points is not None)
                    if self.detected:
                        cv2.polylines(image, [points.reshape(4, 2).astype(np.int32)], True, (60, 210, 160), 3)
                    marker = Marker(at, text, 1, 0, 1, 0, 0) if self.detected else None
                    if self.trigger.observe(marker, None, now, rehearsal=True):
                        self.started = now
                    ok, jpeg = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 75])
                    if ok:
                        self.jpeg = jpeg.tobytes()
            except Exception:
                # Do not log URLs, authorization headers or session tokens.
                with self.lock:
                    self.detected = False
                    self.error = "Camera unavailable. Check BOSCO, the Pi link and drone power."
                    self.trigger.observe(None, None, time.monotonic(), rehearsal=True)
                self.token = None
            self.stop.wait(.2)


def main():
    """Start the local motor-disabled preview server and its camera polling thread."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", default="http://127.0.0.1:8787")
    parser.add_argument("--port", type=int, default=8789)
    parser.add_argument("--image", type=Path, help="decode a test image instead of reading the real camera")
    args = parser.parse_args()
    url = urlparse(args.backend)
    if url.scheme != "http" or url.hostname not in ("localhost", "127.0.0.1") or url.path not in ("", "/"):
        parser.error("Use a local BOSCO backend URL")
    expected = Path(__file__).with_name("orbit-marker.txt").read_text(encoding="utf-8").strip()
    rehearsal = Rehearsal(args.backend.rstrip("/"), expected, args.image)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            """Suppress routine access logging from the rehearsal web server."""
            pass

        def send(self, code, data, kind):
            """Send a typed response with the rehearsal server's cache headers."""
            self.send_response(code)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            """Serve the preview page, latest camera image or rehearsal status."""
            path = urlparse(self.path).path
            if path == "/":
                self.send(200, Path(__file__).with_name("qr-orbit-rehearsal.html").read_bytes(), "text/html; charset=utf-8")
            elif path == "/state":
                self.send(200, json.dumps(rehearsal.state()).encode(), "application/json")
            elif path == "/frame.jpg":
                with rehearsal.lock:
                    data = rehearsal.jpeg
                self.send(200 if data else 204, data or b"", "image/jpeg")
            else:
                self.send(404, b"Not found", "text/plain")

        def do_POST(self):
            """Handle only the rehearsal's local arm/reset actions."""
            if self.headers.get("Origin") != f"http://127.0.0.1:{args.port}":
                self.send(403, b"Open the local rehearsal page", "text/plain")
                return
            try:
                rehearsal.action(self.path.removeprefix("/"))
                self.send(200, b"{}", "application/json")
            except ValueError as error:
                self.send(409, str(error).encode(), "text/plain")

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    threading.Thread(target=rehearsal.poll, daemon=True).start()
    print(f"QR rehearsal: http://127.0.0.1:{args.port}/ — motor commands disabled by design", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        rehearsal.stop.set()
        server.server_close()


if __name__ == "__main__":
    main()
