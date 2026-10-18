"""End-to-end maneuver decisions with a fake aircraft, clock and backend; no SDK/radio."""
from datetime import datetime,timezone
import math
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock
sys.path.insert(0,str(Path(__file__).parents[1]/'bridge'))
from dive_surveillance import DiveSurveillance


class World:
    """Provide measured feedback and renew the independent control channel in virtual time."""
    def __init__(self,fault=None):
        self.time=0.;self.fault=fault;self.moves=[];self.aims=[];self.acks=[];self.lands=0
        self.sample={'connected':True,'state':'hovering','altitude_m':1.2,'battery_pct':80,
            'speed_mps':0.,'roll_deg':0.,'pitch_deg':0.,'camera_pitch_deg':-35.,'yaw_deg':0.,
            'ages':{name:0. for name in ('altitude','speed','attitude','camera','video')}}
        self.bridge=SimpleNamespace(running=True,abort_flight=threading.Event(),flight_lock=threading.Lock(),
                                    publisher=Mock(),flight_phase=None)
        self.controller=DiveSurveillance(self.bridge,self,self,clock=lambda:self.time,sleep=self.advance,wall=lambda:1000+self.time)

    def snapshot(self):
        """Return the fake aircraft's current measurement, never a commanded substitute."""
        return self.sample.copy()

    def request(self,path,body=None):
        """Renew healthy control or inject a realistic loss of permission."""
        if path.endswith('/ack'):
            self.acks.append(body);return {'acked':True}
        captured=1000+self.time-(10 if self.fault=='no-inference' else 0)
        return {'authorized':self.fault!='permission' or not self.moves,
                'stop_id':'operator-stop' if self.fault=='land' and self.moves else None,
                'person_detection':{'captured_at':datetime.fromtimestamp(captured,timezone.utc).isoformat()}}

    def advance(self,seconds):
        """Progress both virtual time and the independent control heartbeat."""
        self.time+=seconds
        if self.fault=='stale-control' and self.moves:return
        self.controller.refresh()

    def configure(self,check):
        """Acknowledge the bounded-speed setup without actual radio commands."""
        check()

    def restore(self,check):
        """Confirm final setting restoration through the same guards."""
        check()

    def move(self,*,dz,yaw,check):
        """Move the fake world, optionally under-delivering to test measured confirmation."""
        check();self.moves.append((dz,yaw))
        if self.fault!='stuck-altitude':self.sample['altitude_m']-=dz
        if self.fault!='stuck-yaw':self.sample['yaw_deg']+=math.degrees(yaw)*(.8 if self.fault=='yaw-undershoot' else 1.)
        if self.fault=='battery':self.sample['battery_pct']=39
        if self.fault=='stale-sensor':self.sample['ages']['altitude']=2
        if self.fault=='disconnect':self.sample['connected']=False
        if self.fault=='abort':self.bridge.abort_flight.set()
        if self.fault=='ascent' and dz<0:raise RuntimeError('Ascent acknowledgement failed')
        self.advance(.25)

    def settle(self,check):
        """Only accept the fake world's measured hover."""
        check()

    def aim(self,pitch,check):
        """Measure camera pitch after the requested aim."""
        check();self.aims.append(pitch);self.sample['camera_pitch_deg']=pitch;self.advance(.1)

    def land(self):
        """Record a landing request, with an explicit unconfirmed-link failure option."""
        self.lands+=1;self.sample['state']='landed';return self.fault!='disconnect'

    def run(self,params=None):
        """Execute one already-delivered, explicitly authorized fake command."""
        self.controller.busy.set()
        self.controller._execute({'id':'command-one','type':'dive-surveillance',
                                  'params':params or {'target_altitude_m':.4,'sweep_deg':360}})


class ManeuverTests(unittest.TestCase):
    def test_full_descent_all_search_views_and_measured_return(self):
        w=World();w.run()
        self.assertEqual(w.acks[-1]['status'],'done');self.assertEqual(w.lands,0)
        self.assertAlmostEqual(w.sample['altitude_m'],1.2)
        self.assertAlmostEqual(sum(turn for _,turn in w.moves),2*math.pi)
        self.assertEqual(w.aims,[-10.,-35.]);self.assertEqual(w.controller.phase,'hovering')
        self.assertTrue(all(abs(dz)<=.201 and abs(yaw)<=math.pi/4+.001 for dz,yaw in w.moves))
        self.assertFalse(w.controller.busy.is_set())

    def test_each_failure_requests_landing_and_never_reports_done(self):
        for fault in ('battery','stale-sensor','disconnect','abort','permission','land','no-inference',
                      'stuck-altitude','stuck-yaw','ascent','stale-control'):
            with self.subTest(fault=fault):
                w=World(fault);w.run()
                self.assertNotEqual(w.acks[-1]['status'],'done');self.assertEqual(w.lands,1)
                self.assertFalse(w.controller.busy.is_set())
                if fault=='disconnect':self.assertIn('UNCONFIRMED',w.acks[-1]['note'])

    def test_yaw_undershoot_is_corrected_from_measurement_before_completion(self):
        w=World('yaw-undershoot');w.run()
        self.assertEqual(w.acks[-1]['status'],'done')
        self.assertLessEqual(abs(w.sample['yaw_deg']-360),5)
        self.assertGreater(len([move for move in w.moves if move[1]]),8)

    def test_landed_moving_low_battery_and_bad_params_never_move(self):
        for changes,params in [({'state':'landed'},None),({'state':'flying'},None),({'battery_pct':39},None),
                ({'speed_mps':.2},None),({}, {'target_altitude_m':float('nan'),'sweep_deg':360}),
                ({},{'target_altitude_m':1.1,'sweep_deg':360}),({}, {'target_altitude_m':.4,'sweep_deg':720})]:
            w=World();w.sample.update(changes);w.run(params)
            self.assertEqual(w.moves,[]);self.assertEqual(w.lands,0);self.assertEqual(w.acks[-1]['status'],'failed')

    def test_existing_maneuver_lock_prevents_competing_commands(self):
        w=World();w.bridge.flight_lock.acquire();w.run()
        self.assertEqual(w.moves,[]);self.assertEqual(w.acks[-1]['status'],'failed')


if __name__=='__main__':unittest.main()
