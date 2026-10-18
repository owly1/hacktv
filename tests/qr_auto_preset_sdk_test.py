"""Automatic demo tests with mocked aircraft; never open a drone connection."""
import importlib.util
from pathlib import Path
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0,str(Path(__file__).parents[1]/'bridge'))
HAS_SDK=importlib.util.find_spec('olympe') is not None
TEXT='EW1:Alpha|120|X|35|M|30|60|31|18|18'
if HAS_SDK:
    import qr_auto_circle as auto


@unittest.skipUnless(HAS_SDK,'Run in the Pi SDK; all aircraft objects are mocked')
class AutoPresetTests(unittest.TestCase):
    def setUp(self):
        """Prepare isolated SDK/test fixtures with real aircraft constructors guarded."""
        for factory in ('Anafi','Drone','SkyController3'):
            guard=patch('anafi_bridge.olympe.'+factory,side_effect=AssertionError('no radio in tests'))
            guard.start();self.addCleanup(guard.stop)

    def bridge(self,execute=True):
        """Construct the tested runtime with mock aircraft and publisher dependencies."""
        args=SimpleNamespace(ip=None,controller='direct',home_lat=0,home_lon=0,
                             execute=execute,terminal_control=True,hover_seconds=1)
        b=auto.QRAutoPreset(args,Mock(),Mock(),TEXT)
        b.connected=True;b.drone=Mock(connected=True)
        b.sensor_ages=SimpleNamespace(ages={k:time.monotonic() for k in ('altitude','speed','attitude')})
        b.last_frame_time=time.time()
        b.telemetry={'state':'landed','battery_pct':70,'altitude_m':0,
                     'ground_speed_mps':0,'attitude_deg':{'roll':0,'pitch':0}}
        return b

    def scan(self,b,now,text=TEXT):
        """Supply selected-QR frames with controlled times to exercise recognition gating."""
        for i in range(6):b.scan.observe(text,now-1+i*.2,now-1+i*.2)

    def test_incident_then_exactly_one_automatic_mission_without_calibration(self):
        """Verify incident then exactly one automatic mission without calibration."""
        b=self.bridge();now=time.monotonic();self.scan(b,now)
        self.assertIsNone(b.pose)
        with patch.object(auto,'read_preflight',side_effect=AssertionError('preset does not use pose preflight')), \
             patch.object(auto.threading,'Thread') as worker:
            b._maybe_start();worker.assert_not_called()
            b.scan.acknowledge({'accepted':True,'id':'incident'},now)
            b._maybe_start();b._maybe_start()
            worker.assert_called_once_with(target=b._automatic_mission)
            self.assertTrue(b.takeoff_used);self.assertTrue(b.hold_connection);b.drone.assert_not_called()

    def test_wrong_qr_stale_data_cancellation_and_read_only_never_start(self):
        """Verify wrong qr stale data cancellation and read only never start."""
        for case in ('wrong-qr','stale-qr','stale-sensors','cancel','closed-terminal','low-battery','read-only'):
            with self.subTest(case=case):
                b=self.bridge(case!='read-only');now=time.monotonic()
                self.scan(b,now,'EW1:Other' if case=='wrong-qr' else TEXT)
                b.scan.acknowledge({'accepted':True,'id':'incident'},now)
                if case=='stale-qr':b.scan.last_at-=2
                if case=='stale-sensors':b.sensor_ages.ages['speed']-=3
                if case=='cancel':b.abort_flight.set()
                if case=='closed-terminal':b.input_closed.set()
                if case=='low-battery':b.telemetry['battery_pct']=10
                with patch.object(auto.threading,'Thread') as worker:
                    b._maybe_start();worker.assert_not_called();b.drone.assert_not_called()

    def test_small_and_large_qr_create_the_same_fire_preset_without_pose(self):
        """Verify small and large qr create the same fire preset without pose."""
        import cv2
        from fire_detection import FireDetector
        original=cv2.imread(str(Path(__file__).parents[1]/'dist/test-marker.png'))
        for side in (300,800):
            b=self.bridge(False);b.detector=FireDetector('unused.pt',.5,use_yolo=False)
            image=cv2.resize(original,(side,side),interpolation=cv2.INTER_NEAREST)
            clock=[100.]
            with patch.object(auto.time,'monotonic',side_effect=lambda:clock[0]), \
                 patch.object(auto.time,'time',side_effect=lambda:1000+clock[0]):
                for i in range(6):
                    clock[0]=100+i*.2;b._detect_step(image,1000+clock[0])
            payload=b.incident_queue.get_nowait()
            self.assertEqual(payload['source'],'qr-test');self.assertEqual(payload['label'],'fire')
            self.assertEqual(payload['details']['flight_protocol'],'qr-auto-preset')
            self.assertEqual(payload['details']['path_reference'],'launch-heading')
            self.assertIsNone(b.pose);self.assertIsNone(b.marker);b.drone.assert_not_called()

    def fly(self,failure=None):
        """Exercise flight logic against fake moves and a controlled clock, without aircraft access."""
        b=self.bridge();now=[100.];moves=[];lands=[];sends=[]
        b.scan.used=True;b.scan.last_at=100.;b.started_at=100.;b.takeoff_used=True
        def advance(seconds):
            """Advance the fake clock and refresh test sensor timestamps."""
            now[0]+=seconds
            b.sensor_ages.ages={k:now[0] for k in ('altitude','speed','attitude')}
            b.last_frame_time=time.time()
            b.telemetry.update(state='hovering',altitude_m=1)
            b.marker=None  # QR is intentionally absent throughout flight.
        b.sensor_ages.ages={k:100. for k in ('altitude','speed','attitude')}
        def receive(message):
            """Supply a controlled SDK state/frame update to the tested flight runtime."""
            sends.append(str(message));return SimpleNamespace(done=lambda:True,success=lambda:True,cancel=lambda:None)
        aircraft=b.drone=Mock(connected=True,side_effect=receive)
        outer=self
        class Driver:
            def request_land(self):"""Record a nonblocking fake landing request for cancellation assertions."""; lands.append('requested')
            def land(self):
                """Record a fake landing attempt and return the fixture confirmation result."""
                outer.assertIs(b.drone,aircraft);lands.append('confirmed');return True
            def move(self,offset,speed,check):
                """Record the requested relative move and simulate its result or injected failure."""
                outer.assertIs(b.drone,aircraft);moves.append(offset);advance(.5)
                if failure=='cancel':b.abort_flight.set()
                if failure=='stale':b.last_frame_time-=3
                if failure=='move-error':raise RuntimeError('move rejected')
                if failure is None and len(moves)==49:b.abort_flight.set()
                check()
        b.driver=Driver()
        with patch.object(auto.time,'monotonic',side_effect=lambda:now[0]),patch.object(auto.time,'sleep',side_effect=advance):
            b._hover()
        return b,moves,lands,sends

    def test_one_takeoff_repeated_laps_until_land_with_no_visible_qr(self):
        """Verify one takeoff repeated laps until land with no visible qr."""
        b,moves,lands,sends=self.fly()
        self.assertEqual(len(sends),1);self.assertIn('TakeOff',sends[0])
        self.assertEqual(len(moves),49);self.assertEqual(lands,['confirmed'])
        self.assertTrue(b.land_confirmed);self.assertFalse(b.running)

    def test_cancel_stale_video_and_move_rejection_land(self):
        """Verify cancel stale video and move rejection land."""
        for case in ('cancel','stale','move-error'):
            b,moves,lands,_=self.fly(case)
            self.assertEqual(len(moves),1);self.assertEqual(lands[-1],'confirmed')
            self.assertTrue(b.land_confirmed)

    def test_camera_aims_at_planned_centre_without_marker_measurements(self):
        """Verify camera aims at planned centre without marker measurements."""
        b=self.bridge();b.telemetry['altitude_m']=1
        self.assertEqual(b._camera_pitch(),-45)
        def receive(message):
            """Supply a controlled SDK state/frame update to the tested flight runtime."""
            self.assertEqual(message.command_args['pitch'],-45)
            b.camera_stop.set();return Mock()
        b.drone.side_effect=receive;b._camera_loop();b.drone.assert_called_once()

    def test_live_cli_selects_preset_without_calibration_or_arm_phrase(self):
        """Verify live cli selects preset without calibration or arm phrase."""
        with patch.object(sys,'argv',['qr_auto_circle.py','--preset','--execute','--backend','http://localhost:8787']), \
             patch.object(sys.stdin,'isatty',return_value=True),patch.dict(auto.os.environ,{'INGEST_TOKEN':'test-only'}), \
             patch.object(auto,'CalibratedPose',side_effect=AssertionError('no calibration')), \
             patch.object(auto,'read_preflight',side_effect=AssertionError('no marker preflight')), \
             patch.object(auto,'QRAutoPreset') as factory,patch.object(auto,'Publisher'), \
             patch.object(auto,'FireDetector'),patch.object(auto.signal,'signal'):
            auto.main();factory.assert_called_once();factory.return_value.run.assert_called_once()


if __name__=='__main__':unittest.main()
