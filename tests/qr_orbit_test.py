"""No-aircraft checks for the opt-in QR orbit. Run with unittest discover."""
from dataclasses import replace
import json
import math
from pathlib import Path
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, str(Path(__file__).parents[1] / "bridge"))
from qr_orbit_core import Limits, Marker, Trigger, Vehicle, LandingConfirmation, fly_once, polygon

TEXT = "EW1:Alpha|120|X|35|M|30|60|31|18|18"
LIMITS = Limits()


def marker(t, **kw):
    """Build a measured-marker fixture with explicit values for the geometry test."""
    return replace(Marker(t, TEXT, 1, 0, 1, 0, .1), **kw)


def vehicle(t, **kw):
    """Build a vehicle-state fixture with controllable freshness and flight fields."""
    return replace(Vehicle(t, True, "hovering", 80, 1, 0, 0), **kw)


class LandingTests(unittest.TestCase):
    def observation(self, now, **changes):
        return dict(now=now,requested_at=10.,state='landed',state_at=10.1,
                    emergency_at=float('-inf'),connected=True,sensors_at=now,
                    roll=0.,pitch=0.,speed=0.) | changes

    def test_requires_continuous_fresh_upright_settle(self):
        gate=LandingConfirmation()
        self.assertFalse(gate.observe(**self.observation(10.2)))
        self.assertFalse(gate.observe(**self.observation(10.4,roll=77.8)))
        self.assertFalse(gate.observe(**self.observation(10.6)))
        self.assertFalse(gate.observe(**self.observation(10.9)))
        self.assertTrue(gate.observe(**self.observation(11.2)))

    def test_stale_landed_events_and_emergency_never_confirm(self):
        for change in ({'state_at':9.}, {'sensors_at':8.}, {'state':'landing'},
                       {'connected':False}, {'speed':.2}, {'roll':float('nan')}):
            gate=LandingConfirmation()
            for at in (10.5,11.5):self.assertFalse(gate.observe(**self.observation(at,**change)))
        gate=LandingConfirmation()
        self.assertFalse(gate.observe(**self.observation(10.2)))
        self.assertFalse(gate.observe(**self.observation(10.4,state='emergency',roll=-176.3)))
        # A later stale/successful landed notification cannot erase the crash.
        self.assertFalse(gate.observe(**self.observation(12.,state_at=11.)))
        self.assertIn('emergency',gate.fault)

    def test_cached_prelanding_or_repeated_sensor_samples_cannot_confirm(self):
        gate=LandingConfirmation()
        self.assertFalse(gate.observe(**self.observation(10.2,sensors_at=10.05)))
        self.assertFalse(gate.observe(**self.observation(10.3,sensors_at=10.2)))
        self.assertFalse(gate.observe(**self.observation(10.9,sensors_at=10.2)))
        self.assertTrue(gate.observe(**self.observation(10.9,sensors_at=10.9)))


