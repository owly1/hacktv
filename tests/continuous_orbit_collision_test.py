"""Recorded visual escape must prompt recovery despite reassuring odometry.

The fixture retains valid QR measurements and their capture/receipt times from
the wall-impact flight. Raw NED velocity was not logged; this deliberately does
not reconstruct that flight's physics. Healthy, zero velocity is adversarial
input proving that visual escape cannot be hidden behind an integrated radius.
No SDK, aircraft connection, or physical piloting commands are used.
"""
from dataclasses import dataclass
import json
import math
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parents[1] / 'bridge'))
from continuous_orbit import Control, Motion, run_continuous_orbit
from qr_orbit_core import Limits, Vehicle


FIXTURE = json.loads((Path(__file__).parent / 'fixtures' /
                     'continuous_orbit_collision_20261018.json').read_text())


@dataclass(frozen=True)
class RecordedTarget:
    at: float
    episode: str
    forward_m: float
    right_m: float
    down_m: float
    width_m: float = .12
    position_source: str = 'measured-qr-3d'
    position_uncertainty_m: float = .1


def target_from(row):
    return RecordedTarget(row['captured_s'], 'recorded-impact-marker',
                          row['forward_m'], row['right_m'], row['down_m'],
                          position_uncertainty_m=row.get('uncertainty_m', .1))


class VisualReplay:
    def __init__(self, start=0., stop=4.1):
        self.time, self.stop = start, stop
        self.commands, self.remembered, self.diagnostics = [], [], []
        self.presence_at = start
        self.frames = FIXTURE['measurements']
        self.limits = Limits(segments=24, speed_mps=.6, lap_seconds=15.)
        self.seed = RecordedTarget(start - .1, 'recorded-impact-marker',
                                   .9, 0., 1.)

    def latest(self):
        return next(row for row in reversed(self.frames)
                    if row['received_s'] <= self.time)

    def observed(self):
        return target_from(self.latest())

    def check(self):
        if self.time >= self.stop:
            raise InterruptedError('test replay complete')
        # Detection/presence remains fresh throughout. It must not substitute
        # for fresh, bounded metric position in the continuous flight core.
        self.presence_at = self.time
        return Vehicle(self.time, True, 'flying', 80., 1., 0., 0.), self.observed()

    def motion(self):
        return Motion(self.time, self.latest()['yaw_rad'], 0., 0., 0., 1.,
                      velocity_at=self.time)

    def command(self, value):
        self.commands.append((self.time, value))

    def sleep(self, duration):
        if not 0 < duration <= .1:
            raise AssertionError(f'Unbounded control interval: {duration}')
        self.time += duration

    def run(self):
        run_continuous_orbit(
            self.seed, self.limits, self.check, self.motion, self.command,
            lambda *args: None,
            remember=lambda value: self.remembered.append((self.time, value)),
            diagnostic=lambda *args: self.diagnostics.append((self.time, *args)),
            clock=lambda: self.time, sleep=self.sleep)


