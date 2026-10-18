"""Accepted far starts approach the ring before timing physical laps."""
import math
import unittest

from continuous_orbit_test import Control, FlightWorld


class ContinuousOrbitApproachTests(unittest.TestCase):
    def test_far_starts_approach_then_complete_three_fast_physical_laps(self):
        for radius in (2., 3.):
            with self.subTest(radius=radius):
                world = FlightWorld(radius=radius, heading_deg=-14.28, duration=65)
                with self.assertRaisesRegex(InterruptedError, 'three physical laps'):
                    world.run()
                starts = [data for name, data in world.diagnostics
                          if name == 'orbit_radial_recovery_started']
                completed = [data for name, data in world.diagnostics
                             if name == 'orbit_radial_recovery_completed']
                self.assertEqual(len(starts), 1)
                self.assertEqual(starts[0]['no_progress_limit_s'], 5.)
                self.assertEqual(len(completed), 1)
                aligned = completed[0]['duration_s']
                self.assertTrue(any(name == 'orbit_radial_recovery_progress'
                                    for name, _ in world.diagnostics))
                # Ground-truth motion must approach the marker, not merely
                # report a smaller estimated radius or rotate the aircraft.
                at_two_seconds = next(r for at, r in world.radius_samples if at >= 2.)
                self.assertLess(at_two_seconds, radius-.2)
                after_alignment = [r for at, r in world.radius_samples if at >= aligned]
                self.assertGreaterEqual(min(after_alignment), .8)
                self.assertLessEqual(max(after_alignment), 1.2)
                self.assertEqual(len(world.laps), 3)
                durations = [world.laps[0]-aligned,
                             *(b-a for a, b in zip(world.laps, world.laps[1:]))]
                for duration in durations:
                    self.assertLessEqual(duration, 15.)
                self.assertEqual(world.commands[-1][1], Control())

    def test_stationary_far_starts_stop_when_corrective_motion_stalls(self):
        for radius in (2., 3.):
            with self.subTest(radius=radius):
                world = FlightWorld(radius=radius, translation=False, duration=30)
                with self.assertRaisesRegex(InterruptedError, 'Radius correction stalled'):
                    world.run()
                self.assertGreaterEqual(world.time, 5.)
                self.assertLessEqual(world.time, 5.051)
                self.assertTrue(any(control.pitch > 0 for _, control in world.commands))
                self.assertEqual(world.laps, [])
                self.assertEqual(world.commands[-1][1], Control())

    def test_later_divergence_stops_when_translation_fails(self):
        class DisturbedWorld(FlightWorld):
            disturb_at = None
            disturbed = False

            def check(self):
                if self.disturb_at is None and any(name == 'orbit_radial_recovery_completed'
                                                   for name, _ in self.diagnostics):
                    self.disturb_at = self.time+2.
                if self.disturb_at is not None and self.time >= self.disturb_at and not self.disturbed:
                    # Inject a fixed outward position disturbance after real
                    # tangential flight, then a failed translation actuator.
                    angle = math.atan2(self.y, self.x)
                    self.x, self.y = 2.3*math.cos(angle), 2.3*math.sin(angle)
                    self.vx = self.vy = 0.
                    self.translation = False
                    self.disturbed = True
                return super().check()

        world = DisturbedWorld(radius=2., duration=30, stop_after_laps=None)
        with self.assertRaisesRegex(InterruptedError, 'Radius correction stalled'):
            world.run()
        starts = [data for name, data in world.diagnostics
                  if name == 'orbit_radial_recovery_started']
        self.assertTrue(world.disturbed)
        self.assertEqual([data['no_progress_limit_s'] for data in starts], [5., 5.])
        self.assertLess(world.time-world.disturb_at, 7.)
        self.assertEqual(world.commands[-1][1], Control())


if __name__ == '__main__':
    unittest.main()
