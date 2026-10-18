"""Detection tests use isolated fixtures, never the live drone or cloud backend."""
import base64
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
from fire_detection import FireDetector, parse_marker
from fire_monitor import Episodes, Monitor, detection_payload

MARKER = 'EW1:Alpha|120|X|35|M|30|60|31|18|18'
HIT = {'source': 'qr-test', 'label': 'fire', 'confidence': 1., 'bbox': [0., 0., 1., 1.],
       'details': {'test_marker': True}, 'qr_text': MARKER}


class FireMonitorTests(unittest.TestCase):
    def test_repository_marker_classifies_as_fire_even_without_quiet_zone(self):
        """Verify repository marker classifies as fire even without quiet zone."""
        detector = FireDetector('', .5, use_yolo=False)
        hit = detector.detect(cv2.imread(str(ROOT/'dist/test-marker.png')))
        self.assertEqual(hit['source'], 'qr-test')
        self.assertEqual(hit['label'], 'fire')
        self.assertEqual(hit['qr_text'], MARKER)
        self.assertEqual(hit['details']['area_ha'], 120)

    def test_invalid_marker_does_not_create_fire(self):
        """Verify invalid marker does not create fire."""
        for value in ['https://example.com', MARKER.replace('120', 'nan'), MARKER.replace('|18|18', '|200|18')]:
            self.assertIsNone(parse_marker(value))
        self.assertIsNone(FireDetector('', .5, False).detect(np.zeros((360, 640, 3), np.uint8)))

    def test_confirmation_needs_distinct_fresh_frames_and_retries_same_episode(self):
        """Verify confirmation needs distinct fresh frames and retries same episode."""
        e = Episodes()
        self.assertIsNone(e.observe(HIT, 100, 100.1))
        self.assertIsNone(e.observe(HIT, 100, 100.2))
        self.assertIsNone(e.observe(HIT, 100.2, 100.3))
        episode = e.observe(HIT, 100.4, 100.5)
        self.assertTrue(episode)
        self.assertEqual(e.observe(HIT, 100.6, 100.7), episode)  # delivery failed
        e.acknowledged(100.7)
        self.assertIsNone(e.observe(HIT, 100.8, 100.9))
        self.assertIsNone(e.observe(HIT, 100.8, 120))  # cached image is stale
        self.assertIsNone(e.observe(HIT, 121, 121.1))
        self.assertIsNone(e.observe(HIT, 121.2, 121.3))
        self.assertNotEqual(e.observe(HIT, 121.4, 121.5), episode)

    def test_temporary_occlusion_does_not_retrigger_analysis(self):
        """Verify temporary occlusion does not retrigger analysis."""
        e = Episodes()
        for at in [100, 100.2, 100.4]:
            episode = e.observe(HIT, at, at+.01)
        e.acknowledged(100.5)
        e.observe(None, 101, 101.01)
        for at in [101.2, 101.4, 101.6]:
            self.assertIsNone(e.observe(HIT, at, at+.01))
        self.assertEqual(e.episode, episode)

    def test_yolo_needs_five_hits_in_the_same_spot(self):
        """Verify yolo needs five hits in the same spot."""
        e = Episodes()
        yolo = {'source': 'yolo', 'label': 'fire', 'confidence': .8, 'bbox': [.1, .1, .3, .3], 'details': None}
        moved = {**yolo, 'bbox': [.6, .6, .8, .8]}
        for at, hit in [(100, yolo), (100.2, yolo), (100.4, yolo), (100.6, moved)]:
            self.assertIsNone(e.observe(hit, at, at+.01))
        for at in [100.8, 101, 101.2]:
            self.assertIsNone(e.observe(moved, at, at+.01))
        self.assertTrue(e.observe(moved, 101.4, 101.41))

    def test_yolo_filters_drop_non_flame_boxes(self):
        """Verify yolo filters drop non flame boxes."""
        from fire_detection import flame_fraction
        frame = np.full((100, 100, 3), 200, np.uint8)  # grey: haze, sky, concrete
        frame[:50, :50] = (0, 120, 255)                 # orange flame patch
        self.assertGreater(flame_fraction(frame, [0, 0, .5, .5]), .9)
        self.assertEqual(flame_fraction(frame, [.5, .5, 1, 1]), 0)

    def test_only_qr_uses_labeled_scenario_position(self):
        """Verify only qr uses labeled scenario position."""
        site = {'latitude': 43., 'longitude': -79.}
        qr = detection_payload(HIT, b'jpeg', 100, 'test', site=site)
        self.assertTrue(qr['details']['position_simulated'])
        self.assertEqual(qr['fire']['latitude'], 43.)
        rgb = detection_payload({**HIT, 'source': 'yolo', 'details': None}, b'jpeg', 100, 'test', site=site)
        self.assertIsNone(rgb['fire']['latitude'])
        self.assertIsNone(rgb['fire']['longitude'])

    def test_rgb_camera_ray_uses_real_pose_and_estimates_initial_area(self):
        pose = {'latitude': 43.78, 'longitude': -79.19, 'altitude_m': 30,
                'extra': {'heading_deg': 90, 'gimbal_pitch_deg': -45, 'position_source': 'gps'}}
        hit = {**HIT, 'source': 'yolo', 'label': 'smoke', 'bbox': [.4, .4, .6, .6], 'details': None}
        payload = detection_payload(hit, b'jpeg', 100, 'test', pose, frame_shape=(540, 960))
        self.assertAlmostEqual(payload['fire']['distance_m'], 30)
        self.assertGreater(payload['fire']['longitude'], pose['longitude'])
        self.assertAlmostEqual(payload['fire']['latitude'], pose['latitude'])
        self.assertIn('camera-ray', payload['fire']['position_source'])
        self.assertGreater(payload['details']['area_ha'], 0)
        pose['extra']['gimbal_pitch_deg'] = 0
        self.assertIsNone(detection_payload(hit, b'jpeg', 100, 'test', pose)['fire']['latitude'])
        del pose['extra']['gimbal_pitch_deg']
        self.assertIsNone(detection_payload(hit, b'jpeg', 100, 'test', pose)['fire']['latitude'])

    def test_smoke_is_enabled_only_when_requested(self):
        from types import SimpleNamespace
        from unittest.mock import Mock
        detector = FireDetector('', use_yolo=False)
        boxes = SimpleNamespace(xyxyn=Mock(tolist=lambda: [[.2, .2, .6, .6]]),
                                cls=Mock(tolist=lambda: [0]), conf=Mock(tolist=lambda: [.9]))
        detector.model = Mock(return_value=[SimpleNamespace(boxes=boxes)])
        detector.model.names = {0: 'smoke'}
        image = np.zeros((100, 100, 3), np.uint8)
        self.assertIsNone(detector.detect(image))
        detector.labels = ('fire', 'smoke')
        self.assertEqual(detector.detect(image)['label'], 'smoke')

    def test_real_decoder_reaches_incident_without_auto_analysis_on_isolated_backend(self):
        """Verify real QR/HTTP detection still works with background analysis disabled."""
        # Real QR decoding and HTTP ingest, with a fake Gemini transport and
        # memory-only storage so no test image is submitted to production.
        js = """
import http from 'node:http';
import {createApp, MemoryStorage} from './backend/server.mjs';
const app=createApp({ingestToken:'test-ingest', dashboardToken:'test-dashboard',
 storage:new MemoryStorage(), dataDir:null,
 geminiTransport:async()=>{throw new Error('Unexpected background scene analysis');}});
const server=http.createServer(app); server.listen(0,'127.0.0.1',()=>console.log(server.address().port));
"""
        server = subprocess.Popen(['node', '--input-type=module', '-e', js], cwd=ROOT,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            port = int(server.stdout.readline())
            base = f'http://127.0.0.1:{port}'
            monitor = Monitor(base, 'test-dashboard', 'test-ingest', FireDetector('', .5, False))
            image = cv2.imread(str(ROOT/'dist/test-marker.png'))
            ok, jpeg = cv2.imencode('.jpg', image)
            self.assertTrue(ok)
            for _ in range(3):
                captured = time.time()
                from fire_monitor import iso
                req = Request(base+'/api/ingest/frame', data=jpeg.tobytes(), method='POST', headers={
                    'Authorization':'Bearer test-ingest', 'Content-Type':'image/jpeg', 'X-Captured-At':iso(captured)})
                with urlopen(req) as response:
                    self.assertEqual(response.status, 204)
                with contextlib.redirect_stdout(io.StringIO()):
                    monitor.step()
            with monitor.get('/api/incident') as response:
                incident = json.load(response)['incident']
            self.assertTrue(incident['active'])
            self.assertEqual(incident['latest']['source'], 'qr-test')
            self.assertTrue(incident['latest']['details']['position_simulated'])
            with monitor.get('/api/analysis/latest') as response:
                analysis = json.load(response)
            self.assertIsNone(analysis['analysis'])
            self.assertFalse(analysis['pending'])
            self.assertIsNone(analysis['error'])
            with monitor.get('/api/status') as response:
                self.assertFalse(json.load(response)['gemini']['automatic_analysis'])
        finally:
            server.terminate()
            server.communicate(timeout=5)


if __name__ == '__main__':
    unittest.main()