class ContinuousOrbitCollisionTests(unittest.TestCase):
    def assert_neutral(self, replay):
        self.assertTrue(replay.commands, 'Every exit must explicitly neutralize PCMD')
        self.assertEqual(replay.commands[-1][1], Control())

    def projected_acceleration(self, replay, at, control):
        # Tilt -> body acceleration, projected onto the independently recorded
        # QR direction. No controller radius, mode or desired velocity is used.
        row = next(row for row in reversed(replay.frames) if row['received_s'] <= at)
        radius = math.hypot(row['forward_m'], row['right_m'])
        forward = 9.81 * math.tan(math.radians(control.pitch * .1))
        right = 9.81 * math.tan(math.radians(control.roll * .1))
        inward = (forward * row['forward_m'] + right * row['right_m']) / radius
        tangent = (forward * row['right_m'] - right * row['forward_m']) / radius
        return inward, tangent

    def test_recorded_startup_aligns_fresh_radius_before_tangential_translation(self):
        replay = VisualReplay(stop=.8)
        old = FIXTURE['initial_propagated']
        replay.seed = RecordedTarget(old['captured_s'], 'recorded-impact-marker',
                                     old['forward_m'], old['right_m'], old['down_m'],
                                     position_source='motion-propagated-fire')
        # Independently measure the mismatch directly from recorded positions.
        self.assertAlmostEqual(math.hypot(old['forward_m'], old['right_m']), .9006, places=3)
        self.assertLess(math.hypot(replay.latest()['forward_m'],
                                   replay.latest()['right_m']), .73)
        with self.assertRaisesRegex(InterruptedError, 'test replay complete'):
            replay.run()
        active = [(at, value) for at, value in replay.commands if value.roll or value.pitch]
        self.assertTrue(active, 'The measured .72 m radius needs active radial alignment')
        at, control = active[0]
        first_position = replay.remembered[0][1]
        first_measured = next(row for row in reversed(replay.frames)
                              if row['received_s'] <= replay.remembered[0][0])
        self.assertAlmostEqual(math.hypot(first_position.forward_m, first_position.right_m),
                               math.hypot(first_measured['forward_m'], first_measured['right_m']),
                               delta=.01,
                               msg='Stationary entry must use the fresh measured radius, not the stale seed')
        for at, control in active:
            inward, tangent = self.projected_acceleration(replay, at, control)
            self.assertLess(inward, -.05,
                            'Move away from the QR to align the measured short radius')
            self.assertLessEqual(abs(tangent), max(.15, .35 * abs(inward)),
                                 'Initial radius alignment must not launch a sideways circle')
        self.assert_neutral(replay)

    def test_recorded_outward_sequence_commands_inward_recovery_before_old_guard(self):
        # Crop after the invalid startup to independently exercise escape
        # protection. The first post-entry capture is at +1.792 s, radius .891 m.
        # All times below remain relative to the original continuous start.
        replay = VisualReplay(start=1.66, stop=3.30)
        try:
            replay.run()
        except InterruptedError:
            pass  # A bounded recovery failure may stop after a correction attempt.
        recovered = []
        for at, control in replay.commands:
            if not 2.44 <= at <= 3.30:
                continue
            inward, tangent = self.projected_acceleration(replay, at, control)
            if inward > .1 and abs(tangent) <= max(.15, .5 * inward):
                recovered.append(at)
        self.assertTrue(recovered,
                        'The increasing measured QR radius must command inward recovery with reduced tangent')
        self.assertLess(min(recovered), FIXTURE['original_speed_guard_s'] - .5)
        # Recorded frames are fixed inputs; they cannot demonstrate that a
        # changed command physically prevents the original wall impact.
        self.assert_neutral(replay)

    def test_acquired_world_location_survives_qr_gaps_with_fresh_motion(self):
        for missing in (True, False):
            with self.subTest(metric_missing=missing):
                replay = VisualReplay(stop=3.)
                fixed = RecordedTarget(0., 'recorded-impact-marker', 1., 0., 1.)
                replay.seed = fixed
                # Supply new valid frames for entry, then either no metric
                # observation or a repeated old capture, while presence and
                # all motion timestamps remain healthy.
                def observed():
                    at = min(replay.time, .4)
                    if missing and replay.time > .4:
                        return None
                    return RecordedTarget(at, fixed.episode, 1., 0., 1.)
                replay.observed = observed
                replay.motion = lambda: Motion(replay.time, 0., 0., 0., 0., 1.)
                with self.assertRaisesRegex(InterruptedError, 'test replay complete'):
                    replay.run()
                self.assertTrue(any(at >= 2. and (value.roll or value.pitch)
                                    for at, value in replay.commands),
                                'Fresh motion must maintain the acquired world-space orbit without repeated QR fixes')
                self.assert_neutral(replay)

    def test_initial_missing_metric_position_never_translates(self):
        replay = VisualReplay(stop=2.)
        replay.seed = RecordedTarget(-10., 'recorded-impact-marker', .9, 0., 1.,
                                     position_source='motion-propagated-fire')
        replay.observed = lambda: None
        with self.assertRaises(InterruptedError):
            replay.run()
        self.assertTrue(all(value.roll == value.pitch == 0 for _, value in replay.commands),
                        'A world-space target must be measured before initial translation')
        self.assert_neutral(replay)


if __name__ == '__main__':
    unittest.main()
