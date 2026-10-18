"""Front-facing measured markers remain localizable without weakening fit checks."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parents[1] / 'bridge'))
from fire_tracking import MetricQRPose


class FrontalQRTests(unittest.TestCase):
    def test_camera_facing_square_and_rotated_views_recover_true_position(self):
        k = np.array([[500., 0., 320.], [0., 500., 240.], [0., 0., 1.]])
        calibration = {'image_size': [640, 480], 'camera_matrix': k.tolist(),
                       'distortion_coefficients': [0.] * 5, 'qr_black_square_side_m': .12,
                       'camera_offset_body_m': [0., 0., 0.], 'qr_pose_verified': True}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'calibration.json'
            path.write_text(json.dumps(calibration))
            solver = MetricQRPose(path)
            telemetry = {'attitude_deg': {'roll': 0., 'pitch': 0., 'yaw': 0.}}
            camera = {'roll_absolute': 0., 'pitch_absolute': 0., 'yaw_absolute': 0.}
            for angle in (np.pi, np.pi - .1, np.pi + .1):
                corners, _ = cv2.projectPoints(solver.object_points, np.array([angle, 0., 0.]),
                                              np.array([0., 0., 1.]), k, np.zeros(5))
                observation = {'source': 'qr-test', 'width': 640, 'height': 480,
                               'episode_id': 'approved-marker', 'qr_corners': corners.reshape(4, 2).tolist()}
                target = solver.estimate(observation, telemetry, camera, 123.)
                self.assertAlmostEqual(target.forward_m, 1., places=4)
                self.assertAlmostEqual(target.right_m, 0., places=4)
                self.assertAlmostEqual(target.down_m, 0., places=4)
                self.assertEqual(target.at, 123.)
            observation['qr_corners'] = [[290., 210.], [350., 210.], [350., 270.], [320., 240.]]
            with self.assertRaisesRegex(ValueError, 'invalid corners'):
                solver.estimate(observation, telemetry, camera, 123.)


if __name__ == '__main__':
    unittest.main()
