"""Independent physical disturbances of a fixed-marker orbit; no aircraft IO.

The imported simulator integrates real position from delayed tilt response.
Assertions use that ground truth, separately from estimated/controller radius.
Velocity corruption is applied to both motion vectors and reported vehicle
speed so the safety check cannot secretly see uncorrupted ground truth.
"""
from dataclasses import replace
import math
import unittest

from continuous_orbit_test import FlightWorld
from continuous_orbit import Control
from qr_orbit_core import Vehicle, vehicle_reason


class DisturbedFlight(FlightWorld):
    def __init__(self, *, velocity_scale=1., exposure_error=0.,
                 fault_after_impulse=False, **kwargs):
        super().__init__(**kwargs)
        self.velocity_scale = velocity_scale
        self.exposure_error = exposure_error
        self.fault_after_impulse = fault_after_impulse
        self.impulse_at = None
        self.command_truth = []

    def scale(self):
        if self.fault_after_impulse and self.impulse_at is None:
            return 1.
        return self.velocity_scale

    def motion(self):
        state = super().motion()
        return replace(state, vx=state.vx*self.scale(), vy=state.vy*self.scale())

    def target(self):
        target = super().target()
        if target is None or not self.exposure_error:
            return target
        # The image was physically exposed earlier than its claimed timestamp.
        # Its geometry uses the actual historical aircraft pose; its timestamp
        # intentionally remains incorrect when received by the controller.
        _, x, y, altitude, yaw, *_ = self.historical(target.at-self.exposure_error)
        return replace(target,
                       forward_m=-math.cos(yaw)*x-math.sin(yaw)*y,
                       right_m=math.sin(yaw)*x-math.cos(yaw)*y,
                       down_m=altitude+.18)

    def check(self):
        if self.stop_after_laps and len(self.laps) >= self.stop_after_laps:
            raise InterruptedError('three physical laps completed')
        if self.time >= self.duration:
            raise InterruptedError('simulation operator stop')
        vehicle = Vehicle(self.time, True, 'flying', 80, self.altitude,
                          math.hypot(self.vx, self.vy)*self.scale(),
                          max(abs(self.roll), abs(self.pitch)))
        reason = vehicle_reason(vehicle, self.limits, self.time)
        if reason:
            raise InterruptedError(reason)
        target = self.target()
        if self.time-self.last_visual_at >= 15:
            raise InterruptedError('Fire has not been seen for 15 consecutive seconds')
        return vehicle, target

    def sleep(self, seconds):
        if self.impulse_at is None and self.time >= 6.-1e-9:
            # A physical outward velocity impulse, without teleporting or
            # changing the marker. Camera and telemetry retain their delays.
            self.impulse_at = self.time
            radius = math.hypot(self.x, self.y)
            self.vx += .4*self.x/radius
            self.vy += .4*self.y/radius
            self.history[-1] = self.snapshot(self.time)
        super().sleep(seconds)

    def command(self, value):
        super().command(value)
        forward = 9.81*math.tan(math.radians(value.pitch*.1))
        right = 9.81*math.tan(math.radians(value.roll*.1))
        ax = math.cos(self.yaw)*forward-math.sin(self.yaw)*right
        ay = math.sin(self.yaw)*forward+math.cos(self.yaw)*right
        inward = -(ax*self.x+ay*self.y)/math.hypot(self.x, self.y)
        self.command_truth.append((self.time, inward))


