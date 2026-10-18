#!/usr/bin/env python3
"""Opt-in QR orbit experiment. Default is a grounded, motor-disabled rehearsal.

Never installed by Start BOSCO. See docs/QR_ORBIT_DEMO.md before execution.
"""
import json
import math
import os
from pathlib import Path
import queue
import signal
import sys
import threading
import time

from anafi_bridge import (AnafiBridge, FireDetector, Publisher, argument_parser,
                          olympe, gimbal, AltitudeChanged, AttitudeChanged,
                          SpeedChanged, FlyingStateChanged, Landing)
from olympe.messages.move import extended_move_by
from olympe.messages.ardrone3.PilotingEvent import moveByEnd
from olympe.messages.ardrone3.Piloting import PCMD
from olympe.messages.ardrone3.PilotingSettings import MaxTilt
from olympe.messages.ardrone3.PilotingSettingsState import MaxTiltChanged
from olympe.messages.ardrone3.SpeedSettings import MaxRotationSpeed, MaxVerticalSpeed
from olympe.messages.ardrone3.SpeedSettingsState import MaxRotationSpeedChanged, MaxVerticalSpeedChanged
from olympe.messages.skyctrl.CoPilotingState import pilotingSource
from qr_orbit_core import Limits, Marker, Trigger, Vehicle, LandingConfirmation, fly_once, vehicle_reason
from qr_orbit_pose import CalibratedPose
from terminal_controls import commands as terminal_commands
from pose_history import PoseHistory


class SensorAges(olympe.EventListener):
    """Use received event ages; repeated cache reads cannot refresh these."""
    def __init__(self, drone, publisher=None):
        super().__init__(drone)
        self.ages = {}
        self.landed_at = float("-inf")
        self.state = None
        self.state_at = self.emergency_at = float('-inf')
        self.publisher = publisher
        self.history = PoseHistory()

    @olympe.listen_event(AltitudeChanged(_policy="wait"))
    def altitude(self, event, scheduler):
        self.ages["altitude"] = time.monotonic()
        self.history.record('altitude',self.ages['altitude'],event.args)

    @olympe.listen_event(SpeedChanged(_policy="wait"))
    def speed(self, event, scheduler):
        self.ages["speed"] = time.monotonic()
        self.history.record('speed',self.ages['speed'],event.args)

    @olympe.listen_event(AttitudeChanged(_policy="wait"))
    def attitude(self, event, scheduler):
        self.ages["attitude"] = time.monotonic()
        self.history.record('attitude',self.ages['attitude'],event.args)

    @olympe.listen_event(gimbal.attitude(_policy="wait"))
    def camera(self, event, scheduler):
        self.ages["camera"] = time.monotonic()
        self.history.record('camera',self.ages['camera'],event.args)

    @olympe.listen_event(FlyingStateChanged(_policy="wait"))
    def flight(self, event, scheduler):
        self.state = getattr(event.args.get('state'), 'name', str(event.args.get('state')))
        self.state_at = time.monotonic()
        if self.state == 'landed':
            self.landed_at = self.state_at
        if self.state == 'emergency':
            self.emergency_at = self.state_at
        if self.publisher is not None:
            self.publisher.diagnostic('aircraft_state', {'state':self.state})


