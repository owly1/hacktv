#!/usr/bin/env python3
"""Separate real-fire retreat runtime: --execute + ARM FIRE BUFFER, no takeoff.

Requires a pilot-established hover, verified mission geometry and a paired
SkyController. QR scans cannot arm or control this runtime. No automatic land
on fire/pose loss: interrupt relative movement, verify hover and latch stopped.
"""
from datetime import datetime
import json
import math
import os
from pathlib import Path
import queue
import signal
import sys
import threading
import time
import cv2

from anafi_bridge import (AnafiBridge, FireDetector, Publisher, argument_parser,
                         olympe, gimbal, GpsLocationChanged, GPSFixStateChanged,
                         BatteryStateChanged, WindSpeed, FlyingStateChanged, Landing, moveBy)
from olympe.messages.move import extended_move_by
from olympe.messages.ardrone3.PilotingEvent import moveByEnd
from olympe.messages.skyctrl.CoPilotingState import pilotingSource
from qr_orbit_bridge import SensorAges
from terminal_controls import commands
from real_fire_core import Limits, Vehicle, Session, local_position, project_fire
from real_fire_driver import Driver
from fire_monitor import Episodes, detection_payload


def read_setup(config_path, preflight_path=None, execute=False):
    """Read bounded geometry and, for live execution, recent physical verification."""
    config = json.loads(Path(config_path).read_text(encoding='utf-8'))
    limits = Limits(**config['limits'])
    if execute:
        if config.get('camera_and_ground_measured') is not True:
            raise ValueError('measured camera/ground configuration required')
        checks = json.loads(Path(preflight_path).read_text(encoding='utf-8'))
        required = ('pilot_present', 'controller_override_tested', 'zero_move_stop_tested',
                    'landing_control_tested', 'flight_area_clear', 'flat_ground_verified',
                    'extent_and_gps_error_bound_verified', 'camera_unzoomed_yaw_aligned',
                    'wind_and_energy_checked', 'single_receiver_verified')
        if any(checks.get(k) is not True for k in required):
            raise ValueError('real-fire physical preflight incomplete')
        if checks.get('mission_limits') != config['limits']:
            raise ValueError('preflight must verify this exact mission configuration')
        age = time.time()-float(checks['checked_at_unix'])
        if not 0 <= age <= 3600:
            raise ValueError('real-fire preflight expired')
    return limits


def assert_single_receiver(proc_root=Path('/proc')):
    """Refuse another local aircraft runtime without stopping or modifying it."""
    names = {'anafi_bridge.py', 'anafi_observer.py', 'real_fire_bridge.py', 'hover_checkout.py',
             'qr_auto_circle.py', 'qr_takeoff_demo.py', 'qr_orbit_bridge.py', 'qr_preset_demo.py'}
    for process in proc_root.iterdir():
        if not process.name.isdigit() or int(process.name) == os.getpid():
            continue
        try:
            arguments = (process/'cmdline').read_bytes().split(b'\0')
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
        if any(Path(arg.decode(errors='replace')).name in names for arg in arguments):
            raise ValueError('another aircraft receiver is running; use its terminal to stop it first')


class FireSensors(SensorAges):
    """Add GPS, battery, flight and wind receipt ages to the existing pose events."""
    @olympe.listen_event(GpsLocationChanged(_policy='wait'))
    def gps(self, event, scheduler):
        """Stamp receipt of measured GPS position, never a polled cache read."""
        self.ages['gps'] = time.monotonic()

    @olympe.listen_event(BatteryStateChanged(_policy='wait'))
    def battery(self, event, scheduler):
        """Stamp the battery event used by the flight watchdog."""
        self.ages['battery'] = time.monotonic()

    @olympe.listen_event(FlyingStateChanged(_policy='wait'))
    def flight(self, event, scheduler):
        """Track actual flight state transitions and landed confirmation."""
        super().flight(event, scheduler)
        self.last_flight = event.args.get('state')

    if WindSpeed is not None:
        @olympe.listen_event(WindSpeed(_policy='wait'))
        def wind(self, event, scheduler):
            """Stamp receipt of FC wind measurements required by this outdoor mode."""
            self.ages['wind'] = time.monotonic()


