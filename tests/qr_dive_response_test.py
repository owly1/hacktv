"""Exercise actual circle/search orchestration with measured fake aircraft feedback; no SDK/radio."""
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace
import unittest
sys.path.insert(0,str(Path(__file__).parents[1]/'bridge'))
from qr_dive_response import CircleSearch,SearchHandover,combined_response_class
from qr_orbit_core import Limits,Vehicle
from dive_surveillance_test import World


class Base:
    """Supply the existing QR worker's control/neutralization seams without an aircraft."""
    def __init__(self,args,publisher):
        """Keep event order observable and require exact browser permission throughout."""
        self.running=True;self.abort_flight=threading.Event();self.takeoff_used=True
        self.publisher=publisher;self.limits=Limits();self.calls=[];self.orbits=0;self.permission=True
        self.land_confirmed=False;self.telemetry={};self.target=SimpleNamespace(at=time.monotonic()-10)
        self.orbit_target=self.target;self.camera_aim_sample=self.target
    def checkout_reason_control(self):
        """Represent the independent original QR browser lease."""
        return not self.permission
    def _request_landing(self,force=False):
        """Latch landing without sending any physical command."""
        self.calls.append('landing');self.abort_flight.set()
    def _preset_vehicle(self):
        """Return fresh measured fake vehicle evidence for request-time gates."""
        return Vehicle(time.monotonic(),True,'flying',80,1.,.5,0.,True)
    def _sample_fire(self):
        """Preserve the original flight permission check before considering D."""
        if self.checkout_reason_control():raise InterruptedError('QR flight lease expired')
        return self._preset_vehicle(),self.target
    def report(self,*args):
        """Record progress without a real publisher."""
        self.calls.append(args[0])
    def _after_hover(self):
        """Emulate the orbit's finally cleanup and resumed-target acquisition."""
        self.orbits+=1;self.calls.append('circle')
        if self.orbits==1:
            self.dive.command={'id':'command-one','params':{'target_altitude_m':.4,'sweep_deg':360}}
            self.dive.busy.set();self.dive.launch(self.dive.command)
            try:self._sample_fire()
            finally:self.calls.extend(['neutral','stop_piloting'])
        else:
            assert self.dive.phase=='circling'
            assert self.orbit_target is None
            assert self._sample_fire()[1] is None,'pre-search geometry must not restart movement'
            self.calls.append('reacquire');self.running=False


class CombinedTests(unittest.TestCase):
    def setup_world(self,fault=None):
        """Connect the real handover and full measured maneuver to an independently refreshed fake backend."""
        w=World(fault);b=combined_response_class(Base)(None,w.bridge.publisher)
        b.camera_paused.set()
        c=CircleSearch(b,driver=w,backend=w,clock=lambda:w.time,sleep=w.advance,wall=lambda:1000+w.time)
        b.dive=c;w.controller=c
        return w,b,c

    def test_circle_neutral_search_all_views_return_then_reacquire_before_resuming(self):
        w,b,c=self.setup_world();b._after_hover()
        self.assertEqual(b.orbits,2);self.assertEqual(w.acks[-1]['status'],'done')
        self.assertEqual(w.lands,0);self.assertFalse(b.abort_flight.is_set())
        self.assertAlmostEqual(w.sample['altitude_m'],1.2)
        self.assertEqual(len([yaw for _,yaw in w.moves if yaw]),8)
        self.assertEqual(b.calls[:3],['circle','neutral','stop_piloting'])
        self.assertEqual(b.calls[-2:],['circle','reacquire']);self.assertFalse(b.camera_pause.is_set())

    def test_failed_search_never_resumes_circle(self):
        for fault in ('land','no-inference','stale-sensor','ascent','disconnect'):
            with self.subTest(fault=fault):
                w,b,c=self.setup_world(fault)
                with self.assertRaises((InterruptedError,RuntimeError)):b._after_hover()
                self.assertEqual(b.orbits,1);self.assertTrue(b.abort_flight.is_set())
                self.assertNotEqual(w.acks[-1]['status'],'done')

    def test_original_qr_permission_is_required_even_with_fresh_search_permission(self):
        w,b,c=self.setup_world();b.permission=False;c.control={'authorized':True};c.control_at=w.time
        with self.assertRaisesRegex(InterruptedError,'Original BOSCO'):c.check()
        self.assertEqual(w.moves,[])

    def test_d_queues_without_spawning_or_moving_and_contour_stays_unavailable(self):
        w,b,c=self.setup_world();c.launch({'id':'queued'})
        self.assertTrue(c.requested.is_set());self.assertEqual(w.moves,[])
        self.assertIn('separate runtime',b._contour_reason())

    def test_camera_release_timeout_requests_landing_before_any_search_motion(self):
        w,b,c=self.setup_world();b.camera_paused.clear();c.command={'id':'command-one','params':{}};c.busy.set()
        with self.assertRaisesRegex(TimeoutError,'release ownership'):c.execute_handover()
        self.assertEqual(w.moves,[]);self.assertTrue(b.abort_flight.is_set())


if __name__=='__main__':unittest.main()
