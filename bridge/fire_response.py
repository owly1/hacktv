#!/usr/bin/env python3
"""Dashboard-enabled, measured fire response. Starts disarmed; no demo flag.

RGB inference runs on the laptop, preserving the Pi's camera/control capacity.
The receiver owns localization, preflight checks, movement and landing.
"""
import http.client
import json
from pathlib import Path
import secrets
import signal
import threading
import time
from urllib.parse import urlsplit

from anafi_bridge import AnafiBridge, FireDetector, Publisher, argument_parser, gimbal
from fire_detection import FIRE_MARKER_PAYLOAD
from fire_tracking import FirePose, orbit_fire
from hover_checkout import HoverCheckout
from qr_auto_circle import QRAutoPreset


class FireResponse(QRAutoPreset):
    flight_protocol='autonomous-fire-response'
    path_reference='measured-fire'

    def __init__(self,args,publisher):
        # Record the flight, rather than unlimited hours waiting for Enable.
        args.execute=False
        super().__init__(args,publisher,FireDetector('',use_yolo=False),FIRE_MARKER_PAYLOAD)
        args.execute=True
        self.flight_seconds=60 if getattr(args,'short_test',False) else 300
        self.receiver_id=secrets.token_hex(16)
        self.control=None; self.control_at=float('-inf'); self.target=None
        self.claimed_session=None; self.episode=None; self.projected_at=None
        self.preview_command_id=None
        self.geometry=None; self.geometry_stamp=None; self.geometry_error='Calibration not loaded'
        self.target_error='Waiting for confirmed fire'; self.control_stop=threading.Event()
        self._load_geometry()

    def _load_geometry(self):
        try:
            stamp=Path(self.args.camera_calibration).stat().st_mtime_ns
            if stamp!=self.geometry_stamp:
                self.target=None; self.projected_at=None
                self.geometry=FirePose(self.args.camera_calibration)
                self.geometry_stamp=stamp; self.geometry_error=None
        except (OSError,ValueError,KeyError,TypeError) as error:
            self.target=None; self.projected_at=None
            self.geometry=None; self.geometry_error=str(error)[:250]

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
        if observation and (observation.get('hits',0)<5 or observation['at']-observation['first']<800):observation=None
        if not observation:
            if self.target is not None and time.monotonic()-self.target.at>1: self.target=None
            self.target_error='Waiting for a fresh, confirmed fire rectangle'; return
        at=observation['at']/1000
        if self.projected_at==at: return
        self.projected_at=at
        try:
            if self.geometry is None: raise ValueError(self.geometry_error)
            if not 0<=time.time()-at<=.8: raise ValueError('Fire image is stale')
            # Projection uses the actual received camera attitude and aircraft
            # state. Reject material timestamp skew instead of inventing pose.
            ages=self.sensor_ages.ages if self.sensor_ages else {}
            captured_mono=time.monotonic()-(time.time()-at)
            if any(abs(ages.get(k,float('-inf'))-captured_mono)>.5 for k in ('altitude','attitude','camera')):
                raise ValueError('Fire frame and aircraft/camera pose are not synchronized')
            camera=self._state(gimbal.attitude) or {}
            if 0 in camera:camera=camera[0]
            self.target=self.geometry.estimate(observation,self.telemetry or {},camera,captured_mono)
            self.target_error=None
        except (ValueError,KeyError,TypeError) as error:
            self.target=None; self.target_error=str(error)

    def _preview_camera(self,control):
        command=control.get('camera')
        if (not command or command.get('id')==self.preview_command_id or control.get('enabled')
                or command.get('receiver_id')!=self.receiver_id or self.takeoff_used
                or not self.running or HoverCheckout.checkout_reason(self,starting=True)):
            return
        if command.get('pitch_deg') not in (0,-45,-70) or not 0<=time.time()-command.get('at',0)/1000<=5:
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
                reason=self.geometry_error or HoverCheckout.checkout_reason(self,starting=True)
                position=None if self.target is None or time.monotonic()-self.target.at>1 else {
                    'forward_m':self.target.forward_m,'right_m':self.target.right_m,
                    'width_m':self.target.width_m,'down_m':self.target.down_m,'episode_id':self.target.episode,
                    'source':self.target.position_source}
                control=self._request('/api/ingest/autonomy/status',{
                    'receiver_id':self.receiver_id,'ready':not reason and not self.takeoff_used,
                    'short_test':bool(getattr(self.args,'short_test',False)),
                    'camera_ready':not self.takeoff_used and not HoverCheckout.checkout_reason(self,starting=True),
                    'reason':(self.target_error or 'Tracking measured fire') if self.takeoff_used else reason or 'Ready for a new session',
                    'phase':self.flight_phase or 'waiting','position':position})
                with self.takeoff_lock:
                    self.control=control; self.control_at=time.monotonic()
                    self._preview_camera(control)
                    if self.takeoff_used and (not control.get('enabled') or control.get('session_id')!=self.claimed_session):
                        self._request_landing(force=False)
                    self._update_target()
                    can_start=(control.get('enabled') and control.get('target') and not self.takeoff_used
                               and not self.abort_flight.is_set() and not reason
                               and self.geometry is not None and control['target']['source'] in self.geometry.models)
                    if can_start and control['target']['source']=='qr-test':
                        can_start=(self.target is not None and self.target.episode==control['target']['episode_id']
                                   and 0<=time.monotonic()-self.target.at<=.8)
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
                        self.takeoff_used=self.hold_connection=True
                        self.publisher.start_recording()
                        self.mission=threading.Thread(target=self._automatic_mission)
                        self.mission.start()
            except Exception as error:
                self.control=None
                self.target_error=f'Control unavailable: {type(error).__name__}'
                if self.takeoff_used: self._request_landing(force=False)
            self.control_stop.wait(.15)

    def minimum_battery_pct(self,starting=False):
        return (30 if starting else 25) if getattr(self.args,'short_test',False) else 40

    def checkout_reason(self,starting=False):
        reason=HoverCheckout.checkout_reason(self,starting)
        if reason: return reason
        if self.geometry is None: return self.geometry_error
        if self.takeoff_used and (time.monotonic()-self.control_at>1.5 or not (self.control or {}).get('enabled')
                                 or self.control.get('session_id')!=self.claimed_session):
            return 'Autonomous session ended or control connection is stale'
        if starting and self.takeoff_used:
            observation=(self.control or {}).get('target')
            if (not observation or observation.get('episode_id')!=self.episode
                    or not 0<=time.time()-observation['at']/1000<=.8):
                return 'Confirmed fire was lost before takeoff'
            if observation['source']=='qr-test' and (self.target is None
                    or self.target.episode!=self.episode or not 0<=time.monotonic()-self.target.at<=.8):
                return 'Measured QR position was lost before takeoff'
        return None

    def _sample_fire(self):
        if self.checkout_reason_control():
            self.abort_flight.set()
        return self._preset_vehicle(),self.target

    def checkout_reason_control(self):
        return (time.monotonic()-self.control_at>1.5 or not (self.control or {}).get('enabled')
                or self.control.get('session_id')!=self.claimed_session)

    def _after_hover(self):
        orbit_fire(self.driver,self.limits,self._sample_fire,self.abort_flight,self.report,self.episode,
                   started=self.started_at,min_battery_pct=self.minimum_battery_pct(),flight_seconds=self.flight_seconds)

    def _camera_pitch(self):
        target=self.target
        if target and 0<=time.monotonic()-target.at<=1:
            from qr_circle_core import camera_pitch
            return camera_pitch(target,self.geometry.offset)
        # During vertical acquisition aim down at the ground; no XY target is
        # inferred from this camera command. Orbit waits for measured geometry.
        return -45.

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
    args.checkout_one_segment=False; args.hover_seconds=1
    bridge=FireResponse(args,Publisher(args.out_dir,args.backend,token))
    def stop(*_):
        bridge._request_landing(force=False); bridge.running=False
    for name in ('SIGTERM','SIGHUP','SIGINT'):
        if hasattr(signal,name): signal.signal(getattr(signal,name),stop)
    bridge.run()


if __name__=='__main__': main()
