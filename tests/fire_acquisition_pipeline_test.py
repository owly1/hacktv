"""Rendered takeoff, delayed vision, QR recovery, scale acquisition and orbit.

Regression for 20261018T100712Z: auto-takeoff outruns image tracking, then
the camera freezes before QR scale is known. No SDK or network is available.
The aircraft/gimbal dynamics here are a test model, not hardware validation.
"""
from collections import deque
from dataclasses import replace
import math
import unittest

import numpy as np

import fire_pipeline_simulation_test as pipeline
from camera_search import AcquisitionAim, BearingAim, image_bearing_pitch
from fire_tracking import orbit_fire
from qr_circle_core import camera_pitch
from qr_orbit_core import Limits, Vehicle
from qr_scale import AdaptiveQRScale


class AcquisitionWorld(pipeline.PixelWorld):
    def __init__(self, pose, *, recovery, distance=.52, below_launch=.25):
        super().__init__(pose, below_launch=below_launch)
        self.now=-2.
        self.occluded_until=float('-inf')
        self.position=-pipeline.heading_basis(self.yaw)@np.array([distance, 0., 0.])
        self.camera_roll=0.;self.camera_yaw_offset=0.
        self.pitch=-math.atan2(below_launch,distance-pose.offset[0])
        # The recorded QR is on an inclined laptop screen. Give the bitmap
        # an independent world-space plane; PnP must recover its translation.
        tilt=math.radians(35);c,s=math.cos(tilt),math.sin(tilt)
        tilt_basis=np.array([[c,0,s],[0,1,0],[-s,0,c]])
        half=pose.side/2
        corners=np.array([[half,-half,0],[half,half,0],[-half,half,0],[-half,-half,0]])
        self.marker_world=self.target_world+corners@tilt_basis.T@pipeline.heading_basis(self.yaw).T
        self.command=math.degrees(self.pitch)
        self.aim=AcquisitionAim() if recovery else BearingAim()
        self.recovery=recovery
        self.scale=AdaptiveQRScale(rough=True)
        self.fit=None;self.fit_at=None
        self.queue=deque();self.last_seen=None;self.remembered=None
        self.acquiring=True;self.search_times=[];self.sightings=[]
        self.first_move=None
        self.calibration={'image_size':list(pose.size),
                          'camera_matrix':pose.k.tolist(),
                          'distortion_coefficients':pose.dist.tolist()}

    def sample(self):
        # Preserve the frame's actual capture pose across 250 ms processing
        # delay. At 1 m/s takeoff that delay is a material vertical change.
        if self.now-self.capture_at>=.2-1e-9:
            self.capture_at=self.now
            hidden=(.15<=self.now<=1.5 or self.now<self.occluded_until)
            image=np.full((720,1280,3),180,np.uint8) if hidden else self.render()
            hit=self.detector.detect(image,captured_at=self.now+1000)
            telemetry={'altitude_m':-self.position[2],
                       'attitude_deg':{'roll':0.,'pitch':0.,'yaw':math.degrees(self.yaw)}}
            gimbal={'roll_absolute':0.,'pitch_absolute':math.degrees(self.pitch),
                    'yaw_absolute':math.degrees(self.yaw)}
            self.queue.append((self.now+.25,self.now,hit,telemetry,gimbal))
        while self.queue and self.queue[0][0]<=self.now+1e-9:
            _,captured,hit,pose,gimbal=self.queue.popleft()
            if hit is None:continue
            observation={**hit,'width':1280,'height':720,'episode_id':'simulated-fire'}
            pitch=image_bearing_pitch(observation,self.calibration,gimbal)
            if self.recovery:self.aim.observe(captured,pitch,pose['altitude_m'])
            else:self.aim.observe(captured,pitch)
            if hit.get('qr_tracking','decoded') in ('decoded','visual-template'):
                self.last_seen=captured;self.sightings.append(captured)
            try:
                nominal=self.pose.estimate(observation,pose,gimbal,captured,enforce_envelope=False)
                origin=self.pose.origin(pose)
                unit=(np.array([nominal.forward_m,nominal.right_m,nominal.down_m])-origin)/self.pose.side
                if self.fit is None:
                    self.fit=self.scale.observe(float(unit[2]),pose['altitude_m'],float(origin[2]),at=captured)
                    if self.fit is not None:self.fit_at=self.now
                if self.fit is not None:
                    metric=unit*self.fit.side_m+origin
                    self.observed=replace(nominal,forward_m=float(metric[0]),right_m=float(metric[1]),
                                          down_m=float(metric[2]),width_m=self.fit.side_m)
            except ValueError as error:
                self.observed=None
                self.geometry_rejections.append(str(error))
        if self.recovery:
            command=self.aim.step(self.now,altitude=-self.position[2],actual_pitch=math.degrees(self.pitch),
                                  bounds=(-85.,85.),reacquire=self.acquiring)
            if self.aim.state=='searching':self.search_times.append(self.now)
        else:command=self.aim.predict(self.now)
        if command is None and self.remembered is not None:
            command=camera_pitch(self.remembered,self.pose.offset)
        if command is not None:self.command=command
        target=self.observed if self.observed is not None and self.now-self.observed.at<=1 else None
        state='hovering' if self.now>=1 else 'takingoff' if self.now>=0 else 'landed'
        return Vehicle(self.now,True,state,80,-self.position[2],0.,0.),target

    def advance(self,seconds):
        end=self.now+seconds
        while self.now<end-1e-9:
            dt=min(.05,end-self.now);self.now+=dt
            if self.acquiring:self.position[2]=-min(1.,max(0.,self.now))
            # Finite actuator speed; no camera teleportation to requested pitch.
            actual=math.degrees(self.pitch)
            self.pitch=math.radians(actual+max(-30*dt,min(30*dt,self.command-actual)))
            self.sample()
        self.now=end

    def remember(self,target):self.remembered=target

    def move(self,requested,speed,check):
        if self.fit is None:raise AssertionError('Moved before metric QR scale was available')
        if self.first_move is None:self.first_move=self.now
        actual=super().move(requested,speed,check)
        # This regression injects its loss during takeoff. The base world's
        # separate mid-orbit occlusion is covered by its own integration test.
        self.occluded_until=float('-inf')
        return actual


