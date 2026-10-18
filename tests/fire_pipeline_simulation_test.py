"""Offline pixels -> metric pose -> camera aim -> measured-motion orbit.

The renderer independently uses world-coordinate camera basis vectors. This
does not simulate aerodynamics, radio timing, a landing surface or takeoff.
No SDK, network, aircraft object or motor command is available in this test.
"""
import json
import math
from pathlib import Path
import sys
import tempfile
import threading
import unittest

import cv2
import numpy as np

sys.path.insert(0,str(Path(__file__).parents[1]/'bridge'))
from fire_detection import FIRE_MARKER_PAYLOAD,FireDetector
from fire_tracking import MetricQRPose,orbit_fire
from qr_circle_core import camera_pitch
from qr_orbit_core import Limits,Vehicle


def wrap(angle):
    return math.atan2(math.sin(angle),math.cos(angle))


def heading_basis(yaw):
    c,s=math.cos(yaw),math.sin(yaw)
    return np.array([[c,-s,0],[s,c,0],[0,0,1.]])


def camera_basis(roll,pitch,yaw):
    """Columns are camera right/down/forward expressed in world XYZ-down."""
    c,s=math.cos(yaw),math.sin(yaw)
    forward=np.array([c*math.cos(pitch),s*math.cos(pitch),-math.sin(pitch)])
    right=np.array([-s,c,0.]);down=np.cross(forward,right)
    return np.column_stack((math.cos(roll)*right+math.sin(roll)*down,
                            -math.sin(roll)*right+math.cos(roll)*down,forward))


class PixelWorld:
    """The target stays fixed; only measured displacement changes the aircraft."""
    def __init__(self,pose,*,below_launch):
        self.pose=pose;self.now=0.;self.abort=threading.Event()
        self.target_world=np.array([0.,0.,below_launch])
        self.yaw=math.radians(37.)
        self.position=-heading_basis(self.yaw)@np.array([.70,.12,0.]);self.position[2]=-1.
        self.pitch=math.radians(-55. if below_launch else -45.)
        self.camera_roll=math.radians(1.5);self.camera_yaw_offset=math.radians(6.)
        self.detector=FireDetector('',use_yolo=False)
        encoded=cv2.QRCodeEncoder.create().encode(FIRE_MARKER_PAYLOAD)
        self.texture=cv2.resize(encoded,None,fx=8,fy=8,interpolation=cv2.INTER_NEAREST)
        # The encoder includes two white modules. Physical size describes the
        # black QR square, so pixel edges (not quiet-zone edges) are projected.
        lo=2*8-.5;hi=(encoded.shape[0]-2)*8-.5
        self.source=np.array([[lo,lo],[hi,lo],[hi,hi],[lo,hi]],np.float32)
        side=pose.side/2
        corners=np.array([[side,-side,0],[side,side,0],[-side,side,0],[-side,-side,0]])
        self.marker_world=self.target_world+corners@heading_basis(math.radians(17.)).T
        self.moves=[];self.reports=[];self.swept=0.;self.radii=[]
        self.capture_at=float('-inf');self.observed=None;self.last_observation=None;self.last_gimbal=None;self.occluded_until=0.
        self.occlusions=[];self.decoded=0;self.template=0;self.pose_samples=0;self.pose_errors=[]
        self.geometry_rejections=[];self.render_count=0

    def render(self):
        gimbal_yaw=self.yaw+self.camera_yaw_offset
        axes=camera_basis(self.camera_roll,self.pitch,gimbal_yaw)
        lens=self.position+heading_basis(self.yaw)@self.pose.offset
        rays=(self.marker_world-lens)@axes
        if np.any(rays[:,2]<=0):return np.full((720,1280,3),180,np.uint8)
        projected=(rays[:,:2]/rays[:,2,None])@self.pose.k[:2,:2].T+self.pose.k[:2,2]
        transform=cv2.getPerspectiveTransform(self.source,projected.astype(np.float32))
        gray=cv2.warpPerspective(self.texture,transform,(1280,720),flags=cv2.INTER_LINEAR,borderValue=180)
        self.render_count+=1
        return cv2.cvtColor(gray,cv2.COLOR_GRAY2BGR)

    def sample(self):
        if self.now-self.capture_at>=.2-1e-9:
            self.capture_at=self.now
            hidden=self.now<self.occluded_until
            image=np.full((720,1280,3),180,np.uint8) if hidden else self.render()
            hit=self.detector.detect(image,captured_at=self.now+1000)
            self.observed=None
            if hit is not None:
                observation={**hit,'width':1280,'height':720,'episode_id':'simulated-fire'}
                telemetry={'altitude_m':-self.position[2],
                           'attitude_deg':{'roll':0.,'pitch':0.,'yaw':math.degrees(self.yaw)}}
                gimbal={'roll_absolute':math.degrees(self.camera_roll),'pitch_absolute':math.degrees(self.pitch),
                        'yaw_absolute':math.degrees(self.yaw+self.camera_yaw_offset)}
                self.last_observation=observation;self.last_gimbal=gimbal
                try:
                    self.observed=self.pose.estimate(observation,telemetry,gimbal,self.now)
                    expected=heading_basis(self.yaw).T@(self.target_world-self.position)
                    measured=np.array([self.observed.forward_m,self.observed.right_m,self.observed.down_m])
                    self.pose_errors.append(float(np.linalg.norm(measured-expected)))
                    self.pose_samples+=1
                    self.decoded+=hit['qr_tracking']=='decoded';self.template+=hit['qr_tracking']=='visual-template'
                    # The camera actuator receives a quantized pitch target;
                    # geometry is re-estimated from pixels at that new pitch.
                    self.pitch=math.radians(round(camera_pitch(self.observed,self.pose.offset),1))
                except ValueError as error:self.geometry_rejections.append(str(error))
        return Vehicle(self.now,True,'hovering',80,1.,0.,0.),self.observed

    def advance(self,seconds):self.now+=seconds

    def report(self,phase,message,*args):self.reports.append((self.now,phase,message))

    def move(self,requested,speed,check):
        check()
        if self.now<self.occluded_until:raise AssertionError('Movement began during image occlusion')
        distance=math.hypot(*requested[:2])
        fraction=max(0.,1-.1/distance) if distance else 1.
        actual=(requested[0]*fraction,requested[1]*fraction,requested[2],requested[3])
        old_angle=math.atan2(*(self.position-self.target_world)[[1,0]])
        start_position=self.position.copy();start_yaw=self.yaw
        world_delta=heading_basis(start_yaw)@np.array(actual[:3])
        duration=max(.25,distance/speed,abs(actual[3])/math.radians(25.))
        count=math.ceil(duration/.2)
        # The real monitor continues processing while an SDK move is pending.
        # Do not teleport a 15-degree turn past the optical tracker.
        for step in range(1,count+1):
            self.position=start_position+world_delta*(step/count)
            self.yaw=start_yaw+actual[3]*(step/count)
            self.advance(duration/count)
            self.sample()
        new_angle=math.atan2(*(self.position-self.target_world)[[1,0]])
        self.swept+=wrap(new_angle-old_angle)
        self.radii.append(float(np.linalg.norm((self.position-self.target_world)[:2])))
        self.moves.append((self.now-duration,requested,actual))
        if len(self.moves)==8:
            self.occluded_until=self.now+1.2;self.occlusions.append((self.now,self.occluded_until))
        if self.swept>=2*math.pi:self.abort.set()
        return actual


