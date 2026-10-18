#!/usr/bin/env python3
"""Direct Pi terminal checkout: one requested takeoff, <=3 s hover, then landing.

Default receives only. --execute AND typed TAKEOFF TEST are required for flight.
No QR, horizontal movement, orbit, gimbal command or automatic startup takeoff.
"""
import math
from pathlib import Path
import sys
import threading
import time

from anafi_bridge import AnafiBridge, FireDetector, Publisher, argument_parser, TakeOff
from qr_orbit_bridge import QROrbitBridge
from qr_orbit_core import Limits
from terminal_controls import commands as terminal_commands


class HoverCheckout(QROrbitBridge):
    def __init__(self, args, publisher, detector):
        marker = Path(__file__).with_name("orbit-marker.txt").read_text().strip()
        super().__init__(args, publisher, detector, None, Limits(), marker)
        self.takeoff_used = False
        self.last_checkout_reason = object()
        self.takeoff_lock = threading.RLock()

    def _request_landing(self, force=True):
        # Order TakeOff and LAND on the same connection. A landing key which
        # wins this lock must prevent a subsequently queued takeoff.
        with self.takeoff_lock:
            super()._request_landing(force=force)

    def _detect_step(self, image, captured):
        pass  # This checkout has no QR-triggered action or fire detection.

    def _connection_step(self):
        super()._connection_step()
        if not self.takeoff_used:
            reason = self.checkout_reason(starting=True)
            if reason != self.last_checkout_reason:
                self.last_checkout_reason = reason
                message = reason or self._ready_message()
                self.report("preflight", message)

    def _ready_message(self):
        return ("READY: type TAKEOFF TEST + Enter for one real checkout" if self.args.execute else
                "READY: reception only; restart with -Execute for the operator flight test")

    def _after_hover(self):
        """Default checkout ends here. An explicitly selected QR runtime may continue."""
        pass

    def _hover_observed_message(self):
        return "hover observed; landing after the short checkout"

    def minimum_battery_pct(self,starting=False):
        return 40

    def checkout_reason(self, starting=False):
        if not self.connected or not self._aircraft_link() or self.input_closed.is_set():
            return "aircraft or operator terminal is disconnected"
        if self.abort_flight.is_set():
            return "landing was requested; restart the checkout before another attempt"
        ages = self.sensor_ages.ages if self.sensor_ages else {}
        now = time.monotonic()
        if any(not 0 <= now-ages.get(key, float("-inf")) <= 1 for key in ("altitude", "speed", "attitude")):
            return "altitude, speed or attitude events are stale"
        if time.time()-self.last_frame_time > 1.5:
            return "camera frames are stale"
        t = self.telemetry or {}
        values = [t.get("battery_pct"), t.get("altitude_m"), t.get("ground_speed_mps")]
        attitude = t.get("attitude_deg") or {}
        values += [attitude.get("roll"), attitude.get("pitch")]
        if any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in values):
            return "required aircraft telemetry is unknown"
        battery, height, speed, roll, pitch = values
        minimum=self.minimum_battery_pct(starting)
        if battery < minimum:
            return f"battery is below {minimum}%"
        if height < -.2 or height > 1.5:
            return f"measured altitude {height:.2f} m is outside the checkout limit"
        if speed > .3:
            return f"measured ground speed {speed:.2f} m/s exceeds 0.3 m/s"
        if starting and (t.get("state") != "landed" or abs(height) > .25 or speed > .1):
            return "a stationary, grounded aircraft is required"
        if not starting and t.get("state") not in ("landed", "motor_ramping", "takingoff", "hovering", "flying"):
            return f"unexpected flight state: {t.get('state')!r}"
        # Resting attitude is not an airborne hover. These are project guards,
        # not Parrot-specified limits; keep the tighter check after takeoff.
        tilt_limit = 20 if t.get("state") in ("landed", "motor_ramping", "takingoff") else 10
        if max(abs(roll), abs(pitch)) > tilt_limit:
            return (f"aircraft is tilted: roll={roll:.1f}, pitch={pitch:.1f} degrees "
                    f"(maximum {tilt_limit} in {t.get('state')})")
        return None

    def _overlay_lines(self):
        t = self.telemetry or {}
        return ["HOVER CHECKOUT: " + ("LIVE / TERMINAL CONTROL" if self.args.execute else "RECEPTION ONLY"),
                f"Battery: {t.get('battery_pct')} %", f"State: {t.get('state')}",
                f"Height above takeoff: {t.get('altitude_m')} m", "X or Esc requests landing"]

    def _takeoff_message(self):
        return "operator requested one takeoff checkout"

    def _hover(self):
        pending = None
        self.hold_connection = True  # Also land if TakeOff raises after transmission.
        try:
            with self.takeoff_lock:
                reason = self.checkout_reason(starting=True)
                if self.abort_flight.is_set() or reason:
                    raise InterruptedError(reason or "operator landing requested")
                self.report("takeoff", self._takeoff_message())
                pending = self.drone(TakeOff(_no_expect=True))
            deadline = time.monotonic()+10
            hover_started = None
            previous_state = None
            while True:
                state = (self.telemetry or {}).get("state")
                if state != previous_state:
                    self.report("takeoff" if hover_started is None else "climb",
                                f"aircraft reported flight state: {state!r}")
                    previous_state = state
                reason = self.checkout_reason()
                if reason:
                    raise InterruptedError(reason)
                if pending.done() and not pending.success():
                    raise RuntimeError("aircraft rejected TakeOff")
                if (self.telemetry or {}).get("state") == "hovering":
                    if hover_started is None:
                        hover_started = time.monotonic()
                        self.report("climb", self._hover_observed_message())
                    if time.monotonic()-hover_started >= self.args.hover_seconds:
                        break
                elif hover_started is not None:
                    raise InterruptedError("aircraft left its stationary hover")
                if time.monotonic() >= deadline:
                    raise TimeoutError("takeoff/hover checkout timed out")
                time.sleep(.05)
            self._after_hover()
        except Exception as error:
            self._request_landing(force=False)
            self.report("aborted", str(error))
        finally:
            if pending is not None:
                pending.cancel()  # Cancels an expectation, not physical motion.
            self._land()
            if self.land_confirmed:
                self.running = False

    def _terminal(self):
        try:
            for command in terminal_commands(sys.stdin, stopped=lambda: not self.running):
                if not self.running or self.land_confirmed:
                    break  # Do not restart landing during confirmed-landed cleanup.
                if command in ("LAND", "ABORT"):
                    self._request_landing()
                    self.report("landing", "operator landing key received")
                elif command == "TAKEOFF TEST":
                    if not self.args.execute:
                        self.report("preflight", "reception-only mode; no flight commands enabled")
                        continue
                    reason = self.checkout_reason(starting=True)
                    if self.takeoff_used or reason:
                        self.report("preflight", reason or "this checkout is already consumed")
                        continue
                    self.takeoff_used = True
                    self.mission = threading.Thread(target=self._hover)
                    self.mission.start()
        finally:
            self.input_closed.set()
            self._request_landing(force=False)

    def _print_instructions(self):
        print("HOVER CHECKOUT: disarmed" if self.args.execute else "RECEPTION ONLY: no flight commands", flush=True)
        print("TAKEOFF TEST + Enter requests one takeoff, up to 3 seconds of hover, then landing.", flush=True)
        print("Esc or X requests LAND without Enter. LAND + Enter and Ctrl+C also request landing.", flush=True)
        print("Takeoff height is firmware-controlled; this test requests landing if measured altitude exceeds 1.5 m.", flush=True)

    def run(self):
        self._print_instructions()
        status = threading.Thread(target=self._publish_status, daemon=True)
        status.start()
        terminal = threading.Thread(target=self._terminal, daemon=True)
        terminal.start()
        try:
            AnafiBridge.run(self)
        finally:
            self.running = False
            self.abort_flight.set()
            self._land()
            terminal.join(timeout=1)
            status.join(timeout=1)
            if self.args.execute and self.takeoff_used:
                # Do not lose the final local result if backend delivery is slow.
                print("RESULT: aircraft confirmed landed" if self.land_confirmed else
                      "RESULT: LANDING UNCONFIRMED; check the aircraft", flush=True)


def main():
    parser = argument_parser()
    parser.description = __doc__
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--hover-seconds", type=float, default=3)
    args = parser.parse_args()
    if args.controller != "direct" or args.demo_flight or args.gimbal_pitch is not None:
        parser.error("This checkout uses direct Pi reception with the controller off; do not combine other flight/gimbal modes")
    if not sys.stdin.isatty():
        parser.error("Run in an interactive Pi SSH terminal")
    if not math.isfinite(args.hover_seconds) or not 1 <= args.hover_seconds <= 3:
        parser.error("Hover duration must be 1-3 seconds")
    import os
    token = os.environ.get("INGEST_TOKEN")
    if args.backend and not token:
        parser.error("Backend integration requires INGEST_TOKEN in the environment")
    args.no_window = args.no_auto_gimbal = args.no_yolo = args.terminal_control = True
    args.checkout_one_segment = False
    bridge = HoverCheckout(args, Publisher(args.out_dir, args.backend, token),
                           FireDetector(args.model, args.conf, use_yolo=False))
    import signal
    def stop(signum, frame):
        bridge._request_landing(force=False)
        bridge.running = False
    for name in ("SIGTERM", "SIGHUP", "SIGINT"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), stop)
    bridge.run()


if __name__ == "__main__":
    main()