class TriggerTests(unittest.TestCase):
    def frames(self, trigger, change=lambda m: m, **kwargs):
        """Supply a timed sequence of marker frames to the recognition gate."""
        return [trigger.observe(change(marker(t)), vehicle(t), t, **kwargs)
                for t in (10.1, 10.3, 10.5, 10.7, 10.95)]

    def test_qr_alone_cannot_start_flight(self):
        """Verify qr alone cannot start flight."""
        t = Trigger(TEXT, LIMITS)
        self.assertFalse(any(self.frames(t)))
        self.assertEqual(t.state, "disarmed")

    def test_armed_stable_target_triggers_once(self):
        """Verify armed stable target triggers once."""
        t = Trigger(TEXT, LIMITS)
        t.arm(10)
        self.assertEqual(self.frames(t), [False]*4+[True])
        self.assertFalse(t.observe(marker(11), vehicle(11), 11))
        with self.assertRaises(ValueError):
            t.arm(11)

    def test_only_the_fire_marker_can_be_selected(self):
        """Verify only the fire marker can be selected."""
        for other in ("EW1:Ravine|300|X|35|M|45|90|31|18|18", TEXT + " ", "https://example.com"):
            with self.assertRaises(ValueError):
                Trigger(other, LIMITS)

    def test_cached_frames_cannot_accumulate_hits(self):
        """Verify cached frames cannot accumulate hits."""
        t = Trigger(TEXT, LIMITS)
        t.arm(10)
        for _ in range(10):
            self.assertFalse(t.observe(marker(10.1), vehicle(10.1), 10.1))
        self.assertEqual(t.hits, 1)

    def test_prearm_or_delayed_frames_are_rejected(self):
        """Verify prearm or delayed frames are rejected."""
        t = Trigger(TEXT, LIMITS)
        t.arm(10)
        self.assertFalse(t.observe(marker(9.9), vehicle(10.1), 10.1))
        self.assertFalse(t.observe(marker(10.1), vehicle(12), 12))
        self.assertEqual(t.hits, 0)

    def test_wrong_marker_pose_and_unknown_values_rejected(self):
        """Verify wrong marker pose and unknown values rejected."""
        for change in (lambda m: replace(m, text="EW1:other"), lambda m: replace(m, right_m=.4),
                       lambda m: replace(m, forward_m=2), lambda m: replace(m, down_m=.1),
                       lambda m: replace(m, floor_tilt_deg=80), lambda m: replace(m, forward_m=float("nan"))):
            t = Trigger(TEXT, LIMITS)
            t.arm(10)
            self.assertFalse(any(self.frames(t, change)))

    def test_landed_low_battery_stale_sensors_or_tilt_rejected(self):
        """Verify landed low battery stale sensors or tilt rejected."""
        for v in (vehicle(11, state="landed"), vehicle(11, battery_pct=30), vehicle(8),
                  vehicle(11, altitude_m=2), vehicle(11, connected=False), vehicle(11, tilt_deg=10),
                  vehicle(11, battery_pct=None), vehicle(11, controller_source_ok=False)):
            t = Trigger(TEXT, LIMITS)
            t.arm(10)
            self.assertFalse(t.observe(marker(11), v, 11))

    def test_expiry_and_cancel_consume_session(self):
        """Verify expiry and cancel consume session."""
        t = Trigger(TEXT, LIMITS)
        t.arm(10)
        self.assertFalse(t.observe(marker(31), vehicle(31), 31))
        self.assertEqual(t.state, "cancelled")
        with self.assertRaises(ValueError):
            t.arm(31)

    def test_rehearsal_can_recognize_on_ground(self):
        """Verify rehearsal can recognize on ground."""
        t = Trigger(TEXT, LIMITS)
        t.arm(10)
        self.assertTrue(t.observe(marker(10.1), None, 10.1, rehearsal=True) is False)
        self.assertEqual(self.frames(t, rehearsal=True)[-1], True)


class FlightTests(unittest.TestCase):
    def test_polygon_centers_on_marker_and_returns_facing_center(self):
        """Verify polygon centers on marker and returns facing center."""
        x = y = yaw = 0
        for dx, dy, dz, turn in polygon(LIMITS):
            x, y = x+dx*math.cos(yaw)-dy*math.sin(yaw), y+dx*math.sin(yaw)+dy*math.cos(yaw)
            yaw += turn
            self.assertAlmostEqual(math.hypot(x-1, y), 1, places=10)
            self.assertAlmostEqual((1-x)*math.sin(yaw)-(-y)*math.cos(yaw), 0, places=10)
            self.assertEqual(dz, 0)
        self.assertAlmostEqual(x, 0, places=10)
        self.assertAlmostEqual(y, 0, places=10)
        self.assertAlmostEqual(yaw, 2*math.pi, places=10)

    def fly(self, fail=None, confirmed=True, one_segment=False):
        """Exercise flight logic against fake moves and a controlled clock, without aircraft access."""
        now, abort, reports, moves = [10.0], threading.Event(), [], []
        class Driver:
            def move(self, offset, speed, check):
                """Record the requested relative move and simulate its result or injected failure."""
                moves.append(offset)
                now[0] += .2
                if fail == "abort":
                    abort.set()
                check()
                if fail == "sdk":
                    raise RuntimeError("move failed")
            def land(self):
                """Record a fake landing attempt and return the fixture confirmation result."""
                return confirmed
        def sample():
            """Return the current fake vehicle/marker sample and any injected fault."""
            if fail == "stale" and moves:
                return vehicle(now[0]-10), marker(now[0])
            if fail == "lost" and moves:
                return vehicle(now[0]), None
            if fail == "drift" and moves:
                return vehicle(now[0]), marker(now[0], forward_m=2)
            if fail == "source" and moves:
                return vehicle(now[0], controller_source_ok=False), marker(now[0])
            return vehicle(now[0]), marker(now[0])
        fly_once(Driver(), LIMITS, TEXT, sample, abort, lambda *x: reports.append(x),
                 clock=lambda: now[0], sleep=lambda n: now.__setitem__(0, now[0]+n), one_segment=one_segment)
        return moves, reports

    def test_one_orbit_then_confirmed_land(self):
        """Verify one orbit then confirmed land."""
        moves, reports = self.fly()
        self.assertEqual(len(moves), 12)
        self.assertEqual(reports[-1][0], "landed")

    def test_abort_lost_marker_stale_sensors_and_sdk_failure_land(self):
        """Verify abort lost marker stale sensors and sdk failure land."""
        for failure in ("abort", "lost", "stale", "sdk", "drift", "source"):
            moves, reports = self.fly(failure)
            self.assertEqual(len(moves), 1)
            self.assertTrue(any(r[0] == "aborted" for r in reports))
            self.assertEqual(reports[-1][0], "landed")

    def test_unconfirmed_landing_is_an_error(self):
        """Verify unconfirmed landing is an error."""
        _, reports = self.fly("abort", confirmed=False)
        self.assertEqual(reports[-1][0], "error")
        self.assertFalse(any(r[0] == "landed" for r in reports))

    def test_checkout_sends_one_chord_then_lands_without_further_segments(self):
        """Verify checkout sends one chord then lands without further segments."""
        moves, reports = self.fly(one_segment=True)
        self.assertEqual(len(moves), 1)
        self.assertAlmostEqual(math.hypot(moves[0][0], moves[0][1]), 2*math.sin(math.pi/12))
        self.assertEqual(reports[0][2:], (1, 1))
        self.assertEqual(reports[-1][0], "landed")

    def test_invalid_settings_rejected(self):
        """Verify invalid settings rejected."""
        for kw in ({"radius_m": 8}, {"height_m": 3}, {"speed_mps": 2}, {"radius_m": float("nan")}):
            with self.assertRaises(ValueError):
                Limits(**kw)