class OlympeOrbitDriver:
    supports_continuous_orbit = True

    def __init__(self, bridge):
        self.bridge = bridge
        self.first_land_request = None
        self.movement_started = False
        self.landing_confirmation = LandingConfirmation()
        self.landing_error = None
        self._piloting_lock = threading.RLock()
        self._piloting_active = False
        self._piloting_restore = []
        self._last_motion_diagnostic_at = None

    def _continuous_diagnostic(self, kind, data):
        # High-cadence evidence belongs in the bounded flight recording, never
        # the network/dashboard path or unlimited idle receiver logs.
        publisher = getattr(self.bridge, 'publisher', None)
        if publisher is not None and getattr(publisher, 'recorder', None) is not None:
            self._diagnostic(kind, data)

    def _continuous_motion(self):
        from continuous_orbit import Motion
        ages = dict(getattr(getattr(self.bridge, 'sensor_ages', None), 'ages', {}))
        attitude = self.bridge._state(AttitudeChanged) or {}
        speed = self.bridge._state(SpeedChanged) or {}
        # AltitudeChanged is above takeoff; terrain clearance is the separate
        # AltitudeAboveGroundChanged event and must not drive this height loop.
        altitude = self.bridge._state(AltitudeChanged) or {}
        try:
            values = (min(ages.get(k, float('-inf')) for k in ('speed', 'attitude', 'altitude')),
                      attitude['yaw'], speed['speedX'], speed['speedY'], speed['speedZ'], altitude['altitude'])
            values = tuple(float(value) for value in values)
        except (KeyError, TypeError, ValueError):
            raise InterruptedError('Continuous orbit requires received motion and altitude samples')
        if not all(math.isfinite(value) for value in values):
            raise InterruptedError('Continuous orbit motion samples are invalid')
        # Keep conservative cross-sensor freshness separate from the velocity
        # sample's own timestamp: altitude/attitude updates must not create a
        # fictitious acceleration sample or alter velocity prediction age.
        observed = Motion(*values, velocity_at=float(ages['speed']))
        if observed.velocity_at != self._last_motion_diagnostic_at:
            self._last_motion_diagnostic_at = observed.velocity_at
            self._continuous_diagnostic('continuous_motion', {
                'oldest_sensor_at_mono':observed.at, 'velocity_at_mono':observed.velocity_at,
                'sample_times_mono':{name:ages.get(name) for name in ('speed','attitude','altitude','camera')},
                'velocity_ned_mps':{'north':observed.vx,'east':observed.vy,'down':observed.vz},
                'yaw_rad':observed.yaw_rad, 'altitude_m':observed.altitude,
                'attitude_rad':{axis:attitude.get(axis) if isinstance(attitude.get(axis),(int,float))
                    and math.isfinite(attitude[axis]) else None for axis in ('roll','pitch','yaw')}})
        return observed

    def _configure_continuous_controls(self, check, clock, sleep):
        # PCMD values are percentages of these settings, not velocity values.
        # Save the pilot's original settings and require a new acknowledgement
        # before interpreting a percentage as a bounded physical command.
        for command, state, value in ((MaxTilt, MaxTiltChanged, 10.),
                                      (MaxRotationSpeed, MaxRotationSpeedChanged, 60.),
                                      (MaxVerticalSpeed, MaxVerticalSpeedChanged, .3)):
            check()
            previous = self.bridge._state(state) or {}
            old = previous.get('current')
            if (not isinstance(old, (int, float)) or not math.isfinite(old)
                    or not all(isinstance(previous.get(k), (int, float)) and math.isfinite(previous[k])
                               for k in ('min', 'max'))
                    or not previous['min'] <= value <= previous['max']):
                raise RuntimeError('Continuous orbit piloting limits are unavailable or unsupported')
            self._piloting_restore.append((command, state, float(old)))
            pending = self.bridge.drone(command(current=value, _no_expect=True)
                >> state(current=value, _policy='wait', _timeout=2))
            deadline = clock()+2
            try:
                while not pending.done():
                    check()
                    if clock() >= deadline:
                        raise TimeoutError('Continuous orbit piloting setting was not acknowledged')
                    sleep(.02)
                check()
                if not pending.success():
                    raise RuntimeError('Continuous orbit piloting setting was rejected')
            finally:
                pending.cancel()

    def _continuous_command(self, control):
        with self._piloting_lock:
            values = (control.roll, control.pitch, control.yaw, control.gaz)
            if not all(isinstance(v, (int, float)) and math.isfinite(v) and -100 <= v <= 100 for v in values):
                raise ValueError('Continuous orbit produced an invalid piloting command')
            if self.first_land_request is not None or not self._piloting_active:
                if not any(values):
                    return  # A finally-block neutral must not restart piloting.
                raise InterruptedError('Landing requested; continuous controls stopped')
            # Installed Olympe 8.5 expires this command to neutral after .20 s
            # if this worker stalls. The SDK transmits PCMD every 25 ms.
            applied = tuple(int(round(v)) for v in values)
            issued_at = time.monotonic()
            accepted = self.bridge.drone.piloting(*applied, piloting_time=.20) is True
            self._continuous_diagnostic('continuous_pcmd', {'issued_at_mono':issued_at,
                'command':dict(zip(('roll','pitch','yaw','gaz'),applied)),
                'lease_seconds':.20, 'accepted':accepted})
            if not accepted:
                raise RuntimeError('Continuous orbit piloting command was rejected')

    def _neutralize_continuous_controls(self):
        with self._piloting_lock:
            if not self._piloting_active:
                return
            self._piloting_active = False
            try:
                issued_at = time.monotonic()
                accepted = self.bridge.drone.piloting(0, 0, 0, 0, piloting_time=.20) is True
                self._continuous_diagnostic('continuous_pcmd', {'issued_at_mono':issued_at,
                    'command':dict.fromkeys(('roll','pitch','yaw','gaz'),0),
                    'lease_seconds':.20, 'accepted':accepted, 'reason':'landing_or_cleanup'})
            finally:
                # Send neutral immediately as well as replacing the background
                # lease: positive PCMD gaz would cancel an SDK Landing command.
                self.bridge.drone(PCMD(0, 0, 0, 0, 0, 0, _no_expect=True))

    def orbit_continuously(self, target, limits, check, report, remember=None,
                          clock=time.monotonic, sleep=time.sleep):
        from continuous_orbit import run_continuous_orbit
        check()
        started = False
        try:
            self._configure_continuous_controls(check, clock, sleep)
            with self._piloting_lock:
                check()
                if self.first_land_request is not None:
                    raise InterruptedError('Landing requested; continuous controls stopped')
                if self.bridge.drone.start_piloting() is not True:
                    raise RuntimeError('Continuous orbit piloting interface could not start')
                self._piloting_active = started = True
            self.movement_started = True
            self._diagnostic('continuous_orbit_started', {'lap_seconds':limits.lap_seconds,
                'command_lease_seconds':.20, 'max_tilt_deg':10., 'max_yaw_deg_s':60., 'max_vertical_mps':.3})
            return run_continuous_orbit(target, limits, check, self._continuous_motion,
                self._continuous_command, report, remember=remember, diagnostic=self._diagnostic,
                clock=clock, sleep=sleep,get_bearing=lambda:getattr(self.bridge,'orbit_bearing',None))
        finally:
            try:
                self._neutralize_continuous_controls()
            finally:
                if started:
                    self.bridge.drone.stop_piloting()

    def _restore_continuous_controls(self):
        # Invoked only after the existing fresh, upright, stationary landing
        # confirmation. Changing control scales in flight would change commands.
        restore, self._piloting_restore = self._piloting_restore, []
        for command, state, value in reversed(restore):
            try:
                pending = self.bridge.drone(command(current=value, _no_expect=True)
                    >> state(current=value, _policy='wait', _timeout=2))
                if not pending.wait(_timeout=2).success():
                    raise RuntimeError('setting restore was not acknowledged')
            except Exception as error:
                self._diagnostic('piloting_setting_restore_failed', {'setting':str(command), 'reason':str(error)})

    def move(self, offset, speed, check):
        # The explicit event expectation filters errors; cached hovering alone
        # cannot acknowledge a new move. No unbounded wait blocks the watchdog.
        dx, dy, dz, yaw = offset
        check()
        self.movement_started = True
        # Capture errors too, so a rejected/interrupted command is diagnosed
        # immediately instead of disappearing into an eight-second timeout.
        event = moveByEnd(_policy="wait", _timeout=8)
        diagnostic = {"requested": dict(zip(("dX", "dY", "dZ", "dPsi"), offset)),
                      "speed_mps": speed}
        self._diagnostic("move_requested", diagnostic)
        pending = self.bridge.drone(extended_move_by(
            dx, dy, dz, yaw, speed, .2,
            45 if getattr(getattr(self.bridge,'limits',None),'lap_seconds',None)==15 else 25,
            _timeout=8, _no_expect=True) >> event)
        deadline = time.monotonic() + 8
        try:
            while not pending.done():
                check()
                if time.monotonic() >= deadline:
                    raise TimeoutError("relative move timed out")
                time.sleep(.05)
            check()
            if not pending.success():
                raise RuntimeError("aircraft did not acknowledge a successful relative move")
            matched = pending.matched_events().last(moveByEnd)
            if matched is None:
                raise RuntimeError("relative move completed without its displacement event")
            result = matched.args
            error = getattr(result["error"], "name", str(result["error"]))
            actual = tuple(float(result[k]) for k in ("dX", "dY", "dZ", "dPsi"))
            diagnostic.update(actual=dict(zip(("dX", "dY", "dZ", "dPsi"), actual)), error=error)
            self._diagnostic("move_completed", diagnostic)
            if error != "ok" or not all(math.isfinite(x) for x in actual):
                raise RuntimeError(f"relative move failed: {error}; actual={actual}")
            # Real short moves do not land exactly on their requested endpoint.
            # Permit bounded error; the preset feeds the measured result into
            # its next waypoint, rather than accumulating identical chords.
            horizontal_error = math.hypot(actual[0]-dx, actual[1]-dy)
            corrected_preset = getattr(self.bridge, 'path_reference', None) == 'launch-heading'
            horizontal_bad = (horizontal_error > .15 if corrected_preset else
                              abs(actual[0]-dx) > .08 or abs(actual[1]-dy) > .08)
            measured_fire = getattr(self.bridge, 'path_reference', None) == 'measured-fire'
            distance = math.hypot(dx, dy)
            if measured_fire and distance > .01:
                # orbit_fire waits for a fresh, coherent target after EACH move
                # and replans from that observation. A short endpoint is not a
                # failed mission; sideways error and overshoot remain bounded.
                along = (actual[0]*dx + actual[1]*dy)/distance
                cross = abs(actual[0]*dy - actual[1]*dx)/distance
                horizontal_bad = (along < -.01 or distance-along > .15
                                  or along-distance > .08 or cross > .08)
                if getattr(self.bridge,'response_mode',None)=='contour':
                    # Outdoor GPS steps are up to 2 m, then replan from a new
                    # received fix. Keep bounded stop error without applying
                    # centimetre-scale circle tolerances to this larger course.
                    horizontal_bad=(along < -.01 or distance-along > .5
                                    or along-distance > .3 or cross > .3)
            if horizontal_bad or abs(actual[2]-dz) > (.10 if corrected_preset else .08) or abs(actual[3]-yaw) > (.15 if corrected_preset else .1):
                raise RuntimeError(f"movement outside tolerance: requested={offset}, actual={actual}, "
                                   f"horizontal_error={horizontal_error:.3f} m")
            if measured_fire and horizontal_error > .08:
                self._diagnostic("move_replan", {**diagnostic,
                    "reason": "Bounded undershoot; reacquire target and correct next movement"})
            return actual
        except BaseException as error:
            self._diagnostic("move_failed", {**diagnostic, "reason": str(error)})
            pending.cancel()  # Cancels expectation only; Landing below interrupts flight.
            raise

    def _diagnostic(self, kind, data):
        publisher = getattr(self.bridge, "publisher", None)
        if publisher is not None and hasattr(publisher, "diagnostic"):
            publisher.diagnostic(kind, data)

    def request_land(self):
        # Serialize the landing latch with command updates so a concurrent
        # orbit worker cannot renew positive gaz after Landing is requested.
        with self._piloting_lock:
            if self.first_land_request is None:
                self.first_land_request = time.monotonic()
            try:
                self._neutralize_continuous_controls()
            except Exception as error:
                self._diagnostic('continuous_neutral_failed', {'reason':str(error)})
        ages = getattr(self.bridge, 'sensor_ages', None)
        if ages is not None and (getattr(ages, 'state', None) == 'emergency'
                                or math.isfinite(getattr(ages, 'emergency_at', float('-inf')))):
            self.landing_error = 'Aircraft entered emergency state; landing is not confirmed'
            return
        if self.bridge.drone is not None:
            if self.first_land_request is None:
                self.first_land_request = time.monotonic()
            self.bridge.drone(Landing(_no_expect=True))
            self._diagnostic('landing_requested', {'first_request':self.first_land_request})

    def land(self):
        # Keep receiving telemetry and video while awaiting an actual landed
        # event; sending Landing is never reported as proof of landing.
        if self.bridge.drone is None:
            return False
        if self.landing_confirmation.fault:
            return False
        try:
            landed = self.bridge.drone(FlyingStateChanged(state="landed", _policy="wait", _timeout=20))
        except Exception:
            return False
        deadline, last_send = time.monotonic()+20, 0
        while time.monotonic() < deadline:
            if time.monotonic()-last_send >= 2:
                try:
                    self.request_land()
                except Exception:
                    pass
                last_send = time.monotonic()
            ages = self.bridge.sensor_ages
            cached_state = self.bridge._state(FlyingStateChanged) or {}
            current_state = getattr(cached_state.get('state'),'name',cached_state.get('state'))
            if current_state is None:
                current_state = getattr(ages,'state',None)
            attitude = self.bridge._state(AttitudeChanged) or {}
            speed = self.bridge._state(SpeedChanged) or {}
            try:
                roll, pitch = (math.degrees(attitude[k]) for k in ('roll','pitch'))
                speed_mps = math.sqrt(sum(speed[k]**2 for k in ('speedX','speedY','speedZ')))
            except (KeyError,TypeError,ValueError):
                roll = pitch = speed_mps = float('nan')
            confirmed = self.landing_confirmation.observe(
                now=time.monotonic(), requested_at=self.first_land_request,
                state=current_state,state_at=getattr(ages,'state_at',float('-inf')),
                emergency_at=getattr(ages,'emergency_at',float('-inf')),
                connected=self.bridge.connected and self.bridge.drone.connected,
                sensors_at=min((getattr(ages,'ages',{}).get(k,float('-inf')) for k in ('attitude','speed'))),
                roll=roll,pitch=pitch,speed=speed_mps)
            if self.landing_confirmation.fault:
                self.landing_error = self.landing_confirmation.fault
                self._diagnostic('landing_failed', {'reason':self.landing_error})
                landed.cancel()
                return False
            if confirmed:
                self._diagnostic('landing_confirmed', {'state':ages.state,'roll_deg':roll,'pitch_deg':pitch,'speed_mps':speed_mps})
                landed.cancel()
                self._restore_continuous_controls()
                return True
            time.sleep(.1)
        landed.cancel()
        self.landing_error = 'Landing did not reach a fresh, upright, stationary landed state within 20 seconds'
        self._diagnostic('landing_failed', {'reason':self.landing_error})
        return False


