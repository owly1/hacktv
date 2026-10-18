"""A returning QR must resolve contradictory odometry before more orbiting.

This is a perception/telemetry replay, not a flight dynamics model. The motion
stream keeps reporting a one-metre circle while independently generated QR
observations reveal a displaced aircraft after a visual gap. Commands cannot
change those recorded inputs; tests therefore require an active correction,
then stop through the operator callback before a recovery timeout.
"""
from dataclasses import dataclass
import math
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parents[1] / 'bridge'))
from continuous_orbit import Control, Motion, run_continuous_orbit
from qr_orbit_core import Limits, Vehicle


@dataclass(frozen=True)
class ReacquiredTarget:
    at: float
    episode: str
    forward_m: float
    right_m: float
    down_m: float = 1.18
    width_m: float = .12
    position_source: str = 'measured-qr-3d'
    position_uncertainty_m: float = .1


class ReacquisitionReplay:
    def __init__(self, rate_hz, *, growing=True):
        self.now = 0.
        self.rate_hz = rate_hz
        self.growing = growing
        self.events, self.commands = [], []
        self.limits = Limits(segments=24, speed_mps=.6, lap_seconds=15.)

    @staticmethod
    def angle(at):
        # Initially still, so a true measured centre can be acquired.
        return .45 * max(0., at - .4)

    def target(self):
        if 1 <= self.now < 4:
            return None
        captured = math.floor((self.now - .25) * self.rate_hz + 1e-8) / self.rate_hz
        if self.now < 1:
            return ReacquiredTarget(captured, 'fixed-fire', 1., 0.)
        if self.growing:
            # An actual outward spiral: by return, position disagreement is
            # already >60 cm and continues growing 40 cm every second.
            radius = 1 + .4 * max(0., captured - 2)
            return ReacquiredTarget(captured, 'fixed-fire', radius, 0.)
        # A constant 80 cm world-frame odometry offset. At high observation
        # rates a fixed six-element deque cannot span a one-second window.
        angle = self.angle(captured)
        return ReacquiredTarget(captured, 'fixed-fire',
                                1 - .8 * math.cos(angle), .8 * math.sin(angle))

    def check(self):
        if self.now >= 5.6:
            raise InterruptedError('operator ends reacquisition replay')
        return Vehicle(self.now, True, 'flying', 80, 1.,
                       .45 if self.now > .4 else 0., 0.), self.target()

    def motion(self):
        angle = self.angle(self.now)
        speed = .45 if self.now > .4 else 0.
        return Motion(self.now, angle, speed * math.sin(angle),
                      -speed * math.cos(angle), 0., 1., self.now)

    def sleep(self, duration):
        self.now += duration

    def command(self, control):
        self.commands.append((self.now, control))

    def run(self):
        run_continuous_orbit(
            self.target(), self.limits, self.check, self.motion, self.command,
            lambda *args: None,
            diagnostic=lambda kind, data: self.events.append((self.now, kind, data)),
            clock=lambda: self.now, sleep=self.sleep)


class ContinuousOrbitReacquisitionTests(unittest.TestCase):
    def assert_active_recovery(self, replay):
        with self.assertRaisesRegex(InterruptedError, 'operator ends'):
            replay.run()
        starts = [(at, data) for at, kind, data in replay.events
                  if kind == 'orbit_radial_recovery_started' and at >= 4]
        self.assertTrue(starts, 'Returning coherent QR measurements must start radius recovery')
        self.assertLess(starts[0][0], 5.3,
                        'Give coherent returning measurements a bounded acquisition window')
        corrections = [data for at, kind, data in replay.events
                       if at >= 4 and kind == 'continuous_target_corrected']
        self.assertTrue(corrections, 'Do not permanently reject real drift larger than60 cm')
        recovery = [data for at, kind, data in replay.events
                    if at >= 4 and kind == 'continuous_orbit'
                    and data['recovering_radius']]
        self.assertTrue(any(data['desired_tangent_mps'] == 0
                            and data['desired_radial_mps'] > .15 for data in recovery),
                        'The response must prioritize inward translation before ending the replay')
        self.assertTrue(any(data['radius_m'] > 1.25 for data in recovery),
                        'Returning visual evidence must correct the reassuring one-metre pose')
        self.assertTrue(any(at >= starts[0][0] and control.pitch > 10
                            for at, control in replay.commands),
                        'Recovery needs a physical forward/inward PCMD component')
        self.assertEqual(replay.commands[-1][1], Control())

    def test_growing_disagreement_after_gap_recovers_at_five_and_ten_hz(self):
        for rate in (5, 10):
            with self.subTest(rate_hz=rate):
                self.assert_active_recovery(ReacquisitionReplay(rate, growing=True))

    def test_stable_large_offset_does_not_depend_on_six_frame_window(self):
        for rate in (10, 20):
            with self.subTest(rate_hz=rate):
                self.assert_active_recovery(ReacquisitionReplay(rate, growing=False))


if __name__ == '__main__':
    unittest.main()
