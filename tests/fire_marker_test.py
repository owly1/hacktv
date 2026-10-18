"""The FireSimulationDemo QR is the only code the detector reports as a fire."""
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock,patch,mock_open
from types import SimpleNamespace

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
    def test_rgb_warmup_initializes_predictor_once_and_restores_threads_without_seeding_qr(self):
        detector=FireDetector('',use_yolo=False)
        detector.model_status='ready';torch=SimpleNamespace(threads=2)
        torch.set_num_threads=Mock(side_effect=lambda n:setattr(torch,'threads',n))
        calls=[]
        def predict(image,**kwargs):
            calls.append((image.shape,kwargs));torch.threads=8
            return []
        detector.model=Mock(side_effect=predict)
        with patch.dict(sys.modules,{'torch':torch}):
            self.assertTrue(detector.warmup());self.assertTrue(detector.warmup())
        self.assertEqual(calls,[((720,1280,3),{'imgsz':640,'conf':detector.conf,'verbose':False})])
        torch.set_num_threads.assert_called_once_with(2);self.assertEqual(torch.threads,2)
        self.assertIsNone(detector.qr_track.decoded_at);self.assertIsNone(detector.qr_template.decoded_at)
        self.assertEqual(detector.model_status,'ready')

    def test_rgb_warmup_failure_preserves_qr_detection_and_restores_threads(self):
        detector=FireDetector('',use_yolo=False);detector.model=Mock(side_effect=RuntimeError('model failure'))
        detector.model_status='ready';torch=SimpleNamespace(set_num_threads=Mock())
        with patch.dict(sys.modules,{'torch':torch}):self.assertFalse(detector.warmup())
        self.assertIsNone(detector.model);self.assertEqual(detector.model_status,'error')
        torch.set_num_threads.assert_called_once_with(2)
        self.assertEqual(detector.detect(qr_frame(FIRE_MARKER_PAYLOAD))['source'],'qr-test')

    def test_monitor_is_not_created_or_ready_until_rgb_warmup_completes(self):
        import fire_monitor
        order=[];detector=Mock();detector.warmup.side_effect=lambda:order.append('warmed')
        monitor=Mock()
        def create(*args):
            self.assertEqual(order,['warmed']);order.append('monitor');return monitor
        with patch.object(fire_monitor,'FireDetector',return_value=detector), \
             patch.object(fire_monitor,'Monitor',side_effect=create), \
             patch.object(fire_monitor.fcntl,'flock'), \
             patch.object(Path,'open',mock_open()), \
             patch.dict(sys.modules,{'torch':SimpleNamespace(set_num_threads=Mock())}), \
             patch.dict(fire_monitor.os.environ,{'DASHBOARD_TOKEN':'test','INGEST_TOKEN':'test'}), \
             patch.object(sys,'argv',['fire_monitor.py']):
            fire_monitor.main()
        self.assertEqual(order,['warmed','monitor']);monitor.run.assert_called_once();monitor.close.assert_called_once()

    def test_thread_budget_failure_degrades_to_qr_instead_of_stopping_monitor_startup(self):
        detector=FireDetector('',use_yolo=False);detector.model=Mock(return_value=[])
        detector.model_status='ready'
        with patch.dict(sys.modules,{'torch':SimpleNamespace(set_num_threads=Mock(side_effect=RuntimeError()))}):
            self.assertFalse(detector.warmup())
        self.assertIsNone(detector.model);self.assertEqual(detector.model_status,'error')

    def test_oblique_fallback_returns_original_camera_coordinates(self):
        detector=FireDetector('',use_yolo=False)
        original=np.array([[[100.,50.],[200.,50.],[200.,100.],[100.,100.]]])
        stretched=original.copy();stretched[...,1]=(stretched[...,1]+.5)*1.5-.5
        detector.qr_readers=[Mock(detectAndDecode=Mock(side_effect=[
            ('',None,None),('',None,None),(FIRE_MARKER_PAYLOAD,stretched,None)]))]
        hit=detector.detect(np.zeros((240,320,3),np.uint8))
        np.testing.assert_allclose(hit['qr_corners'],original.reshape(4,2))
        self.assertEqual(hit['frame_w'],320)
        self.assertEqual(hit['bbox'],[.3125,.2083,.625,.4167])

    def test_oblique_fallback_still_rejects_other_payloads(self):
        detector=FireDetector('',use_yolo=False)
        corners=np.array([[[10.,10.],[40.,10.],[40.,40.],[10.,40.]]])
        detector.qr_readers=[Mock(detectAndDecode=Mock(return_value=(LOOKALIKES[0],corners,None)))]
        self.assertIsNone(detector.detect(np.zeros((240,320,3),np.uint8)))

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
