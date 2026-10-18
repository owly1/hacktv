#!/usr/bin/env python3
"""Dashboard-enabled, measured fire response. Starts disarmed; no demo flag.

RGB inference runs on the laptop, preserving the Pi's camera/control capacity.
The receiver owns localization, preflight checks, movement and landing.
"""
import http.client
import hashlib
from dataclasses import replace
import json
import math
from pathlib import Path
import secrets
import signal
import threading
import time
from urllib.parse import urlsplit

from anafi_bridge import (AnafiBridge, FireDetector, Publisher, argument_parser, gimbal,
                          AltitudeChanged, SpeedChanged, AttitudeChanged, FlyingStateChanged)
from olympe.enums.gimbal import axis as GimbalAxis
from olympe.messages.ardrone3.SpeedSettings import MaxVerticalSpeed
from olympe.messages.ardrone3.SpeedSettingsState import MaxVerticalSpeedChanged
from olympe.messages import camera as camera_messages
from camera_search import CameraSearch, AcquisitionAim, image_bearing_pitch, image_bearing_ray
from continuous_orbit import Bearing
from fire_detection import FIRE_MARKER_PAYLOAD
from fire_tracking import FirePose, GroundTargetLock, orbit_fire
from hover_checkout import HoverCheckout
from qr_auto_circle import QRAutoPreset
from qr_orbit_bridge import OlympeOrbitDriver
from qr_scale import AdaptiveQRScale


