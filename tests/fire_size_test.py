"""Indoor fire-size geometry with fake feedback; never imports the aircraft SDK."""
from dataclasses import replace
import math
from pathlib import Path
import sys
import threading
import unittest

sys.path.insert(0, str(Path(__file__).parents[1] / 'bridge'))
from fire_detection import FIRE_MARKER_PAYLOAD, parse_marker
from qr_circle_core import circle, fire_size_radius
from qr_orbit_core import Limits, Marker, Vehicle


class FireSizeTests(unittest.TestCase):
    def test_hectares_scale_monotonically_and_cap_indoor_distance(self):
        """Verify representative areas, units, cap and the actual selected QR."""
        for area, expected in ((30, 1.125), (120, 1.25), (480, 1.5), (1000, 1.5)):
            self.assertAlmostEqual(fire_size_radius(area), expected)
        self.assertEqual(fire_size_radius(parse_marker(FIRE_MARKER_PAYLOAD)['area_ha']), 1.25)
        radii = [fire_size_radius(area) for area in range(1, 1000)]
        self.assertEqual(radii, sorted(radii))
        self.assertTrue(all(1 < r <= 1.5 for r in radii))

    def test_bad_area_never_produces_a_flight_distance(self):
        """Reject missing, nonnumeric, nonfinite, nonpositive or unbounded area."""
        for value in (None, True, '120', 0, -1, float('nan'), float('inf'), 10000001):
            with self.subTest(value=value), self.assertRaises(ValueError):
                fire_size_radius(value)

    def flight(self, area=120, fault=None, initial=1., right=0.):
        """Simulate body-frame moves and fresh measured poses with a controlled clock."""
        now = [100.]
        marker = [Marker(100., FIRE_MARKER_PAYLOAD, initial, right, 1., 0., 0.)]
        abort = threading.Event()
        moves, events = [], []
        limits = Limits(radius_m=fire_size_radius(area), segments=24, mission_seconds=90)

        def advance(seconds):
            """Advance time; optionally freeze camera timestamps after the first command."""
            now[0] += seconds
            if marker[0] is not None and not (fault == 'cached' and moves):
                marker[0] = replace(marker[0], at=now[0]-.001)

        def sample():
            """Supply fresh hover telemetry or inject an airborne health fault."""
            v = Vehicle(now[0], True, 'hovering', 70, 1., 0., 0.)
            if moves and fault == 'battery':
                v = replace(v, battery_pct=20)
            if moves and fault == 'link':
                v = replace(v, connected=False)
            return v, marker[0]

        class Driver:
            def move(self, offset, speed, check):
                """Apply the actual offset/rotation to the fake pose, including failure cases."""
                check()
                moves.append((offset, speed))
                if fault == 'rejected':
                    raise RuntimeError('move rejected')
                if fault != 'no-motion':
                    x, y = marker[0].forward_m-offset[0], marker[0].right_m-offset[1]
                    yaw = offset[3]
                    marker[0] = replace(marker[0], forward_m=x*math.cos(yaw)+y*math.sin(yaw),
                                        right_m=-x*math.sin(yaw)+y*math.cos(yaw))
                advance(.4)
                if fault == 'cancel':
                    abort.set()
                if fault == 'lost':
                    marker[0] = None
                if fault == 'tilted':
                    marker[0] = replace(marker[0], floor_tilt_deg=30)
                check()

        circle(Driver(), limits, FIRE_MARKER_PAYLOAD, sample, abort,
               lambda *event: events.append(event), clock=lambda: now[0], sleep=advance, fire_size=True)
        return moves, events, marker[0]

    def test_current_qr_retreats_25cm_then_orbits_at_125cm(self):
        """Measure the retreat and resulting radius, rather than checking only command count."""
        moves, events, marker = self.flight()
        retreat = [offset for offset, speed in moves if speed == .15]
        self.assertEqual(len(retreat), 2)
        self.assertAlmostEqual(sum(-m[0] for m in retreat), .25)
        self.assertTrue(all(m[0] < 0 and math.hypot(*m[:2]) <= .201 for m in retreat))
        self.assertEqual(len([e for e in events if e[0] == 'circle']), 24)
        self.assertAlmostEqual(marker.forward_m, 1.25)
        self.assertAlmostEqual(marker.right_m, 0)
        self.assertTrue(all(offset[2] == 0 for offset, _ in moves))

    def test_size_changes_retreat_and_larger_circle_geometry(self):
        """Simulated area cases exercise actual measured retreat and the complete lap."""
        for area, distance in ((30, .125), (120, .25), (480, .5), (1000, .5)):
            with self.subTest(area=area):
                moves, _, marker = self.flight(area)
                self.assertAlmostEqual(sum(-m[0] for m, speed in moves if speed == .15), distance)
                self.assertAlmostEqual(marker.forward_m, 1+distance)
                self.assertTrue(all(math.hypot(*m[:2]) <= .5 for m, _ in moves))

    def test_offset_qr_retreat_is_radial_and_camera_facing(self):
        """An off-centre QR changes the retreat vector and yaw without approaching it."""
        moves, _, marker = self.flight(right=.1)
        first = moves[0][0]
        self.assertLess(first[0], 0)
        self.assertLess(first[1], 0)
        self.assertAlmostEqual(first[3], math.atan2(.1, 1.))
        self.assertAlmostEqual(marker.forward_m, 1.25)

    def test_faults_stop_before_the_first_orbit(self):
        """Loss, stale feedback, rejected motion and abort cannot fall through to an orbit."""
        for fault in ('cached', 'battery', 'link', 'cancel', 'lost', 'no-motion', 'tilted'):
            with self.subTest(fault=fault), self.assertRaises(InterruptedError):
                self.flight(fault=fault)
        with self.assertRaisesRegex(RuntimeError, 'move rejected'):
            self.flight(fault='rejected')

    def test_already_farther_away_never_approaches_to_meet_smaller_radius(self):
        """Reject inward repositioning and launch poses outside the acquisition envelope."""
        with self.assertRaisesRegex(InterruptedError, 'refusing an approach'):
            self.flight(area=30, initial=1.25)
        with self.assertRaisesRegex(InterruptedError, 'one metre'):
            self.flight(initial=2.)


if __name__ == '__main__':
    unittest.main()