class RealFireBridge(AnafiBridge):
    def __init__(self, args, publisher, detector, limits):
        """Own one aircraft connection, real evidence stream and isolated retreat session."""
        super().__init__(args, publisher, detector)
        self.limits = limits
        self.sensor_ages = None
        self.fire_lock = threading.Lock()
        self.fire = None
        self.last_capture = None
        self.input_closed = threading.Event()
        self.status_queue = queue.Queue(maxsize=64)
        self.detection_queue = queue.Queue(maxsize=1)
        self.episodes = Episodes()
        self.driver = Driver(self._send_move, self._send_stop, self._send_land)
        self.session = Session(limits, args.drone_id, self.sample, self.driver, self.report, execute=args.execute)
        self.control_thread = None

    def report(self, phase, message):
        """Queue status off the control worker so HTTP/terminal latency cannot block flight."""
        try:
            self.status_queue.put_nowait((phase, message))
        except queue.Full:
            pass

    def _publish_status(self):
        """Publish operational state without authorizing any aircraft commands."""
        while self.running or not self.status_queue.empty():
            try:
                phase, message = self.status_queue.get(timeout=.2)
            except queue.Empty:
                continue
            try:
                print(f'[REAL FIRE] {phase}: {message}', flush=True)
                self.publisher.flight(phase, message)
            except Exception:
                pass

    def _publish_detections(self):
        """Deliver confirmed live fire evidence without network calls on the control path."""
        while self.running:
            try:
                payload = self.detection_queue.get(timeout=.2)
            except queue.Empty:
                continue
            try:
                self.publisher.detection(payload)
            except Exception:
                pass

    def _connect(self):
        """Subscribe to real event ages on the same aircraft SDK object."""
        ok = super()._connect()
        if ok:
            self.sensor_ages = FireSensors(self.drone)
            self.sensor_ages.subscribe()
        return ok

    def _control_source(self):
        """Require the verified paired controller route without switching piloting source."""
        source = (self._state(pilotingSource) or {}).get('source')
        return self.controller_kind == 'skycontroller3' and getattr(source, 'name', source) == 'SkyController'

    def sample(self):
        """Return synchronized snapshots with oldest real sensor age and measured GPS."""
        with self.lock:
            t = self.telemetry or {}
        ages = dict(self.sensor_ages.ages) if self.sensor_ages else {}
        extra, attitude = t.get('extra') or {}, t.get('attitude_deg') or {}
        try:
            e, n = local_position(t.get('latitude'), t.get('longitude'), self.limits)
        except ValueError:
            e = n = float('nan')
        # Battery updates more slowly than pose, but cannot remain cached indefinitely.
        battery = t.get('battery_pct') if 0 <= time.monotonic()-ages.get('battery', -math.inf) <= 10 else None
        at = min(ages.get(k, -math.inf) for k in ('altitude', 'speed', 'attitude', 'camera', 'gps', 'wind'))
        if not 0 <= time.time()-self.last_frame_time <= 1.5:
            at = -math.inf
        vehicle = Vehicle(at, t.get('drone_id'), e, n, t.get('altitude_m'), extra.get('heading_deg'),
                          t.get('ground_speed_mps'), max(abs(attitude.get('roll', math.inf)), abs(attitude.get('pitch', math.inf))),
                          battery, extra.get('fc_wind_speed_mps') if extra.get('fc_wind_available') is True else None, t.get('state'),
                          bool(self.connected and self._aircraft_link()), t.get('gps_fix') is True and extra.get('position_source') == 'gps',
                          self._control_source() and not self.input_closed.is_set())
        with self.fire_lock:
            fire = self.fire
        return vehicle, fire

    def _detect_step(self, image, captured):
        """Project only fresh real-fire frames; QR and missing detections invalidate control evidence."""
        if self.last_capture is not None and captured <= self.last_capture:
            return
        self.last_capture = captured
        fire = None
        hit = self.detector.detect(image)
        self.overlay = [{k: hit[k] for k in ('source', 'label', 'confidence', 'bbox')}] if hit else []
        self.overlay_time = time.time()
        try:
            with self.lock:
                t = self.telemetry or {}
            pose_time = datetime.fromisoformat(t['observed_at'].replace('Z', '+00:00')).timestamp()
            if not 0 <= time.time()-captured <= .75 or abs(pose_time-captured) > .5:
                raise ValueError('capture/pose synchronization failed')
            camera = self._state(gimbal.attitude) or {}
            if 0 in camera:
                camera = camera[0]
            # The projection uses body heading, so reject camera yaw/roll changes.
            yaw_error = (float(camera['yaw_absolute'])-t['extra']['heading_deg']+180)%360-180
            angles = (yaw_error, float(camera['roll_absolute']))
            if any(not math.isfinite(a) or abs(a) > 5 for a in angles):
                raise ValueError('camera yaw/roll differs from verified alignment')
            at = time.monotonic()-(time.time()-captured)
            fire = project_fire(hit, t, image.shape, at, self.limits)
        except (ValueError, TypeError, KeyError, AttributeError):
            pass
        with self.fire_lock:
            self.fire = fire
        episode = self.episodes.observe(hit if fire else None, captured, time.time())
        if episode:
            ok, jpeg = cv2.imencode('.jpg', image)
            if ok:
                payload = detection_payload(hit, jpeg.tobytes(), captured, episode, t, frame_shape=image.shape)
                e, n = local_position(t['latitude'], t['longitude'], self.limits)
                # Publish the same calibrated ground envelope used by control,
                # not the generic monitor's different FOV/ground assumption.
                payload['details'].update(area_ha=math.pi*fire.radius**2/10000,
                                          area_source='camera-box-estimate', area_method='enclosing-projected-box',
                                          extent_uncertainty_m=self.limits.uncertainty_m)
                payload['fire'].update(
                    latitude=self.limits.origin_lat+fire.north/111320,
                    longitude=self.limits.origin_lon+fire.east/(111320*math.cos(math.radians(self.limits.origin_lat))),
                    distance_m=math.hypot(fire.east-e, fire.north-n),
                    bearing_deg=math.degrees(math.atan2(fire.east-e, fire.north-n))%360,
                    position_source='gps+camera-ray-flat-ground')
                try:
                    self.detection_queue.put_nowait(payload)
                    self.episodes.acknowledged(time.time())
                except queue.Full:
                    pass

    def _send_move(self, offset, speed):
        """Dispatch a bounded SDK move; return its expectation and displacement reader."""
        if not self.args.execute or not self.session.active or self.session.aborted.is_set():
            raise ValueError('real-fire flight is not armed')
        event = moveByEnd(_policy='wait', _timeout=8)
        pending = self.drone(extended_move_by(*offset, speed, .2, 10., _timeout=8, _no_expect=True) >> event)

        def actual():
            """Accept only successful displacement events for the requested move."""
            matched = pending.matched_events().last(moveByEnd)
            if matched is None:
                return None
            result = matched.args
            if getattr(result.get('error'), 'name', str(result.get('error'))) != 'ok':
                return None
            return tuple(float(result[k]) for k in ('dX', 'dY', 'dZ', 'dPsi'))
        return pending, actual

    def _send_stop(self):
        """Interrupt relative flight with a zero move and demand a new hover event."""
        if not self.args.execute or not self._aircraft_link() or not self._control_source():
            return False
        # A second moveBy interrupts the first. Cancelling an SDK expectation
        # alone does not stop the aircraft. This binding is physically preflighted.
        hover = self.drone(FlyingStateChanged(state='hovering', _policy='wait', _timeout=3))
        self.drone(moveBy(0., 0., 0., 0., _no_expect=True))
        try:
            hover.wait(_timeout=3)
            return bool(hover.success())
        finally:
            hover.cancel()

    def _send_land(self):
        """Request landing only after explicit operator input and confirm its event."""
        if not self.args.execute or not self._aircraft_link() or not self._control_source():
            return False
        pending = self.drone(Landing(_no_expect=True) >> FlyingStateChanged(state='landed', _policy='wait', _timeout=20))
        try:
            pending.wait(_timeout=20)
            return bool(pending.success())
        finally:
            pending.cancel()

    def _request_landing(self):
        """Serialize operator landing after cancelling all autonomous retreat work."""
        self.session.halt('operator requested landing')
        with self.session.command_lock:
            confirmed = self.driver.land() if self.args.execute else False
        self.report('landed' if confirmed else 'error', 'landing confirmed' if confirmed else 'landing unconfirmed or disabled')

    def _land(self):
        """Override legacy automatic shutdown landing: stop and hand control to the pilot."""
        self.session.halt('runtime shutdown')

    def _connection_step(self):
        """Never reconnect/re-arm a used flight session or replace its SDK connection."""
        if self.session.used:
            if not self._aircraft_link():
                self.session.halt('aircraft link lost')
            else:
                self._poll_telemetry()
            time.sleep(.1)
        else:
            super()._connection_step()

    def _disconnect(self):
        """Stop autonomous work before releasing the sole aircraft connection."""
        self.session.halt('aircraft connection closing')
        if self.sensor_ages:
            self.sensor_ages.unsubscribe()
            self.sensor_ages = None
        super()._disconnect()

    def _terminal(self):
        """Accept explicit real-fire arming, latched HOLD/ABORT and operator LAND."""
        try:
            for command in commands(sys.stdin, stopped=lambda: not self.running):
                if command == 'ARM FIRE BUFFER':
                    try:
                        checked = read_setup(self.args.mission_config, self.args.preflight_file, execute=True)
                        if checked != self.limits:
                            raise ValueError('mission configuration changed; restart before arming')
                        self.session.arm()
                    except (ValueError, TypeError, OSError, KeyError) as error:
                        self.report('preflight', str(error))
                elif command == 'LAND':
                    self._request_landing()
                elif command in ('HOLD', 'ABORT'):
                    self.session.halt('operator stopped retreat')
        finally:
            self.input_closed.set()
            self.session.halt('operator terminal closed')

    def _control(self):
        """Continuously maintain the buffer until explicit cancellation or a latched fault."""
        while self.running:
            self.session.tick()
            time.sleep(.05)

    def run(self):
        """Start independent terminal/control workers; ordinary observation never starts this mode."""
        print('REAL FIRE: disabled' if not self.args.execute else 'REAL FIRE: DISARMED; pilot must establish hover', flush=True)
        print('ARM FIRE BUFFER enables retreat; HOLD/ABORT stops; X/Esc/LAND explicitly lands. No automatic takeoff.', flush=True)
        for target in (self._publish_status, self._publish_detections, self._terminal):
            threading.Thread(target=target, daemon=True).start()
        self.control_thread = threading.Thread(target=self._control, daemon=True)
        self.control_thread.start()
        try:
            super().run()
        finally:
            self.session.halt('runtime ended')
            self.running = False
            self.control_thread.join(timeout=12)