class FireResponse(QRAutoPreset):
    flight_protocol='autonomous-fire-response'
    path_reference='measured-fire'

    def __init__(self,args,publisher):
        # Record the flight, rather than unlimited hours waiting for Enable.
        args.execute=False
        super().__init__(args,publisher,FireDetector('',use_yolo=False),FIRE_MARKER_PAYLOAD)
        args.execute=True
        # Reception-only construction defers recording, but also omits the
        # movement/landing driver. Install it before any session can be armed.
        self.driver=OlympeOrbitDriver(self)
        self.flight_seconds=60 if getattr(args,'short_test',False) else 300
        if getattr(args,'lap_seconds',None)==15:
            self.limits=replace(self.limits,speed_mps=.6,lap_seconds=15.)
        self.receiver_id=secrets.token_hex(16)
        self.control=None; self.control_at=float('-inf'); self.target=None
        self.claimed_session=None; self.episode=None; self.projected_at=None
        self.preview_command_id=None
        self.camera_aim_sample=None
        self.orbit_target=None
        self.orbit_bearing=None
        self.orbit_target_updated_at=float('-inf')
        self.target_vertical_anchor=None
        self.ground_target_lock=GroundTargetLock()
        self.adaptive_qr=bool(getattr(args,'adaptive_qr',False))
        self.bearing_target=None;self.qr_scale=AdaptiveQRScale(rough=True);self.qr_scale_fit=None
        self.qr_scale_session=None;self.qr_scale_episode=None
        self.camera_profile=None
        self.search=CameraSearch();self.search_session=None;self.search_pending=None
        self.search_sent_at=0.;self.search_error=None
        self.camera_period=.05
        self.bearing_aim=AcquisitionAim()
        self.camera_aim_mode=None
        self.geometry=None; self.geometry_stamp=None; self.geometry_error='Calibration not loaded'
        self.geometry_snapshot=None;self.geometry_sha256=None
        self.target_error='Waiting for confirmed fire'; self.control_stop=threading.Event()
        self._load_geometry()

    def _load_geometry(self):
        # A calibration file edit must never change an airborne target's scale.
        # The next disarmed receiver/session may load the new configuration.
        if self.takeoff_used and self.geometry is not None:return
        try:
            stamp=Path(self.args.camera_calibration).stat().st_mtime_ns
            if stamp!=self.geometry_stamp:
                self.ground_target_lock.clear()
                self._reset_qr_scale(self.qr_scale_session)
                self.target=None; self.projected_at=None
                self.camera_aim_sample=None
                self.geometry=FirePose(self.args.camera_calibration)
                raw=Path(self.args.camera_calibration).read_bytes()
                self.geometry_snapshot=json.loads(raw)
                self.geometry_sha256=hashlib.sha256(raw).hexdigest()
                self.geometry_stamp=stamp; self.geometry_error=None
        except (OSError,ValueError,KeyError,TypeError) as error:
            self.ground_target_lock.clear()
            self.target=None; self.projected_at=None
            self.geometry=None; self.geometry_error=str(error)[:250]
            self.camera_aim_sample=None

    def _request(self,path,body=None):
        url=urlsplit(self.args.backend)
        cls=http.client.HTTPSConnection if url.scheme=='https' else http.client.HTTPConnection
        connection=cls(url.hostname,url.port,timeout=1)
        try:
            connection.request('POST' if body is not None else 'GET',path,
                json.dumps(body).encode() if body is not None else None,
                {'Authorization':'Bearer '+self.publisher.token,'Content-Type':'application/json'})
            response=connection.getresponse(); data=json.loads(response.read())
            if response.status!=200: raise ValueError(data.get('error','Control request failed'))
            return data
        finally: connection.close()

    def _calibration_status(self):
        c=self.geometry_snapshot
        if not isinstance(c,dict):return None
        try:
            side=float(c['qr_black_square_side_m']);rms=float(c['rms_px'])
            offset=list(c['camera_offset_body_m']);size=list(c['image_size'])
            if (not math.isfinite(side) or not .03<=side<=.6 or not math.isfinite(rms) or not 0<=rms<=10
                    or len(offset)!=3 or not all(isinstance(v,(int,float)) and math.isfinite(v) for v in offset)
                    or math.sqrt(sum(v*v for v in offset))>.3 or len(size)!=2
                    or any(type(v)!=int for v in size) or not 32<=size[0]<=3840 or not 32<=size[1]<=2160):
                return None
            if self.adaptive_qr:side=self.qr_scale_fit.side_m if self.qr_scale_fit is not None else None
            return {'qr_side_m':side,'offset_body_m':offset,'image_size':size,'rms_px':rms,
                    'qr_verified':c.get('qr_pose_verified') is True,'profile_verified':None}
        except (KeyError,TypeError,ValueError):return None

    def _reset_qr_scale(self,session=None,episode=None):
        self.qr_scale=AdaptiveQRScale(rough=True);self.qr_scale_fit=None;self.bearing_target=None
        self.qr_scale_session=session;self.qr_scale_episode=episode
        self.target_vertical_anchor=None;self.ground_target_lock.clear()
        self.bearing_aim.reset()
        self.orbit_bearing=None
        if self.adaptive_qr:self.target=None;self.camera_aim_sample=None

    def _qr_candidate(self,observation,pose,camera,captured_mono):
        if not self.adaptive_qr or observation['source']!='qr-test':
            return self.geometry.estimate(observation,pose,camera,captured_mono)
        if self.qr_scale_episode!=observation['episode_id']:
            if self.takeoff_used:raise ValueError('QR scale belongs to a different episode')
            self._reset_qr_scale(self.qr_scale_session,observation['episode_id'])
        model=self.geometry.models['qr-test']
        nominal=model.estimate(observation,pose,camera,captured_mono,enforce_envelope=False)
        origin=model.origin(pose)
        unit=[(value-float(offset))/model.side for value,offset in zip(
            (nominal.forward_m,nominal.right_m,nominal.down_m),origin)]
        length=math.sqrt(sum(v*v for v in unit))
        if not math.isfinite(length) or length<=0:raise ValueError('Invalid QR bearing')
        # Dimensionless direction is camera-only evidence, never an orbit pose.
        ray=[unit[i]/length+float(self.geometry.offset[i]) for i in range(3)]
        self.bearing_target=replace(nominal,forward_m=ray[0],right_m=ray[1],down_m=ray[2],
                                    width_m=0.,position_source='qr-bearing-only')
        if self.qr_scale_fit is None:
            fit=self.qr_scale.observe(unit[2],pose['altitude_m'],float(origin[2]),at=captured_mono)
            if self.takeoff_used and fit is not None:
                self.qr_scale_fit=fit;self.target_vertical_anchor=fit.anchor_down_m
                self.publisher.diagnostic('qr_scale_acquired',vars(fit))
        if self.qr_scale_fit is None:return None
        side=self.qr_scale_fit.side_m
        metric=[unit[i]*side+float(origin[i]) for i in range(3)]
        if not .25<=math.hypot(*metric[:2])<=3 or not -.15<=metric[2]<=4:
            raise ValueError('Measured adaptive QR position is outside the flight envelope')
        return replace(nominal,forward_m=metric[0],right_m=metric[1],down_m=metric[2],
                       width_m=side,position_source='measured-qr-3d',
                       position_uncertainty_m=max(.10,math.hypot(*metric[:2])*
                                                  max(.15,self.qr_scale_fit.uncertainty_fraction)))

    def _read_camera_profile(self):
        profile={}
        fields={'zoom_level':('level',),'camera_mode':('mode',),
                'streaming_mode':('value',),
                'recording_mode':('mode','resolution','framerate','hyperlapse'),
                'photo_mode':('mode','format','file_format','burst','bracketing')}
        for name,keys in fields.items():
            value=self._state(getattr(camera_messages,name))
            if not isinstance(value,dict):continue
            value=value.get(0,value)
            if not isinstance(value,dict):continue
            profile[name]={key:getattr(value[key],'name',value[key]) for key in keys if key in value}
        return profile

    def _camera_profile_reason(self):
        if self.camera_profile is None:return None
        if self._read_camera_profile()!=self.camera_profile:
            return 'Camera zoom/crop profile changed after localization; calibration must be rechecked'
        return None

    def _detect_step(self,image,captured):
        # The Mac sends fresh rectangles from the shared RGB/QR detector.
        # This thread has no second model and never decodes QR to authorize flight.
        control=self.control or {}; observed=control.get('observed_target')
        fresh=observed and 0<=time.time()-observed['at']/1000<=1
        self.overlay=[{'source':observed['source'],'label':'fire','confidence':observed['confidence'],
                       'bbox':observed['bbox']}] if fresh else []
        self.overlay_time=time.time()

    def _update_target(self):
        observation=(self.control or {}).get('target') if self.takeoff_used else (self.control or {}).get('observed_target')
        if observation and not self.takeoff_used and (observation.get('hits',0)<5 or observation['at']-observation['first']<800
                or observation.get('qr_tracking','decoded')!='decoded'):observation=None
        if observation and self.takeoff_used and observation.get('episode_id')!=self.episode:observation=None
        if not observation:
            if not self.takeoff_used:self.ground_target_lock.clear()
            if self.target is not None and time.monotonic()-self.target.at>1: self.target=None
            if self.takeoff_used and self.target_error!='Waiting for a fresh, confirmed fire rectangle':
                self.publisher.diagnostic('target_tracking',{'valid':False,'reason':'No fresh confirmed rectangle'})
            self.target_error='Waiting for a fresh, confirmed fire rectangle'; return
        at=observation['at']/1000
        if self.projected_at==at: return
        self.projected_at=at
        self.orbit_bearing=None
        capture_pose=None;vertical_residual=None
        try:
            if self.geometry is None: raise ValueError(self.geometry_error)
            profile_error=self._camera_profile_reason()
            if profile_error:raise ValueError(profile_error)
            if not 0<=time.time()-at<=.8: raise ValueError('Fire image is stale')
            # Projection uses the actual received camera attitude and aircraft
            # state. Reject material timestamp skew instead of inventing pose.
            captured_mono=time.monotonic()-(time.time()-at)
            history=getattr(self.sensor_ages,'history',None)
            if history is None:raise ValueError('Capture-time aircraft/camera pose history is unavailable')
            capture_pose=history.snapshot_at(captured_mono)
            camera=capture_pose['camera']
            if (self.adaptive_qr and observation['source']=='qr-test'
                    and self.qr_scale_episode!=observation['episode_id']):
                if self.takeoff_used:raise ValueError('QR scale belongs to a different episode')
                self._reset_qr_scale(self.qr_scale_session,observation['episode_id'])
            # Camera centering must not depend on successful metric depth fitting.
            if observation['source']=='qr-test' and self.geometry_snapshot is not None:
                self.bearing_aim.observe(captured_mono,image_bearing_pitch(observation,self.geometry_snapshot,camera),
                                         capture_pose['altitude']['altitude'])
            pose={'altitude_m':capture_pose['altitude']['altitude'],
                  'attitude_deg':{k:math.degrees(capture_pose['attitude'][k]) for k in ('roll','pitch','yaw')}}
            if observation['source']=='qr-test' and self.geometry_snapshot is not None:
                # Keep the independently calibrated pixel direction even if
                # the following PnP/height consistency checks reject its depth.
                ray=image_bearing_ray(observation,self.geometry_snapshot,camera)
                yaw=capture_pose['attitude']['yaw'];c,s=math.cos(yaw),math.sin(yaw)
                origin=self.geometry.models['qr-test'].origin(pose)
                self.orbit_bearing=Bearing(captured_mono,observation['episode_id'],
                    float(ray[0]),float(ray[1]),
                    float(c*origin[0]-s*origin[1]),float(s*origin[0]+c*origin[1]))
            candidate=self._qr_candidate(observation,pose,camera,captured_mono)
            if candidate is not None and self.takeoff_used and self.target_vertical_anchor is not None:
                vertical_residual=candidate.down_m-pose['altitude_m']-self.target_vertical_anchor
                if abs(vertical_residual)>.35:
                    raise ValueError(f'QR scale/pose disagrees with measured climb by {vertical_residual:.2f} m; '
                                     'target movement, camera profile or acquired scale is inconsistent')
            self.target=candidate
            if not self.takeoff_used:
                grounded=self.bearing_target if self.adaptive_qr and observation['source']=='qr-test' else candidate
                if grounded is not None:self.ground_target_lock.observe(grounded,pose['altitude_m'])
            # Use every freshly synchronized measurement during ascent. Keeping
            # only the grounded ray ignored real drift visible in the recording.
            if self.target is not None:self.camera_aim_sample=(self.target,pose['altitude_m'])
            self.target_error=None if self.target is not None else 'Acquiring QR scale from measured climb: '+self.qr_scale.reason
        except (ValueError,KeyError,TypeError) as error:
            self.target=None; self.target_error=str(error)
            if self.adaptive_qr:self.bearing_target=None
            if not self.takeoff_used:self.ground_target_lock.clear()
        if self.takeoff_used:
            self.publisher.diagnostic('target_tracking',{
                'captured_at':observation.get('captured_at'),'method':observation.get('qr_tracking','decoded'),
                'frame_at_unix':at,'processed_at_unix':time.time(),'episode_id':observation.get('episode_id'),
                'source':observation.get('source'),'bbox':observation.get('bbox'),
                'qr_corners':observation.get('qr_corners'),
                'frame_size':[observation.get('width'),observation.get('height')],
                'calibration_sha256':self.geometry_sha256,'capture_pose':capture_pose,
                'vertical_anchor_m':self.target_vertical_anchor,'vertical_residual_m':vertical_residual,
                'qr_scale_mode':'adaptive' if self.adaptive_qr else 'measured',
                'qr_scale':vars(self.qr_scale_fit) if self.qr_scale_fit is not None else None,
                'position_uncertainty_m':self.target.position_uncertainty_m if self.target is not None else None,
                'valid':self.target is not None,'reason':self.target_error,
                'bearing_valid':self.orbit_bearing is not None,
                'position':({'forward_m':self.target.forward_m,'right_m':self.target.right_m,'down_m':self.target.down_m}
                            if self.target is not None else None)})

    def _current_pose(self):
        """Read current SDK state, independently of dashboard publishing rate."""
        pose=dict(self.telemetry or {})
        altitude=self._state(AltitudeChanged)
        if isinstance(altitude,dict) and 'altitude' in altitude:pose['altitude_m']=altitude['altitude']
        speed=self._state(SpeedChanged)
        if isinstance(speed,dict) and 'speedZ' in speed:pose['vertical_speed_mps']=-speed['speedZ']
        attitude=self._state(AttitudeChanged)
        if isinstance(attitude,dict) and all(k in attitude for k in ('roll','pitch','yaw')):
            pose['attitude_deg']={k:math.degrees(attitude[k]) for k in ('roll','pitch','yaw')}
        state=self._state(FlyingStateChanged)
        if isinstance(state,dict) and 'state' in state:
            pose['state']=getattr(state['state'],'name',str(state['state']))
        return pose

    def _gimbal_state(self,event):
        state=self._state(event)
        if not isinstance(state,dict):return {}
        return state.get(0,state)

    def _search_bounds(self):
        caps=self._gimbal_state(gimbal.gimbal_capabilities)
        bounds=self._gimbal_state(gimbal.absolute_attitude_bounds)
        try:
            if GimbalAxis.pitch not in caps.get('axes',[]):return None
            low,high=max(-85.,bounds['min_pitch']),min(85.,bounds['max_pitch'])
            if not all(math.isfinite(x) for x in (low,high)) or high-low<30:return None
            return low,high
        except (TypeError,ValueError,KeyError):return None

    def _send_pitch(self,pitch):
        return self.drone(gimbal.set_target(gimbal_id=0,control_mode='position',
            yaw_frame_of_reference='none',yaw=0.,pitch_frame_of_reference='absolute',
            pitch=float(pitch),roll_frame_of_reference='none',roll=0.,_no_expect=True))

    def _search_step(self,control):
        active=(control.get('enabled') and control.get('camera_search') and not self.takeoff_used
                and not self.abort_flight.is_set() and not self.search_error
                and not HoverCheckout.checkout_reason(self,starting=True))
        if not active and not self.search_session:
            return
        pitch=self._gimbal_pitch();bounds=self._search_bounds()
        camera_age=time.monotonic()-(self.sensor_ages.ages.get('camera',float('-inf')) if self.sensor_ages else float('-inf'))
        active=active and bounds is not None and pitch is not None and 0<=camera_age<=1
        if not active:
            # Cancel a sweep by holding its current pitch, without a motor command.
            if self.search_session and not self.takeoff_used and self.connected and pitch is not None:
                self._send_pitch(pitch)
            self.search=CameraSearch();self.search_session=None;self.search_pending=None
            return
        now=time.monotonic()
        if self.search_session!=control['session_id']:
            self.search=CameraSearch();self.search_session=control['session_id'];self.search_pending=None
        if self.search_pending is not None:
            if not self.search_pending.done():
                if now-self.search_sent_at>1:raise RuntimeError('Camera search command timed out')
                return
            if not self.search_pending.success():raise RuntimeError('Camera search command rejected')
        observed=control.get('observed_target')
        seen=bool(observed and 0<=time.time()-observed['at']/1000<=.6)
        previous=self.search.command
        command=self.search.step(now,pitch,bounds,seen)
        # A rectangle at the frame edge is detection, not camera alignment.
        # Centre the freshly localized bearing before permitting takeoff.
        aim=self.bearing_target if self.adaptive_qr else self.target
        visual=self.bearing_aim.predict(now)
        if seen and (visual is not None or (aim is not None and 0<=now-aim.at<=.8)):
            from qr_circle_core import camera_pitch
            desired=visual if visual is not None else camera_pitch(aim,self.geometry.offset)
            desired=max(bounds[0],min(bounds[1],desired))
            command=max(pitch-6.,min(pitch+6.,desired))
            self.search.command=command;self.search.hold=command
        if previous is not None and abs(command-previous)<.1 and self.search_pending is not None:return
        self.search_pending=self._send_pitch(command);self.search_sent_at=now

    def _preview_camera(self,control):
        command=control.get('camera')
        if (not command or command.get('id')==self.preview_command_id or control.get('enabled')
                or command.get('receiver_id')!=self.receiver_id or self.takeoff_used
                or not self.running or HoverCheckout.checkout_reason(self,starting=True,camera_only=True)):
            return
        if command.get('pitch_deg') not in (0,-30,-45,-55,-70) or not 0<=time.time()-command.get('at',0)/1000<=5:
            return
        self.preview_command_id=command['id']
        # Camera only. This path never creates a flight worker or sends TakeOff.
        self.drone(gimbal.set_target(gimbal_id=0,control_mode='position',
            yaw_frame_of_reference='none',yaw=0.,pitch_frame_of_reference='absolute',
            pitch=float(command['pitch_deg']),roll_frame_of_reference='none',roll=0.,_no_expect=True))

    def _control_loop(self):
        while self.running and not self.control_stop.is_set():
            try:
                self._load_geometry()
                reason=self.geometry_error or self.search_error or HoverCheckout.checkout_reason(self,starting=True)
                observed=(self.control or {}).get('observed_target') or {}
                blocked_source=(observed.get('source') if self.geometry is not None and observed.get('source')
                    and observed.get('source') not in self.geometry.models else None)
                source_reason=self.geometry.errors.get(blocked_source) if blocked_source else None
                if (not blocked_source and observed.get('source') and self.target is None
                        and observed.get('hits',0)>=5 and 0<=time.time()-observed.get('at',0)/1000<=1):
                    if self.adaptive_qr and observed['source']=='qr-test':
                        source_reason='QR bearing acquisition; metric scale is measured during vertical ascent'
                    else:
                        blocked_source=observed['source']
                        source_reason='Fire position unavailable before takeoff: '+str(self.target_error)
                if (not self.takeoff_used and self.target is not None
                        and not self.ground_target_lock.ready(time.monotonic(),self.target.episode)):
                    source_reason='Hold the marker still: confirming five stable measured positions before takeoff'
                position=None if self.target is None or time.monotonic()-self.target.at>1 else {
                    'forward_m':self.target.forward_m,'right_m':self.target.right_m,
                    'width_m':self.target.width_m,'down_m':self.target.down_m,'episode_id':self.target.episode,
                    'source':self.target.position_source}
                control=self._request('/api/ingest/autonomy/status',{
                    'receiver_id':self.receiver_id,'ready':not reason and not self.takeoff_used,
                    'aircraft_connected':bool(self.connected and self._aircraft_link()),
                    'short_test':bool(getattr(self.args,'short_test',False)),
                    'qr_scale_mode':'adaptive' if self.adaptive_qr else 'measured',
                    'camera_search_supported':self._search_bounds() is not None,
                    'lap_seconds':self.limits.lap_seconds,
                    'localization_sources':list(self.geometry.models) if self.geometry is not None else [],
                    'calibration':self._calibration_status(),
                    'blocked_source':blocked_source,
                    'search_state':'tracking' if self.takeoff_used and not self.abort_flight.is_set() else self.search.state,
                    'camera_ready':not self.takeoff_used and not HoverCheckout.checkout_reason(self,starting=True,camera_only=True),
                    'reason':(self.target_error or 'Tracking measured fire') if self.takeoff_used else reason or source_reason or 'Ready for a new session',
                    'phase':self.flight_phase or 'waiting','position':position})
                with self.takeoff_lock:
                    if self.adaptive_qr and not self.takeoff_used and control.get('session_id')!=self.qr_scale_session:
                        self._reset_qr_scale(control.get('session_id'))
                    self.control=control; self.control_at=time.monotonic()
                    self._preview_camera(control)
                    if self.takeoff_used and (not control.get('enabled') or control.get('session_id')!=self.claimed_session):
                        self._request_landing(force=False)
                    self._update_target()
                    try:self._search_step(control)
                    except Exception as error:
                        self.search_error=f'Camera search failed: {error}'
                        self.search.state='error';self.report('error',self.search_error)
                        reason=self.search_error
                    can_start=(control.get('enabled') and control.get('target') and not self.takeoff_used
                               and not self.abort_flight.is_set() and not reason
                               and self.geometry is not None and control['target']['source'] in self.geometry.models)
                    if can_start:
                        initial=self.bearing_target if self.adaptive_qr and control['target']['source']=='qr-test' else self.target
                        can_start=(initial is not None and initial.episode==control['target']['episode_id']
                                   and 0<=time.monotonic()-initial.at<=.8
                                   and self.ground_target_lock.ready(time.monotonic(),initial.episode))
                    if can_start and control.get('camera_search'):
                        can_start=self.search.state=='acquiring' and self.search_pending is not None and self.search_pending.done() and self.search_pending.success()
                        if can_start:
                            from qr_circle_core import camera_pitch
                            actual=self._gimbal_pitch()
                            desired=self.bearing_aim.predict(time.monotonic())
                            if desired is None:desired=camera_pitch(initial,self.geometry.offset)
                            can_start=actual is not None and abs(actual-desired)<=3.
                if can_start:
                    # Network runs outside the flight lock; local LAND can win.
                    claim=self._request('/api/ingest/autonomy/claim',{
                        'receiver_id':self.receiver_id,'session_id':control['session_id'],
                        'episode_id':control['target']['episode_id']})
                    with self.takeoff_lock:
                        if self.abort_flight.is_set() or not self.running or not claim.get('enabled'): continue
                        self.control=claim; self.control_at=time.monotonic()
                        self.claimed_session=claim['session_id']; self.episode=claim['mission']['episode_id']
                        self.incident_id=claim['target']['incident_id']
                        self.camera_profile=self._read_camera_profile()
                        if claim['target']['source']=='qr-test' and not self.adaptive_qr:
                            self.target_vertical_anchor=self.ground_target_lock.vertical_anchor()
                        self.takeoff_used=self.hold_connection=True
                        self.publisher.start_recording()
                        self.publisher.diagnostic('mission_calibration',{
                            'sha256':self.geometry_sha256,'calibration':self.geometry_snapshot,
                            'vertical_anchor_m':self.target_vertical_anchor,
                            'camera_profile':self.camera_profile,
                            'camera_profile_matches_calibration':None,
                            'camera_profile_note':'Current profile latched for this mission; historical calibration profile was not recorded',
                            'frame_size':[claim['target'].get('width'),claim['target'].get('height')],
                            'initial_target':({'forward_m':self.target.forward_m,'right_m':self.target.right_m,
                                'down_m':self.target.down_m} if self.target is not None else None)})
                        self.mission=threading.Thread(target=self._automatic_mission)
                        self.mission.start()
            except Exception as error:
                # One timed-out poll is not an authoritative DISABLE. Preserve
                # the last response timestamp, never refresh it on failure, and
                # let the bounded watchdog distinguish a transient from loss.
                self.target_error=f'Control unavailable: {type(error).__name__}'
                if self.takeoff_used and time.monotonic()-self.control_at>3:
                    self._request_landing(force=False)
            self.control_stop.wait(.15)

    def minimum_battery_pct(self,starting=False):
        return (30 if starting else 25) if getattr(self.args,'short_test',False) else 40

    def checkout_reason(self,starting=False):
        reason=HoverCheckout.checkout_reason(self,starting)
        if reason: return reason
        if self.geometry is None: return self.geometry_error
        profile_error=self._camera_profile_reason()
        if profile_error:return profile_error
        if self.takeoff_used and (time.monotonic()-self.control_at>3 or not (self.control or {}).get('enabled')
                                 or self.control.get('session_id')!=self.claimed_session):
            return 'Autonomous session ended or control connection is stale'
        if starting and self.takeoff_used:
            observation=(self.control or {}).get('target')
            if (not observation or observation.get('episode_id')!=self.episode
                    or not 0<=time.time()-observation['at']/1000<=.8):
                return 'Confirmed fire was lost before takeoff'
            initial=self.bearing_target if self.adaptive_qr and observation['source']=='qr-test' else self.target
            if initial is None or initial.episode!=self.episode or not 0<=time.monotonic()-initial.at<=.8:
                label='QR' if observation['source']=='qr-test' else 'fire'
                return f'Measured {label} position was lost before takeoff'
        return None

    def _sample_fire(self):
        reason=('Autonomous session ended or control connection is stale' if self.checkout_reason_control()
                else self._camera_profile_reason())
        if reason:
            self.abort_flight.set()
            raise InterruptedError(reason)
        return self._preset_vehicle(),self.target

    def checkout_reason_control(self):
        return (time.monotonic()-self.control_at>3 or not (self.control or {}).get('enabled')
                or self.control.get('session_id')!=self.claimed_session)

    def _after_hover(self):
        orbit_fire(self.driver,self.limits,self._sample_fire,self.abort_flight,self.report,self.episode,
                   started=self.started_at,min_battery_pct=self.minimum_battery_pct(),flight_seconds=self.flight_seconds,
                   last_seen=self._fire_seen_at,remember=self._remember_orbit_target)

    def _fire_seen_at(self):
        mission=(self.control or {}).get('mission') or {}
        if mission.get('episode_id')!=self.episode:return None
        stamp=mission.get('last_visual_at')
        if not isinstance(stamp,(int,float)) or not math.isfinite(stamp):return None
        return time.monotonic()-(time.time()-stamp/1000.)

    def _remember_orbit_target(self,target):
        self.orbit_target=target
        # Propagated coordinates describe the aircraft at this update, while
        # target.at deliberately remains the last real image timestamp.
        self.orbit_target_updated_at=time.monotonic()
        self.publisher.diagnostic('orbit_target_memory',{'captured_at_mono':target.at,
            'updated_at_mono':self.orbit_target_updated_at,
            'forward_m':target.forward_m,'right_m':target.right_m,'down_m':target.down_m,
            'source':target.position_source,'position_uncertainty_m':target.position_uncertainty_m,
            'last_seen_mono':self._fire_seen_at()})

    def _automatic_mission(self):
        previous_speed=self._state(MaxVerticalSpeedChanged)
        previous_gimbal=self._gimbal_state(gimbal.max_speed)
        try:
            # TakeOff itself has no speed argument. Request the supported speed
            # setting, and track actual ascent rather than assuming it is obeyed.
            for command in (MaxVerticalSpeed(.3,_timeout=2),
                            gimbal.set_max_speed(gimbal_id=0,yaw=0.,pitch=60.,roll=0.,_timeout=2)):
                if self.abort_flight.is_set():raise InterruptedError('Landing requested')
                if not self.drone(command).wait().success():raise RuntimeError('Tracking speed setup was not acknowledged')
            super()._automatic_mission()
        except Exception as error:
            self._request_landing(force=False);self.report('aborted',str(error));self._land()
        finally:
            # Restore shared settings only after confirmed landing.
            emergency=getattr(self.sensor_ages,'emergency_at',float('-inf'))
            emergency_seen=isinstance(emergency,(int,float)) and math.isfinite(emergency)
            if self.land_confirmed and self.connected and not emergency_seen:
                try:
                    if isinstance(previous_speed,dict) and isinstance(previous_speed.get('current'),(int,float)):
                        self.drone(MaxVerticalSpeed(previous_speed['current'],_no_expect=True))
                    if isinstance(previous_gimbal.get('current_pitch'),(int,float)):
                        self.drone(gimbal.set_max_speed(gimbal_id=0,yaw=0.,pitch=previous_gimbal['current_pitch'],roll=0.,_no_expect=True))
                except Exception:pass
                self.running=False
            elif emergency_seen:
                self.running=False

    def _camera_pitch(self):
        from qr_circle_core import camera_pitch
        now=time.monotonic()
        target=self.target
        ages=self.sensor_ages.ages if self.sensor_ages else {}
        fresh_pose=all(0<=now-ages.get(name,float('-inf'))<=1 for name in ('altitude','camera'))
        active_mission=(self.takeoff_used and self.running and self.connected
                        and not self.abort_flight.is_set() and not self.checkout_reason_control())
        if self.orbit_target is not None and self.orbit_target.episode==self.episode:
            seen=self._fire_seen_at()
            aimed=self.orbit_target
            updated=self.orbit_target_updated_at
            live_motion=(aimed.position_source=='velocity-propagated-fire'
                         and 0<=now-updated<=.3)
            if ((seen is not None and 0<=now-seen<15)
                    or (live_motion and active_mission and fresh_pose)):
                visual=self.bearing_aim.predict(now)
                if visual is not None:return visual
                if not live_motion:
                    # Alignment memory can predate the last valid sighting.
                    # Keep that sighting after self.target expires, instead of
                    # snapping back to the old pre-reacquisition camera angle.
                    candidates=(target,self.camera_aim_sample[0] if self.camera_aim_sample else None)
                    after=max(aimed.at,updated)
                    for candidate in candidates:
                        if (candidate is not None and candidate.episode==self.episode
                                and not candidate.position_source.endswith('propagated-fire')
                                and candidate.position_source!='qr-bearing-only'
                                and all(math.isfinite(v) for v in (candidate.at,candidate.forward_m,
                                    candidate.right_m,candidate.down_m))
                                and after<candidate.at<=now and now-candidate.at<15):
                            aimed=candidate;after=candidate.at
                return camera_pitch(aimed,self.geometry.offset)
        if self.adaptive_qr and self.qr_scale_episode is not None and self.qr_scale_fit is None:
            if self.abort_flight.is_set() or (self.takeoff_used and self.checkout_reason_control()):return None
            reacquire=(active_mission and self.started_at is not None
                       and now>=self.started_at and self.driver is not None
                       and not self.driver.movement_started
                       and self.flight_phase in ('takeoff','climb','recover')
                       and fresh_pose)
            pose=self._current_pose() if reacquire else {}
            bounds=self._search_bounds() if reacquire else None
            pitch=self.bearing_aim.step(now,altitude=pose.get('altitude_m'),
                actual_pitch=self._gimbal_pitch() if reacquire else None,
                bounds=bounds or (-85.,85.),reacquire=reacquire and bounds is not None)
            mode=self.bearing_aim.state
            if mode!=self.camera_aim_mode:
                self.camera_aim_mode=mode
                self.publisher.diagnostic('camera_acquisition',{'mode':mode,'pitch_deg':pitch,
                    'altitude_m':pose.get('altitude_m'),'last_visual_at_mono':self.bearing_aim.at})
            if pitch is not None:return pitch
            if self.bearing_target is not None and 0<=now-self.bearing_target.at<=.8:
                # This fallback is for a missing pixel-bearing sample only.
                # A PnP estimate must never overwrite measured visual motion.
                return camera_pitch(self.bearing_target,self.geometry.offset)
            return None

        # During vertical acquisition the target moves downward relative to
        # the aircraft as it climbs. Carry the last measured aim through that
        # brief loss of detection; never feed this estimate into orbit_fire.
        # Only the active mission can extend this camera-only acquisition;
        # horizontal movement or stale pose ends the height-based estimate.
        if (active_mission and fresh_pose and self.camera_aim_sample is not None and self.started_at is not None
                and self.driver is not None and not self.driver.movement_started
                and now>=self.started_at
                and self.flight_phase in ('takeoff','climb','recover')):
            measured,height_at_measurement=self.camera_aim_sample
            pose=self._current_pose();height=pose.get('altitude_m')
            age=time.monotonic()-(self.sensor_ages.ages.get('altitude',float('-inf')) if self.sensor_ages else float('-inf'))
            if (measured.episode==self.episode and 0<=age<=1
                    and all(isinstance(v,(int,float)) and math.isfinite(v) for v in (height,height_at_measurement))):
                # Brief feed-forward covers the camera command/video pipeline.
                speed=pose.get('vertical_speed_mps')
                lead=min(.15,max(0.,speed)*.15) if isinstance(speed,(int,float)) and math.isfinite(speed) else 0.
                aimed=replace(measured,down_m=measured.down_m+height-height_at_measurement+lead)
                return camera_pitch(aimed,self.geometry.offset)
        if target and 0<=time.monotonic()-target.at<=1:
            visual=self.bearing_aim.predict(now)
            return visual if visual is not None else camera_pitch(target,self.geometry.offset)
        # The flight loop owns mission limits. Missing one target holds the
        # camera; it does not independently trigger a descent.
        return None

    def _ready_message(self): return 'Autonomous response: enable this session in the dashboard'
    def _takeoff_message(self): return f'Confirmed fire incident {self.incident_id}; acquiring measured fire location'
    def _hover_observed_message(self): return 'Hover established; acquiring stable fire position before horizontal movement'
    def _print_instructions(self):
        print('AUTONOMOUS FIRE RESPONSE · starts OFF. Enable in the live dashboard.',flush=True)
        print('LAND disables the session. Closing the control page or losing the backend requests landing.',flush=True)
    def _terminal(self):
        # Dashboard heartbeat replaces a terminal requirement in this mode.
        while self.running: self.control_stop.wait(.2)

    def run(self):
        worker=threading.Thread(target=self._control_loop,daemon=True); worker.start()
        try: super().run()
        finally:
            self.control_stop.set(); worker.join(timeout=2)
            try:
                self._request('/api/ingest/autonomy/status',{'receiver_id':self.receiver_id,'ready':False,
                    'phase':'landed' if self.land_confirmed else 'error','reason':'Receiver stopped; session disabled'})
            except Exception: pass


def main():
    import os
    parser=argument_parser(); parser.description=__doc__
    parser.add_argument('--camera-calibration',default='camera.local.json')
    parser.add_argument('--short-test',action='store_true',help='60-second flight cap, minimum 30%% to start, landing below 25%%')
    args=parser.parse_args()
    if args.controller!='direct' or args.demo_flight or args.gimbal_pitch is not None or not args.backend:
        parser.error('Use direct control and a backend; no other flight/gimbal mode')
    token=os.environ.get('INGEST_TOKEN')
    if not token: parser.error('INGEST_TOKEN required')
    args.no_window=args.no_auto_gimbal=args.terminal_control=True
    args.adaptive_qr=True
    args.lap_seconds=15.
    args.checkout_one_segment=False; args.hover_seconds=1
    bridge=FireResponse(args,Publisher(args.out_dir,args.backend,token))
    def stop(*_):
        bridge._request_landing(force=False); bridge.running=False
    for name in ('SIGTERM','SIGHUP','SIGINT'):
        if hasattr(signal,name): signal.signal(getattr(signal,name),stop)
    bridge.run()


if __name__=='__main__': main()
