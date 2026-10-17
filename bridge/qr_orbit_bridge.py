#!/usr/bin/env python3
"""Opt-in QR orbit experiment. Default is a grounded, motor-disabled rehearsal.

Never installed by Start BOSCO. See docs/QR_ORBIT_DEMO.md before execution.
"""
import json
import math
import os
from pathlib import Path
import queue
import signal
import sys
import threading
import time

from anafi_bridge import (AnafiBridge, FireDetector, Publisher, argument_parser,
                          olympe, gimbal, AltitudeChanged, AttitudeChanged,
                          SpeedChanged, FlyingStateChanged, Landing)
from olympe.messages.move import extended_move_by
from olympe.messages.ardrone3.PilotingEvent import moveByEnd
from qr_orbit_core import Limits, Marker, Trigger, Vehicle, fly_once, vehicle_reason
from qr_orbit_pose import CalibratedPose


class SensorAges(olympe.EventListener):
    """Use received event ages; repeated cache reads cannot refresh these."""
    def __init__(self, drone):
        super().__init__(drone)
        self.ages = {}
        self.landed_at = float("-inf")

    @olympe.listen_event(AltitudeChanged(_policy="wait"))
    def altitude(self, event, scheduler):
        self.ages["altitude"] = time.monotonic()

    @olympe.listen_event(SpeedChanged(_policy="wait"))
    def speed(self, event, scheduler):
        self.ages["speed"] = time.monotonic()

    @olympe.listen_event(AttitudeChanged(_policy="wait"))
    def attitude(self, event, scheduler):
        self.ages["attitude"] = time.monotonic()

    @olympe.listen_event(gimbal.attitude(_policy="wait"))
    def camera(self, event, scheduler):
        self.ages["camera"] = time.monotonic()

    @olympe.listen_event(FlyingStateChanged(_policy="wait"))
    def flight(self, event, scheduler):
        if getattr(event.args.get("state"), "name", None) == "landed":
            self.landed_at = time.monotonic()


class OlympeOrbitDriver:
    def __init__(self, bridge):
        self.bridge = bridge
        self.first_land_request = None

    def move(self, offset, speed, check):
        # The explicit event expectation filters errors; cached hovering alone
        # cannot acknowledge a new move. No unbounded wait blocks the watchdog.
        dx, dy, dz, yaw = offset
        check()
        event = moveByEnd(error="ok", _policy="wait", _timeout=8)
        pending = self.bridge.drone(extended_move_by(
            dx, dy, dz, yaw, speed, .2, 25, _timeout=8, _no_expect=True) >> event)
        deadline = time.monotonic() + 8
        try:
            while not pending.done():
                check()
                if time.monotonic() >= deadline:
                    raise TimeoutError("relative move timed out")
                time.sleep(.05)
            check()
            if not pending.success():
                raise RuntimeError("aircraft did not acknowledge a successful relative move")
            result = self.bridge.drone.get_state(moveByEnd)
            if (getattr(result["error"], "name", str(result["error"])) != "ok"
                    or any(abs(result[k]-wanted) > tolerance for k, wanted, tolerance in
                           (("dX", dx, .08), ("dY", dy, .08), ("dZ", dz, .08), ("dPsi", yaw, .1)))):
                raise RuntimeError("aircraft-reported displacement differs from the segment")
        except BaseException:
            pending.cancel()  # Cancels expectation only; Landing below interrupts flight.
            raise

    def request_land(self):
        if self.bridge.drone is not None:
            if self.first_land_request is None:
                self.first_land_request = time.monotonic()
            self.bridge.drone(Landing(_no_expect=True))

    def land(self):
        # Keep receiving telemetry and video while awaiting an actual landed
        # event; sending Landing is never reported as proof of landing.
        if self.bridge.drone is None:
            return False
        try:
            landed = self.bridge.drone(FlyingStateChanged(state="landed", _policy="wait", _timeout=20))
        except Exception:
            return False
        deadline, last_send = time.monotonic()+20, 0
        while time.monotonic() < deadline:
            if time.monotonic()-last_send >= 2:
                try:
                    self.request_land()
                except Exception:
                    pass
                last_send = time.monotonic()
            heard = (self.bridge.sensor_ages is not None and self.first_land_request is not None
                     and self.bridge.sensor_ages.landed_at >= self.first_land_request)
            if (landed.success() or heard) and self.bridge.connected and self.bridge.drone.connected:
                landed.cancel()
                return True
            time.sleep(.1)
        landed.cancel()
        return False


