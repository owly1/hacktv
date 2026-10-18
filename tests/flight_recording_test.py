"""Recorder/playback evidence tests, no radio or SDK."""
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1]/'bridge'))
sys.path.insert(0, str(Path(__file__).parents[1]/'scripts'))
from flight_recording import FlightRecorder
from review_flights import review, preview, lines


class RecordingTests(unittest.TestCase):
    def test_video_timestamps_events_report_and_mp4_round_trip(self):
        import cv2
        import numpy as np
        with tempfile.TemporaryDirectory() as root:
            recorder = FlightRecorder(root)
            recorder.event('flight_control', {'phase':'takeoff'})
            jpeg = cv2.imencode('.jpg', np.zeros((48,64,3),dtype=np.uint8))[1].tobytes()
            for i in range(6):
                recorder.frame(jpeg,100+i/30)
            recorder.event('telemetry', {'state':'hovering','altitude_m':.99})
            recorder.event('move_failed', {'requested':{'dY':-.259},'actual':{'dY':-.6},'reason':'outside tolerance'})
            recorder.event('flight_control', {'phase':'landed'})
            recorder.close()
            self.assertEqual((recorder.path/'video.mjpeg').read_bytes(),jpeg*6)
            frames = lines(recorder.path/'frames.jsonl')
            self.assertEqual([f['offset'] for f in frames],[i*len(jpeg) for i in range(6)])
            report = review(recorder.path)
            self.assertAlmostEqual(report['average_recorded_fps'],30)
            self.assertEqual(report['hover_flight_height_max_m'],.99)
            self.assertEqual(report['last_control_event']['data']['phase'],'landed')
            self.assertEqual(len(report['failures']),1)
            preview(recorder.path)
            capture = cv2.VideoCapture(str(recorder.path/'preview.mp4'))
            self.assertTrue(capture.isOpened())
            self.assertEqual(capture.get(cv2.CAP_PROP_FRAME_COUNT),6)
            capture.release()
            stats=json.loads((recorder.path/'recording.json').read_text())
            self.assertEqual(stats['frames'],6)
            self.assertTrue(stats['closed'])

    def test_frame_overload_does_not_block_or_discard_flight_events(self):
        with tempfile.TemporaryDirectory() as root:
            gate = threading.Event()
            original = FlightRecorder._write
            def delayed(recorder):
                gate.wait(2)
                original(recorder)
            with patch.object(FlightRecorder,'_write',delayed):
                recorder=FlightRecorder(root,frame_capacity=1)
                recorder.frame(b'first',1)
                recorder.frame(b'second',2)
                recorder.event('flight_control',{'phase':'landed'})
                gate.set();recorder.close()
            self.assertEqual(recorder.stats['dropped_frames'],1)
            self.assertEqual(recorder.stats['dropped_events'],0)
            self.assertTrue(any(e['data'].get('phase')=='landed' for e in lines(recorder.path/'events.jsonl')))


if __name__ == '__main__':
    unittest.main()
