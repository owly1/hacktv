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
        detector = FireDetector('', .5, use_yolo=False)
        hit = detector.detect(cv2.imread(str(ROOT/'dist/test-marker.png')))
        self.assertEqual(hit['source'], 'qr-test')
        self.assertEqual(hit['label'], 'fire')
        self.assertEqual(hit['qr_text'], MARKER)
        self.assertEqual(hit['details']['area_ha'], 120)

    def test_invalid_marker_does_not_create_fire(self):
        for value in ['https://example.com', MARKER.replace('120', 'nan'), MARKER.replace('|18|18', '|200|18')]:
            self.assertIsNone(parse_marker(value))
        self.assertIsNone(FireDetector('', .5, False).detect(np.zeros((360, 640, 3), np.uint8)))

    def test_confirmation_needs_distinct_fresh_frames_and_retries_same_episode(self):
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
        e = Episodes()
        for at in [100, 100.2, 100.4]:
            episode = e.observe(HIT, at, at+.01)
        e.acknowledged(100.5)
        e.observe(None, 101, 101.01)
        for at in [101.2, 101.4, 101.6]:
            self.assertIsNone(e.observe(HIT, at, at+.01))
        self.assertEqual(e.episode, episode)

    def test_only_qr_uses_labeled_scenario_position(self):
        site = {'latitude': 43., 'longitude': -79.}
        qr = detection_payload(HIT, b'jpeg', 100, 'test', site=site)
        self.assertTrue(qr['details']['position_simulated'])
        self.assertEqual(qr['fire']['latitude'], 43.)
        rgb = detection_payload({**HIT, 'source': 'yolo', 'details': None}, b'jpeg', 100, 'test', site=site)
        self.assertIsNone(rgb['fire']['latitude'])
        self.assertIsNone(rgb['fire']['longitude'])

    def test_real_decoder_reaches_incident_and_auto_analysis_on_isolated_backend(self):
        # Real QR decoding and HTTP ingest, with a fake Gemini transport and
        # memory-only storage so no test image is submitted to production.
        js = """
import http from 'node:http';
import {createApp, MemoryStorage} from './backend/server.mjs';
const app=createApp({ingestToken:'test-ingest', dashboardToken:'test-dashboard',
 storage:new MemoryStorage(), dataDir:null,
 geminiTransport:async()=>({candidates:[{content:{parts:[{text:JSON.stringify({summary:'QR scenario confirmed',unknowns:[],limitations:'Isolated test'})}]}}]})});
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
            deadline = time.monotonic()+3
            while True:
                with monitor.get('/api/analysis/latest') as response:
                    analysis = json.load(response).get('analysis')
                if analysis or time.monotonic() >= deadline:
                    break
                time.sleep(.02)
            self.assertEqual(analysis['trigger'], 'auto-detection')
            self.assertEqual(analysis['episode_id'], incident['episode_id'])
        finally:
            server.terminate()
            server.communicate(timeout=5)


if __name__ == '__main__':
    unittest.main()
