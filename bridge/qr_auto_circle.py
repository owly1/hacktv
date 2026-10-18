#!/usr/bin/env python3
"""Opt-in autonomous QR fire -> takeoff -> measured or preset circle -> land.

--execute enables one automatic flight per process after a stable selected QR
creates a backend incident. Without it, detection works but motors stay disabled.
--preset uses the fixed launch-relative demo instead of a measured-marker orbit.
--fire-size backs away to a scaled indoor radius derived from QR fire hectares.
"""
import os
import math
from pathlib import Path
import queue
import secrets
import signal
import sys
import threading
import time

import cv2
from anafi_bridge import FireDetector, Publisher, argument_parser, gimbal
from fire_detection import parse_marker
from fire_monitor import detection_payload
from hover_checkout import HoverCheckout
from qr_circle_core import ScanGate, camera_pitch, circle, fire_size_radius
from qr_orbit_bridge import read_preflight
from qr_orbit_core import Limits, Trigger, Vehicle
from qr_orbit_pose import CalibratedPose
from qr_preset_core import fly_preset
from terminal_controls import commands as terminal_commands


class QRAutoCircle(HoverCheckout):
    flight_protocol = 'qr-auto-circle'
    path_reference = 'measured-marker'

    def __init__(self, args, publisher, detector, pose, marker):
        """Initialize the one-shot measured-marker mission, incident queue and camera tracker."""
        super().__init__(args, publisher, detector)
        self.pose = pose
        self.fire_size = bool(getattr(args, 'fire_size', False))
        if self.fire_size and getattr(args, 'preset', False):
            raise ValueError('Fire-size mode requires a measured marker, not the fixed preset')
        details = parse_marker(marker)
        if details is None:
            raise ValueError('Select the pinned fire marker')
        self.area_ha = details['area_ha']
        radius = fire_size_radius(self.area_ha) if self.fire_size else 1.
        if self.fire_size:
            self.flight_protocol = 'qr-fire-size'
        self.limits = Limits(radius_m=radius, height_m=1., segments=24, mission_seconds=90)
        self.trigger = Trigger(marker, self.limits)
        self.scan = ScanGate(marker)
        self.episode_id = self.flight_protocol + '-' + secrets.token_hex(8)
        self.incident_queue = queue.Queue(maxsize=1)
        self.incident_pending = False
        self.incident_id = None
        self.next_post = 0
        self.started_at = None
        self.camera_stop = threading.Event()

    def _ready_message(self):
        """Explain automatic takeoff when execution is enabled, or incident-only rehearsal."""
        return ('AUTONOMOUS: selected QR + accepted fire incident starts one flight' if self.args.execute
                else 'READ ONLY: QR creates a fire incident; no flight commands')

    def _print_instructions(self):
        """Print measured-circle geometry, recognition trigger and landing controls."""
        print(self._ready_message(), flush=True)
        print(f'Radius {self.limits.radius_m:g} m; 24 measured chords, then land.', flush=True)
        if self.fire_size:
            print(f'QR scenario: {self.area_ha:g} ha; retreat in <=20 cm steps before orbiting. Indoor scale only.', flush=True)
        print('Place the measured QR flat on the launch floor about 1 m ahead. Keep the terminal open.', flush=True)
        print('X, Esc, LAND or Ctrl+C requests landing. Restart deliberately for another flight.', flush=True)

    def _overlay_lines(self):
        """Show scan count, accepted incident, selected radius and flight phase."""
        return [self._ready_message(), f'QR scans: {self.scan.hits}; incident: {self.incident_id or "waiting"}',
                f'Flight: {self.flight_phase or "waiting"}; radius: {self.limits.radius_m:g} m; X requests landing']

    def _detect_step(self, image, captured):
        """Process each fresh selected-QR frame and queue its incident before considering takeoff."""
        if self.last_processed_frame is not None and captured <= self.last_processed_frame:
            return
        self.last_processed_frame = captured
        hit = self.detector.detect(image)
        at = time.monotonic() - (time.time()-captured)
        selected = bool(hit and hit.get('source') == 'qr-test' and hit.get('qr_text') == self.scan.expected)
        # Never supply the rehearsal's synthetic pose to this flight controller.
        if self.pose is not None:
            self._process_hit(image, captured, hit if selected else None)
        else:
            self.overlay = [{k: hit[k] for k in ('source', 'label', 'confidence', 'bbox')}] if selected else []
            self.overlay_time = time.time()
        with self.takeoff_lock:
            stable = self.scan.observe(hit['qr_text'] if selected else None, at, time.monotonic())
            if stable and not self.incident_pending and self.scan.ack_at is None and time.monotonic() >= self.next_post:
                ok, jpeg = cv2.imencode('.jpg', image, [cv2.IMWRITE_JPEG_QUALITY, 85])
                if ok:
                    payload = detection_payload(hit, jpeg.tobytes(), captured, self.episode_id, self.telemetry)
                    # The map has no measured geographic position indoors. The
                    # relative orbit is deliberately independent of scenario GPS.
                    payload['details'].update(flight_protocol=self.flight_protocol, orbit_radius_m=self.limits.radius_m,
                                              path_reference=self.path_reference)
                    self.incident_pending = True
                    self.incident_queue.put_nowait(payload)
            self._maybe_start()

    def _publish_incidents(self):
        """Submit queued sightings off the camera thread and recheck the one-shot gate."""
        # Network latency never blocks frame decoding or the airborne watchdog.
        while self.running:
            try:
                payload = self.incident_queue.get(timeout=.2)
            except queue.Empty:
                continue
            try:
                result = self.publisher.detection(payload)
            except Exception:
                result = None
            with self.takeoff_lock:
                self.incident_pending = False
                self.next_post = time.monotonic()+2
                if self.scan.acknowledge(result, time.monotonic()):
                    self.incident_id = result['id']
                    self.report('preflight', 'QR fire incident accepted; checking automatic takeoff')
                else:
                    self.report('preflight', 'incident unconfirmed or QR lost; waiting on fresh scans')
                self._maybe_start()

    def _validate_flight_setup(self):
        """Require measured camera calibration and a current physical terminal preflight."""
        if self.pose is None:
            raise ValueError('measured camera calibration is required')
        read_preflight(self.args.preflight_file, terminal_control=True)

    def _maybe_start(self):
        """Under the takeoff lock, consume a fresh incident/scan gate and launch one mission."""
        # Caller holds takeoff_lock. LAND wins this same lock before TakeOff.
        if self.scan.ack_at is not None and time.monotonic()-self.scan.ack_at > 5:
            self.scan.ack_at = None
        if not self.args.execute or self.takeoff_used or self.abort_flight.is_set() or not self.running:
            return
        if not self.scan.stable(time.monotonic()) or self.scan.ack_at is None:
            return
        try:
            self._validate_flight_setup()
            reason = self.checkout_reason(starting=True)
            if reason:
                raise ValueError(reason)
        except (ValueError, OSError, KeyError) as error:
            self.report('preflight', str(error))
            return
        if self.scan.consume(time.monotonic()):
            self.takeoff_used = self.hold_connection = True
            self.mission = threading.Thread(target=self._automatic_mission)
            self.mission.start()

    def _automatic_mission(self):
        """Run takeoff/mission with camera tracking and bounded tracker cleanup."""
        self.started_at = time.monotonic()
        camera = threading.Thread(target=self._camera_loop, daemon=True)
        camera.start()
        try:
            self._hover()  # Same SDK object; inherited finally always lands.
        finally:
            self.camera_stop.set()
            camera.join(timeout=1)

    def _takeoff_message(self):
        """Identify the accepted incident that triggered this automatic takeoff."""
        return f"QR fire incident {self.incident_id} accepted; automatic takeoff"

    def _hover_observed_message(self):
        """Describe post-takeoff acquisition of the measured marker centre."""
        return f'hover established; acquiring measured QR center for a {self.limits.radius_m:g} m radius circle'

    def checkout_reason(self, starting=False):
        """Extend hover guards with selected-QR freshness and the whole-mission deadline."""
        reason = super().checkout_reason(starting=starting)
        if reason:
            return reason
        if starting and not self.scan.used:
            # _maybe_start calls this before consume; _hover calls it after.
            return None
        if starting and (self.scan.last_at is None or not 0 <= time.monotonic()-self.scan.last_at <= .8):
            return 'QR became stale before takeoff'
        if self.started_at is not None and time.monotonic()-self.started_at > getattr(self, 'flight_seconds', self.limits.mission_seconds):
            return 'mission time limit'
        return None

    def _camera_pitch(self):
        """Aim at a fresh measured marker or the planned floor point during vertical takeoff."""
        _, marker = self.sample()
        if marker and marker.text == self.scan.expected and 0 <= time.monotonic()-marker.at <= .8:
            return camera_pitch(marker, self.pose.offset)
        # During vertical takeoff, aim at the planned floor point. This
        # estimate only aims the camera; it never supplies a measured XY pose.
        height = (self.telemetry or {}).get('altitude_m') or 0
        return -math.degrees(math.atan2(max(0., height), 1. if self.fire_size else self.limits.radius_m))

    def _camera_loop(self):
        """Update gimbal pitch without blocking and request landing if aiming fails."""
        pending = None
        sent_at = None
        try:
            while not self.camera_stop.is_set() and not self.abort_flight.is_set() and not self.land_confirmed:
                if not self.args.execute or self.drone is None:
                    return
                if pending is not None:
                    if not pending.done():
                        if time.monotonic()-sent_at > 1:
                            raise RuntimeError('camera tracking command timed out')
                        self.camera_stop.wait(.05)
                        continue
                    if not pending.success():
                        raise RuntimeError('camera rejected tracking target')
                pitch = self._camera_pitch()
                pending = self.drone(gimbal.set_target(
                    gimbal_id=0, control_mode='position',
                    yaw_frame_of_reference='none', yaw=0.,
                    pitch_frame_of_reference='absolute', pitch=pitch,
                    roll_frame_of_reference='none', roll=0., _no_expect=True))
                sent_at = time.monotonic()
                self.camera_stop.wait(.2)
        except Exception as error:
            self.report('aborted', f'camera tracking failed: {error}')
            self._request_landing(force=False)

    def _after_hover(self):
        """Fly one measured circle, then hand back to guaranteed landing cleanup."""
        circle(self.driver, self.limits, self.scan.expected, self.sample,
               self.abort_flight, self.report, started=self.started_at, fire_size=self.fire_size)
        self.report('landing', 'one circle complete; landing at the current position')

    def _terminal(self):
        """Accept landing/abort input without a second arm prompt in automatic mode."""
        try:
            for command in terminal_commands(sys.stdin, stopped=lambda: not self.running):
                if self.land_confirmed or not self.running:
                    break
                if command in ('LAND', 'ABORT'):
                    self._request_landing()
        finally:
            self.input_closed.set()
            self._request_landing(force=False)

    def run(self):
        """Run reception plus the nonblocking incident worker and stop it on shutdown."""
        worker = threading.Thread(target=self._publish_incidents, daemon=True)
        worker.start()
        try:
            super().run()
        finally:
            self.camera_stop.set()
            worker.join(timeout=1)


