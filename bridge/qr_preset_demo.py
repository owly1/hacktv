#!/usr/bin/env python3
"""Arm -> recognize QR -> take off -> one preset circle -> nearby hover -> land.

No camera calibration, marker distance estimation, object tracking or approach.
The operator aligns the start one metre behind the intended circle center.
Default is reception/rehearsal only. --execute AND ARM QR PRESET enable flight.
"""
import math
import os
from pathlib import Path
import signal
import sys
import threading
import time

from anafi_bridge import FireDetector, Publisher, argument_parser
from hover_checkout import HoverCheckout
from qr_orbit_core import Limits, Vehicle
from qr_preset_core import Recognition, RecognitionTrigger, fly_preset
from terminal_controls import commands as terminal_commands


class QRPresetDemo(HoverCheckout):
    def __init__(self, args, publisher, detector, limits, marker):
        super().__init__(args, publisher, detector)
        self.limits = limits
        self.trigger = RecognitionTrigger(marker, limits.arm_seconds)
        self.observation = None
        self.observation_lock = threading.Lock()
        self.armed_drone = None
        self.flight_started = None
        self.last_trigger_reason = None

    def _ready_message(self):
        return "READY: ARM QR PRESET + Enter, then show the selected QR; " + (
            "recognition will request real takeoff" if self.args.execute else "REHEARSAL ONLY, no motor commands")

    def _print_instructions(self):
        print("QR PRESET: DISARMED" if self.args.execute else "QR PRESET: REHEARSAL / NO MOTOR COMMANDS", flush=True)
        print("NO OBJECT TRACKING. Place the intended circle center 1 m ahead of the aligned launch point.", flush=True)
        print("ARM QR PRESET + Enter, then five fresh selected-QR frames: takeoff, one preset circle, nearby hover.", flush=True)
        print(f"Hover ends on X/Esc or after {self.args.hold_seconds:g} seconds; total flight cap is 90 seconds.", flush=True)
        print("X/Esc needs no Enter; LAND + Enter and Ctrl+C also request controlled landing.", flush=True)

    def _hover_observed_message(self):
        return "hover established; beginning the preset path relative to the launch heading"

    def _overlay_lines(self):
        sample = self.telemetry or {}
        return ["QR PRESET: " + ("LIVE" if self.args.execute else "REHEARSAL / NO MOTOR COMMANDS"),
                "OBJECT POSITION NOT TRACKED; manually aligned preset path",
                f"QR: {self.trigger.state}; {self.trigger.reason}",
                f"State: {sample.get('state')}; height: {sample.get('altitude_m')} m; X requests landing"]

    def _detect_step(self, image, captured):
        if captured == self.last_processed_frame:
            return
        self.last_processed_frame = captured
        hit = self.detector.detect(image)
        observation = None
        if hit and hit.get("source") == "qr-test":
            observation = Recognition(time.monotonic()-(time.time()-captured), hit["qr_text"])
            self.overlay = [{key: hit[key] for key in ("source", "label", "confidence", "bbox")}]
            self.overlay_time = time.time()
        else:
            self.overlay = []
        with self.observation_lock:
            self.observation = observation

    def _connection_step(self):
        super()._connection_step()
        self._supervise_once()

    def _supervise_once(self):
        with self.trigger_lock:
            if self.trigger.state != "armed":
                return
        if self.args.execute:
            reason = self.checkout_reason(starting=True)
            if self.drone is not self.armed_drone:
                reason = "aircraft connection changed after arming"
            if reason:
                with self.trigger_lock:
                    self.trigger.cancel(reason)
                self.report("preflight", f"preset cancelled before takeoff: {reason}")
                return
        with self.observation_lock:
            observation = self.observation
        with self.trigger_lock:
            triggered = self.trigger.observe(observation, time.monotonic())
            reason = self.trigger.reason
        if triggered:
            if self.args.execute:
                with self.takeoff_lock:
                    if self.abort_flight.is_set() or self.input_closed.is_set():
                        self.trigger.cancel("operator cancelled before takeoff")
                        return
                    self.takeoff_used = self.hold_connection = True
                    self.flight_started = time.monotonic()
                    self.mission = threading.Thread(target=self._hover)
                    self.mission.start()
            else:
                self.report("circle", "QR RECOGNIZED: would take off, circle and hold nearby; REHEARSAL ONLY")
        elif reason != self.last_trigger_reason:
            self.last_trigger_reason = reason
            self.report("preflight", reason)

    def _terminal(self):
        try:
            for command in terminal_commands(sys.stdin, stopped=lambda: not self.running):
                if not self.running or self.land_confirmed:
                    break
                if command in ("LAND", "ABORT"):
                    with self.trigger_lock:
                        self.trigger.cancel()
                    grounded = not self.takeoff_used and (self.telemetry or {}).get("state") == "landed"
                    self._request_landing(force=not grounded)
                    self.report("preflight" if grounded else "landing", "operator cancelled before takeoff" if grounded else
                                "operator landing key received")
                elif command == "ARM QR PRESET":
                    reason = self.checkout_reason(starting=True) if self.args.execute else None
                    if reason or self.takeoff_used or self.abort_flight.is_set():
                        self.report("preflight", reason or "this session is consumed; restart to try again")
                        continue
                    try:
                        with self.trigger_lock:
                            self.trigger.arm(time.monotonic())
                            self.armed_drone = self.drone
                        self.report("preflight", "armed for 20 seconds; selected QR recognition will trigger this session")
                    except ValueError as error:
                        self.report("preflight", str(error))
        finally:
            self.input_closed.set()
            with self.trigger_lock:
                self.trigger.cancel("operator terminal closed")
            self._request_landing(force=False)

    def _preset_vehicle(self):
        sample = self.telemetry or {}
        ages = self.sensor_ages.ages if self.sensor_ages else {}
        attitude = sample.get("attitude_deg") or {}
        oldest = min(ages.get(key, float("-inf")) for key in ("altitude", "speed", "attitude"))
        frame_time = self.last_frame_time
        video_fresh = 0 <= time.time()-frame_time <= 1.5
        return Vehicle(oldest, bool(self.connected and self._aircraft_link() and video_fresh),
                       sample.get("state"), sample.get("battery_pct"), sample.get("altitude_m"),
                       sample.get("ground_speed_mps"),
                       max(abs(attitude.get("roll", float("inf"))), abs(attitude.get("pitch", float("inf")))),
                       not self.input_closed.is_set())

    def _after_hover(self):
        fly_preset(self.driver, self.limits, self._preset_vehicle, self.abort_flight, self.report,
                   hold_seconds=self.args.hold_seconds, flight_started=self.flight_started,
                   clock=time.monotonic, sleep=time.sleep)


