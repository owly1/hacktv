"""Dashboard-driven flight decisions with mocked SDK; no radio access."""
import importlib.util
from pathlib import Path
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock,patch
sys.path.insert(0,str(Path(__file__).parents[1]/'bridge'))
HAS_SDK=importlib.util.find_spec('olympe') is not None
if HAS_SDK:
    import fire_response as response
    from fire_tracking import FireTarget


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
        b.sensor_ages=SimpleNamespace(ages={k:time.monotonic() for k in ('altitude','speed','attitude','camera')})
        return b
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
    def test_control_expiry_invalidates_airborne_sample(self):
        b=self.bridge();b.control={'enabled':True,'session_id':'session'};b.claimed_session='session'
        b.control_at=time.monotonic()-2
        b._sample_fire();self.assertTrue(b.abort_flight.is_set())

    def test_actual_multi_instance_camera_state_is_unwrapped_for_localization(self):
        b=self.bridge();b.geometry=Mock();b.geometry_error=None
        now=time.time()*1000
        b.control={'observed_target':{'at':now,'first':now-1000,'hits':6,'source':'qr-test','episode_id':'fire'}}
        camera={'roll_absolute':0,'pitch_absolute':-45,'yaw_absolute':0}
        with patch.object(b,'_state',return_value={0:camera}):b._update_target()
        b.geometry.estimate.assert_called_once();self.assertEqual(b.geometry.estimate.call_args.args[2],camera)

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
        for fault in ('missing','stale','wrong-episode','valid'):
            b=self.bridge();b.geometry=Mock(models={'qr-test':Mock()});b.geometry_error=None
            target={'at':time.time()*1000,'episode_id':'fire','incident_id':'incident','source':'qr-test'}
            control={'enabled':True,'session_id':'session','target':target,'mission':{'episode_id':'fire'}}
            if fault!='missing':
                b.target=FireTarget(
                    time.monotonic()-(2 if fault=='stale' else 0),
                    'other' if fault=='wrong-episode' else 'fire',1,0,1.8,.13)
            paths=[]
            def request(path,body):
                paths.append(path);b.control_stop.set();return control
            with patch.object(b,'_load_geometry'),patch.object(b,'_update_target'), \
                 patch.object(b,'_request',side_effect=request),patch.object(response.threading,'Thread') as thread:
                b._control_loop()
            self.assertEqual(any(p.endswith('/claim') for p in paths),fault=='valid')
            if fault=='valid':
                thread.assert_called_once();self.assertIsNone(b.checkout_reason(starting=True))
                b.target=None
                self.assertIn('Measured QR position was lost',b.checkout_reason(starting=True))
            else:thread.assert_not_called()
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