class QROrbitBridge(AnafiBridge):
    def __init__(self, args, publisher, detector, pose, limits, marker):
        super().__init__(args, publisher, detector)
        self.pose, self.limits = pose, limits
        self.trigger = Trigger(marker, limits)
        self.marker = None
        self.marker_lock = threading.Lock()
        self.trigger_lock = threading.RLock()
        self.sensor_ages = None
        self.driver = OlympeOrbitDriver(self) if args.execute else None
        self.mission = None
        self.hold_connection = False
        self.land_confirmed = False
        self.last_processed_frame = None
        self.last_pose_log = 0
        self.input_closed = threading.Event()
        self.status_queue = queue.Queue(maxsize=32)

    def _connect(self):
        ok = super()._connect()
        if ok:
            self.sensor_ages = SensorAges(self.drone, self.publisher)
            self.sensor_ages.subscribe()
        return ok

    def _disconnect(self):
        if self.hold_connection and not self.land_confirmed:
            self.abort_flight.set()
            self._land()
        if self.sensor_ages:
            self.sensor_ages.unsubscribe()
            self.sensor_ages = None
        super()._disconnect()

    def _connection_step(self):
        if self.hold_connection:
            # Never destroy/reconnect the aircraft object during an armed session
            # or an unconfirmed landing. Reconnection cannot restart the mission.
            if not self._aircraft_link() or time.time()-self.last_frame_time > 1.5:
                if not self.abort_flight.is_set():
                    self.trigger.cancel("aircraft/video link lost")
                    self._request_landing()
            if self._aircraft_link():
                self._poll_telemetry()
            time.sleep(.1)
        else:
            super()._connection_step()

    def _controller_source_ok(self):
        # Never switch to Controller here: that setting disables RC joysticks.
        # This only verifies the reported source; physical override/landing still
        # require the separate supervised preflight and actual hardware testing.
        if getattr(self.args, "terminal_control", False):
            return self.controller_kind == "direct" and not self.input_closed.is_set()
        if self.controller_kind != "skycontroller3":
            return False
        source = (self._state(pilotingSource) or {}).get("source")
        return getattr(source, "name", source) == "SkyController"

    def sample(self):
        t = self.telemetry or {}
        attitude = t.get("attitude_deg") or {}
        ages = dict(self.sensor_ages.ages) if self.sensor_ages else {}
        oldest = min((ages.get(key, float("-inf")) for key in ("altitude", "speed", "attitude", "camera")))
        vehicle = Vehicle(oldest, bool(self.connected and self._aircraft_link()),
                          t.get("state"), t.get("battery_pct"), t.get("altitude_m"),
                          t.get("ground_speed_mps"),
                          max(abs(attitude.get("roll", float("inf"))), abs(attitude.get("pitch", float("inf")))),
                          self._controller_source_ok())
        with self.marker_lock:
            marker = self.marker
        return vehicle, marker

    def _poll_telemetry(self):
        with self.lock:
            super()._poll_telemetry()
            if self.telemetry["extra"]["position_source"] != "gps":
                self.telemetry["latitude"] = self.telemetry["longitude"] = None
                self.telemetry["extra"]["position_source"] = "unavailable; marker-relative demo"

    def _telemetry_loop(self):
        while self.running:
            with self.lock:
                sample = self.telemetry
            if self.connected and sample:
                try:
                    self.publisher.telemetry(sample)
                except Exception:
                    print("[!] Telemetry not delivered; local supervision continues", flush=True)
            time.sleep(1)

    def _overlay_lines(self):
        t = self.telemetry or {}
        return ["QR ORBIT: " + ("LIVE EXPERIMENT" if self.args.execute else "REHEARSAL / MOTORS DISABLED"),
                f"QR session: {self.trigger.state}", f"Battery: {t.get('battery_pct')} %",
                f"Height above takeoff: {t.get('altitude_m')} m", f"State: {t.get('state')}",
                f"GPS: {t.get('extra', {}).get('position_source', 'unknown')}"]

    def _detect_step(self, img, captured):
        if self.last_processed_frame == captured:
            return
        self.last_processed_frame = captured
        self._process_hit(img, captured, self.detector.detect(img))

    def _process_hit(self, img, captured, hit):
        marker = None
        if hit and hit.get("source") == "qr-test":
            self.overlay = [{k: hit[k] for k in ("source", "label", "confidence", "bbox")}]
            self.overlay_time = time.time()
            at = time.monotonic() - (time.time()-captured)
            if self.pose is None:
                # Rehearsal pose is deliberately simulated, never flight evidence.
                marker = Marker(at, hit["qr_text"], self.limits.radius_m, 0, self.limits.height_m, 0, 0)
            else:
                try:
                    state = self._state(gimbal.attitude) or {}
                    if 0 in state:
                        state = state[0]
                    yaw = (self.telemetry or {}).get("extra", {}).get("heading_deg")
                    marker = self.pose.estimate(hit["qr_text"], hit["qr_corners"], img.shape, at, yaw, state)
                    if time.monotonic()-self.last_pose_log >= 1:
                        self.last_pose_log = time.monotonic()
                        print(f"[POSE] forward={marker.forward_m:.2f} right={marker.right_m:.2f} "
                              f"down={marker.down_m:.2f} m; floor tilt={marker.floor_tilt_deg:.1f} deg; "
                              f"reprojection={marker.reprojection_px:.2f} px", flush=True)
                except (ValueError, KeyError, TypeError) as error:
                    self.trigger.reason = f"pose unavailable: {error}"
        else:
            self.overlay = []
        if marker is not None:
            with self.marker_lock:
                self.marker = marker
        else:
            # Reset the consecutive recognition streak on a miss, but preserve
            # the last pose until its timestamp expires during an active chord.
            # A single failed decode must not manufacture a brand-new pose.
            with self.trigger_lock:
                if self.trigger.state == "armed":
                    self.trigger.hits, self.trigger.first = 0, None
                    self.trigger.reason = "waiting for stable QR observations"
        # No Gemini response, simulated fire metadata or dashboard button has
        # access to the flight driver. Detection handling never moves the drone.

    def report(self, phase, message, step=None, steps=None):
        prefix = "LIVE EXPERIMENT" if self.args.execute else "REHEARSAL / NO MOTOR COMMANDS"
        if self.args.execute:
            self.flight_phase = phase
            self.land_confirmed = phase == "landed"
        # Preserve the actual control-thread timestamp even if HTTP delivery is
        # delayed, the status queue fills, or shutdown follows landing at once.
        if hasattr(self.publisher, 'diagnostic'):
            self.publisher.diagnostic('flight_control', {
                'phase': phase, 'message': message, 'step': step, 'steps': steps})
        # Neither a stalled terminal nor a backend outage may block the flight
        # worker. The status thread owns all report output and HTTP delivery.
        try:
            self.status_queue.put_nowait((phase, f"{prefix}: {message}", step, steps))
        except queue.Full:
            pass

    def _publish_status(self):
        while self.running or not self.status_queue.empty():
            try:
                phase, message, step, steps = self.status_queue.get(timeout=.2)
            except queue.Empty:
                continue
            prefix = "LIVE EXPERIMENT" if self.args.execute else "REHEARSAL / NO MOTOR COMMANDS"
            try:
                print(f"[{prefix}] {phase}: {message}", flush=True)
            except (OSError, ValueError):
                pass
            try:
                self.publisher.flight(phase, message, step=step, steps=steps)
            except Exception:
                print("[!] Dashboard status not delivered; local supervision continues", flush=True)

    def _request_landing(self, force=True):
        self.abort_flight.set()
        if self.land_confirmed:
            return
        if force and self.driver and self.connected:
            self.hold_connection = True  # Explicit pilot LAND also works before arming.
        if self.driver and self.hold_connection:
            try:
                self.driver.request_land()
            except Exception:
                print("[!] Landing request not delivered; pilot intervention required", flush=True)

    def _land(self):
        if self.driver and self.hold_connection and not self.land_confirmed:
            self.abort_flight.set()
            if self.mission and self.mission.is_alive() and threading.current_thread() != self.mission:
                self.mission.join(timeout=22)
                if self.mission.is_alive():
                    self.report("error", "flight worker did not stop: pilot intervention required")
                return
            self.report("landing", "operator/shutdown landing request")
            try:
                confirmed = self.driver.land()
            except Exception as error:
                self.driver.landing_error = f'Landing confirmation failed: {type(error).__name__}: {error}'
                confirmed = False
            self.report("landed" if confirmed else "error", "aircraft confirmed landed" if confirmed else
                        "LANDING UNCONFIRMED: " + (getattr(self.driver,'landing_error',None) or 'pilot intervention required'))

    def _orbit(self):
        fly_once(self.driver, self.limits, self.trigger.expected, self.sample,
                 self.abort_flight, self.report,
                 one_segment=getattr(self.args, "checkout_one_segment", False))

    def _terminal(self):
        arm_phrase = "ARM QR CHECKOUT" if getattr(self.args, "checkout_one_segment", False) else "ARM QR ORBIT"
        try:
            for command in terminal_commands(sys.stdin, stopped=lambda: not self.running):
                if command in ("LAND", "X", "ABORT"):
                    with self.trigger_lock:
                        self.trigger.cancel()
                    self._request_landing()
                elif command == arm_phrase:
                    if self.args.execute:
                        try:
                            read_preflight(self.args.preflight_file, terminal_control=getattr(self.args, "terminal_control", False))
                        except (ValueError, KeyError, OSError) as error:
                            print(f"[!] Cannot arm: {error}", flush=True)
                            continue
                        v, _ = self.sample()
                        reason = vehicle_reason(v, self.limits, time.monotonic(), starting=True)
                        if reason:
                            print(f"[!] Cannot arm: {reason}", flush=True)
                            continue
                    try:
                        with self.trigger_lock:
                            self.trigger.arm(time.monotonic())
                        self.hold_connection = self.args.execute
                        self.report("preflight", "armed for 20 seconds; selected QR required")
                    except ValueError as error:
                        print(f"[!] {error}", flush=True)
        finally:
            self.input_closed.set()
            with self.trigger_lock:
                self.trigger.cancel("operator terminal closed")
            self._request_landing(force=False)

    def run(self):
        print("REHEARSAL: motors disabled" if not self.args.execute else "LIVE EXPERIMENT: disarmed", flush=True)
        checkout = getattr(self.args, "checkout_one_segment", False)
        arm_phrase = "ARM QR CHECKOUT" if checkout else "ARM QR ORBIT"
        print("ONE-SEGMENT CHECKOUT, THEN LAND" if checkout else "ONE TWELVE-SEGMENT ORBIT, THEN LAND", flush=True)
        print(f"Type {arm_phrase} once; Esc or X requests landing WITHOUT Enter. LAND + Enter and Ctrl+C also request landing. No automatic takeoff.", flush=True)
        threading.Thread(target=self._publish_status, daemon=True).start()
        threading.Thread(target=self._terminal, daemon=True).start()

        def supervise():
            last_reason = None
            while self.running:
                v, m = self.sample()
                with self.trigger_lock:
                    triggered = self.trigger.observe(m, v, time.monotonic(), rehearsal=not self.args.execute)
                if triggered:
                    if self.args.execute:
                        self.mission = threading.Thread(target=self._orbit)
                        self.mission.start()
                    else:
                        count = 1 if checkout else 12
                        self.report("circle", f"selected QR recognized: WOULD fly {count} segment(s), then land (simulated)")
                if self.trigger.reason != last_reason:
                    last_reason = self.trigger.reason
                    print(f"[QR] {last_reason}", flush=True)
                # An armed pilot hover remains pilot-controlled when arming
                # expires; LAND remains available. Never silently re-arm.
                time.sleep(.05)

        threading.Thread(target=supervise, daemon=True).start()
        try:
            super().run()
        finally:
            self.abort_flight.set()
            if self.mission:
                self.mission.join(timeout=23)
            self._land()  # Also covers a broken stdout during the legacy cleanup.


