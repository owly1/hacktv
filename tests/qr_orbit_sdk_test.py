"""SDK binding checks with a fake aircraft. Never connects or sends over a radio.

Run on the Pi inside the installed Olympe environment. Skips without Olympe.
"""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1]/"bridge"))
HAS_SDK = importlib.util.find_spec("olympe") is not None
if HAS_SDK:
    from qr_orbit_bridge import OlympeOrbitDriver, QROrbitBridge, read_preflight
    from qr_orbit_core import Limits


@unittest.skipUnless(HAS_SDK, "Run inside the Pi's Olympe environment")
class AdapterTests(unittest.TestCase):
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
