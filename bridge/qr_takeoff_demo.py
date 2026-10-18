#!/usr/bin/env python3
"""Operator-started takeoff -> calibrated QR hover -> one chord or orbit -> land.

One SDK connection throughout. Default has no flight driver. --execute, current
physical preflight, verified calibration and a typed start phrase are required.
Showing a QR on the ground cannot start the motors.
"""
import os
from pathlib import Path
import signal
import sys
import threading
import time

from anafi_bridge import FireDetector, Publisher, argument_parser
from hover_checkout import HoverCheckout
from qr_orbit_bridge import QROrbitBridge, read_preflight
from qr_orbit_core import Limits, Trigger, vehicle_reason
from qr_orbit_pose import CalibratedPose
from terminal_controls import commands as terminal_commands


class QRTakeoffDemo(HoverCheckout):
    def __init__(self, args, publisher, detector, pose, limits, marker):
        """Combine operator takeoff and measured QR waiting on one owned SDK connection."""
        super().__init__(args, publisher, detector)
        self.pose, self.limits = pose, limits
        self.trigger = Trigger(marker, limits)
        self.start_phrase = "START QR ORBIT" if args.full_orbit else "START QR CHECKOUT"

    def _ready_message(self):
        """Describe typed-start readiness or the non-executing reception mode."""
        return (f"READY: {self.start_phrase} + Enter requests takeoff and QR waiting" if self.args.execute else
                "READY: read-only QR reception; no takeoff or movement commands enabled")

    def _hover_observed_message(self):
        """Describe the QR-waiting stage entered after a stable takeoff hover."""
        return "hover established; checking the calibrated QR session before movement"

    def _print_instructions(self):
        """Print the integrated start phrase, selected arc/orbit and landing controls."""
        print("QR FLIGHT: DISARMED" if self.args.execute else "QR RECEPTION ONLY: no motor commands", flush=True)
        print("One full orbit, then landing" if self.args.full_orbit else "One short arc, then landing", flush=True)
        print(f"{self.start_phrase} + Enter: take off, settle in hover, then wait for the selected QR.", flush=True)
        print("A QR alone cannot start the motors. No search flight or outward repositioning is implemented.", flush=True)
        print("Esc or X requests landing without Enter. LAND + Enter and Ctrl+C also request landing.", flush=True)

    def _overlay_lines(self):
        """Show the current checkout stage and measured QR readiness."""
        sample = self.telemetry or {}
        return ["QR FLIGHT: " + ("LIVE / TERMINAL CONTROL" if self.args.execute else "READ ONLY"),
                f"QR: {self.trigger.state}; measured pose: {'available' if self.pose else 'unavailable'}",
                f"Battery: {sample.get('battery_pct')} %; state: {sample.get('state')}",
                f"Height above launch: {sample.get('altitude_m')} m; X requests landing"]

    def _detect_step(self, image, captured):
        """Decode a fresh image into the measured-pose pipeline used by the checkout."""
        QROrbitBridge._detect_step(self, image, captured)

    def _terminal(self):
        """Accept the typed start phrase while giving immediate landing input priority."""
        try:
            for command in terminal_commands(sys.stdin, stopped=lambda: not self.running):
                if not self.running or self.land_confirmed:
                    break
                if command in ("LAND", "ABORT"):
                    with self.trigger_lock:
                        self.trigger.cancel()
                    self._request_landing()
                    self.report("landing", "operator landing key received")
                elif command == self.start_phrase:
                    if not self.args.execute:
                        self.report("preflight", "read-only reception; no flight commands enabled")
                        continue
                    if self.takeoff_used:
                        self.report("preflight", "this session is already consumed")
                        continue
                    try:
                        if self.pose is None:
                            raise ValueError("measured camera calibration is required")
                        read_preflight(self.args.preflight_file, terminal_control=True)
                        reason = self.checkout_reason(starting=True)
                        if reason:
                            raise ValueError(reason)
                    except (ValueError, KeyError, OSError) as error:
                        self.report("preflight", f"cannot start: {error}")
                        continue
                    self.takeoff_used = True
                    self.mission = threading.Thread(target=self._hover)
                    self.mission.start()
        finally:
            self.input_closed.set()
            with self.trigger_lock:
                self.trigger.cancel("operator terminal closed")
            self._request_landing(force=False)

    def _after_hover(self):
        """Wait for one valid QR trigger, then fly the selected arc/orbit with the same driver."""
        # This hook runs on the same worker and SDK connection as TakeOff.
        # It never runs in the ordinary three-second hover checkout.
        if not self.args.execute or self.pose is None:
            raise InterruptedError("QR flight requires live mode and measured camera calibration")
        read_preflight(self.args.preflight_file, terminal_control=True)
        if self.abort_flight.is_set() or self.input_closed.is_set():
            raise InterruptedError("operator requested landing")
        with self.trigger_lock:
            self.trigger.arm(time.monotonic())
        self.report("preflight", f"hover established; waiting up to {self.limits.arm_seconds:g} seconds for the selected QR")
        last_reason = None
        while True:
            reason = self.checkout_reason()
            if reason:
                raise InterruptedError(reason)
            vehicle, marker = self.sample()
            reason = vehicle_reason(vehicle, self.limits, time.monotonic(), starting=True)
            if reason:
                raise InterruptedError(reason)
            with self.trigger_lock:
                triggered = self.trigger.observe(marker, vehicle, time.monotonic())
                state, reason = self.trigger.state, self.trigger.reason
            if state == "cancelled":
                raise InterruptedError(reason)
            if triggered:
                self.report("preflight", "selected QR and measured geometry confirmed; starting one movement session")
                self._orbit()  # Uses this bridge's existing driver; confirms landing.
                return
            if reason != last_reason:
                last_reason = reason
                self.report("preflight", reason)
            time.sleep(.05)


