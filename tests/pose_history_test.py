import math
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).parents[1]/'bridge'))
from pose_history import PoseHistory


class PoseHistoryTests(unittest.TestCase):
    def test_interpolates_capture_pose_and_wraps_yaw_without_using_newest_cache(self):
        history=PoseHistory()
        for at,h,yaw,pitch in [(10.,0.,179.,-30.),(10.2,.4,-179.,-50.),(10.4,1.,-170.,-70.)]:
            history.record('altitude',at,{'altitude':h})
            history.record('attitude',at,{'yaw':math.radians(yaw),'roll':0.,'pitch':0.})
            history.record('camera',at,{'yaw_absolute':yaw,'pitch_absolute':pitch,'roll_absolute':0.})
        pose=history.snapshot_at(10.1)
        self.assertAlmostEqual(pose['altitude']['altitude'],.2)
        self.assertAlmostEqual(math.degrees(pose['attitude']['yaw']),180.)
        self.assertAlmostEqual(pose['camera']['yaw_absolute'],180.)
        self.assertAlmostEqual(pose['camera']['pitch_absolute'],-40.)
        self.assertEqual(pose['sample_times']['camera'],[10.,10.2])

    def test_missing_stale_future_and_discontinuous_pose_are_rejected(self):
        history=PoseHistory()
        with self.assertRaises(ValueError):history.snapshot_at(10.)
        for name in history.samples:history.record(name,10.,{'value':1.})
        for at in (9.8,10.2,20.):
            with self.assertRaises(ValueError):history.snapshot_at(at)
        for name in history.samples:history.record(name,11.,{'value':2.})
        with self.assertRaises(ValueError):history.snapshot_at(10.5)

if __name__=='__main__':unittest.main()
