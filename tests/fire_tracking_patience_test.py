"""Real timed path waits for valid geometry and keeps a measured target model."""
import math
import threading
import unittest

from continuous_orbit_test import FlightWorld
from continuous_orbit import Control, run_continuous_orbit
from fire_tracking import FireTarget, orbit_fire
from qr_orbit_core import Limits, Vehicle


class PatientTrackingTests(unittest.TestCase):
    def test_late_glare_recovery_acquires_without_a_fifteen_second_deadline(self):
        now=[0.]; handoffs=[]; reports=[]
        def sample():
            target=FireTarget(now[0],'fire',1.,0.,1.3,.12) if now[0]>=22 else None
            return Vehicle(now[0],True,'hovering',80,1.,0.,0.),target
        def sleep(dt):now[0]+=dt
        class Driver:
            supports_continuous_orbit=True
            def move(self,*args):raise AssertionError('No blind movement before target lock')
            def orbit_continuously(self,target,limits,check,*args,**kwargs):
                check();handoffs.append(target)
                raise InterruptedError('late measured target acquired')
        with self.assertRaisesRegex(InterruptedError,'late measured target'):
            orbit_fire(Driver(),Limits(speed_mps=.6,lap_seconds=15),sample,
                       threading.Event(),lambda *args:reports.append(args),'fire',started=0.,
                       clock=lambda:now[0],sleep=sleep,last_seen=lambda:0.)
        self.assertGreaterEqual(handoffs[0].at,22.)
        self.assertTrue(any(row[0]=='recover' for row in reports))

    def test_waiting_for_geometry_still_obeys_land_battery_and_mission_limit(self):
        for reason in ('Operator','battery','60-second'):
            with self.subTest(reason=reason):
                now=[0.]; abort=threading.Event()
                def sample():
                    battery=20 if reason=='battery' and now[0]>=21 else 80
                    return Vehicle(now[0],True,'hovering',battery,1.,0.,0.),None
                def sleep(dt):
                    now[0]+=dt
                    if reason=='Operator' and now[0]>=21:abort.set()
                class Driver:
                    supports_continuous_orbit=True
                    def orbit_continuously(self,*args,**kwargs):
                        raise AssertionError('No measured target exists')
                with self.assertRaisesRegex(InterruptedError,reason):
                    orbit_fire(Driver(),Limits(speed_mps=.6,lap_seconds=15),sample,
                               abort,lambda *args:None,'fire',started=0.,flight_seconds=60,
                               clock=lambda:now[0],sleep=sleep,last_seen=lambda:0.)
                self.assertGreater(now[0],20.)
                self.assertLess(now[0],61.)

    def test_locked_point_completes_physical_laps_through_long_visual_gap(self):
        world=FlightWorld(dropout=(2.,25.))
        def sample():
            if len(world.laps)>=3:raise InterruptedError('three physical laps completed')
            vehicle=Vehicle(world.time,True,'hovering',80,world.altitude,
                            math.hypot(world.vx,world.vy),max(abs(world.roll),abs(world.pitch)))
            return vehicle,world.target()
        class Driver:
            supports_continuous_orbit=True
            def orbit_continuously(self,target,limits,check,report,remember,**kwargs):
                run_continuous_orbit(target,limits,check,world.motion,world.command,report,
                                     remember=remember,**kwargs)
        with self.assertRaisesRegex(InterruptedError,'three physical laps'):
            orbit_fire(Driver(),world.limits,sample,threading.Event(),lambda *args:None,
                       'fixed-marker',started=0.,clock=lambda:world.time,sleep=world.sleep,
                       last_seen=lambda:world.last_visual_at,remember=world.remembered.append)
        self.assertEqual(len(world.laps),3)
        self.assertTrue(any(18.<at<24. and control!=Control() for at,control in world.commands))
        self.assertLessEqual(max(world.radii),1.2)
        self.assertGreaterEqual(min(world.radii),.8)
        self.assertEqual(world.commands[-1][1],Control())


if __name__=='__main__':unittest.main()
