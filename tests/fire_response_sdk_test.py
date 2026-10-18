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
if HAS_SDK: import fire_response as response


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
            b=self.bridge();b.geometry=Mock();b.geometry_error=None
            target={'at':time.time()*1000,'episode_id':'fire','incident_id':'incident'}
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

    def test_lost_fire_between_claim_and_takeoff_blocks_motor_command(self):
        b=self.bridge();b.geometry=Mock();b.geometry_error=None;b.takeoff_used=True
        b.control={'enabled':True,'session_id':'session','target':None}
        b.claimed_session='session';b.episode='fire';b.control_at=time.monotonic()
        self.assertIn('lost before takeoff',b.checkout_reason(starting=True))
        b.drone.assert_not_called()
    def test_rectangles_follow_the_current_fire_and_clear_when_stale(self):
        b=self.bridge();observation={'source':'yolo','bbox':[.2,.3,.4,.6],'confidence':.9,'at':time.time()*1000}
        b.control={'observed_target':observation};b._detect_step(None,0)
        self.assertEqual(b.overlay[0]['bbox'],observation['bbox'])
        observation['at']-=3000;b._detect_step(None,0);self.assertEqual(b.overlay,[])


if __name__=='__main__':unittest.main()
