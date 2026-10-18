"""Grounded preparation checks. Synthetic camera data; no aircraft connection."""
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parents[1]/"bridge"))
from calibrate_camera import PATTERN, board_corners, fit_views

spec = importlib.util.spec_from_file_location("observer_for_calibration", Path(__file__).parents[1]/"bridge"/"anafi_observer.py")
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class CalibrationTests(unittest.TestCase):
    def test_printed_pattern_has_expected_inner_corner_count(self):
        """Verify printed pattern has expected inner corner count."""
        image = np.full((560, 740, 3), 255, np.uint8)
        for row in range(7):
            for col in range(10):
                if (row+col) % 2 == 0:
                    image[60+row*60:60+(row+1)*60, 60+col*60:60+(col+1)*60] = 0
        corners = board_corners(image)
        self.assertIsNotNone(corners)
        self.assertEqual(len(corners), PATTERN[0]*PATTERN[1])

    def test_calibration_recovers_known_synthetic_camera(self):
        """Verify calibration recovers known synthetic camera."""
        k = np.array([[920., 0, 640], [0, 910., 360], [0, 0, 1]])
        objects = np.zeros((54, 3), np.float32)
        objects[:, :2] = np.mgrid[0:9, 0:6].T.reshape(-1, 2)*.02
        views = []
        for i in range(20):
            r = np.array([-.35+.14*(i % 5), -.3+.2*(i % 4), -.15+.1*(i % 3)])
            t = np.array([-.29+.14*(i % 4), -.20+.11*(i//4), .65+.04*(i % 3)])
            points, _ = cv2.projectPoints(objects, r, t, k, np.zeros(5))
            views.append(points)
        estimated, dist, rms, errors = fit_views(views, (1280, 720), .02)
        self.assertLess(rms, .01)
        np.testing.assert_allclose(estimated, k, rtol=.002, atol=.02)
        self.assertEqual(len(errors), 20)

    def test_insufficient_or_unvaried_views_do_not_produce_calibration(self):
        """Verify insufficient or unvaried views do not produce calibration."""
        with self.assertRaises(ValueError):
            fit_views([], (1280, 720), .02)
        point = np.zeros((54, 1, 2), np.float32)
        with self.assertRaises(ValueError):
            fit_views([point]*20, (1280, 720), .02)

    def test_native_frames_are_preserved_for_both_supported_yuv_formats(self):
        """Verify native frames are preserved for both supported yuv formats."""
        sdk = SimpleNamespace(VDEF_I420=1, VDEF_NV12=2)
        raw = np.full((720*3//2, 1280), 128, np.uint8)
        for fmt in (1, 2):
            frame = SimpleNamespace(as_ndarray=lambda: raw, format=lambda: fmt)
            native = observer.prepare_image(frame, cv2, sdk, 0)
            normal = observer.prepare_image(frame, cv2, sdk, 640)
            self.assertEqual(native.shape, (720, 1280, 3))
            self.assertEqual(normal.shape, (360, 640, 3))


if __name__ == "__main__":
    unittest.main()
