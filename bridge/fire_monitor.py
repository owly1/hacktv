#!/usr/bin/env python3
"""Laptop RGB/QR detector consuming the real camera relay. No aircraft commands."""
import argparse
import base64
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import secrets
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError

import cv2
import numpy as np
from fire_detection import FireDetector, confirm_hits, same_spot
from fire_location import locate_fire
from person_detection import PersonDetector, PersonTracks, person_payload


def iso(at):
    """Convert a Unix capture time to an ISO UTC timestamp for ingest."""
    return datetime.fromtimestamp(at, timezone.utc).isoformat()


class Episodes:
    """Confirm 3 fresh QR frames or 5 same-spot YOLO frames; retry failed posts in one episode."""
    def __init__(self):
        """Initialize selected-hit confirmation and fire-episode update timers."""
        self.last_capture = None
        self.identity = None
        self.last_bbox = None
        self.hits = 0
        self.episode = None
        self.last_seen = 0
        self.last_post = float('-inf')

    def observe(self, hit, captured, now):
        """Confirm repeated fresh hits and decide when a new or continuing episode should publish."""
        if self.episode and now - self.last_seen > 15:
            self.episode = None
        if not 0 <= now - captured < 2:
            self.hits = 0
            return None
        if self.last_capture is not None and captured <= self.last_capture:
            return None
        if self.last_capture is not None and captured - self.last_capture > 1.5:
            self.hits = 0
        self.last_capture = captured
        if hit is None:
            self.hits = 0
            return None
        identity = (hit['source'], hit['label'], hit.get('qr_text'))
        if identity != self.identity:
            self.hits = 0
            self.episode = None
            self.identity = identity
        if self.hits and not same_spot(hit, self.last_bbox):
            self.hits = 0
        self.last_bbox = hit['bbox']
        self.hits += 1
        self.last_seen = now
        if self.hits < confirm_hits(hit):
            return None
        if self.episode is None:
            self.episode = 'vision-' + secrets.token_hex(8)
            self.last_post = float('-inf')
        return self.episode if now - self.last_post >= 5 else None

    def acknowledged(self, now):
        """Record a successful sighting delivery so updates obey the episode interval."""
        self.last_post = now


def detection_payload(hit, jpeg, captured, episode, telemetry=None, site=None, frame_shape=(540, 960)):
    """Build a fire-ingest record from camera evidence and the available pose."""
    details = dict(hit.get('details') or {})
    fire = {'latitude': None, 'longitude': None, 'distance_m': None,
            'bearing_deg': None, 'position_source': 'unavailable'}
    # QR is an explicit scenario test. Use the configured scenario site for
    # its spread visualization, never label this as measured aircraft GPS.
    if hit['source'] == 'qr-test' and site:
        fire.update(latitude=site['latitude'], longitude=site['longitude'],
                    position_source='qr-scenario-site-not-measured')
        details.update(position_simulated=True, location_note='Configured scenario site; not measured fire GPS')
    elif hit['source'] == 'yolo':
        fire, area = locate_fire(hit, telemetry, frame_shape, captured=captured)
        if area is not None:
            details.update(area_ha=area, area_source='camera-box-estimate')
    return {'detected_at': iso(captured), 'episode_id': episode,
            **{k: hit[k] for k in ('source', 'label', 'confidence', 'bbox')},
            'fire': fire, 'drone': telemetry, 'details': details,
            'frame_jpeg_base64': base64.b64encode(jpeg).decode()}