class QROrbitBridge(AnafiBridge):
    def __init__(self, args, publisher, detector, pose, limits, marker):
        super().__init__(args, publisher, detector)
        self.pose, self.limits = pose, limits
        self.trigger = Trigger(marker, limits)
        self.marker = None
        self.marker_lock = threading.Lock()
        self.trigger_lock = threading.RLock()
        self.sensor_ages = None
        self.driver = OlympeOrbitDriver(self) if args.execute else None
        self.mission = None
        self.hold_connection = False
        self.land_confirmed = False
        self.last_processed_frame = None
        self.last_pose_log = 0
        self.input_closed = threading.Event()
        self.status_queue = queue.Queue(maxsize=32)

    def _connect(self):
        ok = super()._connect()
        if ok:
            self.sensor_ages = SensorAges(self.drone)
            self.sensor_ages.subscribe()
        return ok

    def _disconnect(self):
        if self.hold_connection and not self.land_confirmed:
            self.abort_flight.set()
            self._land()
        if self.sensor_ages:
            self.sensor_ages.unsubscribe()
            self.sensor_ages = None
        super()._disconnect()

    def _connection_step(self):
        if self.hold_connection:
            # Never destroy/reconnect the aircraft object during an armed session
            # or an unconfirmed landing. Reconnection cannot restart the mission.
            if not self.drone or not self.drone.connected or time.time()-self.last_frame_time > 1.5:
                if not self.abort_flight.is_set():
                    self.trigger.cancel("aircraft/video link lost")
                    self._request_landing()
            if self.drone and self.drone.connected:
                self._poll_telemetry()
            time.sleep(.1)
        else:
            super()._connection_step()

    def sample(self):
        t = self.telemetry or {}
        attitude = t.get("attitude_deg") or {}
        ages = dict(self.sensor_ages.ages) if self.sensor_ages else {}
        oldest = min((ages.get(key, float("-inf")) for key in ("altitude", "speed", "attitude", "camera")))
        vehicle = Vehicle(oldest, bool(self.connected and self.drone and self.drone.connected),
                          t.get("state"), t.get("battery_pct"), t.get("altitude_m"),
                          t.get("ground_speed_mps"),
                          max(abs(attitude.get("roll", float("inf"))), abs(attitude.get("pitch", float("inf")))))
        with self.marker_lock:
            marker = self.marker
        return vehicle, marker

    def _poll_telemetry(self):
        with self.lock:
            super()._poll_telemetry()
            if self.telemetry["extra"]["position_source"] != "gps":
                self.telemetry["latitude"] = self.telemetry["longitude"] = None
                self.telemetry["extra"]["position_source"] = "unavailable; marker-relative demo"

    def _telemetry_loop(self):
        while self.running:
            with self.lock:
                sample = self.telemetry
            if self.connected and sample:
                try:
                    self.publisher.telemetry(sample)
                except Exception:
                    print("[!] Telemetry not delivered; local supervision continues", flush=True)
            time.sleep(1)

    def _overlay_lines(self):
        t = self.telemetry or {}
        return ["QR ORBIT: " + ("LIVE EXPERIMENT" if self.args.execute else "REHEARSAL / MOTORS DISABLED"),
                f"QR session: {self.trigger.state}", f"Battery: {t.get('battery_pct')} %",
                f"Height above takeoff: {t.get('altitude_m')} m", f"State: {t.get('state')}",
                f"GPS: {t.get('extra', {}).get('position_source', 'unknown')}"]

    def _detect_step(self, img, captured):
        if self.last_processed_frame == captured:
            return
        self.last_processed_frame = captured
        hit = self.detector.detect(img)
        marker = None
        if hit and hit.get("source") == "qr-test":
            self.overlay = [{k: hit[k] for k in ("source", "label", "confidence", "bbox")}]
            self.overlay_time = time.time()
            at = time.monotonic() - (time.time()-captured)
            if self.pose is None:
                # Rehearsal pose is deliberately simulated, never flight evidence.
                marker = Marker(at, hit["qr_text"], self.limits.radius_m, 0, self.limits.height_m, 0, 0)
            else:
                try:
                    state = self._state(gimbal.attitude) or {}
                    if 0 in state:
                        state = state[0]
                    yaw = (self.telemetry or {}).get("extra", {}).get("heading_deg")
                    marker = self.pose.estimate(hit["qr_text"], hit["qr_corners"], img.shape, at, yaw, state)
                    if time.monotonic()-self.last_pose_log >= 1:
                        self.last_pose_log = time.monotonic()
                        print(f"[POSE] forward={marker.forward_m:.2f} right={marker.right_m:.2f} "
                              f"down={marker.down_m:.2f} m; floor tilt={marker.floor_tilt_deg:.1f} deg; "
                              f"reprojection={marker.reprojection_px:.2f} px", flush=True)
                except (ValueError, KeyError, TypeError) as error:
                    self.trigger.reason = f"pose unavailable: {error}"
        else:
            self.overlay = []
        if marker is not None:
            with self.marker_lock:
                self.marker = marker
        else:
            # Reset the consecutive recognition streak on a miss, but preserve
            # the last pose until its timestamp expires during an active chord.
            # A single failed decode must not manufacture a brand-new pose.
            with self.trigger_lock:
                if self.trigger.state == "armed":
                    self.trigger.hits, self.trigger.first = 0, None
                    self.trigger.reason = "waiting for stable QR observations"
        # No Gemini response, simulated fire metadata or dashboard button has
        # access to the flight driver. Detection handling never moves the drone.

    def report(self, phase, message, step=None, steps=None):
        prefix = "LIVE EXPERIMENT" if self.args.execute else "REHEARSAL / NO MOTOR COMMANDS"
        try:
            print(f"[{prefix}] {phase}: {message}", flush=True)
        except (OSError, ValueError):
            pass  # A closed operator terminal must not prevent Landing.
        if self.args.execute:
            self.flight_phase = phase
            self.land_confirmed = phase == "landed"
        # A backend outage must never delay a movement watchdog or Landing.
        try:
            self.status_queue.put_nowait((phase, f"{prefix}: {message}", step, steps))
        except queue.Full:
            pass

    def _publish_status(self):
        while self.running:
            try:
                phase, message, step, steps = self.status_queue.get(timeout=.2)
            except queue.Empty:
                continue
            try:
                self.publisher.flight(phase, message, step=step, steps=steps)
            except Exception:
                print("[!] Dashboard status not delivered; local supervision continues", flush=True)

    def _request_landing(self, force=True):
        self.abort_flight.set()
        if force and self.driver and self.connected:
            self.hold_connection = True  # Explicit pilot LAND also works before arming.
        if self.driver and self.hold_connection:
            try:
                self.driver.request_land()
            except Exception:
                print("[!] Landing request not delivered; pilot intervention required", flush=True)

    def _land(self):
        if self.driver and self.hold_connection and not self.land_confirmed:
            self.abort_flight.set()
            if self.mission and self.mission.is_alive() and threading.current_thread() != self.mission:
                self.mission.join(timeout=22)
                if self.mission.is_alive():
                    self.report("error", "flight worker did not stop: pilot intervention required")
                return
            self.report("landing", "operator/shutdown landing request")
            confirmed = self.driver.land()
            self.report("landed" if confirmed else "error", "aircraft confirmed landed" if confirmed else
                        "LANDING UNCONFIRMED: pilot intervention required")

    def _orbit(self):
        fly_once(self.driver, self.limits, self.trigger.expected, self.sample,
                 self.abort_flight, self.report,
                 one_segment=getattr(self.args, "checkout_one_segment", False))

    def _terminal(self):
        arm_phrase = "ARM QR CHECKOUT" if getattr(self.args, "checkout_one_segment", False) else "ARM QR ORBIT"
        try:
            for line in sys.stdin:
                command = line.strip().upper()
                if command in ("LAND", "X", "ABORT"):
                    with self.trigger_lock:
                        self.trigger.cancel()
                    self._request_landing()
                elif command == arm_phrase:
                    if self.args.execute:
                        try:
                            read_preflight(self.args.preflight_file)
                        except (ValueError, KeyError, OSError) as error:
                            print(f"[!] Cannot arm: {error}", flush=True)
                            continue
                        v, _ = self.sample()
                        reason = vehicle_reason(v, self.limits, time.monotonic(), starting=True)
                        if reason:
                            print(f"[!] Cannot arm: {reason}", flush=True)
                            continue
                    try:
                        with self.trigger_lock:
                            self.trigger.arm(time.monotonic())
                        self.hold_connection = self.args.execute
                        self.report("preflight", "armed for 20 seconds; selected QR required")
                    except ValueError as error:
                        print(f"[!] {error}", flush=True)
        finally:
            self.input_closed.set()
            with self.trigger_lock:
                self.trigger.cancel("operator terminal closed")
            self._request_landing(force=False)

    def run(self):
        print("REHEARSAL: motors disabled" if not self.args.execute else "LIVE EXPERIMENT: disarmed", flush=True)
        checkout = getattr(self.args, "checkout_one_segment", False)
        arm_phrase = "ARM QR CHECKOUT" if checkout else "ARM QR ORBIT"
        print("ONE-SEGMENT CHECKOUT, THEN LAND" if checkout else "ONE TWELVE-SEGMENT ORBIT, THEN LAND", flush=True)
        print(f"Type {arm_phrase} once; LAND or X + Enter requests landing. No automatic takeoff.", flush=True)
        threading.Thread(target=self._publish_status, daemon=True).start()
        threading.Thread(target=self._terminal, daemon=True).start()

        def supervise():
            last_reason = None
            while self.running:
                v, m = self.sample()
                with self.trigger_lock:
                    triggered = self.trigger.observe(m, v, time.monotonic(), rehearsal=not self.args.execute)
                if triggered:
                    if self.args.execute:
                        self.mission = threading.Thread(target=self._orbit)
                        self.mission.start()
                    else:
                        count = 1 if checkout else 12
                        self.report("circle", f"selected QR recognized: WOULD fly {count} segment(s), then land (simulated)")
                if self.trigger.reason != last_reason:
                    last_reason = self.trigger.reason
                    print(f"[QR] {last_reason}", flush=True)
                # An armed pilot hover remains pilot-controlled when arming
                # expires; LAND remains available. Never silently re-arm.
                time.sleep(.05)

        threading.Thread(target=supervise, daemon=True).start()
        try:
            super().run()
        finally:
            self.abort_flight.set()
            if self.mission:
                self.mission.join(timeout=23)
            self._land()  # Also covers a broken stdout during the legacy cleanup.