class QRAutoPreset(QRAutoCircle):
    """Selected QR -> fire incident -> fixed launch-relative circle -> land.

    QR content selects this preset; QR dimensions, apparent location and camera
    calibration have no role in its path. --execute enables the one-shot trigger.
    """
    flight_protocol = 'qr-auto-preset'
    path_reference = 'launch-heading'

    def __init__(self, args, publisher, detector, marker):
        """Select the calibration-free fixed preset and its five-minute session cap."""
        super().__init__(args, publisher, detector, None, marker)
        self.flight_seconds = 300

    def _validate_flight_setup(self):
        """Skip marker-pose calibration because this path is defined by launch heading."""
        # This path uses the aircraft's relative movement commands. There is
        # no camera-derived target position to calibrate or verify here.
        pass

    def _ready_message(self):
        """Explain the automatic repeated preset or its incident-only rehearsal mode."""
        return ('AUTONOMOUS PRESET: selected QR + fire incident starts repeated circles' if self.args.execute
                else 'PRESET REHEARSAL: QR creates a fire incident; no flight commands')

    def _print_instructions(self):
        """Print fixed-path geometry, repetition limits and landing controls."""
        print(self._ready_message(), flush=True)
        print('One metre radius, centre 1 m ahead of launch heading; repeat until LAND or a protection limit.', flush=True)
        print('Flight cap: 5 minutes including takeoff; landing below 40% battery.', flush=True)
        print('QR is only the demo trigger. Camera aims toward the planned centre; no visual position tracking.', flush=True)
        print('X, Esc, LAND or Ctrl+C requests landing. Keep this terminal open. Restart for another flight.', flush=True)

    def _hover_observed_message(self):
        """Describe the fixed circle that starts after a stable takeoff hover."""
        return 'hover established; beginning the demo circle relative to launch heading'

    def _preset_vehicle(self):
        """Build the guarded aircraft sample used by the fixed preset controller."""
        sample = self.telemetry or {}
        ages = dict(self.sensor_ages.ages) if self.sensor_ages else {}
        attitude = sample.get('attitude_deg') or {}
        oldest = min(ages.get(key, float('-inf')) for key in ('altitude', 'speed', 'attitude'))
        video_fresh = 0 <= time.time()-self.last_frame_time <= 1.5
        return Vehicle(oldest, bool(self.connected and self._aircraft_link() and video_fresh),
                       sample.get('state'), sample.get('battery_pct'), sample.get('altitude_m'),
                       sample.get('ground_speed_mps'),
                       max(abs(attitude.get('roll', float('inf'))), abs(attitude.get('pitch', float('inf')))),
                       not self.input_closed.is_set())

    def _camera_pitch(self):
        """Aim toward the planned centre using height, without inventing a measured QR pose."""
        height = (self.telemetry or {}).get('altitude_m') or 0
        return -math.degrees(math.atan2(max(0., height), self.limits.radius_m))

    def _after_hover(self):
        """Repeat the measured-feedback fixed preset until landing or a protection limit."""
        fly_preset(self.driver, self.limits, self._preset_vehicle, self.abort_flight, self.report,
                   hold_seconds=1, flight_started=self.started_at, clock=time.monotonic, sleep=time.sleep,
                   circles=0, flight_seconds=self.flight_seconds)


