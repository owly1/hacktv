"""Independent point-mass flight simulation; no SDK or aircraft commands.

Position, video, and received telemetry have separate clocks.  Lap assertions
use the simulated aircraft's path around the fixed physical marker, never the
controller's progress report or the aircraft's yaw.
"""
from dataclasses import dataclass, replace
import itertools
import math
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parents[1] / 'bridge'))
from continuous_orbit import Control, Motion, run_continuous_orbit
from qr_orbit_core import Limits, Vehicle, vehicle_reason


@dataclass(frozen=True)
class SimulatedTarget:
    at: float
    episode: str
    forward_m: float
    right_m: float
    down_m: float
    width_m: float
    position_source: str
    position_uncertainty_m: float


class FlightWorld:
    """Acceleration from delayed body tilt, drag, and independent NED motion."""
    def __init__(self, *, upward_bias=.02, camera_latency=.25,
                 telemetry_latency=.05, outlier=False, translation=True,
                 stale_motion=False, stop_after_laps=3, duration=60,
                 forced_yaw_rate=0., radius=1., heading_deg=0., drag=.45,
                 tilt_lag=.18, telemetry_period=.2, dropout=None,
                 initial_radius_estimate=None):
        self.time = 0.
        self.x, self.y, self.altitude = -radius, 0., 1.
        self.vx = self.vy = self.vz = 0.
        self.yaw = math.radians(heading_deg)
        self.roll = self.pitch = self.yaw_rate = self.climb_rate = 0.
        self.control = Control(0, 0, 0, 0)
        self.upward_bias = upward_bias
        self.camera_latency = camera_latency
        self.telemetry_latency = telemetry_latency
        self.telemetry_period = telemetry_period
        self.drag, self.tilt_lag = drag, tilt_lag
        self.dropout = dropout
        self.initial_radius_estimate = initial_radius_estimate
        self.last_visual_at = -camera_latency
        self.outlier = outlier
        self.translation = translation
        self.forced_yaw_rate = forced_yaw_rate
        self.stale_motion = stale_motion
        self.stop_after_laps = stop_after_laps
        self.duration = duration
        self.commands, self.reports, self.diagnostics, self.remembered = [], [], [], []
        self.history = [self.snapshot(-1.), self.snapshot(0.)]
        self.swept = 0.
        self.laps = []
        self.radii = [radius]
        self.radius_samples = [(0., radius)]
        self.altitudes = [1.]
        self.bearings = []
        self.limits = Limits(segments=24, speed_mps=.6, lap_seconds=15.)

    def snapshot(self, at):
        return (at, self.x, self.y, self.altitude, self.yaw,
                self.vx, self.vy, self.vz)

    def historical(self, at):
        # The sim's ground truth is intentionally separate from the core's
        # telemetry integrator and any motion interpolation implementation.
        if at <= self.history[0][0]:
            return (at, *self.history[0][1:])
        for index in range(len(self.history) - 1, 0, -1):
            later, earlier = self.history[index], self.history[index - 1]
            if earlier[0] <= at:
                ratio = min(1., (at - earlier[0]) / (later[0] - earlier[0]))
                return (at, *(a + ratio * (b - a)
                              for a, b in zip(earlier[1:], later[1:])))
        raise AssertionError('Missing simulated history')

    def target(self):
        # Video captures at 5 Hz, then arrives 250 ms after capture.
        if self.dropout and self.dropout[0] <= self.time < self.dropout[1]:
            return None
        captured = math.floor((self.time - self.camera_latency) * 5 + 1e-8) / 5
        self.last_visual_at = captured
        _, x, y, altitude, yaw, *_ = self.historical(captured)
        marker_x = 1.5 if self.outlier and 5 <= self.time < 5.6 else 0.
        dx, dy = marker_x - x, -y
        forward = math.cos(yaw) * dx + math.sin(yaw) * dy
        right = -math.sin(yaw) * dx + math.cos(yaw) * dy
        return SimulatedTarget(captured, 'fixed-marker', forward, right,
                               altitude + .18, .12, 'measured-qr-3d', .025)

    def motion(self):
        received_at = self.time - self.telemetry_latency
        if self.stale_motion and self.time > 1:
            received_at = 1 - self.telemetry_latency
        # Real logs deliver motion/attitude near 5 Hz. Cache reads between
        # those events preserve the sample timestamp; they are not new data.
        received_at = math.floor(received_at / self.telemetry_period + 1e-8) * self.telemetry_period
        at, _, _, altitude, yaw, vx, vy, vz = self.historical(received_at)
        return Motion(at, yaw, vx, vy, vz, altitude)

    def check(self):
        if self.stop_after_laps and len(self.laps) >= self.stop_after_laps:
            raise InterruptedError('three physical laps completed')
        if self.time >= self.duration:
            raise InterruptedError('simulation operator stop')
        vehicle = Vehicle(self.time, True, 'flying', 80, self.altitude,
                          math.hypot(self.vx, self.vy),
                          max(abs(self.roll), abs(self.pitch)))
        reason = vehicle_reason(vehicle, self.limits, self.time)
        if reason:
            raise InterruptedError(reason)
        target = self.target()
        if self.time - self.last_visual_at >= 15:
            raise InterruptedError('Fire has not been seen for 15 consecutive seconds')
        return vehicle, target

    def command(self, value):
        self.control = value
        self.commands.append((self.time, value))
        for axis in ('roll', 'pitch', 'yaw', 'gaz'):
            if not math.isfinite(getattr(value, axis)) or abs(getattr(value, axis)) > 100:
                raise AssertionError(f'Invalid PCMD {axis}: {value}')

    def sleep(self, seconds):
        if not 0 < seconds <= .1:
            raise AssertionError(f'Watchdog interval too long: {seconds}')
        until = self.time + seconds
        while self.time < until - 1e-10:
            dt = min(.01, until - self.time)
            old_angle = math.atan2(self.y, self.x)
            old_swept = self.swept
            self.roll += (10 * self.control.roll / 100 - self.roll) * (1 - math.exp(-dt / self.tilt_lag))
            self.pitch += (10 * self.control.pitch / 100 - self.pitch) * (1 - math.exp(-dt / self.tilt_lag))
            forward_acc = 9.81 * math.tan(math.radians(self.pitch))
            right_acc = 9.81 * math.tan(math.radians(self.roll))
            if self.translation:
                self.vx += (math.cos(self.yaw) * forward_acc - math.sin(self.yaw) * right_acc
                            - self.drag * self.vx) * dt
                self.vy += (math.sin(self.yaw) * forward_acc + math.cos(self.yaw) * right_acc
                            - self.drag * self.vy) * dt
                self.x += self.vx * dt
                self.y += self.vy * dt
            desired_yaw_rate = (self.forced_yaw_rate or
                                math.radians(60) * self.control.yaw / 100)
            self.yaw_rate += (desired_yaw_rate - self.yaw_rate) * (1 - math.exp(-dt / .12))
            self.yaw += self.yaw_rate * dt
            self.climb_rate += (.3 * self.control.gaz / 100 - self.climb_rate) * (1 - math.exp(-dt / .2))
            self.vz = -self.climb_rate - self.upward_bias
            self.altitude -= self.vz * dt
            angle = math.atan2(self.y, self.x)
            self.swept += math.atan2(math.sin(angle - old_angle), math.cos(angle - old_angle))
            self.time += dt
            next_lap = (len(self.laps) + 1) * 2 * math.pi
            if self.swept >= next_lap:
                fraction = (next_lap - old_swept) / (self.swept - old_swept)
                self.laps.append(self.time - dt + fraction * dt)
            self.radii.append(math.hypot(self.x, self.y))
            self.radius_samples.append((self.time, self.radii[-1]))
            self.altitudes.append(self.altitude)
            self.bearings.append(math.atan2(math.sin(math.atan2(-self.y, -self.x) - self.yaw),
                                           math.cos(math.atan2(-self.y, -self.x) - self.yaw)))
            self.history.append(self.snapshot(self.time))

    def run(self):
        target = self.target()
        if self.initial_radius_estimate is not None:
            scale = self.initial_radius_estimate / math.hypot(target.forward_m, target.right_m)
            target = replace(target, forward_m=target.forward_m * scale,
                             right_m=target.right_m * scale,
                             position_source='motion-propagated-fire')
        run_continuous_orbit(target, self.limits, self.check, self.motion,
                             self.command, lambda *args: self.reports.append(args),
                             remember=self.remembered.append,
                             diagnostic=lambda *args: self.diagnostics.append(args),
                             clock=lambda: self.time, sleep=self.sleep)


