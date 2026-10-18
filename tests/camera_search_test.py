import sys
from pathlib import Path
import unittest
sys.path.insert(0,str(Path(__file__).parents[1]/'bridge'))
from camera_search import CameraSearch, BearingAim, AcquisitionAim, image_bearing_pitch, image_bearing_ray


class SearchTests(unittest.TestCase):
    def test_pixel_ray_uses_capture_compass_heading_without_assuming_metric_depth(self):
        import math
        calibration={'image_size':[200,100],'camera_matrix':[[100,0,100],[0,100,50],[0,0,1]],
                     'distortion_coefficients':[0,0,0,0,0]}
        # Centre pixel, camera pointing east and down 45 degrees. The QR's
        # changing apparent size cannot change that independently known ray.
        for radius in (5,15):
            observation={'width':200,'height':100,'qr_corners':[[100-radius,50-radius],
                [100+radius,50-radius],[100+radius,50+radius],[100-radius,50+radius]]}
            ray=image_bearing_ray(observation,calibration,
                {'roll_absolute':0.,'pitch_absolute':-45.,'yaw_absolute':90.})
            self.assertAlmostEqual(ray[0],0.)
            self.assertAlmostEqual(ray[1],math.sqrt(.5))
            self.assertAlmostEqual(ray[2],math.sqrt(.5))

    def test_pixel_tracking_is_independent_of_qr_size_and_compensates_camera_pitch(self):
        import math
        calibration={'image_size':[200,100],'camera_matrix':[[100,0,100],[0,100,50],[0,0,1]],
                     'distortion_coefficients':[0,0,0,0,0]}
        camera={'roll_absolute':0.,'pitch_absolute':-20.,'yaw_absolute':90.}
        for radius in (5,15):
            observation={'width':200,'height':100,'qr_corners':[[100-radius,75-radius],[100+radius,75-radius],
                          [100+radius,75+radius],[100-radius,75+radius]]}
            self.assertAlmostEqual(image_bearing_pitch(observation,calibration,camera),-20-math.degrees(math.atan(.25)))
    def test_prediction_follows_observed_direction_without_a_fixed_downward_sweep(self):
        for direction in (-1,1):
            aim=BearingAim();aim.observe(0.,-30.);aim.observe(.2,-30.+direction*4)
            self.assertAlmostEqual(aim.predict(.3),-30.+direction*6)
            self.assertAlmostEqual(aim.predict(.8),-30.+direction*9)
            self.assertIsNone(aim.predict(1.1))

    def test_duplicate_frames_do_not_create_motion_and_reset_forgets_previous_target(self):
        aim=BearingAim();aim.observe(0.,-30.);aim.observe(0.,-80.)
        self.assertEqual(aim.predict(.1),-30.)
        aim.reset();self.assertIsNone(aim.predict(.2))

    def test_takeoff_detection_loss_reacquires_downward_without_a_metric_range(self):
        # Latest recording: QR last seen at 0.165 m; TakeOff then reached
        # 0.93 m while the old tracker expired and held the camera at -27 deg.
        aim=AcquisitionAim();old=BearingAim()
        for controller in (aim,old):controller.observe(2.7,-24.);controller.observe(2.86,-27.)
        aim.observe(2.87,-27.,.165)
        actual=-27.;commands=[]
        for tick in range(100):
            now=3.7+tick*.05
            command=aim.step(now,altitude=.93,actual_pitch=actual,reacquire=True)
            self.assertIsNotNone(command)
            self.assertLessEqual(abs(command-actual),.751)
            actual=command;commands.append(command)
            if command<=-65:break
        self.assertIsNone(old.predict(now))
        self.assertEqual(aim.state,'searching')
        self.assertLess(now,7.)
        self.assertLessEqual(commands[-1],-65.)
        # Fresh image feedback owns the camera immediately, without waiting
        # for physical QR scale to finish acquiring.
        aim.observe(now,-61.,.93)
        self.assertEqual(aim.step(now,altitude=.93,actual_pitch=actual,reacquire=True),-61.)
        self.assertEqual(aim.state,'tracking')

    def test_search_needs_measured_ascent_and_stops_when_authorization_expires(self):
        for fault in ('not-authorized','no-altitude','no-ascent','descending','no-camera','future-observation'):
            aim=AcquisitionAim();aim.observe(0.,-25.,None if fault=='no-altitude' else .1)
            command=aim.step(-1. if fault=='future-observation' else 1.,
                altitude=.1 if fault=='no-ascent' else 0. if fault=='descending' else 1.,
                actual_pitch=None if fault=='no-camera' else -25.,reacquire=fault!='not-authorized')
            self.assertIsNone(command,fault)
        aim=AcquisitionAim();aim.observe(0.,-25.,.1)
        self.assertIsNotNone(aim.step(1.,altitude=1.,actual_pitch=-25.,reacquire=True))
        self.assertIsNone(aim.step(1.1,altitude=1.,actual_pitch=-25.,reacquire=False))
        self.assertEqual(aim.state,'holding')

    def test_authorized_search_continues_after_twenty_seconds_without_extrapolating_old_pixels(self):
        aim=AcquisitionAim();aim.observe(0.,-25.,.1)
        self.assertIsNone(aim.predict(25.))
        self.assertEqual(aim.step(25.,altitude=1.,actual_pitch=-30.,reacquire=True),-30.)
        self.assertLess(aim.step(25.1,altitude=1.,actual_pitch=-30.,reacquire=True),-30.)
        self.assertEqual(aim.state,'searching')
        self.assertIsNone(aim.step(25.2,altitude=1.,actual_pitch=-31.,reacquire=False))

    def test_search_respects_pitch_bounds_pauses_and_new_observation_timestamps(self):
        aim=AcquisitionAim();aim.observe(0.,-25.,.1)
        command=aim.step(1.,altitude=1.,actual_pitch=-25.,bounds=(-60,40),reacquire=True)
        # A stalled worker may not jump all the way down when it resumes.
        self.assertGreaterEqual(aim.step(3.,altitude=1.,actual_pitch=command,
                                         bounds=(-60,40),reacquire=True),command-3.75)
        for tick in range(200):
            command=aim.step(3.+tick*.05,altitude=1.,actual_pitch=command,bounds=(-60,40),reacquire=True)
        self.assertEqual(command,-60.)
        aim.observe(0.,10.,1.)
        self.assertEqual(aim.altitude,.1)
        aim.reset();self.assertIsNone(aim.step(13.,altitude=1.,actual_pitch=-60.,reacquire=True))

    def test_late_climb_loss_preserves_ground_baseline_until_episode_reset(self):
        aim=AcquisitionAim();aim.observe(0.,-25.,0.)
        aim.observe(1.,-62.,.98)
        self.assertEqual(aim.baseline_altitude,0.)
        self.assertEqual(aim.step(2.,altitude=1.,actual_pitch=-62.,reacquire=True),-62.)
        self.assertLess(aim.step(2.1,altitude=1.,actual_pitch=-62.,reacquire=True),-62.)
        self.assertEqual(aim.state,'searching')
        aim.reset();self.assertIsNone(aim.baseline_altitude)
        aim.observe(3.,-62.,1.)
        self.assertIsNone(aim.step(4.,altitude=1.,actual_pitch=-62.,reacquire=True))

    def test_sweep_covers_both_ends_at_bounded_rate_and_respects_hardware_bounds(self):
        for bounds in ((-85,85),(-60,40)):
            search=CameraSearch();pitch=0.;values=[]
            for tick in range(1600):
                command=search.step(tick*.1,pitch,bounds)
                self.assertLessEqual(abs(command-pitch),1.00001)
                self.assertTrue(bounds[0]<=command<=bounds[1])
                values.append(command);pitch=command
            self.assertAlmostEqual(min(values),bounds[0]);self.assertAlmostEqual(max(values),bounds[1])

    def test_first_detection_holds_camera_and_loss_resumes_search(self):
        search=CameraSearch();pitch=-30
        search.step(0,pitch,(-85,85))
        held=search.step(.2,pitch,(-85,85),True)
        self.assertEqual(search.state,'acquiring')
        self.assertEqual(search.step(1,pitch,(-85,85)),held)
        search.step(1.5,pitch,(-85,85))
        self.assertEqual(search.state,'scanning')

    def test_long_pause_does_not_jump_the_camera(self):
        search=CameraSearch();search.step(0,0,(-85,85))
        self.assertGreaterEqual(search.step(30,0,(-85,85)),-2.5)

if __name__=='__main__':unittest.main()
