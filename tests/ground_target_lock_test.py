"""Grounded metric consensus prevents one good decode from freezing a bad pose."""
from dataclasses import replace
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).parents[1]/'bridge'))
from fire_tracking import FireTarget,GroundTargetLock


class GroundLockTests(unittest.TestCase):
    def target(self,at,**changes):
        return replace(FireTarget(at,'fire',.6,0,.8,.12),**changes)

    def test_distinct_coherent_poses_and_time_span_are_required(self):
        lock=GroundTargetLock()
        for _ in range(10):lock.observe(self.target(0),0.)
        self.assertFalse(lock.ready(0,'fire'))
        for at in (.2,.4,.6,.81):lock.observe(self.target(at),0.)
        self.assertTrue(lock.ready(.81,'fire'))
        self.assertFalse(lock.ready(1.62,'fire'))
        self.assertFalse(lock.ready(.81,'another-fire'))

    def test_outlier_new_episode_or_long_gap_restarts_grounded_confirmation(self):
        for changed in (self.target(1,forward_m=1.),self.target(1,episode='other'),self.target(2.)):
            lock=GroundTargetLock()
            for at in (0,.2,.4,.6,.81):lock.observe(self.target(at),0.)
            lock.observe(changed,0.)
            self.assertFalse(lock.ready(changed.at,changed.episode))
            self.assertEqual(len(lock.samples),1)

    def test_anchor_uses_window_median_and_received_altitude(self):
        lock=GroundTargetLock()
        for i,down in enumerate((.8,.81,.79,.80,.91)):
            lock.observe(self.target(i*.25,down_m=down),.1)
        self.assertTrue(lock.ready(1.,'fire'))
        self.assertAlmostEqual(lock.vertical_anchor(),.7)
        lock.clear();self.assertFalse(lock.ready(1.,'fire'))


if __name__=='__main__':unittest.main()
