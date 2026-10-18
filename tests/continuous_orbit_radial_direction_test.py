"""Regression for flight 110714: intended outward approach was being braked."""
import itertools
import math
import unittest

from continuous_orbit_test import FlightWorld, SimulatedTarget
from continuous_orbit import Control, Motion, run_continuous_orbit


class RadialDirectionTests(unittest.TestCase):
    def replay_outward_sample(self, radius):
        now = [0.]
        commands, diagnostics = [], []
        # First settle and lock the marker, then deliver the recorded outward
        # speed. Trapezoidal integration reaches the requested replay radius.
        target = SimulatedTarget(0., 'marker', radius-.0168, 0., 1., .12,
                                 'measured-qr-3d', .02)
        limits = FlightWorld().limits

        def check():
            if now[0] > .2:
                raise InterruptedError('replay completed')
            return None, target

        def motion():
            return Motion(now[0], 0., -.168 if now[0] else 0., 0., 0., 1.)

        def advance(_):
            now[0] += .2

        with self.assertRaisesRegex(InterruptedError, 'replay completed'):
            run_continuous_orbit(target, limits, check, motion, commands.append,
                                 lambda *args: None,
                                 diagnostic=lambda *args: diagnostics.append(args),
                                 clock=lambda: now[0], sleep=advance)
        sample = [data for kind, data in diagnostics if kind == 'continuous_orbit'][-1]
        self.assertAlmostEqual(sample['radius_m'], radius)
        self.assertAlmostEqual(sample['outward_mps'], .168)
        self.assertEqual(commands[-1], Control())
        return sample

    def test_recorded_inside_ring_motion_keeps_the_outward_goal(self):
        sample = self.replay_outward_sample(.572)
        self.assertEqual(sample['desired_radial_mps'], -.2)
        self.assertEqual(sample['desired_tangent_mps'], 0.)
        self.assertLess(sample['command']['pitch'], 0)

    def test_near_ring_feedback_brakes_without_reversing_the_radial_goal(self):
        sample = self.replay_outward_sample(.98)
        self.assertLess(sample['desired_radial_mps'], 0)
        self.assertGreater(sample['command']['pitch'], 0)

    def test_outside_ring_divergence_still_commands_inward_motion(self):
        sample = self.replay_outward_sample(1.2)
        self.assertGreater(sample['desired_radial_mps'], .15)
        self.assertGreater(sample['command']['pitch'], 0)

    def assert_close_entry_laps(self, world):
        with self.assertRaisesRegex(InterruptedError, 'three physical laps completed'):
            world.run()
        recoveries = [data for kind, data in world.diagnostics
                      if kind == 'orbit_radial_recovery_completed']
        self.assertEqual(len(recoveries), 1)
        aligned = recoveries[0]['duration_s']
        self.assertLess(aligned, 5.36051)
        after = [r for at, r in world.radius_samples if at >= aligned]
        self.assertGreaterEqual(min(after), .8)
        self.assertLessEqual(max(after), 1.2)
        actual_after_two_seconds = next(r for at, r in world.radius_samples if at >= 2.)
        self.assertGreater(actual_after_two_seconds, .8)
        self.assertEqual(len(world.laps), 3)
        for duration in [world.laps[0]-aligned,
                         *(b-a for a, b in zip(world.laps, world.laps[1:]))]:
            self.assertLessEqual(duration, 15.)
        self.assertEqual(world.commands[-1][1], Control())

    def test_recorded_close_start_with_camera_delay_drag_and_response_lag(self):
        for latency, drag, lag in itertools.product((.25, .35), (.25, .7), (.12, .25)):
            with self.subTest(latency=latency, drag=drag, lag=lag):
                world = FlightWorld(radius=.527898, heading_deg=-8.30657,
                                    camera_latency=latency, drag=drag,
                                    tilt_lag=lag, duration=65)
                self.assert_close_entry_laps(world)

    def test_close_start_handles_an_actual_outward_velocity_disturbance(self):
        class DisturbedApproach(FlightWorld):
            pushed = False

            def sleep(self, seconds):
                if self.time >= .8 and not self.pushed:
                    radius = math.hypot(self.x, self.y)
                    self.vx += .08*self.x/radius
                    self.vy += .08*self.y/radius
                    self.pushed = True
                super().sleep(seconds)

        for latency, drag, lag in ((.25, .45, .18), (.35, .25, .25), (.35, .7, .25)):
            with self.subTest(latency=latency, drag=drag, lag=lag):
                world = DisturbedApproach(radius=.527898, heading_deg=-8.30657,
                                          camera_latency=latency, drag=drag,
                                          tilt_lag=lag, duration=65)
                self.assert_close_entry_laps(world)
                self.assertTrue(world.pushed)


if __name__ == '__main__':
    unittest.main()