class Monitor:
    def __init__(self, backend, dashboard_token, ingest_token, detector, person_detector=None):
        """Configure authenticated snapshot reads, detection and health publishing."""
        self.backend = backend.rstrip('/')
        self.dashboard_token, self.ingest_token = dashboard_token, ingest_token
        self.detector = detector
        self.person_detector = person_detector
        self.person_tracks = PersonTracks()
        self.episodes = Episodes()
        self.last_capture = None
        self.last_health = 0
        self.health = {'model_status': detector.model_status, 'camera_state': 'waiting',
                       'people_model_status': person_detector.model_status if person_detector else 'disabled',
                       'last_person_at': None,
                       'last_frame_at': None, 'last_detection_at': None,
                       'last_source': None, 'error': None}

    def get(self, path):
        """Make a dashboard-authenticated read from the configured backend."""
        return urlopen(Request(self.backend + path, headers={
            'Authorization': 'Bearer ' + self.dashboard_token}), timeout=3)

    def post(self, path, body):
        """Submit an ingest-authenticated JSON record to the backend."""
        with urlopen(Request(self.backend + path, data=json.dumps(body, allow_nan=False).encode(),
                headers={'Authorization': 'Bearer ' + self.ingest_token,
                         'Content-Type': 'application/json'}, method='POST'), timeout=5) as response:
            return response.status

    def step(self):
        """Process one fresh camera snapshot and publish detector health or a confirmed sighting."""
        with self.get('/api/snapshot') as response:
            captured = datetime.fromisoformat(response.headers['X-Captured-At'].replace('Z', '+00:00')).timestamp()
            jpeg = response.read(5_000_001)
        now = time.time()
        if len(jpeg) > 5_000_000:
            raise ValueError('Oversized frame')
        if not 0 <= now - captured < 2:
            self.episodes.observe(None, captured, now)
            self.health.update(camera_state='stale', error=None)
            return
        if captured == self.last_capture:
            return
        self.last_capture = captured
        image = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError('Invalid JPEG')
        hit = self.detector.detect(image)
        people_hits = []
        if self.person_detector:
            try:
                people_hits = self.person_detector.detect(image)
            except Exception:
                self.health['people_model_status'] = 'error'
        now = time.time()  # Inference itself must not make old evidence fresh.
        episode = self.episodes.observe(hit, captured, now)
        person_tracks = self.person_tracks.observe(people_hits, captured, now)
        self.health.update(camera_state='live' if now-captured < 2 else 'stale',
                           last_frame_at=iso(captured), error=None)
        # Preview every fresh inference, including empty results. Incident
        # confirmation and its five-second repeat interval remain separate.
        overlays = [{k: hit[k] for k in ('source', 'label', 'confidence', 'bbox')}] if hit and now-captured < 2 else []
        if 0 <= now-captured < 2:
            overlays.extend(people_hits[:9])
        self.post('/api/ingest/overlays', {'captured_at': iso(captured), 'detections': overlays})
        sample = None
        if episode or person_tracks:
            with self.get('/api/telemetry/latest') as response:
                telemetry = json.load(response)
            sample = telemetry.get('sample') if (telemetry.get('age_ms') is not None and 0 <= telemetry['age_ms'] < 10000) else None
        for track in person_tracks:
            payload = person_payload(track, iso(captured), sample, image.shape, self.person_detector.name)
            if payload['drone']:
                x1, y1, x2, y2 = track['bbox']
                h, w = image.shape[:2]
                crop = image[int(y1*h):max(int(y1*h)+1, int(y2*h)), int(x1*w):max(int(x1*w)+1, int(x2*w))]
                if crop.size:
                    scale = min(1, 160/max(crop.shape[:2]))
                    crop = cv2.resize(crop, (max(1, int(crop.shape[1]*scale)), max(1, int(crop.shape[0]*scale))))
                    ok, encoded = cv2.imencode('.jpg', crop)
                    if ok:
                        payload['crop_jpeg_base64'] = base64.b64encode(encoded).decode()
                try:
                    self.post('/api/ingest/person', payload)
                except HTTPError as error:
                    if error.code != 422:
                        raise
                    payload['location_reason'] = 'ground-intersection-unavailable'
                    payload.pop('crop_jpeg_base64', None)
                    self.post('/api/ingest/person/sighting', payload)
            else:
                self.post('/api/ingest/person/sighting', payload)
            self.person_tracks.acknowledged(track['id'], time.time())
            self.health['last_person_at'] = iso(captured)
            print(f"Person observation accepted: {track['id']}", flush=True)
        if episode:
            with self.get('/api/status') as response:
                status = json.load(response)
            payload = detection_payload(hit, jpeg, captured, episode, sample, status.get('site'), image.shape)
            self.post('/api/ingest/detection', payload)
            self.episodes.acknowledged(time.time())
            self.health.update(last_detection_at=iso(captured), last_source=hit['source'])
            print(f"Detection accepted: {hit['source']} / {hit['label']} ({episode})", flush=True)

    def run(self):
        """Repeat camera processing and recover from unavailable frames/backend requests."""
        while True:
            started = time.monotonic()
            try:
                self.step()
            except Exception as error:
                self.health.update(camera_state='waiting', error=type(error).__name__)
                self.episodes.hits = 0
            if time.monotonic() - self.last_health >= 2:
                try:
                    self.post('/api/ingest/vision', {'observed_at': iso(time.time()), **self.health})
                except Exception:
                    pass
                self.last_health = time.monotonic()
            time.sleep(max(.01, .2 - (time.monotonic() - started)))


def main():
    """Load local credentials/options and start the laptop fire monitor."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend', default='http://127.0.0.1:8787')
    parser.add_argument('--model', default=os.environ.get('EMBERWATCH_MODEL', str(Path.home()/'emberwatch-models/fire-smoke-yolov8n.pt')))
    parser.add_argument('--detect-smoke', action='store_true', default=os.environ.get('EMBERWATCH_DETECT_SMOKE') == '1',
                        help='Also confirm smoke-only sightings (more prone to false alarms)')
    parser.add_argument('--person-model', default=os.environ.get('EMBERWATCH_PERSON_MODEL', str(Path.home()/'emberwatch-models/yolov8n.pt')))
    parser.add_argument('--no-people', action='store_true', help='Disable laptop person recognition')
    args = parser.parse_args()
    from urllib.parse import urlparse
    url = urlparse(args.backend)
    if url.scheme != 'http' or url.hostname not in ('localhost', '127.0.0.1'):
        parser.error('Use the localhost backend')
    with (Path(__file__).parents[1]/'.fire-monitor.local').open('w') as lock:
        try:
            if os.name == 'nt':
                import msvcrt
                lock.write('0')
                lock.flush()
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise SystemExit('A fire monitor is already running for this checkout.')
        try:
            import torch
            torch.set_num_threads(2)
        except ImportError:
            pass  # The QR detector still works; model health reports the gap.
        detector = FireDetector(args.model, detect_smoke=args.detect_smoke)
        people_detector = None if args.no_people else PersonDetector(args.person_model)
        print('Vision monitor: QR + fire/smoke + people; no flight commands.', flush=True)
        Monitor(args.backend, os.environ['DASHBOARD_TOKEN'], os.environ['INGEST_TOKEN'], detector, people_detector).run()


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
