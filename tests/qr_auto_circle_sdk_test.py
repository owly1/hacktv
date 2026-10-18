"""Fake-aircraft adapter tests. Never create an Olympe Drone or open its radio."""
import importlib.util
from pathlib import Path
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).parents[1]/'bridge'))
HAS_SDK = importlib.util.find_spec('olympe') is not None
TEXT = 'EW1:Alpha|120|X|35|M|30|60|31|18|18'
if HAS_SDK:
    import qr_auto_circle as auto
    from qr_orbit_core import Marker
    from qr_circle_core import circle


@unittest.skipUnless(HAS_SDK, 'Run in the Pi Olympe SDK; aircraft is mocked')
class AutoCircleTests(unittest.TestCase):
    def setUp(self):
        # An accidental real SDK construction fails even when running on the Pi.
        self.radio = patch('anafi_bridge.olympe.Drone', side_effect=AssertionError('no radio access in tests'))
        self.radio.start()
        self.addCleanup(self.radio.stop)

    def bridge(self, execute=True):
        args = SimpleNamespace(ip=None, controller='direct', home_lat=0, home_lon=0,
            execute=execute, terminal_control=True, hover_seconds=1,
            preflight_file='test-only.json')
        b = auto.QRAutoCircle(args, Mock(), Mock(), SimpleNamespace(offset=(0,0,0)), TEXT)
        b.connected = True
        b.drone = Mock(connected=True)
        b.sensor_ages = SimpleNamespace(ages={key:time.monotonic() for key in ('altitude','speed','attitude','camera')})
        b.last_frame_time = time.time()
        b.telemetry = {'state':'landed','battery_pct':70,'altitude_m':0,
            'ground_speed_mps':0,'attitude_deg':{'roll':0,'pitch':0}}
        return b

    def scan(self, b, at):
        for i in range(6): b.scan.observe(TEXT,at-1+i*.2,at-1+i*.2)

    def test_no_takeoff_before_backend_acceptance_then_exactly_one_worker(self):
        b = self.bridge(); now=time.monotonic(); self.scan(b, now)
        with patch.object(auto, 'read_preflight'), patch.object(auto.threading, 'Thread') as worker:
            b._maybe_start(); worker.assert_not_called()
            b.scan.acknowledge({'accepted':True,'id':'accepted-incident'},now)
            b._maybe_start(); b._maybe_start()
            worker.assert_called_once_with(target=b._automatic_mission)
            self.assertTrue(b.takeoff_used)
            b.drone.assert_not_called()

    def test_read_only_missing_preflight_stale_scan_or_cancel_cannot_start(self):
        for case in ('read-only','preflight','stale','cancel'):
            b = self.bridge(execute=case!='read-only'); now=time.monotonic(); self.scan(b,now)
            b.scan.acknowledge({'accepted':True,'id':'x'},now)
            if case=='stale': b.scan.last_at-=2
            if case=='cancel': b._request_landing(force=False)
            with patch.object(auto, 'read_preflight', side_effect=ValueError('physical checks required') if case=='preflight' else None), patch.object(auto.threading,'Thread') as worker:
                b._maybe_start(); worker.assert_not_called(); b.drone.assert_not_called()

    def flight(self, fail=None):
        b=self.bridge(); now=[100.]; moves=[]; lands=[]; sends=[]
        b.scan.used=True; b.scan.last_at=100.; b.started_at=100.; b.takeoff_used=True
        def advance(seconds):
            now[0]+=seconds
            b.sensor_ages.ages={key:now[0] for key in ('altitude','speed','attitude','camera')}
            b.last_frame_time=time.time()
            b.telemetry.update(state='hovering',altitude_m=1,attitude_deg={'roll':0,'pitch':0})
            b.marker=Marker(now[0]-.001,TEXT,1,0,1,0,0)
        b.sensor_ages.ages={key:100. for key in ('altitude','speed','attitude','camera')}
        def receive(message):
            sends.append(str(message))
            return SimpleNamespace(done=lambda:True,success=lambda:True,cancel=lambda:None)
        aircraft=b.drone=Mock(connected=True,side_effect=receive)
        outer=self
        class Driver:
            def request_land(self): lands.append('request')
            def land(self):
                outer.assertIs(b.drone,aircraft)
                lands.append('confirmed'); return True
            def move(self,offset,speed,check):
                outer.assertIs(b.drone,aircraft)
                moves.append(offset); advance(.5)
                if fail=='lost-marker': b.marker=None
                if fail=='cancel': b.abort_flight.set()
                if fail=='move-error': raise RuntimeError('move rejected')
                check()
        b.driver=Driver()
        def fly(*args,**kwargs): return circle(*args,**kwargs,clock=lambda:now[0],sleep=advance)
        with patch.object(auto.time,'monotonic',side_effect=lambda:now[0]), \
             patch.object(auto.time,'sleep',side_effect=advance), patch.object(auto,'circle',side_effect=fly):
            b._hover()
        return b,moves,lands,sends

    def test_takeoff_24_measured_segments_and_confirmed_land_on_same_sdk_object(self):
        b,moves,lands,sends=self.flight()
        self.assertEqual(len(sends),1); self.assertIn('TakeOff',sends[0])
        self.assertEqual(len(moves),24); self.assertEqual(lands,['confirmed'])
        self.assertTrue(b.land_confirmed); self.assertFalse(b.running)

    def test_marker_loss_cancel_and_rejected_move_always_land(self):
        for case in ('lost-marker','cancel','move-error'):
            with self.subTest(case=case):
                b,moves,lands,sends=self.flight(case)
                self.assertEqual(len(moves),1); self.assertEqual(lands[-1],'confirmed')
                self.assertTrue(b.land_confirmed)

    def test_camera_uses_measured_pitch_and_disabled_mode_sends_nothing(self):
        b=self.bridge(); now=time.monotonic()
        b.marker=Marker(now,TEXT,1,0,1,0,0)
        def receive(message):
            b.camera_stop.set()
            self.assertAlmostEqual(message.command_args['pitch'],-45.)
            return Mock()
        b.drone=Mock(connected=True,side_effect=receive)
        b._camera_loop()
        b.drone.assert_called_once()
        self.assertFalse(b.abort_flight.is_set())
        b=self.bridge(execute=False); b._camera_loop(); b.drone.assert_not_called()

    def test_real_qr_image_creates_fire_before_automatic_takeoff_worker(self):
        import cv2
        from fire_detection import FireDetector
        b = self.bridge()
        b.detector = FireDetector('unused.pt', .5, use_yolo=False)
        b.pose = Mock(offset=(0,0,0))
        b.pose.estimate.side_effect = ValueError('ground pose not yet measurable')
        image = cv2.imread(str(Path(__file__).parents[1]/'dist/test-marker.png'))
        clock = [100.]
        with patch.object(auto.time,'monotonic',side_effect=lambda:clock[0]), \
             patch.object(auto.time,'time',side_effect=lambda:1000+clock[0]), \
             patch.object(auto,'read_preflight'), patch.object(auto.threading,'Thread') as worker:
            for i in range(6):
                clock[0] = 100+i*.2
                b.sensor_ages.ages={k:clock[0] for k in ('altitude','speed','attitude','camera')}
                b.last_frame_time=1000+clock[0]
                b._detect_step(image,1000+clock[0])
            worker.assert_not_called()
            self.assertTrue(b.incident_pending)
            payload=b.incident_queue.get_nowait()
            self.assertEqual(payload['source'],'qr-test')
            self.assertEqual(payload['label'],'fire')
            self.assertEqual(payload['details']['orbit_radius_m'],1.)
            self.assertIsNone(payload['fire']['latitude'])
            b.incident_queue.put_nowait(payload)
            # The worker exits on its next queue check. The accepted response
            # drives the real _maybe_start once while Thread itself is mocked.
            def receive(payload):
                return {'accepted':True,'id':'real-camera-test'}
            b.publisher.detection.side_effect=receive
            original_get=b.incident_queue.get
            def get_once(**kwargs):
                if b.incident_queue.empty():
                    b.running=False
                    raise auto.queue.Empty
                return original_get(**kwargs)
            with patch.object(b.incident_queue,'get',side_effect=get_once): b._publish_incidents()
            b.publisher.detection.assert_called_once()
            worker.assert_called_once_with(target=b._automatic_mission)
            b.drone.assert_not_called()

    def test_camera_rejection_aborts_and_requests_landing(self):
        b=self.bridge(); b.hold_connection=True; b.driver=Mock()
        b.drone.return_value=SimpleNamespace(done=lambda:True,success=lambda:False)
        with patch.object(b.camera_stop,'wait'):
            b._camera_loop()
        self.assertTrue(b.abort_flight.is_set())
        b.driver.request_land.assert_called_once()

    def test_unverified_live_configuration_stops_before_sdk_construction(self):
        with patch.object(sys,'argv',['qr_auto_circle.py','--execute','--backend','http://localhost:8787']), \
             patch.object(sys.stdin,'isatty',return_value=True), patch.dict(auto.os.environ,{'INGEST_TOKEN':'test-only'}), \
             patch.object(auto,'QRAutoCircle') as constructor:
            with self.assertRaises(SystemExit): auto.main()
            constructor.assert_not_called()


if __name__ == '__main__': unittest.main()