class ContinuousOrbitRecoveryTests(unittest.TestCase):
    def assert_neutral(self, world):
        self.assertEqual(world.commands[-1][1], Control())

    def test_outward_impulse_returns_to_ring_and_completes_three_physical_laps(self):
        cases = ({}, {'camera_latency':.35, 'tilt_lag':.25},
                 {'camera_latency':.35, 'tilt_lag':.25, 'velocity_scale':.9})
        for parameters in cases:
            with self.subTest(**parameters):
                world = DisturbedFlight(**parameters)
                with self.assertRaisesRegex(InterruptedError, 'three physical laps completed'):
                    world.run()
                self.assertEqual(len(world.laps), 3)
                self.assertIsNotNone(world.impulse_at)
                peak, peak_at = max((radius, at) for at, radius in world.radius_samples
                                    if world.impulse_at <= at <= world.impulse_at+5)
                self.assertGreater(peak, 1.18, 'Exercise a meaningful physical departure from the ring')
                self.assertLess(peak, 1.35)
                returned = next((at for at, radius in world.radius_samples
                                 if at > peak_at and .91 <= radius <= 1.09), None)
                self.assertIsNotNone(returned, 'Actual aircraft position must return to the ring')
                self.assertLess(returned-world.impulse_at, 5.)
                self.assertTrue(any(inward > .3 for at, inward in world.command_truth
                                    if world.impulse_at <= at <= world.impulse_at+1.),
                                'Corrective thrust must physically point toward the fixed marker')
                settled = [radius for at, radius in world.radius_samples if at >= 12.]
                self.assertGreater(min(settled), .85)
                self.assertLess(max(settled), 1.2)
                # Recovery is allowed to delay the interrupted first lap.
                self.assertTrue(all(b-a <= 15. for a, b in zip(world.laps, world.laps[1:])))
                centres = [tuple(data['centre_m']) for kind, data in world.diagnostics
                           if kind == 'continuous_target_corrected']
                self.assertGreater(len(centres), 20)
                self.assertEqual(len(set(centres)), 1,
                                 'Later QR fixes must not move the locked world-space marker')
                self.assert_neutral(world)

    def test_corrupt_velocity_and_exposure_time_recover_or_stop_on_stalled_progress(self):
        for scale in (.8, .6):
            for deferred in (False, True):
                with self.subTest(velocity_scale=scale, fault_after_impulse=deferred):
                    world = DisturbedFlight(velocity_scale=scale, exposure_error=.2,
                                            fault_after_impulse=deferred,
                                            camera_latency=.35, tilt_lag=.25)
                    outcome = 'three physical laps completed' if scale == .8 else 'Radius correction stalled'
                    with self.assertRaisesRegex(InterruptedError, outcome):
                        world.run()
                    self.assertIsNotNone(world.impulse_at)
                    self.assertTrue(any(inward > .3 for at, inward in world.command_truth
                                        if world.impulse_at <= at <= world.impulse_at+1.))
                    # Moderate corruption still converges after more than five
                    # seconds. Severe corruption must stop after actual progress
                    # ceases, rather than at an arbitrary completion deadline.
                    self.assertGreater(world.time-world.impulse_at, 1.)
                    if scale == .8:
                        self.assertEqual(len(world.laps), 3)
                        completed = [data for name, data in world.diagnostics
                                     if name == 'orbit_radial_recovery_completed']
                        self.assertGreater(completed[0]['duration_s'], 5.)
                    else:
                        start = next(data for name, data in world.diagnostics
                                     if name == 'orbit_radial_recovery_started')
                        progress = [data for name, data in world.diagnostics
                                    if name == 'orbit_radial_recovery_progress']
                        last_progress = start['elapsed_s'] + (progress[-1]['duration_s'] if progress else 0.)
                        self.assertGreaterEqual(world.time-last_progress, 5.)
                        self.assertLessEqual(world.time-last_progress, 5.051)
                    self.assertLess(max(world.radii), 1.5)
                    self.assertGreater(min(world.radii), .5)
                    self.assert_neutral(world)

    def test_position_corrections_do_not_count_as_physical_laps(self):
        world = FlightWorld(translation=False, upward_bias=0.,
                            stop_after_laps=None, duration=8.)
        real_target = world.target

        def rotating_pose_error():
            target = real_target()
            phase = max(0., target.at)*2*math.pi/3
            _, _, _, _, yaw, *_ = world.historical(target.at)
            # Faulty metric geometry changes while physical position stays
            # fixed. Yaw is accounted for separately in the reported bearing.
            return replace(target, forward_m=math.cos(phase-yaw),
                           right_m=math.sin(phase-yaw))

        world.target = rotating_pose_error
        with self.assertRaises(InterruptedError):
            world.run()
        corrections = [data for kind, data in world.diagnostics
                       if kind == 'continuous_target_corrected']
        self.assertGreaterEqual(len(corrections), 3)
        self.assertEqual(world.laps, [])
        self.assertEqual(world.swept, 0.)
        self.assertFalse(any(kind == 'orbit_lap_completed' for kind, _ in world.diagnostics))
        self.assertTrue(all(data['sweep_deg'] == 0. for kind, data in world.diagnostics
                            if kind == 'continuous_orbit'))
        self.assert_neutral(world)


if __name__ == '__main__':
    unittest.main()