try:
    import cv2
    import numpy as np
    from qr_orbit_pose import CalibratedPose, rotation
except ImportError:
    cv2 = None


@unittest.skipUnless(cv2, "OpenCV/NumPy required for camera geometry checks")
class PoseTests(unittest.TestCase):
    def test_actual_marker_image_decodes_to_selected_payload(self):
        """Verify actual marker image decodes to selected payload."""
        image = cv2.imread(str(Path(__file__).parents[1]/"dist"/"test-marker.png"))
        # The generator's PNG omits its printed white quiet zone.
        image = cv2.copyMakeBorder(image, 100, 100, 100, 100, cv2.BORDER_CONSTANT, value=(255, 255, 255))
        text, corners, _ = cv2.QRCodeDetector().detectAndDecode(image)
        self.assertEqual(text, TEXT)
        self.assertIsNotNone(corners)

    def test_template_cannot_enable_flight(self):
        """Verify template cannot enable flight."""
        with self.assertRaises(ValueError):
            CalibratedPose(Path(__file__).parents[1]/"bridge"/"orbit-calibration.example.json")

    def test_known_projected_floor_target_recovers_metric_position(self):
        """Verify known projected floor target recovers metric position."""
        calibration = {"measured_and_verified": True, "image_size": [1280, 720],
                       "camera_matrix": [[900, 0, 640], [0, 900, 360], [0, 0, 1]],
                       "distortion_coefficients": [0]*5, "camera_offset_body_m": [0, 0, 0],
                       "qr_black_square_side_m": .18}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/"test.json"
            path.write_text(json.dumps(calibration))
            pose = CalibratedPose(path)
        axes = np.array([[0, 0, 1], [1, 0, 0], [0, 1, 0]])
        for yaw in (0, 53, 179):
            wc = rotation(0, -45, yaw) @ axes
            world_target = rotation(0, 0, yaw) @ np.array([1., 0., 1.])
            r, _ = cv2.Rodrigues(wc.T @ np.diag([1., -1., -1.]))
            t = wc.T @ world_target
            points, _ = cv2.projectPoints(pose.object_points, r, t, pose.k, pose.dist)
            m = pose.estimate(TEXT, points, (720, 1280, 3), 10, yaw,
                              {"roll_absolute": 0, "pitch_absolute": -45, "yaw_absolute": yaw})
            self.assertAlmostEqual(m.forward_m, 1, places=4)
            self.assertAlmostEqual(m.right_m, 0, places=4)
            self.assertAlmostEqual(m.down_m, 1, places=4)
        with self.assertRaises(ValueError):
            pose.estimate(TEXT, points, (360, 640, 3), 10, 0, {})


if __name__ == "__main__":
    unittest.main()
