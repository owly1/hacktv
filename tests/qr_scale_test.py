import math
import json
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0,str(Path(__file__).parents[1]/'bridge'))
from qr_scale import AdaptiveQRScale
from fire_tracking import MetricQRPose


class AdaptiveQRScaleTests(unittest.TestCase):
    def observe(self,estimator,side,anchor,altitudes,*,noise=0.,outliers=(),origin=.025):
        fit=None
        for index,altitude in enumerate(altitudes):
            # Independent physical equation: world target down from body is
            # anchor+altitude; camera origin is offset from the body.
            camera_down=anchor+altitude-origin
            unit_down=(camera_down+noise*math.sin(index*1.7))/side
            if index in outliers:unit_down+=.4/side
            fit=estimator.observe(unit_down,altitude,origin,at=float(index))
        return fit

    def test_different_physical_sizes_and_target_levels_are_recovered(self):
        for side in (.06,.12,.25):
            for anchor in (0.,.525,.8):
                with self.subTest(side=side,anchor=anchor):
                    fit=self.observe(AdaptiveQRScale(),side,anchor,[0.]*4+[.25,.5]+[1.]*4)
                    self.assertIsNotNone(fit)
                    self.assertAlmostEqual(fit.side_m,side,places=10)
                    self.assertAlmostEqual(fit.anchor_down_m,anchor,places=10)
                    self.assertLess(fit.residual_m,1e-10)

    def test_noise_and_one_bad_frame_do_not_bias_scale(self):
        fit=self.observe(AdaptiveQRScale(),.12,.8,[0.]*5+[.25,.5,.75]+[1.]*5,
                         noise=.007,outliers=(8,))
        self.assertIsNotNone(fit)
        self.assertLess(abs(fit.side_m/.12-1),.03)
        self.assertLess(abs(fit.anchor_down_m-.8),.02)
        self.assertLess(fit.inliers,fit.samples)

    def test_stationary_short_baseline_or_single_high_frame_cannot_establish_scale(self):
        for heights in ([0.]*12,[0.]*4+[.3]*4,[0.]*6+[1.]):
            with self.subTest(heights=heights):
                self.assertIsNone(self.observe(AdaptiveQRScale(),.12,.8,heights))

    def test_repeated_frames_and_nonfinite_inputs_do_not_count(self):
        estimator=AdaptiveQRScale()
        for _ in range(10):estimator.observe(5.,0.,at=1.)
        self.assertEqual(len(estimator.samples),1)
        self.assertIsNone(estimator.observe(float('nan'),1.,at=2.))
        self.assertIsNone(estimator.observe(True,1.,at=3.))
        self.assertIsNone(estimator.observe(1e300,1.,at=4.))
        self.assertEqual(len(estimator.samples),1)

    def test_inconsistent_motion_and_reversed_scale_are_rejected(self):
        estimator=AdaptiveQRScale()
        for i,height in enumerate([0.]*4+[.2,.4,.6]+[1.]*5):
            unit=(.6+height+(.2 if i%2 else -.2))/.12
            fit=estimator.observe(unit,height,at=float(i))
        self.assertIsNone(fit)
        estimator=AdaptiveQRScale()
        for i,height in enumerate([0.]*4+[1.]*4):
            fit=estimator.observe((2-height)/.12,height,at=float(i))
        self.assertIsNone(fit)

    def test_one_spurious_altitude_cannot_create_vertical_baseline(self):
        estimator=AdaptiveQRScale()
        heights=[0.]*8+[1.]
        self.assertIsNone(self.observe(estimator,.12,.8,heights))

    def test_unstable_slope_or_implausible_physical_size_is_not_trusted(self):
        estimator=AdaptiveQRScale()
        for i,(height,error) in enumerate(zip([0.]*3+[.5]*3,[-.05,0,.05]*2)):
            fit=estimator.observe((.8+height+error)/.12,height,at=float(i))
        self.assertIsNone(fit)
        for side in (.02,1.):
            self.assertIsNone(self.observe(AdaptiveQRScale(),side,.8,[0.]*4+[1.]*4))

    def test_offset_variation_is_removed_before_fitting(self):
        estimator=AdaptiveQRScale()
        for i,height in enumerate([0.]*4+[.3,.6]+[1.]*4):
            origin=.08*math.sin(i/4)
            fit=estimator.observe((.5+height-origin)/.12,height,origin,at=float(i))
        self.assertAlmostEqual(fit.side_m,.12,places=10)
        self.assertAlmostEqual(fit.anchor_down_m,.5,places=10)

    def test_rough_mode_replays_recorded_climb_without_claiming_precise_scale(self):
        # Recorded 20261018T094339Z: time, altitude, unit QR down, camera origin
        # down. All initial observations plus evenly spaced later hover frames
        # retain the original early/late disagreement; no ruler size is used.
        rows=[
            (.32,0.,1.794106,-.012989),(.48,0.,1.777704,-.012994),
            (.64,0.,1.766451,-.012995),(.95,0.,1.7506,-.012994),
            (1.12,0.,1.742022,-.012996),(1.28,0.,1.726841,-.013002),
            (1.43,0.,1.727175,-.013003),(1.75,0.,1.700855,-.013104),
            (1.9,.000022,1.710837,-.013293),(2.06,.000136,1.707194,-.013283),
            (2.22,.000259,1.700502,-.013323),(2.53,.00539,1.699076,-.006212),
            (2.69,.051071,1.641351,.000442),(2.85,.109992,1.958958,-.003411),
            (3.16,.37273,3.205781,-.002375),(4.56,.970578,9.724193,-.002336),
            (4.72,.983474,9.898224,-.003063),(5.04,.994319,9.908332,-.003088),
            (5.68,1.024234,10.797233,-.001963),(6.49,1.010981,11.253547,-.001952),
            (7.14,1.006036,11.805275,-.001937),(8.14,1.017443,12.067782,-.001868),
            (8.8,.997474,12.199407,-.002139),(9.62,1.010888,12.551311,-.002263),
            (10.44,1.009011,12.539571,-.001929),(11.42,.993084,12.53013,-.001765),
            (12.38,.986498,12.273201,-.002047),(13.2,.985199,12.278714,-.001978),
            (14.03,.976331,12.305684,-.001782),(14.7,.984507,12.32669,-.002035),
        ]
        rough=AdaptiveQRScale(rough=True);strict=AdaptiveQRScale();first=None
        for at,altitude,unit_down,origin in rows:
            fit=rough.observe(unit_down,altitude,origin,at=at)
            strict.observe(unit_down,altitude,origin,at=at)
            if fit is not None and first is None:first=(at,fit)
        self.assertIsNotNone(first)
        self.assertLessEqual(first[0],5.04)
        self.assertGreater(first[1].uncertainty_fraction,.15)
        self.assertGreater(first[1].max_error_m,.15)
        self.assertIsNotNone(fit)
        self.assertLessEqual(fit.max_error_m,.20)
        self.assertLessEqual(fit.uncertainty_fraction,.25)
        self.assertGreater(fit.uncertainty_fraction,.10)
        self.assertIsNone(strict.fit)

    def test_rough_mode_keeps_metric_baseline_and_outlier_limits(self):
        for heights in ([0.]*12,[0.]*4+[.3]*4,[0.]*6+[1.]):
            self.assertIsNone(self.observe(AdaptiveQRScale(rough=True),.12,.8,heights))
        estimator=AdaptiveQRScale(rough=True)
        for i,height in enumerate([0.]*5+[.2,.4,.6]+[1.]*5):
            fit=estimator.observe((.6+height+(.4 if i%2 else -.4))/.12,height,at=float(i))
        self.assertIsNone(fit)
        estimator=AdaptiveQRScale(rough=True)
        for i,height in enumerate([0.]*4+[1.]*4):
            fit=estimator.observe((.8+height)/.12,height,at=i*.01)
        self.assertIsNone(fit)
        self.assertIn('sustained',estimator.reason)

    def test_rough_mode_does_not_invent_a_marker_size(self):
        for side in (.06,.12,.25):
            fit=self.observe(AdaptiveQRScale(rough=True),side,.525,[0.]*4+[.25,.5]+[1.]*4)
            self.assertAlmostEqual(fit.side_m,side,places=10)
            self.assertLess(fit.uncertainty_fraction,1e-10)

    def test_projected_corners_through_nominal_pnp_recover_unknown_size(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'calibration.json'
            path.write_text(json.dumps({'image_size':[1280,720],
                'camera_matrix':[[1000,0,640],[0,1000,360],[0,0,1]],
                'distortion_coefficients':[0]*5,'camera_offset_body_m':[.08,0,.02],
                'qr_black_square_side_m':.12,'qr_pose_verified':True}))
            model=MetricQRPose(path)
            telemetry={'attitude_deg':{'roll':0.,'pitch':0.,'yaw':0.}}
            for actual_side in (.06,.12,.25):
                for anchor in (.525,.8):
                    estimator=AdaptiveQRScale()
                    for index,height in enumerate([0.]*4+[.25,.5]+[1.]*4):
                        centre=np.array([1.,0.,anchor+height])
                        pitch=-math.atan2(centre[2]-.02,centre[0]-.08)
                        forward=np.array([math.cos(pitch),0.,-math.sin(pitch)])
                        right=np.array([0.,1.,0.]);down=np.cross(forward,right)
                        axes=np.column_stack((right,down,forward))
                        half=actual_side/2
                        world=centre+np.array([[half,-half,0],[half,half,0],[-half,half,0],[-half,-half,0]])
                        camera=(world-model.offset)@axes
                        pixels=camera[:,:2]/camera[:,2,None]*1000+np.array([640,360])
                        observation={'source':'qr-test','episode_id':'test','width':1280,'height':720,
                                     'qr_corners':pixels.tolist()}
                        gimbal={'roll_absolute':0.,'pitch_absolute':math.degrees(pitch),'yaw_absolute':0.}
                        nominal=model.estimate(observation,telemetry,gimbal,index,enforce_envelope=False)
                        origin=float(model.origin(telemetry)[2])
                        fit=estimator.observe((nominal.down_m-origin)/model.side,height,origin,at=float(index))
                    self.assertIsNotNone(fit)
                    self.assertAlmostEqual(fit.side_m,actual_side,places=7)
                    self.assertAlmostEqual(fit.anchor_down_m,anchor,places=7)


if __name__=='__main__':unittest.main()
