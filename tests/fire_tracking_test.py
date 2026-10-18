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

    def test_undershoot_replans_from_observed_position_and_completes_laps(self):
        for stuck in (False,True):
            now=[0.];abort=threading.Event();moves=[];phases=[];swept=[0.];messages=[]
            target=[FireTarget(0,'fire',.65,0,1.5,.12)]
            def advance(s):
                now[0]+=s;target[0]=replace(target[0],at=now[0])
            def sample():return Vehicle(now[0],True,'hovering',80,1,0,0),target[0]
            class Driver:
                def move(self,offset,speed,check):
                    check();moves.append(offset)
                    # Real short-move behavior: stop 10 cm early, but complete yaw.
                    length=math.hypot(*offset[:2])
                    scale=0 if stuck else max(0,1-.10/length) if length else 1
                    dx,dy=offset[0]*scale,offset[1]*scale
                    yaw=0 if stuck else offset[3]
                    t=target[0];x,y=t.forward_m-dx,t.right_m-dy
                    swept[0]+=math.atan2(y,x)-math.atan2(t.right_m,t.forward_m)
                    target[0]=replace(t,forward_m=math.cos(yaw)*x+math.sin(yaw)*y,
                                     right_m=-math.sin(yaw)*x+math.cos(yaw)*y)
                    advance(.5)
                    if swept[0]>=4*math.pi:abort.set()
                    return dx,dy,0,yaw
            def report(phase,message,*args):phases.append(phase);messages.append(message)
            with self.assertRaisesRegex(InterruptedError,'insufficient progress' if stuck else 'Operator'):
                orbit_fire(Driver(),Limits(segments=24),sample,abort,report,
                           'fire',started=0,clock=lambda:now[0],sleep=advance)
            if stuck:self.assertEqual(len(moves),3)
            else:
                self.assertGreaterEqual(swept[0],4*math.pi)
                self.assertIn('climb',phases);self.assertIn('circle',phases)
                self.assertLess(abs(math.hypot(target[0].forward_m,target[0].right_m)-1),.15)
                self.assertIn('Tracking fire · lap 2',messages)
                self.assertNotIn('Tracking fire · lap 3',messages)

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

    def test_transient_target_loss_holds_then_resumes_without_blind_moves(self):
        for fault in ('miss','outlier','stale','episode'):
            now=[0.];abort=threading.Event();moves=[];reports=[];recover_until=[0.]
            def sample():
                t=FireTarget(now[0],'fire',1,0,1.5,.12)
                if moves and now[0]<recover_until[0]:
                    t=(None if fault=='miss' else replace(t,forward_m=2) if fault=='outlier'
                       else replace(t,at=now[0]-5) if fault=='stale' else replace(t,episode='other'))
                return Vehicle(now[0],True,'hovering',80,1,0,0),t
            def advance(s):now[0]+=s
            class Driver:
                def move(self,offset,speed,check):
                    self.assert_recovered()
                    moves.append(now[0]);advance(.5)
                    if len(moves)==1:recover_until[0]=now[0]+2.5
                    if len(moves)==2:abort.set()
                    check()
                    return offset
                def assert_recovered(self):
                    if moves and now[0]<recover_until[0]:raise AssertionError('Moved without recovery')
            with self.assertRaisesRegex(InterruptedError,'Operator'):
                orbit_fire(Driver(),Limits(segments=24),sample,abort,lambda *x:reports.append(x),
                           'fire',started=0,clock=lambda:now[0],sleep=advance)
            self.assertEqual(len(moves),2)
            self.assertGreaterEqual(moves[1],recover_until[0]+.3-1e-6)
            self.assertTrue(any(r[0]=='recover' for r in reports))

    def test_recovery_obeys_land_battery_and_deadline(self):
        for fault,message in [('land','Operator'),('battery','battery'),('missing','bounded hover')]:
            now=[0.];abort=threading.Event();moves=[]
            def advance(s):
                now[0]+=s
                if fault=='land' and now[0]>3:abort.set()
            def sample():
                v=Vehicle(now[0],True,'hovering',20 if fault=='battery' and now[0]>3 else 80,1,0,0)
                return v,None if moves else FireTarget(now[0],'fire',1,0,1.5,.12)
            class Driver:
                def move(self,offset,speed,check):moves.append(now[0]);advance(.5);return offset
            with self.assertRaisesRegex(InterruptedError,message):
                orbit_fire(Driver(),Limits(segments=24),sample,abort,lambda *x:None,
                           'fire',started=0,clock=lambda:now[0],sleep=advance)
            self.assertEqual(len(moves),1)
            self.assertLess(now[0],10)

    def test_missing_displacement_never_becomes_an_assumed_successful_move(self):
        now=[0.]
        def sample():return Vehicle(now[0],True,'hovering',80,1,0,0),FireTarget(now[0],'fire',1,0,1.5,.12)
        def advance(s):now[0]+=s
        class Driver:
            def move(self,*args):return None
        with self.assertRaisesRegex(InterruptedError,'measured displacement'):
            orbit_fire(Driver(),Limits(segments=24),sample,threading.Event(),lambda *x:None,
                       'fire',started=0,clock=lambda:now[0],sleep=advance)

    def test_timed_hardware_path_hands_off_to_continuous_control(self):
        calls=[];target=FireTarget(0.,'fire',1.,0.,1.1,.12)
        def sample():return Vehicle(0.,True,'hovering',80,1.1,0,0),target
        class Driver:
            supports_continuous_orbit=True
            def move(self,*args):raise AssertionError('Timed orbit must not stop at each chord')
            def orbit_continuously(self,initial,limits,check,report,remember,**kwargs):
                calls.append((initial,limits));check()
                raise InterruptedError('test completed handoff')
        with self.assertRaisesRegex(InterruptedError,'handoff'):
            orbit_fire(Driver(),Limits(segments=24,speed_mps=.6,lap_seconds=15),sample,
                       threading.Event(),lambda *x:None,'fire',started=0,clock=lambda:0.,
                       last_seen=lambda:0.)
        self.assertEqual(calls[0][0],target)

    def test_alignment_corrects_height_drift_before_entering_orbit(self):
        for height in (.88,1.12):
            with self.subTest(height=height):
                moves=[];abort=threading.Event()
                def sample():return Vehicle(0.,True,'hovering',80,height,0,0),FireTarget(0.,'fire',.6,0,1,.12)
                class Driver:
                    def move(self,offset,speed,check):
                        moves.append(offset);abort.set();return offset
                with self.assertRaisesRegex(InterruptedError,'Operator'):
                    orbit_fire(Driver(),Limits(segments=24),sample,abort,lambda *x:None,'fire',
                               started=0,clock=lambda:0.,sleep=lambda _:None,last_seen=lambda:0.)
                self.assertAlmostEqual(moves[0][2],.7*(height-1.))

    def test_off_radius_and_heading_enter_live_feedback_without_blocking_alignment(self):
        # Actual first and final measured poses from flight 105541. The old
        # alignment moved once, then rejected the second pose by 47 cm.
        for forward,right,down in ((1.159495,.295137,.807095),(.62615,.00447,.87092),(.65,0,1)):
            with self.subTest(forward=forward,right=right):
                target=FireTarget(-.25,'fire',forward,right,down,.144)
                handoff=[];remembered=[]
                def sample():return Vehicle(0.,True,'hovering',80,1.,0.,0.),target
                class Driver:
                    supports_continuous_orbit=True
                    def move(self,*args):
                        raise AssertionError('Blocking alignment loses live inward-facing control')
                    def orbit_continuously(self,initial,limits,check,*args,**kwargs):
                        check();handoff.append(initial)
                        raise InterruptedError('measured handoff')
                with self.assertRaisesRegex(InterruptedError,'measured handoff'):
                    orbit_fire(Driver(),Limits(segments=24,speed_mps=.6,lap_seconds=15),sample,
                               threading.Event(),lambda *args:None,'fire',started=0.,
                               clock=lambda:0.,last_seen=lambda:0.,remember=remembered.append)
                self.assertEqual(handoff,[target])
                self.assertEqual(remembered,[target])


