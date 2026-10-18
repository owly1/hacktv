"""Control proceeds while independent motion confirms continued progress."""
from dataclasses import replace
import math
import unittest

from continuous_orbit_test import FlightWorld
from continuous_orbit import Control, run_continuous_orbit


class ContinuousOrbitProgressTests(unittest.TestCase):
    def test_slow_physical_approach_can_take_more_than_five_seconds(self):
        class SlowAircraft(FlightWorld):
            def command(self, value):
                super().command(replace(value, pitch=round(value.pitch*.15),
                                        roll=round(value.roll*.15)))

            def check(self):
                if any(name == 'orbit_radial_recovery_completed' for name, _ in self.diagnostics):
                    raise InterruptedError('physical approach completed')
                return super().check()

        for radius in (1.6, .55):
            with self.subTest(radius=radius):
                world = SlowAircraft(radius=radius, camera_latency=.35,
                                     tilt_lag=.25, duration=30)
                with self.assertRaisesRegex(InterruptedError, 'physical approach completed'):
                    world.run()
                self.assertGreater(world.time, 5.)
                self.assertLess(world.time, 10.)
                self.assertGreater(abs(world.radii[-1]-radius), .3)
                self.assertLess(abs(world.radii[-1]-1.), .09)
                progress = [data for name, data in world.diagnostics
                            if name == 'orbit_radial_recovery_progress']
                self.assertGreater(len(progress), 3)
                self.assertTrue(all(data['measured_radial_progress_m'] >= .04 and
                                    data['radius_error_reduction_m'] >= .04 for data in progress))
                self.assertEqual(world.commands[-1][1], Control())

    def test_visual_pose_drift_cannot_renew_recovery_without_actual_motion(self):
        world = FlightWorld(radius=1.6, translation=False, duration=12)
        actual_target = world.target

        def drifting_target():
            target = actual_target()
            return replace(target, forward_m=target.forward_m-min(.2,max(0.,target.at)*.04))

        world.target = drifting_target
        with self.assertRaisesRegex(InterruptedError, 'Radius correction stalled'):
            world.run()
        self.assertLessEqual(world.time, 5.051)
        self.assertAlmostEqual(world.radii[-1], 1.6)
        self.assertTrue(any(name == 'continuous_target_corrected' for name, _ in world.diagnostics))
        self.assertFalse(any(name == 'orbit_radial_recovery_progress' for name, _ in world.diagnostics))
        self.assertEqual(world.commands[-1][1], Control())

    def run_waiting_world(self, world, initial):
        run_continuous_orbit(initial, world.limits, world.check, world.motion, world.command,
                             lambda *args: world.reports.append(args),
                             diagnostic=lambda *args: world.diagnostics.append(args),
                             clock=lambda: world.time, sleep=world.sleep)

    def test_initial_missing_pose_waits_neutral_until_operator_stops(self):
        world = FlightWorld(duration=3.5)
        initial = world.target()
        world.target = lambda: None
        with self.assertRaisesRegex(InterruptedError, 'simulation operator stop'):
            self.run_waiting_world(world, initial)
        self.assertGreater(world.time, 3.)
        self.assertTrue(all(control == Control() for _, control in world.commands))
        self.assertEqual(len(world.reports), 1)

    def test_initial_pose_can_arrive_after_the_old_startup_deadline(self):
        world = FlightWorld(duration=4.)
        initial, actual_target = world.target(), world.target
        world.target = lambda: None if world.time < 3. else actual_target()
        with self.assertRaisesRegex(InterruptedError, 'simulation operator stop'):
            self.run_waiting_world(world, initial)
        self.assertTrue(all(control == Control() for at, control in world.commands if at < 3.))
        self.assertTrue(any(control != Control() for at, control in world.commands if at >= 3.))
        self.assertEqual(world.commands[-1][1], Control())

    def test_slow_real_orbit_continues_without_a_minimum_rotation_speed(self):
        class SlowAircraft(FlightWorld):
            def command(self, value):
                super().command(replace(value, pitch=round(value.pitch*.025),
                                        roll=round(value.roll*.025)))

        world = SlowAircraft(duration=12., stop_after_laps=None, upward_bias=0.)
        with self.assertRaisesRegex(InterruptedError, 'simulation operator stop'):
            world.run()
        five_seconds = next(row for row in world.history if row[0] >= 5.)
        initial_angle = math.atan2(world.history[1][2], world.history[1][1])
        first_sweep = math.atan2(five_seconds[2],five_seconds[1])-initial_angle
        first_sweep = math.atan2(math.sin(first_sweep),math.cos(first_sweep))
        self.assertGreater(first_sweep, math.radians(2.5))
        self.assertLess(first_sweep, math.radians(20))
        self.assertGreater(world.swept-first_sweep, math.radians(5))
        self.assertFalse(any(name == 'orbit_radial_recovery_started' for name, _ in world.diagnostics))
        self.assertEqual(world.commands[-1][1], Control())


if __name__ == '__main__':
    unittest.main()