def read_preflight(path):
    c = json.loads(Path(path).read_text(encoding="utf-8"))
    needed = ("cleared_area", "pilot_present", "landing_control_tested_with_pi",
              "marker_on_launch_floor", "calibration_checked_at_known_positions")
    if any(c.get(key) is not True for key in needed):
        raise ValueError("Live orbit requires a completed supervised preflight, including tested landing control")
    # These acknowledgments describe a physical rehearsal, not a software test.
    tested = float(c["checked_at_unix"])
    if not 0 <= time.time()-tested <= 3600:
        raise ValueError("Preflight acknowledgment expired (maximum one hour)")


def main():
    parser = argument_parser()
    parser.description = __doc__
    parser.add_argument("--execute", action="store_true", help="opt in to hardware commands; still requires typed arming")
    parser.add_argument("--checkout-one-segment", action="store_true",
                        help="one chord then land, armed with ARM QR CHECKOUT; uses all the live-flight gates")
    parser.add_argument("--height", type=float, default=1.0, help="pilot-established hover height above launch floor")
    parser.add_argument("--marker-file", default=str(Path(__file__).with_name("orbit-marker.txt")))
    parser.add_argument("--camera-calibration", help="measured intrinsics/extrinsics JSON; required with --execute")
    parser.add_argument("--preflight-file", help="recent physical preflight acknowledgment; required with --execute")
    args = parser.parse_args()
    if args.demo_flight or args.gimbal_pitch is not None:
        parser.error("QR orbit cannot be combined with legacy demo-flight or automatic camera aiming")
    if not sys.stdin.isatty():
        parser.error("Use an interactive pilot terminal; unattended startup is disabled")
    args.no_auto_gimbal, args.no_yolo = True, True
    try:
        limits = Limits(radius_m=args.radius, height_m=args.height)
        marker = Path(args.marker_file).read_text(encoding="utf-8").strip()
        pose = None
        if args.execute:
            if not args.camera_calibration or not args.preflight_file:
                parser.error("--execute requires --camera-calibration and --preflight-file")
            read_preflight(args.preflight_file)
        if args.camera_calibration:
            pose = CalibratedPose(args.camera_calibration, require_verified=args.execute)
    except (ValueError, KeyError, OSError) as error:
        parser.error(str(error))
    token = os.environ.get("INGEST_TOKEN")
    if args.backend and not token:
        parser.error("Backend integration requires INGEST_TOKEN in the environment")
    bridge = QROrbitBridge(args, Publisher(args.out_dir, args.backend, token),
                           FireDetector(args.model, args.conf, use_yolo=False), pose, limits, marker)
    def stop_on_signal(signum, frame):
        bridge.running = False  # Main loop exits into the bounded landing cleanup.
    for name in ("SIGTERM", "SIGHUP"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), stop_on_signal)
    bridge.run()


if __name__ == "__main__":
    main()