def main():
    parser = argument_parser()
    parser.description = __doc__
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--hold-seconds", type=float, default=30)
    parser.add_argument("--marker-file", default=str(Path(__file__).with_name("orbit-marker.txt")))
    args = parser.parse_args()
    if args.controller != "direct" or args.demo_flight or args.gimbal_pitch is not None:
        parser.error("Use the direct Pi link with the Skycontroller off; do not combine other flight modes")
    if not sys.stdin.isatty():
        parser.error("Use an interactive operator terminal")
    if not math.isfinite(args.hold_seconds) or not 1 <= args.hold_seconds <= 30:
        parser.error("Hover timeout must be 1-30 seconds")
    if args.radius != 1:
        parser.error("This manually aligned preset uses a fixed 1 m radius")
    args.no_window = args.no_auto_gimbal = args.no_yolo = args.terminal_control = True
    args.hover_seconds, args.checkout_one_segment = 1, False
    marker = Path(args.marker_file).read_text(encoding="utf-8").strip()
    limits = Limits(radius_m=1, height_m=1, mission_seconds=90)
    token = os.environ.get("INGEST_TOKEN")
    if args.backend and not token:
        parser.error("Backend integration requires INGEST_TOKEN in the environment")
    bridge = QRPresetDemo(args, Publisher(args.out_dir, args.backend, token),
                          FireDetector(args.model, args.conf, use_yolo=False), limits, marker)
    def stop(signum, frame):
        bridge._request_landing(force=False)
        bridge.running = False
    for name in ("SIGINT", "SIGTERM", "SIGHUP"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), stop)
    bridge.run()


if __name__ == "__main__":
    main()
