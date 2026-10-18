"""Physical entry alignment without blocking SDK relative-move commands.

The fixed marker, aircraft position, yaw and lap crossings come from the
independent FlightWorld dynamics. SDK-style yaw is wrapped at +/- pi, while
the physical simulator retains continuous angles for its own geometry.
"""
from dataclasses import replace
import math
import unittest

from continuous_orbit_test import FlightWorld
from continuous_orbit import Control


def wrap(angle):
    return math.atan2(math.sin(angle), math.cos(angle))


class EntryWorld(FlightWorld):
    def __init__(self, *, radius, bearing_deg, world_rotation_deg=0., **kwargs):
        super().__init__(radius=radius,
                         heading_deg=world_rotation_deg-bearing_deg,
                         camera_latency=.35, tilt_lag=.25, **kwargs)
        rotation = math.radians(world_rotation_deg)
        self.x, self.y = -radius*math.cos(rotation), -radius*math.sin(rotation)
        self.history = [self.snapshot(-1.), self.snapshot(0.)]
        self.motion_headings = []
        self.initial_radius = radius
        self.initial_bearing = math.radians(bearing_deg)

    def motion(self):
        state = super().motion()
        state = replace(state, yaw_rad=wrap(state.yaw_rad))
        self.motion_headings.append((self.time, state.yaw_rad))
        return state

    def physical_alignment(self):
        """First 300 ms of stable ring position and inward heading, from truth."""
        stable_since = None
        for at, x, y, _, yaw, vx, vy, _ in self.history:
            if at < 0:
                continue
            radius = math.hypot(x, y)
            bearing = wrap(math.atan2(-y, -x)-yaw)
            radial_speed = (vx*x+vy*y)/radius
            aligned = (abs(radius-1.) <= .09 and abs(bearing) <= math.radians(5)
                       and abs(radial_speed) <= .15)
            if not aligned:
                stable_since = None
            else:
                if stable_since is None:
                    stable_since = at
                if at-stable_since >= .3:
                    return at
        return None


class ContinuousOrbitEntryTests(unittest.TestCase):
    def verify_entry_and_laps(self, world):
        with self.assertRaisesRegex(InterruptedError, 'three physical laps completed'):
            world.run()
        self.assertEqual(len(world.laps), 3)
        aligned_at = world.physical_alignment()
        self.assertIsNotNone(aligned_at, 'Actual radius and heading must settle before timing laps')
        self.assertLess(aligned_at, 4.)
        self.assertLess(aligned_at, world.laps[0])
        self.assertLessEqual(world.laps[0]-aligned_at, 15.,
                             'The first orbit after stable physical alignment exceeds the target')
        for previous, later in zip(world.laps, world.laps[1:]):
            self.assertLessEqual(later-previous, 15.)
        self.assertLessEqual(max(world.radii), 1.25,
                             'Entry must not send the aircraft farther out while aligning')
        self.assertGreaterEqual(min(world.radii), min(world.initial_radius, .85)-.02)
        settled_radii = [radius for at, radius in world.radius_samples if at >= aligned_at]
        self.assertGreaterEqual(min(settled_radii), .85)
        self.assertLessEqual(max(settled_radii), 1.2)
        near_one_second = next(row for row in world.history if row[0] >= 1.)
        _, x, y, _, yaw, *_ = near_one_second
        self.assertLess(abs(wrap(math.atan2(-y, -x)-yaw)), math.radians(5),
                        'The physical aircraft must turn toward the marker promptly')
        if abs(world.initial_radius-1.) > .15:
            initial_angle = math.atan2(world.history[1][2], world.history[1][1])
            before_alignment = [abs(wrap(math.atan2(y, x)-initial_angle))
                                for at, x, y, *_ in world.history if 0 <= at < aligned_at]
            self.assertLess(max(before_alignment), math.radians(5),
                            'A radial approach must precede substantial tangential travel')
        self.assertEqual(world.commands[-1][1], Control())
        return aligned_at

    def test_latest_measured_entry_radius_and_bearing_align_then_repeat_laps(self):
        world = EntryWorld(radius=1.1965, bearing_deg=14.28)
        self.verify_entry_and_laps(world)

    def test_close_measured_entry_moves_out_to_ring_before_orbiting(self):
        world = EntryWorld(radius=.626, bearing_deg=14.28)
        self.verify_entry_and_laps(world)

    def verify_dropout_and_yaw_wrap(self, world):
        aligned_at = self.verify_entry_and_laps(world)
        self.assertLess(aligned_at, 4., 'Complete alignment before QR decoding resumes')
        self.assertTrue(any(.05 <= at < 1. and value.yaw != 0
                            for at, value in world.commands),
                        'Inward yaw must continue from the locked model during QR loss')
        self.assertTrue(any(.05 <= at < aligned_at and (value.roll or value.pitch)
                            for at, value in world.commands))
        headings = [yaw for at, yaw in world.motion_headings if at <= 2.]
        self.assertTrue(any(abs(second-first) > math.pi
                            for first, second in zip(headings, headings[1:])),
                        'Exercise an actual SDK +/- pi discontinuity during entry')

    def test_negative_heading_error_crosses_yaw_wrap_during_qr_dropout(self):
        world = EntryWorld(radius=.626, bearing_deg=-35.,
                           world_rotation_deg=170., dropout=(.05, 4.))
        self.verify_dropout_and_yaw_wrap(world)

    def test_positive_heading_error_crosses_yaw_wrap_during_qr_dropout(self):
        world = EntryWorld(radius=1.1965, bearing_deg=35.,
                           world_rotation_deg=-170., dropout=(.05, 4.))
        self.verify_dropout_and_yaw_wrap(world)


if __name__ == '__main__':
    unittest.main()