def read_preflight(path, terminal_control=False):
    c = json.loads(Path(path).read_text(encoding="utf-8"))
    landing_check = "terminal_landing_tested_with_pi" if terminal_control else "landing_control_tested_with_pi"
    needed = ("cleared_area", "pilot_present", landing_check,
              "marker_on_launch_floor", "calibration_checked_at_known_positions")
    if terminal_control:
        needed += ("controller_powered_off",)
    if any(c.get(key) is not True for key in needed):
        raise ValueError("Live orbit requires a completed supervised preflight, including tested landing control")
    # These acknowledgments describe a physical rehearsal, not a software test.
    tested = float(c["checked_at_unix"])
    if not 0 <= time.time()-tested <= 3600:
        raise ValueError("Preflight acknowledgment expired (maximum one hour)")


def main():
    parser = argument_parser()
    parser.description = __doc__
    parser.add_argument("--execute", action="store_true", help="opt in to hardware commands; still requires typed arming")
    parser.add_argument("--terminal-control", action="store_true",
                        help="direct Pi control with terminal landing; controller must be off, requires its own physical landing-test record")
    parser.add_argument("--checkout-one-segment", action="store_true",
                        help="one chord then land, armed with ARM QR CHECKOUT; uses all the live-flight gates")
    parser.add_argument("--height", type=float, default=1.0, help="pilot-established hover height above launch floor")
    parser.add_argument("--marker-file", default=str(Path(__file__).with_name("orbit-marker.txt")))
    parser.add_argument("--camera-calibration", help="measured intrinsics/extrinsics JSON; required with --execute")
    parser.add_argument("--preflight-file", help="recent physical preflight acknowledgment; required with --execute")
    args = parser.parse_args()
    if args.demo_flight or args.gimbal_pitch is not None:
        parser.error("QR orbit cannot be combined with legacy demo-flight or automatic camera aiming")
    if args.terminal_control and args.controller != "direct":
        parser.error("--terminal-control requires --controller direct")
    if args.execute and args.controller != "skycontroller3" and not args.terminal_control:
        parser.error("Live QR execution requires --controller skycontroller3 or explicit --terminal-control with the controller off")
    if not sys.stdin.isatty():
        parser.error("Use an interactive pilot terminal; unattended startup is disabled")
    args.no_auto_gimbal, args.no_yolo = True, True
    try:
        limits = Limits(radius_m=args.radius, height_m=args.height)
        marker = Path(args.marker_file).read_text(encoding="utf-8").strip()
        pose = None
        if args.execute:
            if not args.camera_calibration or not args.preflight_file:
                parser.error("--execute requires --camera-calibration and --preflight-file")
            read_preflight(args.preflight_file, terminal_control=args.terminal_control)
        if args.camera_calibration:
            pose = CalibratedPose(args.camera_calibration, require_verified=args.execute)
    except (ValueError, KeyError, OSError) as error:
        parser.error(str(error))
    token = os.environ.get("INGEST_TOKEN")
    if args.backend and not token:
        parser.error("Backend integration requires INGEST_TOKEN in the environment")
    bridge = QROrbitBridge(args, Publisher(args.out_dir, args.backend, token),
                           FireDetector(args.model, args.conf, use_yolo=False), pose, limits, marker)
    def stop_on_signal(signum, frame):
        bridge.running = False  # Main loop exits into the bounded landing cleanup.
    for name in ("SIGTERM", "SIGHUP"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), stop_on_signal)
    bridge.run()


if __name__ == "__main__":
    main()