def main():
    """Validate calibrated integrated-checkout options and construct its one-shot runtime."""
    parser = argument_parser()
    parser.description = __doc__
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--full-orbit", action="store_true", help="explicitly choose twelve segments; default is one chord")
    parser.add_argument("--height", type=float, default=1)
    parser.add_argument("--marker-file", default=str(Path(__file__).with_name("orbit-marker.txt")))
    parser.add_argument("--camera-calibration")
    parser.add_argument("--preflight-file")
    args = parser.parse_args()
    if args.controller != "direct" or args.demo_flight or args.gimbal_pitch is not None:
        parser.error("Use direct Pi control with the Skycontroller off; do not combine flight/gimbal modes")
    if not sys.stdin.isatty():
        parser.error("Use an interactive operator terminal")
    args.no_window = args.no_auto_gimbal = args.no_yolo = args.terminal_control = True
    args.checkout_one_segment, args.hover_seconds = not args.full_orbit, 1
    try:
        limits = Limits(radius_m=args.radius, height_m=args.height)
        marker = Path(args.marker_file).read_text(encoding="utf-8").strip()
        pose = CalibratedPose(args.camera_calibration, require_verified=args.execute) if args.camera_calibration else None
        if args.execute:
            if pose is None or not args.preflight_file:
                raise ValueError("Live QR flight requires verified calibration and a current physical preflight file")
            read_preflight(args.preflight_file, terminal_control=True)
    except (ValueError, KeyError, TypeError, OSError) as error:
        parser.error(str(error))
    token = os.environ.get("INGEST_TOKEN")
    if args.backend and not token:
        parser.error("Backend integration requires INGEST_TOKEN in the environment")
    bridge = QRTakeoffDemo(args, Publisher(args.out_dir, args.backend, token),
                           FireDetector(args.model, args.conf, use_yolo=False), pose, limits, marker)
    def stop(signum, frame):
        """Cancel the integrated checkout and request landing on termination."""
        bridge._request_landing(force=False)
        bridge.running = False
    for name in ("SIGINT", "SIGTERM", "SIGHUP"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), stop)
    bridge.run()


if __name__ == "__main__":
    main()