def main():
    """Validate the separate outdoor mission before creating any aircraft adapter."""
    parser = argument_parser()
    parser.description = __doc__
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--mission-config', required=True)
    parser.add_argument('--preflight-file')
    args = parser.parse_args()
    if args.demo_flight or args.no_yolo or args.detect_smoke or args.gimbal_pitch is not None:
        parser.error('real-fire mode cannot use QR-only, smoke, demo-flight or automatic gimbal modes')
    if not sys.stdin.isatty():
        parser.error('interactive operator terminal required')
    if args.execute and (args.controller != 'skycontroller3' or not args.preflight_file):
        parser.error('execution requires a paired SkyController and verified real-fire preflight')
    try:
        limits = read_setup(args.mission_config, args.preflight_file, args.execute)
        assert_single_receiver()
    except (ValueError, TypeError, OSError, KeyError) as error:
        parser.error(str(error))
    args.no_auto_gimbal = args.no_window = args.no_person = True
    args.hfov = limits.hfov_deg
    token = os.environ.get('INGEST_TOKEN')
    if args.backend and not token:
        parser.error('--backend requires INGEST_TOKEN')
    detector = FireDetector(args.model, max(.8, args.conf), use_yolo=True)
    if detector.model_status != 'ready':
        parser.error('real fire model unavailable; QR cannot substitute for real-fire evidence')
    bridge = RealFireBridge(args, Publisher(args.out_dir, args.backend, token), detector, limits)

    def stop(signum, frame):
        """Latch cancellation on terminal/process signals; do not choose a landing site."""
        bridge.session.aborted.set()
        bridge.running = False
    for name in ('SIGINT', 'SIGTERM', 'SIGHUP'):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), stop)
    bridge.run()


if __name__ == '__main__':
    main()
