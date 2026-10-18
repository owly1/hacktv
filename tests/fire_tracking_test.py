import json
import math
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import cv2
import numpy as np
from dataclasses import replace
sys.path.insert(0,str(Path(__file__).parents[1]/'bridge'))
from fire_tracking import GroundFirePose,MetricQRPose,FirePose,FireTarget,orbit_fire
from qr_orbit_pose import rotation
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
        for fault in ('operator','lost','jump','vertical-jump'):
            now=[0.];abort=threading.Event();moves=[]
            target=[FireTarget(0,'fire-one',1,0,1.8,.1)]
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
                    if fault=='vertical-jump':target[0]=replace(target[0],down_m=2.5)
                    return offset
            with self.assertRaises(InterruptedError):
                orbit_fire(Driver(),Limits(segments=24),sample,abort,lambda *x:None,'fire-one',
                           started=0,clock=lambda:now[0],sleep=advance)
            self.assertEqual(len(moves),49 if fault=='operator' else 1)

    def test_short_test_keeps_time_and_battery_limits(self):
        now=[0.];abort=threading.Event();moves=[]
        def sample():return Vehicle(now[0],True,'hovering',32,1,0,0),FireTarget(now[0],'fire',1,0,1.8,.1)
        def advance(s):now[0]+=s
        class Driver:
            def move(self,offset,speed,check):moves.append(offset);advance(.5);return offset
        with self.assertRaisesRegex(InterruptedError,'60-second'):
            orbit_fire(Driver(),Limits(segments=24),sample,abort,lambda *x:None,'fire',started=0,
                       clock=lambda:now[0],sleep=advance,min_battery_pct=25,flight_seconds=60)
        self.assertTrue(moves);self.assertLess(now[0],61)
        with self.assertRaises(ValueError):
            orbit_fire(Driver(),Limits(),sample,abort,lambda *x:None,'fire',started=0,min_battery_pct=25,flight_seconds=300)


class MetricPoseTests(unittest.TestCase):
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory();self.addCleanup(self.folder.cleanup)
        self.path=Path(self.folder.name)/'camera.json'
        self.config={'image_size':[1280,720],'camera_matrix':[[1000,0,640],[0,1000,360],[0,0,1]],
                     'distortion_coefficients':[0]*5,'camera_offset_body_m':[.04,0,.01],
                     'qr_black_square_side_m':.16,'qr_pose_verified':True}
        self.save();self.pose=MetricQRPose(self.path)
    def save(self):self.path.write_text(json.dumps(self.config))
    def project(self,target,pitch):
        camera=rotation(0,pitch,0) @ np.array([[0,0,1],[1,0,0],[0,1,0]])
        marker_rotation=np.array([[0,1,0],[1,0,0],[0,0,-1]],dtype=float)
        rvec,_=cv2.Rodrigues(camera.T @ marker_rotation)
        tvec=camera.T @ (np.array(target)-self.pose.offset)
        corners,_=cv2.projectPoints(self.pose.object_points,rvec,tvec,self.pose.k,self.pose.dist)
        return {'source':'qr-test','width':1280,'height':720,'episode_id':'fire',
                'qr_corners':corners.reshape(4,2).tolist()}
    def test_same_floor_and_lower_floor_keep_separate_height_and_radius(self):
        for down in (1.,1.8,2.5):
            pitch=-math.degrees(math.atan2(down,1.))
            obs=self.project([1.,.05,down],pitch)
            for altitude in (0.,1.):
                target=self.pose.estimate(obs,{'altitude_m':altitude,'attitude_deg':{'roll':0,'pitch':0,'yaw':30}},
                    {'roll_absolute':0,'pitch_absolute':pitch,'yaw_absolute':30},1.)
                np.testing.assert_allclose([target.forward_m,target.right_m,target.down_m],[1,.05,down],atol=.002)
                self.assertEqual(target.position_source,'measured-qr-3d')
    def test_missing_size_offset_verification_or_corners_never_authorize_pose(self):
        for field,value in [('qr_black_square_side_m',None),('camera_offset_body_m',[None]*3),('qr_pose_verified',False)]:
            original=self.config[field];self.config[field]=value;self.save()
            with self.assertRaises(ValueError):MetricQRPose(self.path)
            self.config[field]=original
        self.save()
        obs=self.project([1,0,1],-45);obs.pop('qr_corners')
        with self.assertRaisesRegex(ValueError,'corners'):self.pose.estimate(obs,{}, {},1)
    def test_qr_does_not_fall_back_to_a_verified_ground_plane(self):
        self.config['qr_pose_verified']=False;self.config['fire_ground_plane_verified']=True;self.save()
        router=FirePose(self.path)
        self.assertIn('yolo',router.models);self.assertNotIn('qr-test',router.models)
        with self.assertRaisesRegex(ValueError,'verification'):router.estimate(self.project([1,0,1],-45),{},{},1)
    def test_camera_only_diagnostics_never_require_or_set_flight_verification(self):
        self.config['qr_pose_verified']=False;self.config['camera_offset_body_m']=[None]*3;self.save()
        diagnostic=MetricQRPose(self.path,camera_only=True)
        self.assertTrue(diagnostic.camera_only);self.assertFalse(json.loads(self.path.read_text())['qr_pose_verified'])


if __name__=='__main__':unittest.main()
