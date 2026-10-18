"""Leased person-search descent. Height is above takeoff, not terrain/AGL.

SDK access stays in one aircraft owner. No takeoff or import-time radio access.
The controller accepts fake drivers for complete offline maneuver tests.
"""
import http.client
import json
import math
import secrets
import threading
import time
from datetime import datetime


class Backend:
    """Keep bounded control requests separate from camera upload connections."""
    def __init__(self, publisher):
        self.publisher = publisher

    def request(self, path, body=None):
        """Return authenticated JSON without waiting behind a video upload."""
        url = self.publisher.url
        cls = http.client.HTTPSConnection if url.scheme == 'https' else http.client.HTTPConnection
        connection = cls(url.hostname, url.port, timeout=.8)
        try:
            connection.request('GET' if body is None else 'POST', path,
                None if body is None else json.dumps(body).encode(),
                {'Authorization': 'Bearer ' + self.publisher.token, 'Content-Type': 'application/json'})
            response = connection.getresponse(); result = json.loads(response.read())
            if response.status != 200: raise RuntimeError(result.get('error', 'Dive control failed'))
            return result
        finally:
            connection.close()


class DiveSurveillance:
    """Execute one measured search while an independent worker renews control evidence."""
    def __init__(self, bridge, driver=None, backend=None, clock=time.monotonic, sleep=time.sleep, wall=time.time):
        self.bridge = bridge; self.driver = driver; self.backend = backend or Backend(bridge.publisher)
        self.clock = clock; self.sleep = sleep; self.wall = wall; self.receiver_id = secrets.token_hex(16)
        self.busy = threading.Event(); self.command = None; self.phase = 'idle'
        self.control = {}; self.control_at = float('-inf'); self.started_at = None
        self.stop_id = None; self.outcomes = {}; self.consumed = set(); self.last_error = None

    def reason(self, starting=False, motion_limit=None):
        """Require measured camera/aircraft state and normal battery reserve before any movement."""
        if self.driver is None: return 'Aircraft driver is connecting'
        sample = self.driver.snapshot()
        if not sample.get('connected'): return 'Aircraft is disconnected'
        if self.bridge.abort_flight.is_set(): return 'Landing requested; restart the receiver after landing'
        if any(not isinstance(sample.get(key), (int,float)) or not math.isfinite(sample[key])
               for key in ('altitude_m','battery_pct','speed_mps','roll_deg','pitch_deg','camera_pitch_deg','yaw_deg')):
            return 'Aircraft or camera measurements are unavailable'
        if any(not 0 <= sample.get('ages', {}).get(key, float('inf')) < 1.5
               for key in ('altitude','speed','attitude','camera','video')):
            return 'Aircraft or camera measurements are stale'
        if sample['battery_pct'] < 40: return 'Battery is below 40%'
        if not .25 <= sample['altitude_m'] <= 3: return 'Altitude is outside the 0.25–3 m search envelope'
        if sample['state'] not in (('hovering',) if starting else ('hovering','flying')):
            return 'A stationary airborne hover is required; this control never takes off'
        if sample['speed_mps'] > (motion_limit if motion_limit is not None else .1 if starting else .3): return 'Aircraft is moving too fast for a search'
        if max(abs(sample['roll_deg']),abs(sample['pitch_deg'])) > 10: return 'Aircraft tilt exceeds 10 degrees'
        if starting and sample['altitude_m'] <= .6: return 'Start above 0.6 m above takeoff'
        return None

    def refresh(self):
        """Publish current progress and receive the movement lease or urgent stop signal."""
        reason = self.reason(starting=not self.busy.is_set())
        command_id = self.command['id'] if self.command else None
        response = self.backend.request('/api/ingest/dive/status', {
            'receiver_id': self.receiver_id, 'ready': reason is None and not self.busy.is_set(),
            'reason': reason or self.last_error or 'Ready for a controlled person search',
            'phase': self.phase, 'command_id': command_id,
            'stop_id': self.stop_id})
        if command_id == (self.command['id'] if self.command else None):
            self.control = response; self.control_at = self.clock()

    def _ack(self, command, status, note):
        """Retain terminal outcomes for retry without executing a duplicate maneuver."""
        body = {'receiver_id': self.receiver_id, 'status': status, 'note': note}
        if status in ('done','aborted','failed'): self.outcomes[command['id']] = body
        self.backend.request('/api/commands/' + command['id'] + '/ack', body)

    def poll(self):
        """Keep lease polling independent of the movement thread and retry lost acknowledgements."""
        last_poll = float('-inf')
        while self.bridge.running:
            try:
                self.refresh()
                if self.control.get('stop_id') and not self.busy.is_set() and self.control['stop_id'] != self.stop_id:
                    self.stop_id = self.control['stop_id']; self.bridge.abort_flight.set(); self.busy.set()
                    threading.Thread(target=self._idle_land, daemon=True).start()
                if not self.busy.is_set() and self.clock()-last_poll >= .5:
                    last_poll = self.clock()
                    command = self.backend.request('/api/commands/next?receiver_id=' + self.receiver_id).get('command')
                    if command and command['id'] not in self.consumed:
                        self.consumed.add(command['id']); self.busy.set(); self.command = command
                        self.launch(command)
                for command_id, body in list(self.outcomes.items()):
                    self.backend.request('/api/commands/' + command_id + '/ack', body)
                    del self.outcomes[command_id]
            except Exception as error:
                self.last_error = str(error)[:250]
            self.sleep(.2)

    def launch(self, command):
        """Start the standalone worker; combined QR flight overrides this handover."""
        threading.Thread(target=self._execute, args=(command,), daemon=True).start()

    def _idle_land(self):
        """Honor LAND without a running search and publish only actual touchdown confirmation."""
        try:
            self.phase = 'landing'
            confirmed = self.driver.land() if self.driver else False
            self.phase = 'landed' if confirmed else 'error'
            self.last_error = None if confirmed else 'LANDING UNCONFIRMED: inspect the aircraft'
        finally:
            self.busy.clear()

    def check(self):
        """Check lease, inference, operator, aircraft and maneuver-time limits throughout each move."""
        if not self.bridge.running or self.bridge.abort_flight.is_set(): raise InterruptedError('Operator requested landing')
        if self.control.get('stop_id'):
            self.stop_id = self.control['stop_id']; raise InterruptedError('Operator requested landing')
        if self.clock()-self.control_at > 2.5 or not self.control.get('authorized'):
            raise InterruptedError('Search control or person detector permission expired')
        if self.started_at is not None and self.clock()-self.started_at > 120:
            raise InterruptedError('Search exceeded its 120-second maneuver limit')
        reason = self.reason()
        if reason: raise InterruptedError(reason)
        return self.driver.snapshot()

    def _height(self, target):
        """Correct measured altitude in bounded steps and reject three ineffective moves."""
        stalled = 0
        while True:
            current = self.check()['altitude_m']; error = current-target
            if abs(error) <= .06:
                self.driver.settle(self.check); return
            self.driver.move(dz=max(-.2,min(.2,error)),yaw=0.,check=self.check)
            progress = abs(error)-abs(self.check()['altitude_m']-target)
            stalled = stalled+1 if progress < .02 else 0
            if stalled >= 3: raise RuntimeError('Aircraft did not reach the requested search height')

    def _phase(self, phase, message):
        """Send the measured maneuver phase through the existing flight-event channel."""
        self.phase = phase; self.bridge.flight_phase = phase
        self.bridge.publisher.flight({'descending':'dive','searching':'surveil','ascending':'climb'}.get(phase,phase),message)

    def _execute(self, command):
        """Descend, infer at each view, restore measured height/camera, then report completion."""
        self.command = command; locked = False
        try:
            locked = self.bridge.flight_lock.acquire(blocking=False)
            if not locked: raise RuntimeError('Another maneuver owns the aircraft')
            reason = self.reason(starting=True)
            if reason: raise RuntimeError(reason)
            params = command.get('params',{}); target = params.get('target_altitude_m',.4); sweep = params.get('sweep_deg',360)
            if (type(target) not in (int,float) or not math.isfinite(target) or not .3 <= target <= 2
                    or type(sweep) not in (int,float) or not math.isfinite(sweep) or not 45 <= sweep <= 360):
                raise ValueError('Invalid height or sweep')
            original = self.driver.snapshot(); height = original['altitude_m']; pitch = original['camera_pitch_deg']
            if height-target < .15: raise ValueError('Search height must be at least 0.15 m below the current hover')
            self.started_at = self.clock(); self.refresh(); self.check()
            self._ack(command,'in_progress','Starting measured person-search descent')
            self.driver.configure(self.check)
            self._phase('descending',f'Descending to {target:.2f} m above takeoff'); self._height(target)
            self.driver.aim(-10.,self.check)
            self._phase('searching',f'Searching for people through {sweep:g} degrees')
            swept = 0.; segments = 0
            while sweep-swept > 5:
                step = math.radians(min(45,sweep-swept)); segments += 1
                if segments > math.ceil(sweep/45)+4: raise RuntimeError('Measured sweep made insufficient progress')
                before = self.check()['yaw_deg']
                self.driver.move(dz=0.,yaw=step,check=self.check)
                after = self.check()['yaw_deg']
                turn = math.atan2(math.sin(math.radians(after-before)),math.cos(math.radians(after-before)))
                if turn <= 0 or abs(turn-step) > math.radians(12): raise RuntimeError('Measured sweep yaw did not match the requested turn')
                swept += math.degrees(turn)
                if swept-sweep > 8: raise RuntimeError('Measured sweep exceeded the requested angle')
                captured_after = self.wall(); deadline = self.clock()+7
                while True:
                    self.check()
                    captured = self.control.get('person_detection',{}).get('captured_at')
                    if captured and datetime.fromisoformat(captured.replace('Z','+00:00')).timestamp() >= captured_after: break
                    if self.clock() >= deadline: raise RuntimeError('No fresh person inference completed at the search view')
                    self.sleep(.05)
            self._phase('ascending',f'Returning to measured starting height {height:.2f} m'); self._height(height)
            self.driver.aim(pitch,self.check); self.driver.restore(self.check)
            self._phase('hovering','Search completed; original height and camera pitch confirmed')
            self._ack(command,'done','Measured descent, person-search sweep and return completed')
        except Exception as error:
            self.last_error = str(error)
            if locked and self.started_at is not None:
                self.bridge.abort_flight.set(); self._phase('landing',str(error))
                try: confirmed = self.driver.land()
                except Exception: confirmed = False
                self.phase = 'landed' if confirmed else 'error'
                note = str(error)+('; aircraft confirmed landed' if confirmed else '; LANDING UNCONFIRMED')
            else: note = str(error)
            try: self._ack(command,'aborted' if isinstance(error,InterruptedError) else 'failed',note)
            except Exception: pass
        finally:
            if locked: self.bridge.flight_lock.release()
            self.started_at = None; self.command = None; self.busy.clear()


