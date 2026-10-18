#!/usr/bin/env python3
"""Mac RGB/QR detector consuming the real camera relay. No aircraft commands."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import secrets
import time
from urllib.request import Request, urlopen

import cv2
import numpy as np
from fire_detection import FireDetector, confirm_hits, same_spot


def iso(at):
    return datetime.fromtimestamp(at, timezone.utc).isoformat()


class Episodes:
    """Confirm 3 fresh QR frames or 5 same-spot YOLO frames; retry failed posts in one episode."""
    def __init__(self):
        self.last_capture = None
        self.identity = None
        self.last_bbox = None
        self.hits = 0
        self.episode = None
        self.last_seen = 0
        self.last_post = float('-inf')

    def observe(self, hit, captured, now):
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
        if hit.get('qr_tracking') in ('optical-flow','visual-template'):
            # Tracking can maintain an existing episode, never create or
            # reconfirm one, or publish a new incident from cached payload text.
            if self.episode and self.identity==('qr-test','fire',hit.get('qr_text')):
                self.last_seen=now
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
        self.last_post = now


def detection_payload(hit, jpeg, captured, episode, telemetry=None, site=None):
    details = dict(hit.get('details') or {})
    fire = {'latitude': None, 'longitude': None, 'distance_m': None,
            'bearing_deg': None, 'position_source': 'unavailable'}
    # QR is an explicit scenario test. Use the configured scenario site for
    # its spread visualization, never label this as measured aircraft GPS.
    if hit['source'] == 'qr-test' and site:
        fire.update(latitude=site['latitude'], longitude=site['longitude'],
                    position_source='qr-scenario-site-not-measured')
        details.update(position_simulated=True, location_note='Configured scenario site; not measured fire GPS')
    return {'detected_at': iso(captured), 'episode_id': episode,
            **{k: hit[k] for k in ('source', 'label', 'confidence', 'bbox')},
            'fire': fire, 'drone': telemetry, 'details': details,
            'frame_jpeg_base64': base64.b64encode(jpeg).decode()}


class Monitor:
    def __init__(self, backend, dashboard_token, ingest_token, detector):
        self.backend = backend.rstrip('/')
        self.dashboard_token, self.ingest_token = dashboard_token, ingest_token
        self.detector = detector
        self.episodes = Episodes()
        self.last_capture = None
        self.last_health = 0
        # Incident persistence can wait on the database. Never put it on the
        # current-frame path: a slow history write must not erase flight lock.
        self.publisher = ThreadPoolExecutor(max_workers=2, thread_name_prefix='fire-publisher')
        self.incident_pending = None
        self.health_pending = None
        self.health = {'model_status': detector.model_status, 'camera_state': 'waiting',
                       'last_frame_at': None, 'last_detection_at': None,
                       'last_source': None, 'error': None}

    def get(self, path):
        return urlopen(Request(self.backend + path, headers={
            'Authorization': 'Bearer ' + self.dashboard_token}), timeout=3)

    def post(self, path, body, timeout=5):
        with urlopen(Request(self.backend + path, data=json.dumps(body, allow_nan=False).encode(),
                headers={'Authorization': 'Bearer ' + self.ingest_token,
                         'Content-Type': 'application/json'}, method='POST'), timeout=timeout) as response:
            return response.status

    def _publish_incident(self, hit, jpeg, captured, episode):
        with self.get('/api/status') as response:
            status = json.load(response)
        with self.get('/api/telemetry/latest') as response:
            telemetry = json.load(response)
        sample = telemetry.get('sample') if (telemetry.get('age_ms') is not None and 0 <= telemetry['age_ms'] < 10000) else None
        payload = detection_payload(hit, jpeg, captured, episode, sample, status.get('site'))
        self.post('/api/ingest/detection', payload)
        return episode, hit['source'], captured, time.time()

    def _finish_incident(self):
        pending = self.incident_pending
        if pending is None or not pending.done():
            return
        self.incident_pending = None
        try:
            episode, source, captured, accepted = pending.result()
        except Exception as error:
            self.health['incident_error'] = type(error).__name__
            return  # Retry with a new frame; do not refresh stale evidence.
        if self.episodes.episode == episode:
            self.episodes.acknowledged(accepted)
        self.health.update(last_detection_at=iso(captured), last_source=source, incident_error=None)
        print(f"Detection accepted: {source} ({episode})", flush=True)

    def close(self):
        self.publisher.shutdown(wait=True, cancel_futures=True)

    def step(self):
        self._finish_incident()
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
        hit = self.detector.detect(image,captured_at=captured)
        now = time.time()  # Inference itself must not make old evidence fresh.
        episode = self.episodes.observe(hit, captured, now)
        self.health.update(camera_state='live' if now-captured < 2 else 'stale',
                           last_frame_at=iso(captured), error=None)
        # Send fresh rectangles independently of incident updates (which are
        # deliberately rate-limited to five seconds). Missing hits clear lock.
        self.post('/api/ingest/autonomy/target', {
            'captured_at': iso(captured), 'width': image.shape[1], 'height': image.shape[0],
            'episode_id': self.episodes.episode,
            'hit': {k: hit[k] for k in ('source','label','confidence','bbox','qr_text','qr_corners','qr_tracking','qr_decoded_at',
                                     'qr_template_score','qr_template_data_score','qr_template_module_error',
                                     'qr_template_module_coverage') if k in hit}
                   if hit and hit['label']=='fire' else None}, timeout=.5)
        if episode and self.incident_pending is None:
            self.incident_pending = self.publisher.submit(self._publish_incident, dict(hit), jpeg, captured, episode)

    def run(self):
        while True:
            started = time.monotonic()
            try:
                self.step()
            except Exception as error:
                self.health.update(camera_state='waiting', error=type(error).__name__)
                self.episodes.hits = 0
            if time.monotonic() - self.last_health >= 2:
                if self.health_pending is None or self.health_pending.done():
                    self.health_pending = self.publisher.submit(self.post, '/api/ingest/vision',
                        {'observed_at': iso(time.time()), **self.health})
                self.last_health = time.monotonic()
            time.sleep(max(.01, .2 - (time.monotonic() - started)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend', default='http://127.0.0.1:8787')
    parser.add_argument('--model', default=os.environ.get('EMBERWATCH_MODEL', str(Path.home()/'emberwatch-models/fire-smoke-yolov8n.pt')))
    args = parser.parse_args()
    from urllib.parse import urlparse
    url = urlparse(args.backend)
    if url.scheme != 'http' or url.hostname not in ('localhost', '127.0.0.1'):
        parser.error('Use the localhost backend')
    with (Path(__file__).parents[1]/'.fire-monitor.local').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit('A fire monitor is already running for this checkout.')
        detector = FireDetector(args.model)
        detector.warmup()
        print('Fire monitor: QR + RGB inference; no flight commands.', flush=True)
        monitor = Monitor(args.backend, os.environ['DASHBOARD_TOKEN'], os.environ['INGEST_TOKEN'], detector)
        try:
            monitor.run()
        finally:
            monitor.close()


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
