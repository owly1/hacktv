"""New-mode integration gates with mocked aircraft; skip when Olympe is absent."""
import importlib.util
import math
from pathlib import Path
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parents[1]/'bridge'))
HAS_SDK = importlib.util.find_spec('olympe') is not None
if HAS_SDK:
    import fire_response as response
    from fire_contour import GPSFix, geographic_offset
    from fire_detection import parse_marker, TINY_FIRE_MARKER_PAYLOAD
    from fire_tracking import FireTarget
    from fire_response_sdk_test import ResponseTests


@unittest.skipUnless(HAS_SDK, 'Requires Pi SDK; aircraft is mocked')
class ContourResponseTests(unittest.TestCase):
    """Verify separate dispatch, exact identity, immutable anchor and GPS-specific gates."""

    def setUp(self):
        """Prevent every radio factory from opening a real connection."""
        for factory in ('Anafi', 'Drone', 'SkyController3'):
            guard = patch('anafi_bridge.olympe.'+factory, side_effect=AssertionError('No radio in tests'))
            guard.start()
            self.addCleanup(guard.stop)

    def bridge(self):
        """Prepare a stable measured Tiny marker and fresh accurate GPS on a grounded mock."""
        b = ResponseTests.bridge(self)
        b.geometry = SimpleNamespace(models={'qr-test': Mock()}, errors={}, offset=(.08, 0, 0))
        b.geometry_error = None
        b.adaptive_qr = True
        b._search_bounds = Mock(return_value=(-85.,85.))
        b.contour_launch = (43.78,-79.19)
        b.contour_search_id = 'search-one'
        b.flight_seconds = None
        b.contour_initial_yaw = math.pi/2
        b.target = FireTarget(time.monotonic(), 'tiny-fire', 1., 0., .3, .18, 'measured-qr-3d')
        ResponseTests.confirm_grounded_target(self, b)
        b.contour_gps = SimpleNamespace(snapshot=lambda:GPSFix(time.monotonic(), 43.78, -79.19, .3, True))
        details = parse_marker(TINY_FIRE_MARKER_PAYLOAD)
        target = {'source': 'qr-test', 'qr_text': TINY_FIRE_MARKER_PAYLOAD, 'episode_id': 'tiny-fire',
                  'incident_id': 'tiny-incident', 'at': time.time()*1000}
        b.control = {'enabled': True, 'session_id': 'contour-session', 'mode': 'contour', 'target': target,
                     'mission': {'mode': 'contour', 'episode_id': 'tiny-fire', 'qr_text': TINY_FIRE_MARKER_PAYLOAD,
                                 'contour': {'forecast_minutes': 5, 'started_at': time.time()*1000, 'details': details}}}
        b.control['search']={'id':'search-one','receiver_id':b.receiver_id,'height_m':1}
        b.control_at = time.monotonic()
        return b

    def test_acquired_plan_uses_measured_marker_and_heading_then_ignores_visual_loss(self):
        """Freeze the initial general area while preserving actual GPS/session requirements."""
        b = self.bridge()
        plan = b._build_contour_plan(b.control)
        self.assertEqual(plan.anchor, geographic_offset((43.78, -79.19), 0., 1.))
        b.contour_plan = plan
        b.takeoff_used = True
        b.response_mode = 'contour'
        b.claimed_session = 'contour-session'
        b.episode = 'tiny-fire'
        b.target = None
        b.control['target'] = None
        self.assertIsNone(b.checkout_reason(starting=True))
        b._update_target()
        self.assertIs(b.contour_plan, plan)
        self.assertIsNone(b.target)
        b.drone.assert_not_called()

    def test_takeoff_search_claim_needs_no_qr_and_starts_only_one_worker(self):
        """The control loop claims search and can take off before any incident or detection exists."""
        b=self.bridge();b.control['mission']=None;b.control['target']=None
        unclaimed={**b.control,'search':None}
        claimed={**b.control}
        requests=[]
        def request(path,body):
            """Return a ready session then its idempotent search ownership without contacting a server."""
            requests.append((path,body))
            b.control_stop.set()
            return claimed if path.endswith('/claim') else unclaimed
        with patch.object(b,'_request',side_effect=request),patch.object(b,'_load_geometry'), \
             patch.object(b,'_update_target'),patch.object(response.threading,'Thread') as thread:
            b._control_loop()
            b._claim_contour_search(claimed)
        status=requests[0][1]
        self.assertTrue(status['airborne_search_supported'])
        self.assertEqual(requests[1][1]['stage'],'search')
        thread.assert_called_once()
        self.assertTrue(b.takeoff_used)
        self.assertIsNone(b.contour_plan);self.assertIsNone(b.target)
        self.assertIsNone(b.flight_seconds)
        self.assertEqual(b.contour_launch,(43.78,-79.19))
        self.assertIsNone(b.checkout_reason(starting=True))
        b.drone.assert_not_called()

    def test_search_land_wins_before_worker_start(self):
        """A LAND arriving while the claim is in transit must prevent the takeoff worker."""
        b=self.bridge();b.control['mission']=None;b.control['target']=None
        def claim(*args):
            """Simulate an operator LAND just before a successful claim reply."""
            b.abort_flight.set()
            return b.control
        with patch.object(b,'_request',side_effect=claim),patch.object(response.threading,'Thread') as thread:
            b._claim_contour_search(b.control)
        thread.assert_not_called();self.assertFalse(b.takeoff_used)

    def test_airborne_anchor_uses_current_position_but_preserves_the_launch_origin(self):
        """Searching may move the aircraft; the launch geofence must never be reset at detection."""
        b=self.bridge();position=geographic_offset(b.contour_launch,.8,.2)
        b.contour_gps=SimpleNamespace(snapshot=lambda:GPSFix(time.monotonic(),*position,.3,True))
        plan=b._build_contour_plan(b.control)
        self.assertEqual(plan.launch,(43.78,-79.19))
        self.assertEqual(plan.anchor,geographic_offset(position,0.,1.))

    def test_tiny_only_search_and_old_frames_never_trigger_acquisition(self):
        """Reject Alpha, optical flow, stale decodes and pre-hold metric samples while airborne."""
        from fire_detection import FIRE_MARKER_PAYLOAD
        b=self.bridge();target={**b.control['target'],'qr_tracking':'decoded'}
        for text,method,age,expected in ((TINY_FIRE_MARKER_PAYLOAD,'decoded',0,True),
                (FIRE_MARKER_PAYLOAD,'decoded',0,False),
                (TINY_FIRE_MARKER_PAYLOAD,'optical-flow',0,False),
                (TINY_FIRE_MARKER_PAYLOAD,'decoded',2,False)):
            b.control['observed_target']={**target,'qr_text':text,'qr_tracking':method,'at':(time.time()-age)*1000}
            self.assertEqual(b._tiny_seen(),expected)
        b.control['observed_target']=target
        b.claimed_session=b.control['session_id'];b.contour_hold_since=time.monotonic()
        with patch.object(b,'_request') as request:
            self.assertIsNone(b._acquire_contour_plan())
        request.assert_not_called()

    def test_old_status_reply_cannot_erase_fire_claim_but_disabled_reply_still_lands(self):
        """Exercise the two-thread HTTP race without hiding a genuine operator disable."""
        for disabled in (False,True):
            b=self.bridge();claimed={**b.control};old={**claimed,'mission':None,'target':None}
            b.control=old;b.takeoff_used=True;b.response_mode='contour'
            b.claimed_session=old['session_id'];b.telemetry.update(state='hovering',altitude_m=1.)
            def request(path,body):
                """Commit the newer worker claim while an older status snapshot is in transit."""
                b.contour_plan=SimpleNamespace(started_at=claimed['mission']['contour']['started_at'])
                b.contour_claim_at=time.monotonic();b.control=claimed;b.control_stop.set()
                return {**old,'enabled':False,'session_id':None} if disabled else old
            with patch.object(b,'_request',side_effect=request),patch.object(b,'_load_geometry'), \
                 patch.object(b,'_update_target'),patch.object(b,'_request_landing') as land:
                b._control_loop()
            if disabled:
                self.assertFalse(b.control['enabled']);land.assert_called_once()
            else:
                self.assertIs(b.control['mission'],claimed['mission']);land.assert_not_called()

    def test_search_then_contour_reuses_the_same_driver_and_one_metre_target(self):
        """Only the search returns an anchored plan; circle remains independently dispatched."""
        b=self.bridge();plan=object();b.contour_plan=None
        with patch.object(response,'run_airborne_search',return_value=plan) as search, \
             patch.object(response,'run_contour') as contour,patch.object(response,'orbit_fire') as circle:
            b._after_hover()
        search.assert_called_once();contour.assert_called_once();circle.assert_not_called()
        self.assertIs(search.call_args.args[0],b.driver)
        self.assertIs(contour.call_args.args[0],b.driver)
        self.assertEqual(search.call_args.args[1].height_m,1.)
        self.assertIs(contour.call_args.args[2],plan)
        self.assertIsNone(contour.call_args.kwargs['flight_seconds'])

    def test_unscaled_bearing_and_changed_scenario_cannot_build_a_plan(self):
        """Do not convert adaptive bearing guesses or forged scenario fields into GPS anchors."""
        for fault in ('bearing', 'details', 'horizon', 'missing-gps', 'stale-epoch'):
            b = self.bridge()
            if fault == 'bearing':b.target = response.replace(b.target, position_source='qr-bearing-only')
            if fault == 'details':b.control['mission']['contour']['details']['spread_m_per_min'] = 500
            if fault == 'horizon':b.control['mission']['contour']['forecast_minutes'] = 20
            if fault == 'missing-gps':b.contour_gps = None
            if fault == 'stale-epoch':b.control['mission']['contour']['started_at'] -= 20000
            with self.subTest(fault=fault), self.assertRaises(ValueError):b._build_contour_plan(b.control)
            b.drone.assert_not_called()

    def test_contour_dispatch_preserves_original_circle_dispatch(self):
        """The new controller is opt-in; explicit or omitted circle keeps orbit_fire."""
        for mode in (None, 'circle', 'contour'):
            b = self.bridge()
            b.control['mode'] = mode
            b.contour_plan = object()
            with patch.object(response, 'run_contour') as contour, patch.object(response, 'orbit_fire') as circle:
                b._after_hover()
            self.assertEqual(contour.called, mode == 'contour')
            self.assertEqual(circle.called, mode != 'contour')
            if mode == 'contour':
                self.assertIsNone(contour.call_args.args[1].lap_seconds)
                self.assertEqual(contour.call_args.args[1].height_m, 1.)

    def test_contour_reports_verified_measured_scale_without_changing_circle_adaptive_scale(self):
        """Dashboard calibration labels must describe the scale actually used by this mode."""
        b = self.bridge()
        b.geometry_snapshot = {'qr_black_square_side_m': .18, 'rms_px': .3, 'camera_offset_body_m': [.08, 0, 0],
                               'image_size': [1280, 720], 'qr_pose_verified': True}
        self.assertEqual(b._calibration_status()['qr_side_m'], .18)
        b.control['mode'] = 'circle'
        self.assertIsNone(b._calibration_status()['qr_side_m'])

    def test_gps_subscription_failure_only_blocks_new_mode(self):
        """Optional GPS listener errors cannot break a successful original receiver connection."""
        b = self.bridge()
        with patch.object(response.QRAutoPreset, '_connect', return_value=True), \
             patch.object(response, 'ContourGPS', side_effect=RuntimeError('unsupported')):
            self.assertTrue(b._connect())
        self.assertIn('subscription unavailable', b._contour_reason())
        b.control['mode'] = 'circle'
        self.assertIsNone(b.checkout_reason())

    def test_already_fixed_aircraft_still_requires_a_new_precise_location_event(self):
        """The edge-triggered fix flag may be cached; location receipt time never is."""
        drone = Mock()
        drone.get_state.return_value = {'fixed': 1}
        with patch.object(response.olympe.EventListener, '__init__', return_value=None):
            listener = response.ContourGPS(drone)
        self.assertTrue(listener.fixed)
        self.assertIsNone(listener.snapshot())
        listener.location_changed(SimpleNamespace(args={'latitude': 43.78, 'longitude': -79.19,
                                                        'latitude_accuracy': .2, 'longitude_accuracy': .2}), None)
        self.assertIsNone(response.gps_reason(listener.snapshot(), time.monotonic()))
        listener.fix_changed(SimpleNamespace(args={'fixed': 0}), None)
        self.assertIsNotNone(response.gps_reason(listener.snapshot(), time.monotonic()))


if __name__ == '__main__':
    unittest.main()
