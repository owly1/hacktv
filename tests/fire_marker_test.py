"""The FireSimulationDemo QR is the only code the detector reports as a fire."""
from pathlib import Path
import sys
import unittest

import cv2
import numpy as np

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT/'bridge'))
from fire_detection import FIRE_MARKER_PAYLOAD, FireDetector, parse_marker

LOOKALIKES = ['EW1:Ravine|300|X|35|M|45|90|31|18|18', 'EW1:Alpha|120|X|35|M|30|60|31|18|19',
              FIRE_MARKER_PAYLOAD + ' ', 'https://example.com']


def qr_frame(text):
    code = cv2.QRCodeEncoder.create().encode(text)
    code = cv2.resize(code, None, fx=12, fy=12, interpolation=cv2.INTER_NEAREST)
    code = cv2.copyMakeBorder(code, 120, 120, 120, 120, cv2.BORDER_CONSTANT, value=255)
    return cv2.cvtColor(code, cv2.COLOR_GRAY2BGR)


class FireMarkerTests(unittest.TestCase):
    def test_payload_is_the_printed_fire(self):
        self.assertEqual(FIRE_MARKER_PAYLOAD, 'EW1:Alpha|120|X|35|M|30|60|31|18|18')
        self.assertEqual((ROOT/'bridge'/'orbit-marker.txt').read_text(encoding='utf-8').strip(), FIRE_MARKER_PAYLOAD)
        details = parse_marker(FIRE_MARKER_PAYLOAD)
        self.assertEqual((details['name'], details['area_ha'], details['intensity']), ('Alpha', 120, 'extreme'))

    def test_repository_marker_is_a_fire(self):
        hit = FireDetector('', .5, use_yolo=False).detect(cv2.imread(str(ROOT/'dist'/'test-marker.png')))
        self.assertEqual((hit['source'], hit['qr_text']), ('qr-test', FIRE_MARKER_PAYLOAD))

    def test_every_other_qr_code_is_ignored(self):
        detector = FireDetector('', .5, use_yolo=False)
        for text in LOOKALIKES:
            self.assertIsNone(parse_marker(text), text)
            self.assertIsNone(detector.detect(qr_frame(text)), text)
        # The generated frame really is readable, so None above means rejected, not unseen.
        self.assertEqual(detector.detect(qr_frame(FIRE_MARKER_PAYLOAD))['qr_text'], FIRE_MARKER_PAYLOAD)
        self.assertIsNone(detector.detect(np.zeros((360, 640, 3), np.uint8)))


if __name__ == '__main__':
    unittest.main()
