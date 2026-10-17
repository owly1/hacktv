"""SDK binding checks with a fake aircraft. Never connects or sends over a radio.

Run on the Pi inside the installed Olympe environment. Skips without Olympe.
"""
import importlib.util
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parents[1]/"bridge"))
HAS_SDK = importlib.util.find_spec("olympe") is not None
if HAS_SDK:
    import qr_orbit_bridge
    from anafi_bridge import AnafiBridge
    from qr_orbit_bridge import OlympeOrbitDriver, QROrbitBridge, read_preflight
    from qr_orbit_core import Limits
    from hover_checkout import HoverCheckout


@unittest.skipUnless(HAS_SDK, "Run inside the Pi's Olympe environment")
class AdapterTests(unittest.TestCase):
    def controller_args(self, mode="skycontroller3"):
        return SimpleNamespace(ip=None, controller=mode, home_lat=0, home_lon=0,
                               gimbal_pitch=None, execute=False)

    def test_skycontroller_class_and_default_ip_without_piloting_commands(self):
        drone = Mock(connected=True)
        drone.connect.return_value = drone.drone_connection_state.return_value = True
        bridge = AnafiBridge(self.controller_args(), SimpleNamespace(), SimpleNamespace())
        with patch("anafi_bridge.olympe.SkyController3", return_value=drone) as factory, \
             patch("anafi_bridge.olympe.Anafi", side_effect=AssertionError("wrong SDK class")), \
             patch.object(bridge, "_start_video", return_value=True):
            self.assertTrue(bridge._connect())
        factory.assert_called_once_with("192.168.53.1")
        self.assertTrue(bridge._aircraft_link())
        drone.assert_not_called()  # No piloting-source, joystick, gimbal or flight commands.

    def test_controller_connection_without_paired_aircraft_is_not_a_drone_link(self):
        drone = Mock(connected=True)
        drone.connect.return_value = True
        drone.drone_connection_state.return_value = False
        bridge = AnafiBridge(self.controller_args(), SimpleNamespace(), SimpleNamespace())
        with patch("anafi_bridge.olympe.SkyController3", return_value=drone), \
             patch("anafi_bridge.time.monotonic", side_effect=[0, 9]), \
             patch.object(bridge, "_start_video") as video:
            self.assertFalse(bridge._connect())
        video.assert_not_called()
        drone.disconnect.assert_called_once()
        drone.destroy.assert_called_once()
        drone.assert_not_called()

    def test_physical_controller_source_must_be_explicitly_reported(self):
        bridge = QROrbitBridge(self.controller_args(), SimpleNamespace(), SimpleNamespace(), None, Limits(),
                               "EW1:Alpha|120|X|35|M|30|60|31|18|18")
        for state, accepted in ((None, False), ({"source": "Controller"}, False),
                                ({"source": SimpleNamespace(name="SkyController")}, True)):
            with patch.object(bridge, "_state", return_value=state):
                self.assertEqual(bridge._controller_source_ok(), accepted)
        bridge.controller_kind = "direct"
        with patch.object(bridge, "_state", return_value={"source": "SkyController"}):
            self.assertFalse(bridge._controller_source_ok())

    def test_live_direct_mode_rejected_before_aircraft_construction(self):
        with patch.object(sys, "argv", ["qr_orbit_bridge.py", "--execute"]), \
             patch.object(qr_orbit_bridge, "QROrbitBridge") as factory, \
             contextlib.redirect_stderr(io.StringIO()) as output, \
             self.assertRaises(SystemExit) as exit:
            qr_orbit_bridge.main()
        self.assertEqual(exit.exception.code, 2)
        self.assertIn("requires --controller skycontroller3", output.getvalue())
        factory.assert_not_called()

    def test_terminal_mode_requires_its_own_landing_record(self):
        import time
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/"preflight.json"
            record = {key: True for key in ("cleared_area", "pilot_present", "landing_control_tested_with_pi",
                                           "marker_on_launch_floor", "calibration_checked_at_known_positions")}
            record["checked_at_unix"] = time.time()
            path.write_text(json.dumps(record))
            with self.assertRaises(ValueError):
                read_preflight(path, terminal_control=True)
            record.update(terminal_landing_tested_with_pi=True, controller_powered_off=True)
            path.write_text(json.dumps(record))
            read_preflight(path, terminal_control=True)

    def test_terminal_land_key_uses_existing_driver_before_any_report(self):
        args = self.controller_args(mode="direct")
        args.execute = True
        bridge = QROrbitBridge(args, SimpleNamespace(), SimpleNamespace(), None, Limits(),
                               "EW1:Alpha|120|X|35|M|30|60|31|18|18")
        bridge.connected = True
        order = []
        bridge.driver = SimpleNamespace(request_land=lambda: order.append("LAND"))
        with patch("qr_orbit_bridge.terminal_commands", return_value=iter(["LAND"])):
            bridge._terminal()
        self.assertTrue(bridge.abort_flight.is_set())
        self.assertTrue(bridge.input_closed.is_set())
        self.assertEqual(order[0], "LAND")

    def test_hover_checkout_has_no_horizontal_or_qr_commands(self):
        args = self.controller_args(mode="direct")
        args.execute, args.terminal_control, args.hover_seconds = True, True, 1
        bridge = HoverCheckout(args, SimpleNamespace(), SimpleNamespace())
        calls, now = [], [0.0]
        pending = SimpleNamespace(done=lambda: True, success=lambda: True, cancel=lambda: None)
        bridge.connected = True
        bridge.last_frame_time = time.time()
        bridge.sensor_ages = SimpleNamespace(ages={key: now[0] for key in ("altitude", "speed", "attitude")})
        bridge.telemetry = {"state": "landed", "battery_pct": 50, "altitude_m": 0,
                            "ground_speed_mps": 0, "attitude_deg": {"roll": 0, "pitch": 6.7}}
        def receive(message):
            calls.append(message)
            bridge.telemetry["state"] = "motor_ramping"
            return pending
        bridge.drone = receive
        def advance(seconds):
            now[0] += seconds
            bridge.sensor_ages.ages = {key: now[0] for key in ("altitude", "speed", "attitude")}
            bridge.telemetry["state"] = "motor_ramping" if now[0] < .25 else "takingoff" if now[0] < .5 else "hovering"
            if now[0] >= .5:
                bridge.telemetry.update(altitude_m=1, attitude_deg={"roll": 0, "pitch": 0})
        with patch.object(bridge, "_aircraft_link", return_value=True), \
             patch.object(bridge, "_land") as land, \
             patch("hover_checkout.time.monotonic", side_effect=lambda: now[0]), \
             patch("hover_checkout.time.sleep", side_effect=advance):
            bridge._hover()
        self.assertEqual(len(calls), 1)  # TakeOff only; mocked landing tested separately.
        self.assertIn("TakeOff", str(calls[0]))
        self.assertGreaterEqual(now[0], 1.5)  # The full hover completed after startup.
        messages = [entry[1] for entry in list(bridge.status_queue.queue)]
        self.assertTrue(any("'motor_ramping'" in message for message in messages))
        self.assertFalse(any("unexpected flight state" in message for message in messages))
        land.assert_called_once()

    def test_hover_checkout_abort_before_takeoff_never_sends_takeoff(self):
        args = self.controller_args(mode="direct")
        args.execute, args.terminal_control, args.hover_seconds = True, True, 1
        bridge = HoverCheckout(args, SimpleNamespace(), SimpleNamespace())
        bridge.drone = Mock()
        bridge.abort_flight.set()
        with patch.object(bridge, "checkout_reason", return_value=None), \
             patch.object(bridge, "_land") as land:
            bridge._hover()
        self.assertTrue(all("Landing" in str(call.args[0]) for call in bridge.drone.call_args_list))
        land.assert_called_once()

    def test_hover_checkout_resting_attitude_is_separate_from_airborne_limit(self):
        import time
        bridge = HoverCheckout(self.controller_args(mode="direct"), SimpleNamespace(), SimpleNamespace())
        bridge.connected = True
        bridge.sensor_ages = SimpleNamespace(ages={key: time.monotonic() for key in ("altitude", "speed", "attitude")})
        bridge.last_frame_time = time.time()
        bridge.telemetry = {"state": "landed", "battery_pct": 50, "altitude_m": 0,
                            "ground_speed_mps": 0, "attitude_deg": {"roll": .9, "pitch": 14.4}}
        with patch.object(bridge, "_aircraft_link", return_value=True):
            self.assertIsNone(bridge.checkout_reason(starting=True))
            bridge.telemetry.update(state="takingoff", altitude_m=.3)
            self.assertIsNone(bridge.checkout_reason())
            bridge.telemetry.update(state="motor_ramping", altitude_m=0)
            self.assertIsNone(bridge.checkout_reason())
            self.assertIn("grounded", bridge.checkout_reason(starting=True))
            bridge.telemetry.update(state="hovering", altitude_m=1)
            self.assertIn("maximum 10 in hovering", bridge.checkout_reason())
            bridge.telemetry["attitude_deg"]["pitch"] = 0
            self.assertIsNone(bridge.checkout_reason())
            self.assertIn("grounded", bridge.checkout_reason(starting=True))
            bridge.telemetry.update(state="landed", altitude_m=0)
            bridge.telemetry["attitude_deg"]["pitch"] = 21
            self.assertIn("maximum 20 in landed", bridge.checkout_reason(starting=True))
            bridge.telemetry["attitude_deg"]["pitch"] = 0
            for state in ("landing", "emergency", "emergency_landing", "usertakeoff", "unknown", None):
                bridge.telemetry["state"] = state
                self.assertEqual(bridge.checkout_reason(), f"unexpected flight state: {state!r}")
        self.assertIsNone(bridge.driver)

    def test_landing_keys_after_confirmed_landing_do_not_restart_cleanup(self):
        args = self.controller_args(mode="direct")
        args.execute = True
        bridge = HoverCheckout(args, SimpleNamespace(), SimpleNamespace())
        bridge.connected = bridge.land_confirmed = True
        bridge.driver = Mock()
        with patch("hover_checkout.terminal_commands", return_value=iter(["LAND"])):
            bridge._terminal()
        bridge.driver.request_land.assert_not_called()
        self.assertTrue(bridge.land_confirmed)

    def test_reports_do_not_write_to_terminal_from_flight_worker(self):
        bridge = HoverCheckout(self.controller_args(mode="direct"), SimpleNamespace(), SimpleNamespace())
        with patch("builtins.print", side_effect=AssertionError("flight worker must not print")):
            bridge.report("landing", "test")
        self.assertEqual(bridge.status_queue.get_nowait()[:1], ("landing",))

    def setup_fake(self):
        pending = SimpleNamespace(done=lambda: False, success=lambda: False,
                                  cancel=lambda: setattr(self, "cancelled", True))
        self.calls, self.cancelled, self.now = [], False, 10.0
        class Drone:
            connected = True
            def __call__(_, message):
                self.calls.append(message)
                return pending
        bridge = SimpleNamespace(drone=Drone(), connected=True,
                                 sensor_ages=SimpleNamespace(landed_at=float("-inf")))
        return OlympeOrbitDriver(bridge), bridge

    def test_abort_is_checked_before_issuing_move(self):
        driver, _ = self.setup_fake()
        def abort():
            raise InterruptedError("operator stop")
        with self.assertRaises(InterruptedError):
            driver.move((.1, -.5, 0, .5), .25, abort)
        self.assertEqual(self.calls, [])

    def test_bounded_move_is_interruptible_without_blocking_wait(self):
        driver, _ = self.setup_fake()
        checks = [0]
        def abort():
            checks[0] += 1
            if checks[0] > 1:
                raise InterruptedError("operator stop")
        with self.assertRaises(InterruptedError):
            driver.move((.1, -.5, 0, .5), .25, abort)
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(self.cancelled)

    def test_landing_requires_a_received_landed_event(self):
        driver, bridge = self.setup_fake()
        def sleep(seconds):
            self.now += seconds
        with patch("qr_orbit_bridge.time.monotonic", side_effect=lambda: self.now), \
             patch("qr_orbit_bridge.time.sleep", side_effect=sleep):
            self.assertFalse(driver.land())
        self.assertTrue(self.cancelled)
        self.assertGreater(len(self.calls), 1)  # Landing retries, no real aircraft.
        # A fresh landed event after the first request permits confirmation.
        bridge.sensor_ages.landed_at = self.now
        with patch("qr_orbit_bridge.time.monotonic", side_effect=lambda: self.now), \
             patch("qr_orbit_bridge.time.sleep", side_effect=sleep):
            self.assertTrue(driver.land())

    def test_rehearsal_never_constructs_a_flight_driver(self):
        args = SimpleNamespace(ip="192.168.42.1", home_lat=0, home_lon=0, execute=False)
        with patch("qr_orbit_bridge.OlympeOrbitDriver", side_effect=AssertionError("flight driver forbidden")):
            bridge = QROrbitBridge(args, SimpleNamespace(), SimpleNamespace(), None, Limits(),
                                   "EW1:Alpha|120|X|35|M|30|60|31|18|18")
            self.assertIsNone(bridge.driver)
            bridge._land()  # No landing command in rehearsal, even on shutdown.
            with patch("builtins.print", side_effect=BrokenPipeError):
                bridge.report("landing", "a lost stdout cannot block cleanup")
            self.assertFalse(bridge.status_queue.empty())

    def test_incomplete_or_old_physical_preflight_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/"preflight.json"
            path.write_text('{}')
            with self.assertRaises(ValueError):
                read_preflight(path)
            c = {key: True for key in ("cleared_area", "pilot_present", "landing_control_tested_with_pi",
                                       "marker_on_launch_floor", "calibration_checked_at_known_positions")}
            c["checked_at_unix"] = 1
            path.write_text(json.dumps(c))
            with self.assertRaises(ValueError):
                read_preflight(path)


if __name__ == "__main__":
    unittest.main()