class FirePipelineSimulationTests(unittest.TestCase):
    def world(self,below_launch):
        folder=tempfile.TemporaryDirectory();self.addCleanup(folder.cleanup)
        path=Path(folder.name)/'camera.json'
        path.write_text(json.dumps({'image_size':[1280,720],
            'camera_matrix':[[928.,0,630.7],[0,926.,358.9],[0,0,1]],
            'distortion_coefficients':[0]*5,'camera_offset_body_m':[.08,0,0],
            'qr_black_square_side_m':.12,'qr_pose_verified':True}))
        return PixelWorld(MetricQRPose(path),below_launch=below_launch)

    def test_pixels_and_actual_pose_drive_complete_circles_above_both_target_levels(self):
        for below_launch in (0.,.8):
            with self.subTest(below_launch=below_launch):
                world=self.world(below_launch)
                with self.assertRaisesRegex(InterruptedError,'Operator requested landing'):
                    orbit_fire(world,Limits(segments=24),world.sample,world.abort,world.report,'simulated-fire',
                               started=0,clock=lambda:world.now,sleep=world.advance)
                self.assertGreaterEqual(world.swept,2*math.pi)
                self.assertGreater(world.decoded,5)
                self.assertGreater(world.render_count,30)
                self.assertGreater(world.pose_samples,100)
                # Rasterized ~50 px markers have a finite localization error;
                # compare against independent world truth, not requested moves.
                self.assertLess(max(world.pose_errors),.10)
                self.assertLess(max(abs(radius-1.) for radius in world.radii[8:]),.15)
                self.assertGreater(len(world.moves),24)  # Shortfalls require more than 24 requests/lap.
                self.assertEqual(len(world.occlusions),1)
                start,end=world.occlusions[0]
                self.assertFalse(any(start<=at<end for at,*_ in world.moves))
                self.assertTrue(any(phase=='recover' and start<=at<end for at,phase,_ in world.reports))
                self.assertGreater(world.yaw,2*math.pi)  # Absolute-yaw wrap was crossed.
                self.assertEqual(world.position[2],-1.)
                self.assertLess(world.now,300.)

    def test_wrong_marker_scale_is_visible_in_independent_climb_geometry(self):
        world=self.world(.8)
        folder=tempfile.TemporaryDirectory();self.addCleanup(folder.cleanup)
        path=Path(folder.name)/'wrong-size.json'
        path.write_text(json.dumps({'image_size':[1280,720],
            'camera_matrix':world.pose.k.tolist(),'distortion_coefficients':[0]*5,
            'camera_offset_body_m':[.08,0,0],'qr_black_square_side_m':.18,'qr_pose_verified':True}))
        wrong=MetricQRPose(path);correct_down=[];wrong_down=[]
        for height in (.2,1.2):
            world.position[2]=-height
            relative=heading_basis(world.yaw).T@(world.target_world-world.position)-world.pose.offset
            world.pitch=-math.atan2(relative[2],math.hypot(*relative[:2]))
            world.advance(.2);_,target=world.sample()
            self.assertIsNotNone(target)
            telemetry={'altitude_m':height,'attitude_deg':{'roll':0.,'pitch':0.,'yaw':math.degrees(world.yaw)}}
            incorrect=wrong.estimate(world.last_observation,telemetry,world.last_gimbal,world.now)
            correct_down.append(target.down_m);wrong_down.append(incorrect.down_m)
        self.assertAlmostEqual(correct_down[1]-correct_down[0],1.,delta=.10)
        self.assertGreater(abs((wrong_down[1]-wrong_down[0])-1.),.35)


if __name__=='__main__':unittest.main()
