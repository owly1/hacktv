"""Exact-payload glare recovery from cropped pixels of an actual flight."""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

import cv2
import numpy as np

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT/'bridge'))
from fire_detection import FIRE_MARKER_PAYLOAD, FireDetector
from qr_contrast import decode_candidate_crop


FIXTURES = Path(__file__).parent/'fixtures'/'qr_glare'
FRAMES = json.loads((FIXTURES/'frames.json').read_text())


def camera_frame(metadata):
    # Preserve every fixture pixel and its original camera coordinates. Only
    # the unrelated room outside the saved crop is replaced by neutral gray.
    width, height = metadata['full_size']
    frame = np.full((height, width, 3), 110, np.uint8)
    crop = cv2.imread(str(FIXTURES/metadata['file']))
    x, y = metadata['crop_xy']
    frame[y:y+crop.shape[0], x:x+crop.shape[1]] = crop
    return frame


class QRGlareTests(unittest.TestCase):
    def test_exact_small_decode_is_localized_against_original_pixels_before_metric_pose(self):
        metadata = json.loads((FIXTURES/'renderer-small-corner-bias.json').read_text())
        width, height = metadata['full_size']
        frame = np.full((height, width, 3), metadata['background_gray'], np.uint8)
        crop = cv2.imread(str(FIXTURES/'renderer-small-corner-bias.png'))
        x, y = metadata['crop_xy']
        frame[y:y+crop.shape[0], x:x+crop.shape[1]] = crop
        hit = FireDetector('', use_yolo=False).detect(frame, captured_at=100.)
        self.assertEqual(hit['qr_text'], FIRE_MARKER_PAYLOAD)
        self.assertEqual(hit['qr_tracking'], 'decoded')
        errors = np.linalg.norm(np.asarray(hit['qr_corners'])-metadata['truth_corners'], axis=1)
        self.assertLess(max(errors), 1.5,
                        'Native ArUco payload decoding displaced the fourth corner by 4.7 pixels')

    def test_actual_glare_frame_recovers_exact_identity_that_old_path_missed(self):
        metadata = next(item for item in FRAMES if '12s' in item['file'])
        frame = camera_frame(metadata)
        baseline = FireDetector('', use_yolo=False)
        baseline._qr_contrast_at = float('inf')
        with patch('fire_detection.decode_candidate_crop', return_value=('', None, None, False)):
            self.assertIsNone(baseline.detect(frame, captured_at=100.))
        hit = FireDetector('', use_yolo=False).detect(frame, captured_at=100.)
        self.assertEqual(hit['qr_text'], FIRE_MARKER_PAYLOAD)
        self.assertEqual(hit['qr_tracking'], 'decoded')
        self.assertEqual(hit['qr_decoded_at'], 100000.)

    def test_actual_glare_and_small_code_fixtures_keep_original_camera_coordinates(self):
        for metadata in FRAMES:
            if not metadata['expected_exact']:
                continue
            with self.subTest(frame=metadata['file']):
                hit = FireDetector('', use_yolo=False).detect(camera_frame(metadata), captured_at=100.)
                self.assertIsNotNone(hit)
                self.assertEqual(hit['qr_text'], FIRE_MARKER_PAYLOAD)
                self.assertEqual(hit['qr_tracking'], 'decoded')
                np.testing.assert_allclose(hit['qr_corners'], metadata['expected_corners'], atol=2.)
                self.assertEqual(hit['frame_w'], 1280)

    def test_actual_unrecoverable_reflection_does_not_invent_a_fire(self):
        metadata = next(item for item in FRAMES if '08s' in item['file'])
        self.assertIsNone(FireDetector('', use_yolo=False).detect(camera_frame(metadata), captured_at=100.))

    def test_crop_decode_rejects_an_actual_wrong_payload(self):
        wrong = FIRE_MARKER_PAYLOAD[:-2]+'19'
        code = cv2.QRCodeEncoder.create().encode(wrong)
        code = cv2.resize(code, (144, 144), interpolation=cv2.INTER_NEAREST)
        image = np.full((300, 400), 180, np.uint8)
        image[80:224, 120:264] = code
        text, points, _ = cv2.QRCodeDetector().detectAndDecode(image)
        self.assertEqual(text, wrong, 'Negative fixture must be genuinely readable')
        text, recovered, _, other = decode_candidate_crop(
            image, [points], cv2.QRCodeDetector(), FIRE_MARKER_PAYLOAD)
        self.assertEqual(text, '')
        self.assertIsNone(recovered)
        self.assertTrue(other, 'A wrong exact decode must clear prior tracking identity')

    def test_crop_resize_pixel_centres_map_back_without_pose_scale_error(self):
        expected = np.array([[[40., 50.], [90., 50.], [90., 100.], [40., 100.]]])
        enlarged = (expected-[24., 34.]+.5)*3-.5
        reader = Mock(detectAndDecode=Mock(return_value=(FIRE_MARKER_PAYLOAD, enlarged, None)))
        _, recovered, _, _ = decode_candidate_crop(
            np.full((200, 300), 180, np.uint8), [expected], reader, FIRE_MARKER_PAYLOAD)
        np.testing.assert_allclose(recovered, expected, atol=1e-10)
        reader.detectAndDecode.assert_called_once()

    def test_crop_work_is_bounded_and_clipped_quadrilaterals_are_rejected(self):
        image = np.full((400, 500), 180, np.uint8)
        reader = Mock(detectAndDecode=Mock(return_value=('', None, None)))
        candidates = [np.array([[[x, 50.], [x+30, 50.], [x+30, 80.], [x, 80.]]])
                      for x in (30., 100., 170., 240.)]
        decode_candidate_crop(image, candidates, reader, FIRE_MARKER_PAYLOAD)
        self.assertEqual(reader.detectAndDecode.call_count, 4, 'At most two crops and two variants each')
        reader.reset_mock()
        clipped = candidates[0].copy(); clipped[0, 0, 0] = -1
        self.assertIsNone(decode_candidate_crop(image, [clipped, [1, 2, 3]], reader,
                                               FIRE_MARKER_PAYLOAD)[1])
        reader.detectAndDecode.assert_not_called()

    def test_full_frame_contrast_scan_is_throttled_during_repeated_misses(self):
        detector = FireDetector('', use_yolo=False)
        reader = Mock(detectAndDecode=Mock(return_value=('', None, None)))
        detector.qr_readers = [reader]
        frame = np.full((240, 320, 3), 110, np.uint8)
        detector.detect(frame, captured_at=100.)
        first = reader.detectAndDecode.call_count
        detector.detect(frame, captured_at=100.2)
        second = reader.detectAndDecode.call_count-first
        detector.detect(frame, captured_at=100.5)
        third = reader.detectAndDecode.call_count-first-second
        self.assertEqual(first, second+1)
        self.assertEqual(third, first)


if __name__ == '__main__':
    unittest.main()