class OlympeDiveDriver:
    """Adapt bounded movement and measured confirmation to the installed SDK."""
    def __init__(self, bridge):
        self.bridge = bridge; self.events = {}; self.subscription = None; self.old_speed = None
        self.landing_lock = threading.Lock(); self.land_confirmed = False

    def attach(self, drone):
        """Record actual event arrival instead of treating cached SDK values as fresh events."""
        from olympe.messages.ardrone3.PilotingState import AltitudeChanged,SpeedChanged,AttitudeChanged
        from olympe.messages import gimbal
        messages = [(AltitudeChanged,'altitude'),(SpeedChanged,'speed'),(AttitudeChanged,'attitude'),(gimbal.attitude,'camera')]
        self.events.clear()
        self.subscription = []
        for message,name in messages:
            def receive(event,scheduler,key=name):
                """Record this sensor's actual event arrival, independently of cached state reads."""
                self.events[key] = time.monotonic()
            self.subscription.append(drone.subscribe(receive,message(_policy='wait')))

    def snapshot(self):
        """Expose current values together with independent sensor/video age evidence."""
        b = self.bridge
        if b.connected and b.drone is not None: b._poll_telemetry()
        t = b.telemetry or {}; attitude = t.get('attitude_deg') or {}
        return {'connected':bool(b.connected and b.drone is not None and b.drone.connected),
            'state':t.get('state'),'altitude_m':t.get('altitude_m'),'battery_pct':t.get('battery_pct'),
            'speed_mps':t.get('ground_speed_mps'),'roll_deg':attitude.get('roll'),'pitch_deg':attitude.get('pitch'),
            'yaw_deg':attitude.get('yaw'),'camera_pitch_deg':(t.get('extra') or {}).get('gimbal_pitch_deg'),
            'ages':{**{key:time.monotonic()-self.events.get(key,float('-inf')) for key in ('altitude','speed','attitude','camera')},
                    'video':time.time()-b.last_frame_time}}

    def _wait(self,pending,check,seconds=15):
        """Poll SDK expectations without blocking LAND or watchdog checks."""
        deadline = time.monotonic()+seconds
        try:
            while not pending.done():
                check()
                if time.monotonic() > deadline: raise TimeoutError('Aircraft command timed out')
                time.sleep(.03)
            check()
            if not pending.success(): raise RuntimeError('Aircraft did not acknowledge the command')
        except Exception:
            pending.cancel(); raise

    def configure(self,check):
        """Apply a 0.2 m/s vertical limit while remembering the actual previous setting."""
        from olympe.messages.ardrone3.SpeedSettings import MaxVerticalSpeed
        from olympe.messages.ardrone3.SpeedSettingsState import MaxVerticalSpeedChanged
        self.old_speed = (self.bridge._state(MaxVerticalSpeedChanged) or {}).get('current')
        self._wait(self.bridge.drone(MaxVerticalSpeed(.2)),check)

    def restore(self,check):
        """Restore only a speed setting that was actually read before the maneuver."""
        from olympe.messages.ardrone3.SpeedSettings import MaxVerticalSpeed
        if isinstance(self.old_speed,(int,float)) and math.isfinite(self.old_speed):
            self._wait(self.bridge.drone(MaxVerticalSpeed(self.old_speed)),check)

    def move(self,*,dz,yaw,check):
        """Bound each move to 20 cm vertical travel or 45 degrees yaw and wait for hover."""
        from olympe.messages.ardrone3.Piloting import moveBy
        from olympe.messages.ardrone3.PilotingState import FlyingStateChanged
        check()
        if abs(dz) > .201 or abs(yaw) > math.pi/4+.001: raise ValueError('Movement exceeds search bounds')
        self._wait(self.bridge.drone(moveBy(0.,0.,dz,yaw) >> FlyingStateChanged(state='hovering',_timeout=15)),check)
        completed = time.monotonic(); deadline = completed+2
        sensor = 'altitude' if abs(dz) > 0 else 'attitude'
        while self.events.get(sensor,float('-inf')) <= completed:
            check()
            if time.monotonic() > deadline: raise TimeoutError('No measured sensor update after the movement completed')
            time.sleep(.03)
        self.settle(check)

    def settle(self,check):
        """Require measured stationary hover after a movement acknowledgement."""
        deadline = time.monotonic()+3
        while True:
            sample = check()
            if sample['state'] == 'hovering' and sample['speed_mps'] <= .1: return
            if time.monotonic() > deadline: raise TimeoutError('Aircraft did not settle into hover')
            time.sleep(.03)

    def aim(self,pitch,check):
        """Verify the camera's actual pitch before starting or completing its search."""
        from olympe.messages import gimbal
        self._wait(self.bridge.drone(gimbal.set_target(gimbal_id=0,control_mode='position',
            yaw_frame_of_reference='none',yaw=0.,pitch_frame_of_reference='absolute',pitch=pitch,
            roll_frame_of_reference='none',roll=0.)),check)
        deadline = time.monotonic()+3
        while abs(check()['camera_pitch_deg']-pitch) > 5:
            if time.monotonic() > deadline: raise TimeoutError('Camera did not reach the requested angle')
            time.sleep(.03)

    def land(self):
        """Serialize shutdown and watchdog landing requests against the same aircraft object."""
        with self.landing_lock:
            if self.land_confirmed: return True
            self.land_confirmed = self._land_once()
            return self.land_confirmed

    def _land_once(self):
        """Confirm touchdown through a landed expectation; disconnected landing remains unconfirmed."""
        from olympe.messages.ardrone3.Piloting import Landing
        from olympe.messages.ardrone3.PilotingState import FlyingStateChanged
        try:
            if not self.snapshot()['connected']: return False
            confirmed = self.bridge.drone(Landing() >> FlyingStateChanged(state='landed',_timeout=30)).wait().success()
            self.bridge.flight_phase = 'landed' if confirmed else 'error'
            self.bridge.publisher.flight('landed' if confirmed else 'error',
                'Aircraft confirmed landed' if confirmed else 'LANDING UNCONFIRMED')
            return bool(confirmed)
        except Exception: return False
