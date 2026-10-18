"""Laptop person tests use fake inference and isolated HTTP; no aircraft or cloud."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import time
import unittest
from urllib.request import Request, urlopen
import cv2
import numpy as np

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT/'bridge'))
from person_detection import PersonTracks, PersonDetector, person_payload
from fire_detection import FireDetector
from fire_monitor import Monitor, iso

HIT = {'source': 'yolo', 'label': 'person', 'confidence': .8, 'bbox': [.4, .4, .6, .8]}


class PersonDetectionTests(unittest.TestCase):
    def test_confirmation_uses_three_distinct_fresh_frames_and_retries_delivery(self):
        tracks = PersonTracks()
        self.assertEqual(tracks.observe([HIT], 100, 100.1), [])
        self.assertEqual(tracks.observe([HIT], 100, 100.2), [])
        self.assertEqual(tracks.observe([HIT], 100.2, 100.3), [])
        result = tracks.observe([HIT], 100.4, 100.5)
        key = result[0]['id']
        self.assertEqual(tracks.observe([HIT], 100.6, 100.7)[0]['id'], key)
        tracks.acknowledged(key, 100.7)
        self.assertEqual(tracks.observe([HIT], 100.8, 100.9), [])
        self.assertEqual(tracks.observe([HIT], 100.8, 104), [])
        self.assertEqual(tracks.observe([], 101, 101.1), [])
        self.assertEqual(tracks.observe([HIT], 101.2, 101.3), [])

    def test_two_people_remain_separate_tracks(self):
        tracks = PersonTracks()
        other = {**HIT, 'bbox': [.1, .2, .2, .5]}
        for at in (100, 100.2, 100.4):
            results = tracks.observe([HIT, other], at, at+.01)
        self.assertEqual(len(results), 2)
        self.assertNotEqual(results[0]['id'], results[1]['id'])

    def test_pose_is_never_fabricated_and_model_missing_is_explicit(self):
        track = {'id': 'test-track', 'seen': 100, 'bbox': HIT['bbox'], 'confidence': .8}
        self.assertIsNone(person_payload(track, iso(100), None, (540, 960), 'fake')['drone'])
        sample = {'latitude': 43.78, 'longitude': -79.19, 'altitude_m': 30,
                  'extra': {'heading_deg': 90, 'gimbal_pitch_deg': -45, 'position_source': 'gps'}}
        payload = person_payload(track, iso(100), sample, (540, 960), 'fake')
        self.assertEqual(payload['drone']['latitude'], 43.78)
        self.assertEqual(payload['provenance'], 'live')
        sample['observed_at'] = iso(90)
        self.assertIsNone(person_payload(track, iso(100), sample, (540, 960), 'fake')['drone'])
        sample['observed_at'] = iso(100)
        sample['gps_fix'] = False
        self.assertIsNone(person_payload(track, iso(100), sample, (540, 960), 'fake')['drone'])
        with contextlib.redirect_stdout(io.StringIO()):
            detector = PersonDetector('not-installed-test-weights.pt')
        self.assertEqual(detector.model_status, 'missing')
        self.assertEqual(detector.detect(np.zeros((20, 20, 3), np.uint8)), [])

    def test_real_frame_relay_records_unlocated_then_geolocated_person(self):
        js = """
import http from 'node:http';
import {createApp,MemoryStorage} from './backend/server.mjs';
const server=http.createServer(createApp({ingestToken:'test-ingest',dashboardToken:'test-dashboard',
storage:new MemoryStorage(),dataDir:null}));
server.listen(0,'127.0.0.1',()=>console.log(server.address().port));
"""
        server = subprocess.Popen(['node', '--input-type=module', '-e', js], cwd=ROOT,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            base = 'http://127.0.0.1:' + server.stdout.readline().strip()
            class FakePersonModel:
                """Return a controlled person box while exercising real frames and HTTP."""
                model_status, name = 'ready', 'isolated-fake-person-model'
                def detect(self, image):
                    """Supply one fake inference result for this isolated integration test."""
                    return [dict(HIT)]
            monitor = Monitor(base, 'test-dashboard', 'test-ingest', FireDetector('', use_yolo=False), FakePersonModel())
            jpeg = cv2.imencode('.jpg', np.zeros((180, 320, 3), np.uint8))[1].tobytes()
            for _ in range(3):
                req = Request(base+'/api/ingest/frame', data=jpeg, method='POST', headers={
                    'Authorization':'Bearer test-ingest', 'Content-Type':'image/jpeg', 'X-Captured-At':iso(time.time())})
                with urlopen(req) as response:
                    self.assertEqual(response.status, 204)
                with contextlib.redirect_stdout(io.StringIO()):
                    monitor.step()
            with monitor.get('/api/people') as response:
                snapshot = json.load(response)
            self.assertEqual(len(snapshot['unlocated_sightings']), 1)
            self.assertEqual(snapshot['leads'], [])
            sample = {'observed_at': iso(time.time()), 'provenance':'live', 'latitude':43.78,
                      'longitude':-79.19, 'altitude_m':30, 'extra':{'heading_deg':90,'gimbal_pitch_deg':-45,'position_source':'gps'}}
            monitor.post('/api/ingest/telemetry', sample)
            for track in monitor.person_tracks.tracks.values():
                track['posted'] = float('-inf')
            req = Request(base+'/api/ingest/frame',data=jpeg,method='POST',headers={
                'Authorization':'Bearer test-ingest','Content-Type':'image/jpeg','X-Captured-At':iso(time.time())})
            with urlopen(req):
                pass
            with contextlib.redirect_stdout(io.StringIO()):
                monitor.step()
            with monitor.get('/api/people') as response:
                snapshot = json.load(response)
            self.assertEqual(snapshot['unlocated_sightings'], [])
            self.assertEqual(len(snapshot['leads']), 1)
            self.assertIsNotNone(snapshot['leads'][0]['latitude'])
            self.assertEqual(snapshot['leads'][0]['provenance'], 'live')
        finally:
            server.terminate()
            server.communicate(timeout=5)


if __name__ == '__main__':
    unittest.main()
