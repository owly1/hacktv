import json
import math
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from dataclasses import replace
sys.path.insert(0,str(Path(__file__).parents[1]/'bridge'))
from fire_tracking import GroundFirePose,FireTarget,orbit_fire
from qr_orbit_core import Limits,Vehicle


class TrackingTests(unittest.TestCase):
    def config(self):
        return {'fire_ground_plane_verified':True,'image_size':[1280,720],
                'camera_matrix':[[1000,0,640],[0,1000,360],[0,0,1]],
                'distortion_coefficients':[0]*5,'camera_offset_body_m':[0,0,0]}
    def pose(self,config=None):
        folder=tempfile.TemporaryDirectory();self.addCleanup(folder.cleanup)
        path=Path(folder.name)/'camera.json';path.write_text(json.dumps(config or self.config()))
        return GroundFirePose(path)
    def observation(self):
        return {'width':1280,'height':720,'bbox':[.45,.4,.55,.5],'source':'yolo','episode_id':'fire-one'}
    def test_calibrated_ray_locates_actual_fire_base_and_camera_heading(self):
        pose=self.pose(); telemetry={'altitude_m':1,'attitude_deg':{'roll':0,'pitch':0,'yaw':40}}
        gimbal={'roll_absolute':0,'pitch_absolute':-45,'yaw_absolute':40}
        target=pose.estimate(self.observation(),telemetry,gimbal,10)
        self.assertAlmostEqual(target.forward_m,1);self.assertAlmostEqual(target.right_m,0)
        observation=self.observation();observation['bbox']=[.55,.4,.65,.5]
        shifted=pose.estimate(observation,telemetry,gimbal,10)
        self.assertGreater(shifted.right_m,.1)
        gimbal['yaw_absolute']=50
        turned=pose.estimate(self.observation(),telemetry,gimbal,10)
        self.assertGreater(turned.right_m,.1)
    def test_unverified_or_unknown_geometry_never_produces_a_target(self):
        for edit in ({'fire_ground_plane_verified':False},{'camera_offset_body_m':[None]*3}):
            with self.assertRaises(ValueError):self.pose({**self.config(),**edit})
        pose=self.pose(); telemetry={'altitude_m':1,'attitude_deg':{'roll':0,'pitch':0,'yaw':0}}
        for edit,gimbal in [({'bbox':[0,.2,.3,.6]}, {'roll_absolute':0,'pitch_absolute':-45,'yaw_absolute':0}),
                            ({}, {'roll_absolute':0,'pitch_absolute':0,'yaw_absolute':0}),
                            ({'width':640}, {'roll_absolute':0,'pitch_absolute':-45,'yaw_absolute':0})]:
            with self.assertRaises(ValueError):pose.estimate({**self.observation(),**edit},telemetry,gimbal,0)
    def test_repeated_measured_circles_and_lost_target_stop_movement(self):
        for fault in ('operator','lost','jump'):
            now=[0.];abort=threading.Event();moves=[]
            target=[FireTarget(0,'fire-one',1,0,1,.1)]
            def advance(s):
                now[0]+=s
                if target[0]:target[0]=replace(target[0],at=now[0])
            def sample():return Vehicle(now[0],True,'hovering',80,1,0,0),target[0]
            class Driver:
                def move(self,offset,speed,check):
                    moves.append(offset);advance(.5)
                    if fault=='operator' and len(moves)==49:abort.set()
                    if fault=='lost':target[0]=None
                    if fault=='jump':target[0]=replace(target[0],forward_m=2)
                    return offset
            with self.assertRaises(InterruptedError):
                orbit_fire(Driver(),Limits(segments=24),sample,abort,lambda *x:None,'fire-one',
                           started=0,clock=lambda:now[0],sleep=advance)
            self.assertEqual(len(moves),49 if fault=='operator' else 1)


if __name__=='__main__':unittest.main()