class MetricPoseTests(unittest.TestCase):
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory();self.addCleanup(self.folder.cleanup)
        self.path=Path(self.folder.name)/'camera.json'
        self.config={'image_size':[1280,720],'camera_matrix':[[1000,0,640],[0,1000,360],[0,0,1]],
                     'distortion_coefficients':[0]*5,'camera_offset_body_m':[.04,0,.01],
                     'qr_black_square_side_m':.16,'qr_pose_verified':True}
        self.save();self.pose=MetricQRPose(self.path)
    def save(self):self.path.write_text(json.dumps(self.config))
    def project(self,target,pitch,size_ratio=1.):
        camera=rotation(0,pitch,0) @ np.array([[0,0,1],[1,0,0],[0,1,0]])
        marker_rotation=np.array([[0,1,0],[1,0,0],[0,0,-1]],dtype=float)
        rvec,_=cv2.Rodrigues(camera.T @ marker_rotation)
        tvec=camera.T @ (np.array(target)-self.pose.offset)
        corners,_=cv2.projectPoints(self.pose.object_points*size_ratio,rvec,tvec,self.pose.k,self.pose.dist)
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

    def test_nominal_pnp_exposes_size_independent_translation_for_climb_scaling(self):
        actual=np.array([1.,.05,1.8]);telemetry={'attitude_deg':{'roll':0.,'pitch':0.,'yaw':0.}}
        camera={'roll_absolute':0.,'pitch_absolute':-60.,'yaw_absolute':0.}
        origin=self.pose.origin(telemetry)
        for side in (.06,.12,.25):
            observation=self.project(actual,-60.,size_ratio=side/self.pose.side)
            nominal=self.pose.estimate(observation,telemetry,camera,1.,enforce_envelope=False)
            unit=(np.array([nominal.forward_m,nominal.right_m,nominal.down_m])-origin)/self.pose.side
            np.testing.assert_allclose(unit*side+origin,actual,atol=.002)
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