class AcquisitionPipelineTests(unittest.TestCase):
    def world(self,**options):
        # Reuse the calibrated renderer fixture, including its real QR bitmap.
        fixture=pipeline.FirePipelineSimulationTests()
        base=fixture.world(options.get('below_launch',.25))
        self.addCleanup(fixture.doCleanups)
        return AcquisitionWorld(base.pose,**options)

    def test_old_camera_stalls_after_takeoff_before_metric_scale_or_movement(self):
        world=self.world(recovery=False)
        world.advance(12.)
        self.assertGreater(len(world.sightings),3)
        self.assertLess(world.sightings[-1],1.)
        self.assertIsNone(world.fit)
        self.assertEqual(world.moves,[])
        self.assertGreater(math.degrees(world.pitch),-50.)

    def test_delayed_pixels_reacquire_then_measure_and_complete_a_circle(self):
        for distance,below_launch in ((.52,.25),(.7,.4)):
            with self.subTest(distance=distance,below_launch=below_launch):
                world=self.world(recovery=True,distance=distance,below_launch=below_launch)
                world.advance(3.2)  # Ground observations plus the firmware's fast takeoff.
                self.assertIsNone(world.fit)
                self.assertEqual(world.moves,[])
                while world.fit is None and world.now<12:world.advance(.1)
                self.assertIsNotNone(world.fit,world.scale.reason)
                self.assertTrue(world.search_times)
                self.assertGreater(world.last_seen,1.5)
                self.assertLess(abs(world.fit.side_m/world.pose.side-1),.12)
                self.assertLess(world.fit_at,12.)
                world.acquiring=False
                # Startup ends in hover; the real motion controller now owns
                # approach and repeated circles with actual 10 cm undershoot.
                with self.assertRaisesRegex(InterruptedError,'Operator requested landing'):
                    orbit_fire(world,Limits(segments=24,speed_mps=.6,lap_seconds=15.),
                               world.sample,world.abort,world.report,'simulated-fire',
                               started=0.,clock=lambda:world.now,sleep=world.advance,
                               last_seen=lambda:world.last_seen,remember=world.remember)
                self.assertGreaterEqual(world.swept,2*math.pi)
                self.assertGreaterEqual(world.first_move,world.fit_at)
                self.assertGreater(len(world.moves),24)
                self.assertLess(max(abs(radius-1.) for radius in world.radii[-24:]),.2)
                self.assertEqual(world.position[2],-1.)


if __name__=='__main__':unittest.main()
