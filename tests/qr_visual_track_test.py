from pathlib import Path
import sys
import unittest
import cv2
import numpy as np
sys.path.insert(0,str(Path(__file__).parents[1]/'bridge'))
from qr_visual_track import QRVisualTrack,QRTemplateTrack
from fire_detection import FIRE_MARKER_PAYLOAD


class VisualTrackingTests(unittest.TestCase):
    def fixture(self):
        qr=cv2.QRCodeEncoder.create().encode(FIRE_MARKER_PAYLOAD)
        qr=cv2.resize(qr,(180,180),interpolation=cv2.INTER_NEAREST)
        gray=np.full((360,480),180,np.uint8);gray[100:280,140:320]=qr
        return gray,np.array([[140,100],[319,100],[319,279],[140,279]],np.float32)

    def test_partial_glare_keeps_current_measured_corners_under_translation(self):
        gray,corners=self.fixture();track=QRVisualTrack();track.seed(gray,corners,100)
        moved=cv2.warpAffine(gray,np.float32([[1,0,5],[0,1,7]]),(480,360),borderValue=180)
        moved[112:127,135:330]=255
        points=track.follow(moved,100.2)
        self.assertIsNotNone(points)
        np.testing.assert_allclose(points,corners+[5,7],atol=1.5)
        self.assertEqual(track.decoded_at,100)

    def test_no_seed_full_occlusion_gap_and_decode_expiry_never_return_a_target(self):
        gray,corners=self.fixture()
        self.assertIsNone(QRVisualTrack().follow(gray,100))
        for fault in ('occlusion','gap','expired'):
            track=QRVisualTrack();track.seed(gray,corners,100)
            if fault=='expired':
                for step in range(1,13):self.assertIsNotNone(track.follow(gray,100+step*.2))
                self.assertIsNone(track.follow(gray,102.6))
            elif fault=='gap':self.assertIsNone(track.follow(gray,100.6))
            else:self.assertIsNone(track.follow(np.full_like(gray,255),100.2))
            self.assertIsNone(track.corners)

    def test_template_revalidates_a_small_qr_after_flow_expiry_and_brief_occlusion(self):
        gray,corners=self.fixture();_,points,modules=cv2.QRCodeDetector().detectAndDecode(gray)
        corners=points.reshape(4,2);track=QRTemplateTrack();track.seed(gray,corners,100,modules)
        transform=np.float32([[.34,0,170],[0,.34,70]])
        small=cv2.warpAffine(gray,transform,(480,360),flags=cv2.INTER_AREA,borderValue=180)
        observed=corners*.34+[170,70]
        result=track.match(small,[observed],104.)
        self.assertIsNotNone(result)
        self.assertGreaterEqual(result['score'],.85);self.assertGreaterEqual(result['data_score'],.65)
        np.testing.assert_allclose(result['corners'],observed,atol=1.5)
        self.assertEqual(result['decoded_at'],100)
        # Success comes from newly matched pixels, not extending decode time.
        for at in (110.,116.,122.):self.assertIsNotNone(track.match(small,[observed],at))
        self.assertEqual(track.decoded_at,100)

    def test_template_rejects_other_payload_shared_finders_occlusion_and_stale_seed(self):
        gray,corners=self.fixture()
        _,points,modules=cv2.QRCodeDetector().detectAndDecode(gray);corners=points.reshape(4,2)
        wrong=cv2.QRCodeEncoder.create().encode(FIRE_MARKER_PAYLOAD.replace('Alpha','Bravo'))
        wrong=cv2.resize(wrong,(180,180),interpolation=cv2.INTER_NEAREST)
        image=gray.copy();image[100:280,140:320]=wrong
        for fault in ('wrong-code','blank','gap','seed','no-seed'):
            track=QRTemplateTrack()
            if fault!='no-seed':track.seed(gray,corners,100,modules)
            source=image if fault=='wrong-code' else np.full_like(gray,180) if fault=='blank' else gray
            at=116 if fault=='gap' else 401 if fault=='seed' else 100.2
            self.assertIsNone(track.match(source,[corners],at),fault)

    def test_successful_small_decode_refreshes_template_without_discarding_reference(self):
        gray,corners=self.fixture();_,points,modules=cv2.QRCodeDetector().detectAndDecode(gray)
        track=QRTemplateTrack();track.seed(gray,points,100,modules)
        small=cv2.resize(gray,(240,180),interpolation=cv2.INTER_AREA)
        track.seed(small,points*.5,101,modules)
        self.assertEqual(track.decoded_at,101)
        # A malformed refresh cannot erase previously validated evidence.
        track.seed(small,points*.5,102,None)
        self.assertEqual(track.decoded_at,101);self.assertIsNotNone(track.reference)

if __name__=='__main__':unittest.main()
