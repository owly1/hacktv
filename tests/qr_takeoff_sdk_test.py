"""Full QR handoff checks with a fake aircraft; guarded against radio access."""
import importlib.util
from pathlib import Path
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parents[1]/"bridge"))
HAS_SDK = importlib.util.find_spec("olympe") is not None
if HAS_SDK:
    import qr_takeoff_demo
    from anafi_bridge import AnafiBridge
    from qr_orbit_core import Limits, Marker, fly_once
    from qr_takeoff_demo import QRTakeoffDemo

TEXT = "EW1:Alpha|120|X|35|M|30|60|31|18|18"


@unittest.skipUnless(HAS_SDK, "Run inside the Pi Olympe environment")
class QRTakeoffTests(unittest.TestCase):
    def make_bridge(self, execute=True, full_orbit=False):
        args = SimpleNamespace(ip=None, controller="direct", home_lat=0, home_lon=0,
                               execute=execute, terminal_control=True, full_orbit=full_orbit,
                               checkout_one_segment=not full_orbit, hover_seconds=1,
                               preflight_file="unit-test-only.json")
        return QRTakeoffDemo(args, SimpleNamespace(), SimpleNamespace(), object(), Limits(), TEXT)

    def fly(self, full=False, wrong_pose=False, interrupt=False):
        bridge = self.make_bridge(full_orbit=full)
        now, sends, movements, lands = [100.0], [], [], []
        bridge.connected = True
        bridge.sensor_ages = SimpleNamespace(ages={key: now[0] for key in ("altitude", "speed", "attitude", "camera")})
        bridge.last_frame_time = time.time()
        bridge.telemetry = {"state": "landed", "battery_pct": 70, "altitude_m": 0,
                            "ground_speed_mps": 0, "attitude_deg": {"roll": 0, "pitch": 6.7}}
        def advance(seconds):
            now[0] += seconds
            bridge.sensor_ages.ages = {key: now[0] for key in ("altitude", "speed", "attitude", "camera")}
            bridge.last_frame_time = time.time()
            elapsed = now[0]-100
            bridge.telemetry["state"] = "motor_ramping" if elapsed < .25 else "takingoff" if elapsed < .5 else "hovering"
            if elapsed >= .5:
                bridge.telemetry.update(altitude_m=1, attitude_deg={"roll": 0, "pitch": 0})
            bridge.marker = Marker(now[0]-.001, TEXT, .5 if wrong_pose else 1, 0, 1, 0, 0)
        def receive(message):
            sends.append(str(message))
            bridge.telemetry["state"] = "motor_ramping"
            return SimpleNamespace(done=lambda: True, success=lambda: True, cancel=lambda: None)
        # The sole SDK object remains the same from TakeOff through landing.
        aircraft = Mock(connected=True, side_effect=receive)
        bridge.drone = aircraft
        class Driver:
            def request_land(self):
                lands.append("request")
            def move(self, offset, speed, check):
                self_outer.assertIs(bridge.drone, aircraft)
                movements.append(offset)
                advance(.5)
                if interrupt:
                    bridge.abort_flight.set()
                check()
            def land(self):
                self_outer.assertIs(bridge.drone, aircraft)
                lands.append("confirmed")
                bridge.telemetry["state"] = "landed"
                return True
        self_outer = self
        bridge.driver = Driver()
        def orbit(*args, **kwargs):
            return fly_once(*args, **kwargs, clock=lambda: now[0], sleep=advance)
        with patch("qr_takeoff_demo.read_preflight"), \
             patch("qr_takeoff_demo.time.monotonic", side_effect=lambda: now[0]), \
             patch("qr_takeoff_demo.time.sleep", side_effect=advance), \
             patch("qr_orbit_bridge.fly_once", side_effect=orbit):
            bridge._hover()
        return bridge, sends, movements, lands

    def test_same_connection_takeoff_qr_one_chord_and_confirmed_land(self):
        bridge, sends, movements, lands = self.fly()
        self.assertEqual(len(sends), 1)
        self.assertIn("TakeOff", sends[0])
        self.assertEqual(len(movements), 1)
        self.assertEqual(lands, ["confirmed"])
        self.assertTrue(bridge.land_confirmed)
        self.assertFalse(bridge.running)

    def test_full_orbit_requires_explicit_selection(self):
        bridge, sends, movements, lands = self.fly(full=True)
        self.assertEqual(bridge.start_phrase, "START QR ORBIT")
        self.assertEqual(len(sends), 1)
        self.assertEqual(len(movements), 12)
        self.assertEqual(lands, ["confirmed"])

    def test_half_metre_marker_cannot_start_a_one_metre_orbit(self):
        bridge, sends, movements, lands = self.fly(wrong_pose=True)
        self.assertEqual(len(sends), 1)
        self.assertEqual(movements, [])
        self.assertEqual(bridge.trigger.state, "cancelled")
        self.assertEqual(lands[-1], "confirmed")
        self.assertTrue(any("arming expired" in entry[1] for entry in list(bridge.status_queue.queue)))

    def test_operator_interrupt_during_first_chord_prevents_remaining_orbit(self):
        bridge, sends, movements, lands = self.fly(full=True, interrupt=True)
        self.assertEqual(len(movements), 1)
        self.assertEqual(lands[-1], "confirmed")
        self.assertTrue(bridge.land_confirmed)

    def test_no_execute_has_no_driver_and_start_phrase_cannot_take_off(self):
        bridge = self.make_bridge(execute=False)
        bridge.drone = Mock()
        with patch("qr_takeoff_demo.terminal_commands", return_value=iter([bridge.start_phrase])):
            bridge._terminal()
        bridge.drone.assert_not_called()
        self.assertIsNone(bridge.driver)
        self.assertIsNone(bridge.mission)

    def test_missing_physical_landing_record_blocks_takeoff(self):
        bridge = self.make_bridge()
        bridge.drone = Mock()
        with patch("qr_takeoff_demo.read_preflight", side_effect=ValueError("terminal landing is untested")), \
             patch("qr_takeoff_demo.terminal_commands", return_value=iter([bridge.start_phrase])):
            bridge._terminal()
        bridge.drone.assert_not_called()
        self.assertIsNone(bridge.mission)

    def test_missing_calibration_rejected_before_aircraft_construction(self):
        with patch.object(sys, "argv", ["qr_takeoff_demo.py", "--execute"]), \
             patch.object(sys.stdin, "isatty", return_value=True), \
             patch.object(qr_takeoff_demo, "QRTakeoffDemo") as factory, \
             self.assertRaises(SystemExit) as error:
            qr_takeoff_demo.main()
        self.assertEqual(error.exception.code, 2)
        factory.assert_not_called()

    def test_native_video_keeps_calibration_pixels_and_default_keeps_cap(self):
        import cv2
        import numpy as np
        for width, expected in ((0, (720, 1280)), (960, (540, 960))):
            args = SimpleNamespace(ip=None, controller="direct", home_lat=0, home_lon=0,
                                   video_fps=15, video_width=width)
            bridge = AnafiBridge(args, SimpleNamespace(), SimpleNamespace())
            bridge.connected = True
            bridge.latest_bgr = (np.zeros((720, 1280, 3), dtype=np.uint8), time.time())
            sizes = []
            def receive(jpeg, captured, overlay):
                sizes.append(cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR).shape[:2])
                bridge.running = False
            bridge.publisher = SimpleNamespace(frame=receive)
            with patch("anafi_bridge.time.sleep"):
                bridge._video_loop()
            self.assertEqual(sizes, [expected])


if __name__ == "__main__":
    unittest.main()
