"""Calibration UX and geometry checks, with synthetic images and no aircraft."""
import json
import http.client
from http.server import ThreadingHTTPServer
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import cv2
import numpy as np
sys.path.insert(0,str(Path(__file__).parents[1]/'bridge'))
from calibrate_camera import board_corners, board_pattern, session_pattern, fit_views
from calibration_web import CaptureSession, handler_for


def board(columns=10, rows=7):
    image=np.full((600,800,3),230,np.uint8)
    for row in range(rows):
        for col in range(columns):
            image[70+row*50:70+(row+1)*50,100+col*50:100+(col+1)*50]=20 if (row+col)%2==0 else 230
    return image


class CaptureTests(unittest.TestCase):
    def test_square_counts_convert_to_inner_corners_and_support_chessboards(self):
        self.assertEqual(board_pattern(10,7),(9,6))
        self.assertEqual(board_pattern(8,8),(7,7))
        self.assertEqual(len(board_corners(board(8,8),(7,7))),49)
        with self.assertRaises(ValueError): board_pattern(0,7)

    def test_tilted_unevenly_lit_board_is_detected(self):
        image=board()
        transform=cv2.getPerspectiveTransform(np.float32([[100,70],[600,70],[600,420],[100,420]]),
            np.float32([[140,110],[650,65],[590,460],[95,390]]))
        image=cv2.warpPerspective(image,transform,(800,600),borderValue=(230,230,230))
        gradient=np.linspace(.4,1.,800)[None,:,None]
        image=(image*gradient).astype(np.uint8)
        self.assertEqual(len(board_corners(image)),54)

    def test_low_contrast_board_previously_rejected_by_original_detector(self):
        image=cv2.warpAffine(board(),cv2.getRotationMatrix2D((400,300),20,.85),
                            (800,600),borderValue=(230,230,230))
        image=np.uint8(image*.06+94)
        self.assertEqual(len(board_corners(image)),54)

    def test_nondefault_board_fit_uses_saved_inner_corner_dimensions(self):
        k=np.array([[920.,0,640],[0,910.,360],[0,0,1]])
        objects=np.zeros((49,3),np.float32)
        objects[:,:2]=np.mgrid[0:7,0:7].T.reshape(-1,2)*.02
        views=[]
        for i in range(20):
            r=np.array([-.35+.14*(i%5),-.3+.2*(i%4),-.15+.1*(i%3)])
            t=np.array([-.29+.14*(i%4),-.20+.11*(i//4),.65+.04*(i%3)])
            points,_=cv2.projectPoints(objects,r,t,k,np.zeros(5));views.append(points)
        estimated,_,rms,_=fit_views(views,(1280,720),.02,(7,7))
        np.testing.assert_allclose(estimated,k,rtol=.002,atol=.02)
        self.assertLess(rms,.01)

    def test_classic_detector_is_used_when_sector_detector_misses(self):
        with patch('calibrate_camera.cv2.findChessboardCornersSB',return_value=(False,None)):
            self.assertEqual(len(board_corners(board())),54)

    def test_rejected_frame_is_visible_and_never_counted_as_calibration(self):
        with tempfile.TemporaryDirectory() as d:
            s=CaptureSession(Path(d),10,7,lambda:(np.zeros((600,800,3),np.uint8),'1'))
            result=s.capture(10,7)
            self.assertEqual(result['count'],0)
            self.assertIn('mostly dark',result['message'])
            self.assertTrue((Path(d)/'last-attempt.jpg').exists())
            self.assertEqual(list(Path(d).glob('view-*.png')),[])

    def test_acceptance_saves_corners_locks_shape_and_preserves_fit_dimensions(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);s=CaptureSession(root,8,8,lambda:(board(8,8),'1'))
            self.assertEqual(s.capture(8,8)['count'],1)
            self.assertTrue((root/'view-01.png').exists())
            self.assertTrue((root/'corners-01.jpg').exists())
            self.assertEqual(session_pattern(root,10,7),(7,7))
            with self.assertRaisesRegex(ValueError,'locked'):s.capture(10,7)
            with self.assertRaisesRegex(ValueError,'Same camera'):s.capture(8,8)
            with self.assertRaisesRegex(ValueError,'already contains'):CaptureSession(root,8,8,s.camera)

    def test_changed_resolution_does_not_mix_views(self):
        with tempfile.TemporaryDirectory() as d:
            s=CaptureSession(Path(d),10,7,lambda:(board(),'1'));s.capture(10,7)
            s.camera=lambda:(np.zeros((720,1280,3),np.uint8),'2')
            with self.assertRaisesRegex(ValueError,'resolution'):s.capture(10,7)
            self.assertEqual(s.count,1)

    def test_browser_capture_requires_same_origin_and_returns_feedback(self):
        with tempfile.TemporaryDirectory() as d:
            s=CaptureSession(Path(d),10,7,lambda:(board(),'1'))
            server=ThreadingHTTPServer(('127.0.0.1',0),handler_for(s))
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            host=f'127.0.0.1:{server.server_port}'
            conn=http.client.HTTPConnection(host)
            try:
                body=json.dumps({'columns':10,'rows':7})
                conn.request('POST','/capture',body,{'Origin':'http://untrusted.example'})
                response=conn.getresponse();self.assertEqual(response.status,403);response.read()
                conn.request('POST','/capture',body,{'Origin':'http://'+host})
                response=conn.getresponse();self.assertEqual(response.status,200)
                self.assertEqual(json.loads(response.read())['count'],1)
                conn.request('GET','/attempt.jpg');response=conn.getresponse()
                self.assertEqual(response.status,200);self.assertTrue(response.read().startswith(b'\xff\xd8'))
            finally:conn.close();server.shutdown();server.server_close();thread.join()


if __name__=='__main__':unittest.main()
