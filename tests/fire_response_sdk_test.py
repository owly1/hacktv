"""Dashboard-driven flight decisions with mocked SDK; no radio access."""
import importlib.util
from pathlib import Path
import sys
import time
from types import SimpleNamespace
import unittest
from dataclasses import replace
from unittest.mock import Mock,patch
sys.path.insert(0,str(Path(__file__).parents[1]/'bridge'))
HAS_SDK=importlib.util.find_spec('olympe') is not None
if HAS_SDK:
    import fire_response as response
    from fire_tracking import FireTarget
    from pose_history import PoseHistory


@unittest.skipUnless(HAS_SDK,'Requires Pi SDK; aircraft is mocked')
class ResponseTests(unittest.TestCase):
    def setUp(self):
        for factory in ('Anafi','Drone','SkyController3'):
            guard=patch('anafi_bridge.olympe.'+factory,side_effect=AssertionError('No radio in tests'))
            guard.start();self.addCleanup(guard.stop)
    def bridge(self):
        args=SimpleNamespace(ip=None,controller='direct',home_lat=0,home_lon=0,execute=False,
            terminal_control=True,hover_seconds=1,camera_calibration='/nonexistent-test-only.json',backend='http://localhost:1234')
        b=response.FireResponse(args,Mock(),)
        b.connected=True;b.drone=Mock(connected=True)
        b.last_frame_time=time.time()
        b.telemetry={'state':'landed','battery_pct':75,'altitude_m':0,'ground_speed_mps':0,
                     'attitude_deg':{'roll':0,'pitch':0,'yaw':0}}
        now=time.monotonic();history=PoseHistory()
        for name,values in [('altitude',{'altitude':0.}),('attitude',{'roll':0.,'pitch':0.,'yaw':0.}),
                            ('camera',{'roll_absolute':0.,'pitch_absolute':-45.,'yaw_absolute':0.})]:
            history.record(name,now,values)
        b.sensor_ages=SimpleNamespace(landed_at=float('-inf'),emergency_at=float('-inf'),state='landed',state_at=now,
            history=history,ages={k:now for k in ('altitude','speed','attitude','camera')})
        return b

    def confirm_grounded_target(self,b):
        for offset in (-1.,-.75,-.5,-.25,0.):
            b.ground_target_lock.observe(replace(b.target,at=b.target.at+offset),0.)

    def authorize_camera_mission(self,b):
        b.takeoff_used=True
        b.control={'enabled':True,'session_id':'camera-session'}
        b.claimed_session='camera-session';b.control_at=time.monotonic()

    def test_calibration_summary_reports_physical_scale_without_claiming_profile_match(self):
        b=self.bridge();self.assertIsNone(b._calibration_status())
        b.geometry_snapshot={'qr_black_square_side_m':.12,'camera_offset_body_m':[.08,0,0],
                             'image_size':[1280,720],'rms_px':.344,'qr_pose_verified':True}
        summary=b._calibration_status()
        self.assertEqual(summary['qr_side_m'],.12)
        self.assertTrue(summary['qr_verified']);self.assertIsNone(summary['profile_verified'])
        b.geometry_snapshot['rms_px']=float('nan');self.assertIsNone(b._calibration_status())
    def test_startup_installs_landing_driver_without_recording_or_radio_commands(self):
        b=self.bridge()
        self.assertIsInstance(b.driver,response.OlympeOrbitDriver)
        self.assertIs(b.driver.bridge,b)
        self.assertTrue(b.args.execute)
        b.publisher.start_recording.assert_not_called()
        b.drone.assert_not_called()

    def test_response_uses_one_metre_hover_without_a_descent_step(self):
        b=self.bridge();b.driver=Mock()
        with patch.object(response,'orbit_fire') as orbit:
            b._after_hover()
        self.assertEqual(orbit.call_args.args[1].height_m,1.)
        b.driver.move.assert_not_called()

    def test_missing_driver_blocks_takeoff_but_allows_grounded_camera(self):
        b=self.bridge();b.driver=None
        self.assertIn('landing driver',b.checkout_reason(starting=True))
        self.assertIsNone(response.HoverCheckout.checkout_reason(b,camera_only=True))
        b._hover()
        b.drone.assert_not_called()

    def test_land_and_abort_delegate_confirmation_to_landing_driver(self):
        import qr_orbit_bridge as orbit
        import hover_checkout as checkout
        for aborted in (False,True):
            b=self.bridge();b.hold_connection=True
            b.driver.land=Mock(return_value=True)
            b.drone.return_value.success.return_value=True
            with patch.object(orbit,'Landing',return_value='LAND') as land, \
                 patch.object(orbit,'FlyingStateChanged',return_value='WAIT_FOR_LANDED'):
                if aborted:
                    with patch.object(b,'checkout_reason',side_effect=[None,'Fire lost']), \
                         patch.object(checkout,'TakeOff',return_value='TAKEOFF'):
                        b._hover()
                    self.assertEqual(b.drone.call_args_list[0].args[0],'TAKEOFF')
                else:
                    b._request_landing(force=False)
                    self.assertFalse(b.land_confirmed)
                    b._land()
            land.assert_called_with(_no_expect=True)
            self.assertIn('LAND',[c.args[0] for c in b.drone.call_args_list])
            b.driver.land.assert_called_once()
            self.assertTrue(b.land_confirmed)
            self.assertTrue(b.abort_flight.is_set())

    def test_camera_tracks_height_change_without_fabricating_orbit_position(self):
        from qr_circle_core import camera_pitch
        b=self.bridge();b.geometry=SimpleNamespace(offset=(.08,0,0))
        self.authorize_camera_mission(b)
        b.episode='fire';b.started_at=time.monotonic()-4;b.flight_phase='climb'
        measured=FireTarget(time.monotonic()-2,'fire',.52,0,.41,.12)
        b.camera_aim_sample=(measured,0.);b.target=None;b.telemetry['altitude_m']=.97
        expected=FireTarget(measured.at,'fire',.52,0,1.38,.12)
        self.assertAlmostEqual(b._camera_pitch(),camera_pitch(expected,b.geometry.offset))
        self.assertLess(b._camera_pitch(),-70)
        self.assertIsNone(b.target)
        for fault in ('movement','future-start','stale-altitude','stale-camera','disabled','wrong-episode'):
            b.driver.movement_started=fault=='movement'
            b.started_at=time.monotonic()+(1 if fault=='future-start' else -25)
            b.sensor_ages.ages['altitude']=time.monotonic()-(2 if fault=='stale-altitude' else 0)
            b.sensor_ages.ages['camera']=time.monotonic()-(2 if fault=='stale-camera' else 0)
            b.control['enabled']=fault!='disabled'
            b.episode='other' if fault=='wrong-episode' else 'fire'
            self.assertIsNone(b._camera_pitch())

    def test_fresh_camera_target_after_movement_uses_measured_geometry(self):
        from qr_circle_core import camera_pitch
        b=self.bridge();b.geometry=SimpleNamespace(offset=(.08,0,0))
        b.driver.movement_started=True
        b.target=FireTarget(time.monotonic(),'fire',1,0,.7,.12)
        self.assertEqual(b._camera_pitch(),camera_pitch(b.target,b.geometry.offset))

    def test_camera_recovery_keeps_last_measured_aim_after_alignment_and_visual_expiry(self):
        from qr_circle_core import camera_pitch
        # 105541: move memory pointed at -39 degrees, but the final measured
        # target called for -58 degrees. Losing one frame must not undo it.
        for target_expired in (False,True):
            with self.subTest(target_expired=target_expired):
                b=self.bridge();b.geometry=SimpleNamespace(offset=(.08,0,0))
                b.episode='fire';b.driver.movement_started=True;b.flight_phase='recover'
                old=FireTarget(106.55,'fire',1.09849,.01071,.83551,.12,'motion-propagated-fire')
                latest=FireTarget(108.79,'fire',.62615,.00447,.87092,.12,'measured-qr-3d')
                with patch.object(response.time,'monotonic',return_value=108.68):
                    b._remember_orbit_target(old)
                b.target=None if target_expired else latest
                b.camera_aim_sample=(latest,1.01)
                b.bearing_aim.observe(latest.at,-58.07,1.01)
                with patch.object(response.time,'monotonic',return_value=109.7), \
                     patch.object(b,'_fire_seen_at',return_value=latest.at):
                    self.assertAlmostEqual(b._camera_pitch(),camera_pitch(latest,b.geometry.offset))
                    self.assertLess(b._camera_pitch(),-55)
                self.assertIs(b.orbit_target,old)

    def test_camera_keeps_current_velocity_pose_over_older_body_frame_visual_geometry(self):
        from qr_circle_core import camera_pitch
        b=self.bridge();b.geometry=SimpleNamespace(offset=(.08,0,0));b.episode='fire'
        # The model's capture time stays old even as its body coordinates are
        # refreshed at control cadence. Comparing capture times alone is wrong.
        current=FireTarget(106.,'fire',1.,0.,1.,.12,'velocity-propagated-fire')
        with patch.object(response.time,'monotonic',return_value=110.):
            b._remember_orbit_target(current)
        for captured_at in (109.8,110.01):
            b.target=FireTarget(captured_at,'fire',.4,.1,1.,.12,'measured-qr-3d')
            b.camera_aim_sample=(b.target,1.)
            with patch.object(response.time,'monotonic',return_value=110.1), \
                 patch.object(b,'_fire_seen_at',return_value=109.8):
                self.assertAlmostEqual(b._camera_pitch(),camera_pitch(current,b.geometry.offset))

    def test_camera_fallback_rejects_measurements_before_move_or_from_another_episode(self):
        from qr_circle_core import camera_pitch
        b=self.bridge();b.geometry=SimpleNamespace(offset=(.08,0,0));b.episode='fire'
        current=FireTarget(106.,'fire',1.,0.,1.,.12,'motion-propagated-fire')
        with patch.object(response.time,'monotonic',return_value=110.):
            b._remember_orbit_target(current)
        for captured_at,episode in ((109.9,'fire'),(110.1,'other'),(112.,'fire')):
            b.target=FireTarget(captured_at,episode,.4,0.,1.,.12,'measured-qr-3d')
            b.camera_aim_sample=(b.target,1.)
            with patch.object(response.time,'monotonic',return_value=111.), \
                 patch.object(b,'_fire_seen_at',return_value=110.1):
                self.assertAlmostEqual(b._camera_pitch(),camera_pitch(current,b.geometry.offset))

    def test_bosco_search_sends_pitch_only_stops_on_detection_and_stops_on_disable(self):
        b=self.bridge();b.drone.return_value.done.return_value=True;b.drone.return_value.success.return_value=True
        control={'enabled':True,'camera_search':True,'session_id':'search-session'}
        with patch.object(b,'_search_bounds',return_value=(-85,85)),patch.object(b,'_gimbal_pitch',return_value=-30), \
             patch.object(response.gimbal,'set_target',return_value='CAMERA') as pitch:
            b._search_step(control)
            self.assertEqual(b.search.state,'scanning')
            control['observed_target']={'at':time.time()*1000}
            b._search_step(control)
            self.assertEqual(b.search.state,'acquiring')
            b._search_step({'enabled':False})
            self.assertEqual(b.search.state,'off')
            calls=pitch.call_count;b._search_step({'enabled':False});self.assertEqual(pitch.call_count,calls)
        for call in pitch.call_args_list:
            self.assertEqual(call.kwargs['yaw_frame_of_reference'],'none')
            self.assertEqual(call.kwargs['roll_frame_of_reference'],'none')
        self.assertTrue(all(c.args==('CAMERA',) for c in b.drone.call_args_list))
        self.assertFalse(b.takeoff_used)

    def test_bosco_requires_acknowledged_camera_hold_before_claiming_fire(self):
        for acknowledged,pitch in ((False,-40),(True,0),(True,-40)):
            b=self.bridge();b.geometry=Mock(models={'qr-test':Mock()},offset=(0,0,0));b.geometry_error=None
            b.drone.return_value.done.return_value=acknowledged;b.drone.return_value.success.return_value=True
            target={'at':time.time()*1000,'episode_id':'fire','incident_id':'incident','source':'qr-test'}
            b.target=FireTarget(time.monotonic(),'fire',.6,0,.5,.12)
            self.confirm_grounded_target(b)
            control={'enabled':True,'camera_search':True,'session_id':'session','target':target,
                     'observed_target':target,'mission':{'episode_id':'fire'}}
            def request(path,body):b.control_stop.set();return control
            with patch.object(b,'_load_geometry'),patch.object(b,'_update_target'), \
                 patch.object(b,'_request',side_effect=request),patch.object(response.threading,'Thread') as thread, \
                 patch.object(b,'_search_bounds',return_value=(-85,85)),patch.object(b,'_gimbal_pitch',return_value=pitch):
                b._control_loop()
            self.assertEqual(thread.called,acknowledged and pitch==-40)

    def test_search_never_moves_camera_after_mission_handoff_or_with_stale_pose(self):
        for fault in ('flight','stale-camera','low-battery','disabled','manual-session'):
            b=self.bridge();control={'enabled':True,'camera_search':True,'session_id':'session'}
            if fault=='flight':b.takeoff_used=True
            if fault=='stale-camera':b.sensor_ages.ages['camera']-=2
            if fault=='low-battery':b.telemetry['battery_pct']=20
            if fault=='disabled':control['enabled']=False
            if fault=='manual-session':control['camera_search']=False
            with patch.object(b,'_search_bounds',return_value=(-85,85)),patch.object(b,'_gimbal_pitch',return_value=-30):
                b._search_step(control)
            b.drone.assert_not_called()

    def test_ascent_uses_latest_sdk_altitude_and_vertical_speed_not_dashboard_sample(self):
        from qr_circle_core import camera_pitch
        b=self.bridge();b.geometry=SimpleNamespace(offset=(.08,0,0))
        self.authorize_camera_mission(b)
        b.episode='fire';b.started_at=time.monotonic()-3;b.flight_phase='takeoff'
        b.camera_aim_sample=(FireTarget(time.monotonic()-2,'fire',.52,0,.41,.12),0.)
        b.telemetry['altitude_m']=0
        def state(event):
            if event is response.AltitudeChanged:return {'altitude':.97}
            if event is response.SpeedChanged:return {'speedZ':-.5}
            return None
        with patch.object(b,'_state',side_effect=state):pitch=b._camera_pitch()
        expected=FireTarget(0,'fire',.52,0,1.455,.12)
        self.assertAlmostEqual(pitch,camera_pitch(expected,b.geometry.offset))

    def test_rejected_speed_setup_cannot_proceed_to_takeoff(self):
        b=self.bridge();b.hold_connection=True
        b.drone.return_value.wait.return_value.success.return_value=False
        b.driver.land=Mock(return_value=False)
        with patch.object(response.QRAutoPreset,'_automatic_mission') as mission:
            b._automatic_mission()
        mission.assert_not_called();self.assertTrue(b.abort_flight.is_set())
        b.driver.land.assert_called_once()

    def test_response_configures_tracking_then_takeoff_and_lands_when_acquisition_fails(self):
        import hover_checkout as checkout
        import qr_orbit_bridge as orbit
        b=self.bridge();b.hold_connection=True;b.takeoff_used=True;b.args.hover_seconds=0
        b.driver.land=Mock(return_value=True)
        b.telemetry['state']='hovering'
        b.drone.return_value.wait.return_value.success.return_value=True
        b.drone.return_value.done.return_value=True;b.drone.return_value.success.return_value=True
        with patch.object(response,'MaxVerticalSpeed',return_value='CLIMB_LIMIT'), \
             patch.object(response.gimbal,'set_max_speed',return_value='CAMERA_SPEED'), \
             patch.object(checkout,'TakeOff',return_value='TAKEOFF'), \
             patch.object(orbit,'Landing',return_value='LAND'), \
             patch.object(orbit,'FlyingStateChanged',return_value='WAIT_FOR_LANDED'), \
             patch.object(b,'checkout_reason',return_value=None),patch.object(b,'_camera_loop'), \
             patch.object(b,'_after_hover',side_effect=InterruptedError('Fire location did not stabilize')):
            b._automatic_mission()
        commands=[c.args[0] for c in b.drone.call_args_list]
        self.assertEqual(commands[:3],['CLIMB_LIMIT','CAMERA_SPEED','TAKEOFF'])
        self.assertIn('LAND',commands[3:]);self.assertTrue(b.land_confirmed)
        self.assertFalse(b.running)
    def test_startup_and_missing_calibration_never_start_a_mission(self):
        b=self.bridge()
        self.assertIsNone(b.geometry)
        b.publisher.start_recording.assert_not_called()
        def control(*args):
            b.control_stop.set()
            return {'enabled':True,'session_id':'session','target':{'at':time.time()*1000,'episode_id':'fire'}}
        with patch.object(b,'_request',side_effect=control),patch.object(response.threading,'Thread') as thread:
            b._control_loop()
        thread.assert_not_called();b.drone.assert_not_called()
    def test_enabled_confirmed_fire_claim_starts_once_and_land_can_win_claim_race(self):
        for cancel in (False,True):
            b=self.bridge();b.geometry=Mock(models={'yolo':Mock()});b.geometry_error=None
            b.target=FireTarget(time.monotonic(),'fire',1,0,.8,.2)
            self.confirm_grounded_target(b)
            target={'at':time.time()*1000,'episode_id':'fire','incident_id':'incident','source':'yolo'}
            control={'enabled':True,'session_id':'session','target':target,'mission':{'episode_id':'fire'}}
            def request(path,body):
                if path.endswith('/claim'):
                    b.control_stop.set()
                    if cancel:b.abort_flight.set()
                return control
            with patch.object(b,'_load_geometry'),patch.object(b,'_update_target'), \
                 patch.object(b,'_request',side_effect=request),patch.object(response.threading,'Thread') as thread:
                b._control_loop()
            if cancel:thread.assert_not_called()
            else:
                thread.assert_called_once_with(target=b._automatic_mission)
                self.assertTrue(b.takeoff_used);self.assertEqual(b.episode,'fire')
                b.publisher.start_recording.assert_called_once()
            b.drone.assert_not_called()

    def test_rgb_classification_without_metric_position_never_claims_or_takes_off(self):
        b=self.bridge();b.geometry=Mock(models={'yolo':Mock()});b.geometry_error=None
        target={'at':time.time()*1000,'episode_id':'fire','incident_id':'incident','source':'yolo'}
        control={'enabled':True,'session_id':'session','target':target,'mission':{'episode_id':'fire'}}
        paths=[]
        def request(path,body):paths.append(path);b.control_stop.set();return control
        with patch.object(b,'_load_geometry'),patch.object(b,'_update_target'), \
             patch.object(b,'_request',side_effect=request),patch.object(response.threading,'Thread') as thread:
            b._control_loop()
        self.assertFalse(any(p.endswith('/claim') for p in paths));thread.assert_not_called();b.drone.assert_not_called()
    def test_control_expiry_invalidates_airborne_sample(self):
        b=self.bridge();b.control={'enabled':True,'session_id':'session'};b.claimed_session='session'
        b.control_at=time.monotonic()-4
        with self.assertRaisesRegex(InterruptedError,'control connection is stale'):b._sample_fire()
        self.assertTrue(b.abort_flight.is_set())

    def test_localization_uses_frame_pose_history_not_current_sdk_cache(self):
        b=self.bridge();b.geometry=Mock();b.geometry_error=None
        now=time.time()*1000
        b.control={'observed_target':{'at':now,'first':now-1000,'hits':6,'source':'qr-test','episode_id':'fire'}}
        camera={'roll_absolute':0,'pitch_absolute':-45,'yaw_absolute':0}
        with patch.object(b,'_state',return_value={0:{'pitch_absolute':-80}}):b._update_target()
        b.geometry.estimate.assert_called_once();self.assertEqual(b.geometry.estimate.call_args.args[2],camera)

    def test_calibration_does_not_reload_midflight(self):
        b=self.bridge();active=object();b.geometry=active;b.takeoff_used=True
        b.geometry_sha256='frozen';b._load_geometry()
        self.assertIs(b.geometry,active);self.assertEqual(b.geometry_sha256,'frozen')

    def test_zoom_or_crop_change_invalidates_latched_geometry(self):
        b=self.bridge();b.camera_profile={'zoom_level':{'level':1.}}
        b.control={'enabled':True,'session_id':'session'};b.claimed_session='session';b.control_at=time.monotonic()
        with patch.object(b,'_read_camera_profile',return_value={'zoom_level':{'level':1.}}):
            self.assertIsNone(b._camera_profile_reason())
        with patch.object(b,'_read_camera_profile',return_value={'zoom_level':{'level':2.}}):
            self.assertIn('zoom/crop',b._camera_profile_reason())
            with self.assertRaisesRegex(InterruptedError,'zoom/crop'):b._sample_fire()
        self.assertTrue(b.abort_flight.is_set())

    def test_adaptive_qr_derives_metric_scale_from_climb_and_freezes_the_result(self):
        b=self.bridge();b.adaptive_qr=True;b.geometry=SimpleNamespace(offset=(.08,0.,0.),models={})
        model=Mock(side=.12);model.origin.return_value=(.08,0.,0.);b.geometry.models['qr-test']=model
        observation={'source':'qr-test','episode_id':'fire'}
        # True QR is 8 cm, while the nominal PnP reference is 12 cm. No caller
        # supplies that actual size to the response or scale estimator.
        result=None
        for index,height in enumerate((0.,0.,0.,0.,0.,.5,.5,.5,1.,1.,1.)):
            b.takeoff_used=index>=5;b.episode='fire'
            unit=(10.,.5,(height+.4)/.08)
            model.estimate.return_value=FireTarget(index*.2,'fire',unit[0]*.12+.08,unit[1]*.12,unit[2]*.12,.12)
            result=b._qr_candidate(observation,{'altitude_m':height}, {}, index*.2)
            if index<5:self.assertIsNone(result);self.assertIsNone(b.qr_scale_fit)
        self.assertIsNotNone(result)
        self.assertAlmostEqual(b.qr_scale_fit.side_m,.08,places=6)
        self.assertAlmostEqual(result.forward_m,.88,places=6)
        self.assertAlmostEqual(result.right_m,.04,places=6)
        self.assertAlmostEqual(result.down_m,1.4,places=6)
        self.assertGreaterEqual(result.position_uncertainty_m,.10)
        self.assertTrue(b.qr_scale.rough)
        self.assertAlmostEqual(b.target_vertical_anchor,.4,places=6)
        fit=b.qr_scale_fit
        model.estimate.return_value=FireTarget(3.,'fire',1.6,.1,2.,.12)
        b._qr_candidate(observation,{'altitude_m':1.}, {}, 3.)
        self.assertIs(b.qr_scale_fit,fit)

    def test_adaptive_bearing_aim_never_uses_nominal_range_for_height_feedforward(self):
        b=self.bridge();b.adaptive_qr=True;b.qr_scale_episode='fire'
        b.geometry=SimpleNamespace(offset=(.08,0.,0.));b.episode='fire'
        b.bearing_target=FireTarget(time.monotonic(),'fire',.68,0.,.8,0.,'qr-bearing-only')
        b.camera_aim_sample=(FireTarget(time.monotonic(),'fire',.3,0.,10.,.12),0.)
        b.started_at=time.monotonic()-3;b.flight_phase='takeoff';b.telemetry['altitude_m']=1.
        self.assertAlmostEqual(b._camera_pitch(),-53.13010235415598)
        b.bearing_target=FireTarget(time.monotonic()-2,'fire',.68,0.,.8,0.,'qr-bearing-only')
        self.assertIsNone(b._camera_pitch())
        self.assertIsNone(b.target)

    def test_adaptive_session_reset_erases_previous_display_scale_and_ground_window(self):
        b=self.bridge();b.adaptive_qr=True;b.qr_scale_fit=object()
        b.bearing_target=FireTarget(time.monotonic(),'old',1,0,1,0.,'qr-bearing-only')
        b.target=b.bearing_target;b.target_vertical_anchor=.4
        b._reset_qr_scale('new-session','new-episode')
        self.assertIsNone(b.qr_scale_fit);self.assertIsNone(b.bearing_target);self.assertIsNone(b.target)
        self.assertEqual(b.qr_scale.samples,[]);self.assertEqual(len(b.ground_target_lock.samples),0)
        self.assertTrue(b.qr_scale.rough)

    def test_adaptive_loss_only_predicts_recent_observed_motion_without_metric_target(self):
        b=self.bridge();b.adaptive_qr=True;b.qr_scale_episode='fire';b.takeoff_used=True
        b.control={'enabled':True,'session_id':'session'};b.claimed_session='session';b.control_at=time.monotonic()
        now=time.monotonic();b.bearing_aim.observe(now-.3,-16.);b.bearing_aim.observe(now-.1,-20.)
        self.assertLess(b._camera_pitch(),-20.)
        self.assertIsNone(b.target);self.assertIsNone(b.qr_scale_fit)
        b.abort_flight.set();self.assertIsNone(b._camera_pitch())

    def test_adaptive_camera_uses_pixel_bearing_without_overwriting_it_with_pnp(self):
        b=self.bridge();b.adaptive_qr=True;b.qr_scale_episode='fire'
        b.geometry=SimpleNamespace(offset=(.08,0.,0.));b.episode='fire'
        now=time.monotonic();b.bearing_aim.observe(now,-65.,.8)
        b.bearing_target=FireTarget(now,'fire',1.08,0.,.4,0.,'qr-bearing-only')
        self.assertAlmostEqual(b._camera_pitch(),-65.)
        self.assertEqual(b.bearing_aim.pitch,-65.)

    def test_pnp_rejection_keeps_pixel_aim_and_capture_altitude(self):
        b=self.bridge();b.adaptive_qr=True
        model=Mock();model.estimate.side_effect=ValueError('QR position is ambiguous')
        b.geometry=SimpleNamespace(models={'qr-test':model},offset=(.08,0.,0.))
        b.geometry_snapshot={'image_size':[200,100],'camera_matrix':[[100,0,100],[0,100,50],[0,0,1]],
                             'distortion_coefficients':[0]*5}
        now=time.time()*1000
        b.control={'observed_target':{'at':now,'first':now-1000,'hits':6,'source':'qr-test',
                   'episode_id':'fire','width':200,'height':100,
                   'qr_corners':[[90,40],[110,40],[110,60],[90,60]]}}
        b._update_target()
        self.assertIsNone(b.target);self.assertIsNone(b.bearing_target)
        self.assertAlmostEqual(b.bearing_aim.pitch,-45.)
        self.assertEqual(b.bearing_aim.altitude,0.)
        self.assertAlmostEqual(b._camera_pitch(),-45.)

    def test_adaptive_takeoff_loss_scans_only_camera_before_horizontal_movement(self):
        b=self.bridge();b.adaptive_qr=True;b.qr_scale_episode='fire';b.takeoff_used=True
        b.episode='fire';b.started_at=time.monotonic()-4;b.flight_phase='recover'
        b.control={'enabled':True,'session_id':'session'};b.claimed_session='session';b.control_at=time.monotonic()
        b.bearing_aim.observe(time.monotonic()-1.2,-27.,.165)
        with patch.object(b,'_current_pose',return_value={'altitude_m':.93}), \
             patch.object(b,'_gimbal_pitch',return_value=-27.),patch.object(b,'_search_bounds',return_value=(-85.,85.)):
            self.assertEqual(b._camera_pitch(),-27.)
            self.assertEqual(b.camera_aim_mode,'searching')
            b.driver.movement_started=True
            self.assertIsNone(b._camera_pitch())
        self.assertIsNone(b.target);self.assertIsNone(b.qr_scale_fit)
        b.drone.assert_not_called()

    def test_camera_search_after_long_visual_gap_requires_live_mission_and_sensors(self):
        for fault in (None,'movement','altitude','camera','disabled','stale-control','abort','disconnected'):
            with self.subTest(fault=fault):
                b=self.bridge();self.authorize_camera_mission(b)
                now=time.monotonic();b.adaptive_qr=True;b.qr_scale_episode=b.episode='fire'
                b.started_at=now-25.;b.flight_phase='recover'
                b.bearing_aim.observe(now-24.,-27.,.165)
                if fault=='movement':b.driver.movement_started=True
                if fault in ('altitude','camera'):b.sensor_ages.ages[fault]=now-2.
                if fault=='disabled':b.control['enabled']=False
                if fault=='stale-control':b.control_at=now-4.
                if fault=='abort':b.abort_flight.set()
                if fault=='disconnected':b.connected=False
                with patch.object(response.time,'monotonic',return_value=now), \
                     patch.object(b,'_current_pose',return_value={'altitude_m':.93}), \
                     patch.object(b,'_gimbal_pitch',return_value=-27.), \
                     patch.object(b,'_search_bounds',return_value=(-85.,85.)):
                    self.assertIsNone(b.bearing_aim.predict(now))
                    if fault is None:
                        self.assertEqual(b._camera_pitch(),-27.)
                        with patch.object(response.time,'monotonic',return_value=now+.1):
                            self.assertLess(b._camera_pitch(),-27.)
                    else:self.assertIsNone(b._camera_pitch())
                self.assertIsNone(b.target);b.drone.assert_not_called()

    def test_camera_tracks_live_orbit_model_after_long_gap_but_never_expired_body_geometry(self):
        from qr_circle_core import camera_pitch
        for fault in (None,'stale-model','body-frame','disabled','abort','stale-camera'):
            with self.subTest(fault=fault):
                b=self.bridge();self.authorize_camera_mission(b)
                b.geometry=SimpleNamespace(offset=(.08,0,0));b.episode='fire';b.driver.movement_started=True
                now=time.monotonic()
                current=FireTarget(now-25.,'fire',1.,0.,1.3,.12,'velocity-propagated-fire')
                b._remember_orbit_target(current)
                b.target=current;b.camera_aim_sample=(current,1.)
                if fault=='stale-model':b.orbit_target_updated_at=now-.31
                if fault=='body-frame':b.orbit_target=replace(current,position_source='motion-propagated-fire')
                if fault=='disabled':b.control['enabled']=False
                if fault=='abort':b.abort_flight.set()
                if fault=='stale-camera':b.sensor_ages.ages['camera']=now-2.
                with patch.object(response.time,'monotonic',return_value=now+.01), \
                     patch.object(b,'_fire_seen_at',return_value=now-25.):
                    if fault is None:self.assertEqual(b._camera_pitch(),camera_pitch(current,b.geometry.offset))
                    else:self.assertIsNone(b._camera_pitch())
                b.drone.assert_not_called()

    def test_grounded_detection_is_centered_instead_of_freezing_edge_pitch(self):
        b=self.bridge();b.adaptive_qr=True;b.geometry=SimpleNamespace(offset=(.08,0,0))
        b.bearing_target=FireTarget(time.monotonic(),'fire',1.08,0,1.,0.,'qr-bearing-only')
        b.drone.return_value.done.return_value=True;b.drone.return_value.success.return_value=True
        control={'enabled':True,'camera_search':True,'session_id':'s','observed_target':{'at':time.time()*1000}}
        with patch.object(b,'_gimbal_pitch',return_value=0.),patch.object(b,'_search_bounds',return_value=(-85,85)), \
             patch.object(b,'_send_pitch',return_value=Mock(done=lambda:True,success=lambda:True)) as send:
            b._search_step(control)
            self.assertEqual(send.call_args.args[0],-6.)
        self.assertIsNone(b.target_vertical_anchor)

    def test_short_http_failure_preserves_control_but_sustained_loss_requests_landing(self):
        for age in (1.,4.):
            b=self.bridge();b.takeoff_used=True;b.geometry=Mock(models={'qr-test':Mock()})
            b.geometry_error=None;b.control={'enabled':True,'session_id':'session'}
            b.control_at=time.monotonic()-age;previous=b.control_at
            def failed(*args):b.control_stop.set();raise TimeoutError()
            with patch.object(b,'_request',side_effect=failed),patch.object(b,'_request_landing') as land:
                b._control_loop()
            self.assertEqual(land.called,age>3);self.assertTrue(b.control['enabled'])
            self.assertEqual(b.control_at,previous)

    def test_recovery_keeps_ascent_camera_aim_then_holds_without_an_independent_abort(self):
        b=self.bridge();b.geometry=SimpleNamespace(offset=(.08,0,0))
        self.authorize_camera_mission(b)
        b.episode='fire';b.started_at=time.monotonic()-25;b.flight_phase='recover'
        b.camera_aim_sample=(FireTarget(time.monotonic()-2,'fire',.52,0,.4,.12),0.)
        b.telemetry['altitude_m']=1.
        self.assertLess(b._camera_pitch(),-70)
        b.driver.movement_started=True
        self.assertIsNone(b._camera_pitch())
        with patch.object(b.camera_stop,'wait',side_effect=lambda *_:b.camera_stop.set()):b._camera_loop()
        self.assertFalse(b.abort_flight.is_set());b.drone.assert_not_called()

    def test_missing_capture_pose_history_rejects_projection(self):
        b=self.bridge();b.geometry=Mock();b.geometry_error=None;b.takeoff_used=True;b.episode='fire'
        b.sensor_ages.history=PoseHistory()
        b.control={'target':{'at':time.time()*1000,'source':'qr-test','episode_id':'fire'}}
        b._update_target()
        b.geometry.estimate.assert_not_called();self.assertIsNone(b.target)
        self.assertIn('history',b.target_error)

    def test_measured_climb_checks_qr_scale_without_fitting_an_arbitrary_offset(self):
        for down,valid in [(1.66,True),(2.13,False)]:
            b=self.bridge();b.geometry=Mock();b.geometry_error=None;b.takeoff_used=True;b.episode='fire'
            now=time.monotonic();b.target_vertical_anchor=.6
            b.sensor_ages.history=PoseHistory()
            for name,values in [('altitude',{'altitude':1.06}),('attitude',{'roll':0.,'pitch':0.,'yaw':0.}),
                                ('camera',{'roll_absolute':0.,'pitch_absolute':-75.,'yaw_absolute':0.})]:
                b.sensor_ages.history.record(name,now,values)
            b.geometry.estimate.return_value=FireTarget(now,'fire',.6,.1,down,.12)
            b.control={'target':{'at':time.time()*1000,'source':'qr-test','episode_id':'fire'}}
            b._update_target()
            self.assertEqual(b.target is not None,valid)
            if not valid:self.assertIn('scale/pose disagrees',b.target_error)
            self.assertEqual(b.target_vertical_anchor,.6)
            self.assertFalse(b.abort_flight.is_set())

    def test_rejected_depth_preserves_fresh_pixel_bearing_but_profile_failure_clears_it(self):
        b=self.bridge();b.takeoff_used=True;b.episode='fire';b.target_vertical_anchor=.2
        b.geometry=Mock();b.geometry.models={'qr-test':Mock()}
        b.geometry.models['qr-test'].origin.return_value=(.08,0.,0.)
        b.geometry_snapshot={'image_size':[200,100],
            'camera_matrix':[[100,0,100],[0,100,50],[0,0,1]],'distortion_coefficients':[0]*5}
        b.control={'target':{'at':time.time()*1000,'source':'qr-test','episode_id':'fire',
            'width':200,'height':100,'qr_corners':[[80,30],[120,30],[120,70],[80,70]]}}
        now=time.monotonic();b.sensor_ages.history=PoseHistory()
        for name,values in [('altitude',{'altitude':1.}),('attitude',{'roll':0.,'pitch':0.,'yaw':0.}),
                            ('camera',{'roll_absolute':0.,'pitch_absolute':-45.,'yaw_absolute':90.})]:
            b.sensor_ages.history.record(name,now,values)
        with patch.object(b,'_qr_candidate',return_value=FireTarget(now,'fire',1.,0.,2.,.12)):
            b._update_target()
        self.assertIsNone(b.target)
        self.assertIn('scale/pose disagrees',b.target_error)
        self.assertIsNotNone(b.orbit_bearing)
        self.assertAlmostEqual(b.orbit_bearing.north,0.)
        self.assertAlmostEqual(b.orbit_bearing.east,2**-.5)
        self.assertAlmostEqual(b.orbit_bearing.origin_north_m,.08)
        self.assertEqual(b.target_vertical_anchor,.2)
        self.assertFalse(b.abort_flight.is_set())
        b.projected_at=None
        with patch.object(b,'_camera_profile_reason',return_value='Camera profile changed'):
            b._update_target()
        self.assertIsNone(b.orbit_bearing)

    def test_claimed_target_uses_single_fresh_frame_but_grounded_fire_still_needs_confirmation(self):
        for airborne in (False,True):
            b=self.bridge();b.geometry=Mock();b.geometry_error=None;b.takeoff_used=airborne;b.episode='fire'
            now=time.time()*1000
            observation={'at':now,'first':now,'hits':1,'source':'qr-test','episode_id':'fire'}
            b.control={'target':observation,'observed_target':observation}
            with patch.object(b,'_state',return_value={0:{'roll_absolute':0,'pitch_absolute':-45,'yaw_absolute':0}}):
                b._update_target()
            self.assertEqual(b.geometry.estimate.called,airborne)

    def test_battery_test_is_explicit_and_keeps_a_landing_reserve(self):
        b=self.bridge();b.telemetry['battery_pct']=32
        self.assertIn('40%',response.HoverCheckout.checkout_reason(b,starting=True))
        b.args.short_test=True
        self.assertIsNone(response.HoverCheckout.checkout_reason(b,starting=True))
        b.telemetry['battery_pct']=29
        self.assertIn('30%',response.HoverCheckout.checkout_reason(b,starting=True))
        b.telemetry['state']='hovering';b.telemetry['altitude_m']=1;b.telemetry['battery_pct']=24
        self.assertIn('25%',response.HoverCheckout.checkout_reason(b))

    def test_lost_fire_between_claim_and_takeoff_blocks_motor_command(self):
        b=self.bridge();b.geometry=Mock();b.geometry_error=None;b.takeoff_used=True
        b.control={'enabled':True,'session_id':'session','target':None}
        b.claimed_session='session';b.episode='fire';b.control_at=time.monotonic()
        self.assertIn('lost before takeoff',b.checkout_reason(starting=True))
        b.drone.assert_not_called()

    def test_qr_claim_requires_current_measured_position_and_rechecks_before_takeoff(self):
        for fault in ('missing','stale','wrong-episode','unstable','valid'):
            b=self.bridge();b.geometry=Mock(models={'qr-test':Mock()});b.geometry_error=None
            target={'at':time.time()*1000,'episode_id':'fire','incident_id':'incident','source':'qr-test'}
            control={'enabled':True,'session_id':'session','target':target,'mission':{'episode_id':'fire'}}
            if fault!='missing':
                b.target=FireTarget(
                    time.monotonic()-(2 if fault=='stale' else 0),
                    'other' if fault=='wrong-episode' else 'fire',1,0,1.8,.13)
                if fault!='unstable':self.confirm_grounded_target(b)
            paths=[]
            def request(path,body):
                paths.append(path);b.control_stop.set();return control
            with patch.object(b,'_load_geometry'),patch.object(b,'_update_target'), \
                 patch.object(b,'_request',side_effect=request),patch.object(response.threading,'Thread') as thread:
                b._control_loop()
            self.assertEqual(any(p.endswith('/claim') for p in paths),fault=='valid')
            if fault=='valid':
                thread.assert_called_once();self.assertIsNone(b.checkout_reason(starting=True))
                self.assertEqual(b.limits.height_m,1.)
                b.target=None
                self.assertIn('Measured QR position was lost',b.checkout_reason(starting=True))
            else:thread.assert_not_called()
            b.drone.assert_not_called()

    def test_adaptive_qr_stable_bearing_can_claim_but_never_supplies_unscaled_orbit_pose(self):
        for stable in (False,True):
            b=self.bridge();b.adaptive_qr=True;b.qr_scale_session='session';b.qr_scale_episode='fire'
            b.geometry=Mock(models={'qr-test':Mock()});b.geometry_error=None
            b.bearing_target=FireTarget(time.monotonic(),'fire',.7,0,.7,0.,position_source='qr-bearing-only')
            if stable:
                for offset in (-1.,-.75,-.5,-.25,0.):
                    b.ground_target_lock.observe(replace(b.bearing_target,at=b.bearing_target.at+offset),0.)
            target={'at':time.time()*1000,'episode_id':'fire','incident_id':'incident','source':'qr-test'}
            control={'enabled':True,'session_id':'session','target':target,'mission':{'episode_id':'fire'}}
            paths=[]
            def request(path,body):
                paths.append(path);b.control_stop.set();return control
            with patch.object(b,'_load_geometry'),patch.object(b,'_update_target'), \
                 patch.object(b,'_request',side_effect=request),patch.object(response.threading,'Thread') as thread:
                b._control_loop()
            self.assertEqual(any(p.endswith('/claim') for p in paths),stable)
            if stable:
                thread.assert_called_once();self.assertIsNone(b.checkout_reason(starting=True))
                with patch.object(b,'_preset_vehicle',return_value=object()):
                    self.assertIsNone(b._sample_fire()[1])
                b.bearing_target=None
                self.assertIn('lost before takeoff',b.checkout_reason(starting=True))
            else:thread.assert_not_called()
            self.assertIsNone(b.target);self.assertIsNone(b.target_vertical_anchor)
            b.drone.assert_not_called()
    def test_rectangles_follow_the_current_fire_and_clear_when_stale(self):
        b=self.bridge();observation={'source':'yolo','bbox':[.2,.3,.4,.6],'confidence':.9,'at':time.time()*1000}
        b.control={'observed_target':observation};b._detect_step(None,0)
        self.assertEqual(b.overlay[0]['bbox'],observation['bbox'])
        observation['at']-=3000;b._detect_step(None,0);self.assertEqual(b.overlay,[])

    def test_preview_tilts_camera_without_calibration_or_takeoff_and_rejects_unsafe_state(self):
        b=self.bridge()
        control={'enabled':False,'camera':{'id':'preview-one','at':time.time()*1000,
                 'pitch_deg':-45,'receiver_id':b.receiver_id}}
        with patch.object(response.gimbal,'set_target',return_value='camera-only') as tilt:
            b._preview_camera(control);b._preview_camera(control)
        tilt.assert_called_once();self.assertEqual(tilt.call_args.kwargs['pitch'],-45)
        b.drone.assert_called_once_with('camera-only');self.assertFalse(b.takeoff_used)
        for fault in ('enabled','flying','stale','receiver'):
            b=self.bridge();c={**control,'camera':{**control['camera'],'receiver_id':b.receiver_id}}
            if fault=='enabled':c['enabled']=True
            if fault=='flying':b.telemetry['state']='flying'
            if fault=='stale':c['camera']['at']-=10000
            if fault=='receiver':c['camera']['receiver_id']='old-receiver'
            b._preview_camera(c);b.drone.assert_not_called()

    def test_fifteen_degree_raise_from_down_70_sends_only_gimbal_command(self):
        b=self.bridge()
        command={'enabled':False,'camera':{'id':'raise-fifteen','at':time.time()*1000,
                 'pitch_deg':-55,'receiver_id':b.receiver_id}}
        with patch.object(response.gimbal,'set_target',return_value='camera-only') as tilt:
            b._preview_camera(command)
        self.assertEqual(tilt.call_args.kwargs['pitch'],-55)
        b.drone.assert_called_once_with('camera-only')
        self.assertFalse(b.takeoff_used)

    def test_low_battery_camera_preview_keeps_grounded_guards_and_flight_battery_limit(self):
        b=self.bridge();b.telemetry['battery_pct']=21
        command={'enabled':False,'camera':{'id':'shallow-preview','at':time.time()*1000,
                 'pitch_deg':-30,'receiver_id':b.receiver_id}}
        with patch.object(response.gimbal,'set_target',return_value='camera-only') as tilt:
            b._preview_camera(command)
        self.assertEqual(tilt.call_args.kwargs['pitch'],-30)
        b.drone.assert_called_once_with('camera-only')
        self.assertFalse(b.takeoff_used)
        self.assertIn('40%',response.HoverCheckout.checkout_reason(b,starting=True))
        for fault in ('airborne','moving','stale','tilted'):
            b=self.bridge();b.telemetry['battery_pct']=21
            if fault=='airborne':b.telemetry['state']='hovering'
            if fault=='moving':b.telemetry['ground_speed_mps']=.15
            if fault=='stale':b.sensor_ages.ages['altitude']-=3
            if fault=='tilted':b.telemetry['attitude_deg']['pitch']=30
            self.assertIsNotNone(response.HoverCheckout.checkout_reason(b,camera_only=True))


if __name__=='__main__':unittest.main()
