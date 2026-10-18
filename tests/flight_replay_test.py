"""Offline replay uses original indexed frames and never opens a receiver."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parents[1] / 'scripts'))
from replay_fire_tracking import replay, square_fit


class ReplayTests(unittest.TestCase):
    def calibration(self):
        return {'image_size': [640, 480],
                'camera_matrix': [[500., 0., 320.], [0., 500., 240.], [0., 0., 1.]],
                'distortion_coefficients': [0.] * 5, 'qr_black_square_side_m': .12}

    def test_square_fit_reports_metric_scale_and_rejects_too_small_corners(self):
        calibration = self.calibration()
        # Front-facing 12 cm square at 1 m, 500 pixel focal length -> 60 px.
        hit = {'qr_corners': [[290., 210.], [350., 210.], [350., 270.], [290., 270.]]}
        result = square_fit(hit, calibration)
        self.assertTrue(result['square_geometry_usable'])
        self.assertAlmostEqual(result['camera_translation_m'][2], 1.)
        self.assertAlmostEqual(result['min_edge_px'], 60.)
        hit['qr_corners'] = [[315., 235.], [325., 235.], [325., 245.], [315., 245.]]
        self.assertFalse(square_fit(hit, calibration)['square_geometry_usable'])

    def test_replay_honors_capture_times_and_rejects_resolution_mismatch(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            calibration = path / 'calibration.json'
            calibration.write_text(json.dumps(self.calibration()))
            jpeg = cv2.imencode('.jpg', np.zeros((480, 640, 3), np.uint8))[1].tobytes()
            other = cv2.imencode('.jpg', np.zeros((240, 320, 3), np.uint8))[1].tobytes()
            times = [100., 100.05, 100.2, 100.4]
            frames = [jpeg, jpeg, jpeg, other]
            entries = []
            offset = 0
            for i, (at, frame) in enumerate(zip(times, frames)):
                entries.append({'frame': i, 'captured_at_unix': at, 'offset': offset, 'bytes': len(frame)})
                offset += len(frame)
            (path / 'video.mjpeg').write_bytes(b''.join(frames))
            (path / 'frames.jsonl').write_text('\n'.join(json.dumps(entry) for entry in entries))
            (path / 'events.jsonl').write_text(json.dumps({'at_unix': 100.1, 'kind': 'flight_control',
                                                         'data': {'phase': 'climb'}}))
            detector = Mock(detect=Mock(return_value=None))
            result = replay(path, calibration, detector, hz=5.)
            self.assertEqual([x['frame'] for x in result['samples']], [0, 2, 3])
            self.assertEqual([call.kwargs['captured_at'] for call in detector.detect.call_args_list],
                             [100., 100.2])
            self.assertEqual(result['samples'][-1]['method'], 'resolution-mismatch')
            self.assertEqual(result['samples'][0]['phase'], 'preflight')
            self.assertEqual(result['samples'][1]['phase'], 'climb')
            self.assertEqual(result['phases']['climb']['frames'], 2)


if __name__ == '__main__':
    unittest.main()
