"""Preset integration checks with fake SDK objects; never opens an aircraft link."""
import contextlib
import importlib.util
import io
from pathlib import Path
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parents[1]/"bridge"))
HAS_SDK = importlib.util.find_spec("olympe") is not None
if HAS_SDK:
    import qr_preset_demo
    from qr_orbit_core import Limits
    from qr_preset_core import Recognition
    from qr_preset_demo import QRPresetDemo

TEXT = "EW1:Alpha|120|X|35|M|30|60|31|18|18"


@unittest.skipUnless(HAS_SDK, "Run in the installed Pi Olympe environment")
class PresetSDKTests(unittest.TestCase):
    def make_bridge(self, execute=True):
        args = SimpleNamespace(ip=None, controller="direct", home_lat=0, home_lon=0,
                               execute=execute, terminal_control=True, hover_seconds=1, hold_seconds=30)
        return QRPresetDemo(args, SimpleNamespace(), SimpleNamespace(), Limits(mission_seconds=90), TEXT)

    def fly(self, stop=None):
        bridge = self.make_bridge()
        now, sends, moves, land_requests, lands = [100.0], [], [], [], []
        bridge.connected = True
        bridge.telemetry = {"state": "landed", "battery_pct": 70, "altitude_m": 0,
                            "ground_speed_mps": 0, "attitude_deg": {"roll": 0, "pitch": 6.7}}
        bridge.sensor_ages = SimpleNamespace(ages={key: now[0] for key in ("altitude", "speed", "attitude")})
        bridge.last_frame_time = time.time()
        def advance(seconds):
            now[0] += seconds
            bridge.sensor_ages.ages = {key: now[0] for key in ("altitude", "speed", "attitude")}
            bridge.last_frame_time = time.time()
            if bridge.flight_started is not None:
                elapsed = now[0]-bridge.flight_started
                bridge.telemetry["state"] = "motor_ramping" if elapsed < .25 else "takingoff" if elapsed < .5 else "hovering"
                if elapsed >= .5:
                    bridge.telemetry.update(altitude_m=1, attitude_deg={"roll": 0, "pitch": 0})
                # Losing QR after recognition must not invent tracking/pose data.
                bridge.observation = None
            if stop == "hover" and bridge.flight_phase == "return":
                bridge._request_landing(force=False)
        def receive(message):
            sends.append(str(message))
            bridge.telemetry["state"] = "motor_ramping"
            return SimpleNamespace(done=lambda: True, success=lambda: True, cancel=lambda: None)
        aircraft = Mock(connected=True, side_effect=receive)
        bridge.drone = bridge.armed_drone = aircraft
        class Driver:
            def request_land(self):
                land_requests.append(now[0])
            def move(self, offset, speed, check):
                self_outer.assertIs(bridge.drone, aircraft)
                moves.append(offset)
                advance(.5)
                if stop == "circle":
                    bridge._request_landing(force=False)
                check()
            def land(self):
                lands.append(now[0])
                bridge.telemetry["state"] = "landed"
                return True
        self_outer = self
        bridge.driver = Driver()
        class InlineWorker:
            def __init__(self, target):
                self.target = target
            def start(self):
                self.target()
            def is_alive(self):
                return False
        bridge.trigger.arm(now[0])
        with patch("qr_preset_demo.time.monotonic", side_effect=lambda: now[0]), \
             patch("qr_preset_demo.time.sleep", side_effect=advance), \
             patch("qr_preset_demo.threading.Thread", InlineWorker):
            for delta in (.1, .2, .2, .2, .25):
                advance(delta)
                bridge.observation = Recognition(now[0], TEXT)
                bridge._supervise_once()
            # Subsequent scans cannot repeat the flight.
            bridge._supervise_once()
        return bridge, sends, moves, land_requests, lands

    def test_qr_triggers_takeoff_circle_hover_timeout_and_single_landing(self):
        bridge, sends, moves, requests, lands = self.fly()
        self.assertEqual(len(sends), 1)
        self.assertIn("TakeOff", sends[0])
        self.assertEqual(len(moves), 12)
        self.assertEqual(len(lands), 1)
        self.assertEqual(requests, [])
        self.assertTrue(bridge.land_confirmed)
        self.assertFalse(bridge.running)

    def test_x_during_circle_or_hold_sends_land_and_no_remaining_movement(self):
        for stop, count in (("circle", 1), ("hover", 12)):
            bridge, sends, moves, requests, lands = self.fly(stop)
            self.assertEqual(len(moves), count)
            self.assertTrue(requests)
            self.assertEqual(len(lands), 1)
            self.assertTrue(bridge.land_confirmed)

    def test_rehearsal_recognition_does_not_create_a_flight_worker(self):
        bridge = self.make_bridge(execute=False)
        bridge.drone = Mock()
        bridge.trigger.arm(10)
        for at in (10.1, 10.3, 10.5, 10.7, 10.95):
            bridge.observation = Recognition(at, TEXT)
            with patch("qr_preset_demo.time.monotonic", return_value=at):
                bridge._supervise_once()
        self.assertEqual(bridge.trigger.state, "triggered")
        self.assertIsNone(bridge.driver)
        self.assertIsNone(bridge.mission)
        bridge.drone.assert_not_called()

    def test_connection_change_consumes_arming_without_takeoff(self):
        bridge = self.make_bridge()
        bridge.drone = Mock()
        bridge.armed_drone = Mock()
        bridge.trigger.arm(10)
        with patch.object(bridge, "checkout_reason", return_value=None):
            bridge._supervise_once()
        self.assertEqual(bridge.trigger.state, "cancelled")
        bridge.drone.assert_not_called()

    def test_grounded_x_cancels_without_sending_a_motor_or_landing_command(self):
        bridge = self.make_bridge()
        bridge.connected = True
        bridge.drone, bridge.driver = Mock(), Mock()
        bridge.telemetry = {"state": "landed"}
        with patch("qr_preset_demo.terminal_commands", return_value=iter(["LAND"])):
            bridge._terminal()
        bridge.drone.assert_not_called()
        bridge.driver.request_land.assert_not_called()
        self.assertEqual(bridge.trigger.state, "cancelled")

    def test_preset_main_has_no_camera_or_preflight_file_requirement(self):
        for flags, live in (([], False), (["--execute"], True)):
            with patch.object(sys, "argv", ["qr_preset_demo.py", *flags]), \
                 patch.object(sys.stdin, "isatty", return_value=True), \
                 patch.object(qr_preset_demo, "QRPresetDemo") as factory, \
                 patch.object(qr_preset_demo, "Publisher"), \
                 patch.object(qr_preset_demo, "FireDetector"), \
                 patch.object(qr_preset_demo.signal, "signal"):
                qr_preset_demo.main()
            self.assertEqual(factory.call_args.args[0].execute, live)
            factory.return_value.run.assert_called_once()

    def test_unbounded_hover_is_rejected_before_constructing_a_runtime(self):
        with patch.object(sys, "argv", ["qr_preset_demo.py", "--hold-seconds", "999"]), \
             patch.object(sys.stdin, "isatty", return_value=True), \
             patch.object(qr_preset_demo, "QRPresetDemo") as factory, \
             contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            qr_preset_demo.main()
        factory.assert_not_called()


if __name__ == "__main__":
    unittest.main()