def main():
    """Select measured-circle or fixed-preset mode and validate its explicit execution configuration."""
    parser = argument_parser()
    parser.description = __doc__
    parser.add_argument('--execute', action='store_true', help='enable one automatic flight after QR/incident confirmation')
    parser.add_argument('--marker-file', default=str(Path(__file__).with_name('orbit-marker.txt')))
    parser.add_argument('--camera-calibration')
    parser.add_argument('--preflight-file')
    parser.add_argument('--preset', action='store_true', help='QR selects a fixed launch-relative demo; no camera calibration or QR-size measurement')
    parser.add_argument('--fire-size', action='store_true', help='measured QR: retreat to a 1–1.5 m indoor radius scaled from fire area, then orbit once')
    args = parser.parse_args()
    if args.fire_size and args.preset:
        parser.error('--fire-size cannot be combined with --preset')
    if args.controller != 'direct' or args.demo_flight or args.gimbal_pitch is not None or args.radius != 1:
        parser.error('Use direct control, leave --radius at 1 (fire-size derives its own target), and disable other flight/gimbal modes')
    if not sys.stdin.isatty():
        parser.error('Keep an interactive Pi terminal open for immediate landing')
    if not args.backend or not os.environ.get('INGEST_TOKEN'):
        parser.error('QR flight requires a backend and INGEST_TOKEN to confirm the fire incident')
    args.no_window = args.no_auto_gimbal = args.no_yolo = args.terminal_control = True
    args.checkout_one_segment, args.hover_seconds = False, 1
    try:
        marker = Path(args.marker_file).read_text().strip()
        if parse_marker(marker) is None:
            raise ValueError('Select a valid EW1 fire marker')
        if args.preset and (args.camera_calibration or args.preflight_file):
            raise ValueError('Preset mode does not use marker-pose calibration or its preflight file')
        pose = CalibratedPose(args.camera_calibration, require_verified=args.execute) if args.camera_calibration else None
        if args.execute and not args.preset:
            if pose is None or not args.preflight_file:
                raise ValueError('Live execution requires measured calibration and a current physical preflight')
            read_preflight(args.preflight_file, terminal_control=True)
    except (ValueError, TypeError, KeyError, OSError) as error:
        parser.error(str(error))
    publisher = Publisher(args.out_dir, args.backend, os.environ['INGEST_TOKEN'])
    detector = FireDetector(args.model, args.conf, use_yolo=False)
    bridge = (QRAutoPreset(args, publisher, detector, marker) if args.preset else
              QRAutoCircle(args, publisher, detector, pose, marker))
    def stop(signum, frame):
        """Cancel the automatic mission and request landing on process termination."""
        bridge._request_landing(force=False)
        bridge.running = False
    for name in ('SIGINT', 'SIGTERM', 'SIGHUP'):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), stop)
    bridge.run()


if __name__ == '__main__':
    main()