class ContinuousOrbitTests(unittest.TestCase):
    def test_sensor_event_arriving_during_motion_read_is_fresh(self):
        world = FlightWorld(stop_after_laps=None, duration=.2)
        read_motion = world.motion

        def callback_during_read():
            world.time += .00001
            return replace(read_motion(), at=world.time, velocity_at=world.time)

        world.motion = callback_during_read
        with self.assertRaisesRegex(InterruptedError, 'simulation operator stop'):
            world.run()
        self.assertGreater(len(world.commands), 2)
        self.assert_stopped(world)

    def assert_stopped(self, world):
        self.assertTrue(world.commands, 'Core must explicitly neutralize PCMD on exit')
        self.assertEqual(world.commands[-1][1], Control(0, 0, 0, 0))

    def assert_three_fast_physical_laps(self, world):
        with self.assertRaisesRegex(InterruptedError, 'three physical laps'):
            world.run()
        self.assertEqual(len(world.laps), 3)
        durations = [world.laps[0], *(b - a for a, b in zip(world.laps, world.laps[1:]))]
        for lap, duration in enumerate(durations, 1):
            self.assertLessEqual(duration, 15., f'Physical lap {lap} took {duration:.3f}s')
        self.assert_stopped(world)

    def test_three_actual_laps_with_delayed_video_velocity_and_upward_drift(self):
        world = FlightWorld()
        self.assert_three_fast_physical_laps(world)
        self.assertGreaterEqual(min(world.radii), .8)
        self.assertLessEqual(max(world.radii), 1.2)
        self.assertLess(max(abs(value - 1.) for value in world.altitudes), .12)
        self.assertTrue(any(control.gaz < 0 for _, control in world.commands),
                        'The previous flight accumulated upward drift with dZ=0')
        self.assertLess(max(abs(value) for value in world.bearings), math.radians(25))
        corrections = [data for kind, data in world.diagnostics
                       if kind == 'continuous_target_corrected']
        self.assertGreater(len(corrections), 100,
                           'Delayed camera measurements must actually correct the estimate')
        self.assertTrue(all(data['age_s'] >= .25 - 1e-6 for data in corrections))
        self.assert_stopped(world)

    def test_inconsistent_metric_outlier_does_not_move_the_orbit_center(self):
        world = FlightWorld(outlier=True)
        with self.assertRaisesRegex(InterruptedError, 'three physical laps'):
            world.run()
        self.assertEqual(len(world.laps), 3)
        self.assertGreaterEqual(min(world.radii), .8)
        self.assertLessEqual(max(world.radii), 1.2)
        self.assert_stopped(world)

    def test_stale_motion_stops_even_when_vehicle_and_camera_are_fresh(self):
        world = FlightWorld(stale_motion=True)
        with self.assertRaisesRegex(InterruptedError, '(?i)stale|motion|telemetry'):
            world.run()
        self.assertLess(world.time, 2.1)
        self.assert_stopped(world)

    def test_yaw_in_place_does_not_count_as_a_physical_lap(self):
        world = FlightWorld(translation=False, upward_bias=0,
                            stop_after_laps=None, duration=18,
                            forced_yaw_rate=math.radians(90))
        with self.assertRaises(InterruptedError):
            world.run()
        self.assertEqual(world.swept, 0.)
        self.assertEqual(world.laps, [])
        self.assertGreater(abs(world.yaw), 2 * math.pi,
                           'Exercise a complete yaw rotation without physical translation')
        self.assertFalse(any('lap 2' in str(report) for report in world.reports))
        self.assert_stopped(world)

    def test_operator_stop_always_neutralizes_the_last_command(self):
        world = FlightWorld(stop_after_laps=None, duration=.75)
        with self.assertRaisesRegex(InterruptedError, 'operator stop'):
            world.run()
        self.assertTrue(any(control != Control(0, 0, 0, 0)
                            for _, control in world.commands[:-1]))
        self.assert_stopped(world)

    def test_varied_start_pose_drag_attitude_lag_and_camera_latency(self):
        for radius, heading, latency, drag, lag in itertools.product(
                [.9, 1.1], [-8, 8], [.15, .35], [.25, .7], [.12, .25]):
            parameters = dict(radius=radius, heading_deg=heading,
                              camera_latency=latency, drag=drag, tilt_lag=lag)
            with self.subTest(**parameters):
                world = FlightWorld(**parameters)
                self.assert_three_fast_physical_laps(world)
                self.assertGreaterEqual(min(world.radii), .8)
                self.assertLessEqual(max(world.radii), 1.2)

    def test_brief_visual_dropout_keeps_measured_circles(self):
        world = FlightWorld(dropout=(5., 9.))
        self.assert_three_fast_physical_laps(world)
        self.assertGreaterEqual(min(world.radii), .8)
        self.assertLessEqual(max(world.radii), 1.2)

    def test_presence_timeout_from_caller_stops_continuous_control(self):
        world = FlightWorld(dropout=(3., 50.), stop_after_laps=None)
        with self.assertRaisesRegex(InterruptedError, 'not been seen for 15'):
            world.run()
        self.assertLess(world.time, 18.)
        self.assert_stopped(world)

    def test_delayed_vision_repairs_inaccurate_initial_propagated_radius(self):
        for radius in (.75, .8):
            with self.subTest(actual_radius=radius):
                world = FlightWorld(radius=radius, initial_radius_estimate=1.)
                with self.assertRaisesRegex(InterruptedError, 'three physical laps'):
                    world.run()
                recovery = [data for kind,data in world.diagnostics
                            if kind == 'orbit_radial_recovery_completed']
                self.assertEqual(len(recovery),1)
                self.assertLess(recovery[0]['duration_s'],5.)
                # The requested radial correction happens before the first
                # timed circle; it must not accelerate to repay that time.
                durations = [world.laps[0]-recovery[0]['duration_s'],
                             *(b-a for a,b in zip(world.laps,world.laps[1:]))]
                self.assertEqual(len(durations),3)
                self.assertTrue(all(duration<=15. for duration in durations),durations)
                self.assert_stopped(world)
                settled = [value for at, value in world.radius_samples if at >= 3]
                self.assertGreaterEqual(min(settled), .8)
                self.assertLessEqual(max(settled), 1.2)


if __name__ == '__main__':
    unittest.main()
