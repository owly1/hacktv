"""Bearing-only feedback after metric rejection, using independent physical motion."""
from dataclasses import replace
import math
import unittest

from continuous_orbit_test import FlightWorld
from continuous_orbit import Bearing, Control, run_continuous_orbit


class BearingWorld(FlightWorld):
    """QR stays visible after depth fails; SDK velocity has a small world bias."""
    def target(self):
        measured=super().target()
        return measured if self.time < 2 else None

    def motion(self):
        measured=super().motion()
        return replace(measured,vx=measured.vx-.045,vy=measured.vy+.025) if self.time>2 else measured

    def sight(self):
        measured=super().target()
        length=math.sqrt(measured.forward_m**2+measured.right_m**2+measured.down_m**2)
        _,_,_,_,yaw,*_=self.historical(measured.at)
        c,s=math.cos(yaw),math.sin(yaw)
        return Bearing(measured.at,measured.episode,
            (c*measured.forward_m-s*measured.right_m)/length,
            (s*measured.forward_m+c*measured.right_m)/length)

    def run_with_bearings(self, sight=None):
        """Run only fake physics and capture diagnostics; no SDK or radio."""
        run_continuous_orbit(self.target(),self.limits,self.check,self.motion,self.command,
            lambda *args:None,diagnostic=lambda *args:self.diagnostics.append(args),
            clock=lambda:self.time,sleep=self.sleep,get_bearing=sight)


class ContinuousBearingTests(unittest.TestCase):
    def test_visible_direction_controls_drift_after_depth_rejection(self):
        errors=[]
        for corrected in (False,True):
            world=BearingWorld(stop_after_laps=None,duration=43)
            with self.assertRaisesRegex(InterruptedError,'simulation operator stop'):
                world.run_with_bearings(world.sight if corrected else None)
            errors.append(max(abs(r-1) for t,r in world.radius_samples if t>10))
            self.assertEqual(world.commands[-1][1],Control())
            if corrected:
                self.assertGreater(len([d for k,d in world.diagnostics if k=='continuous_bearing_corrected']),100)
                self.assertGreaterEqual(len(world.laps),3)
                for duration in [world.laps[0],*[b-a for a,b in zip(world.laps,world.laps[1:])]]:
                    self.assertLessEqual(duration,15)
                self.assertLess(max(abs(b) for b in world.bearings),math.radians(12))
                self.assertLess(errors[-1],.25)
        self.assertLess(errors[1],errors[0]*.4)

    def test_invalid_sightings_do_not_change_commands(self):
        baseline=BearingWorld(stop_after_laps=None,duration=4)
        with self.assertRaises(InterruptedError):baseline.run_with_bearings()
        for fault in ('stale','future','episode','nan','vertical','reverse','large-error'):
            world=BearingWorld(stop_after_laps=None,duration=4)
            def sight():
                """Inject invalid camera evidence without modifying motion."""
                value=world.sight()
                if fault=='stale':return replace(value,at=value.at-3)
                if fault=='future':return replace(value,at=world.time+1)
                if fault=='episode':return replace(value,episode='other')
                if fault=='nan':return replace(value,east=float('nan'))
                if fault=='vertical':return replace(value,north=.01,east=0.)
                if fault=='reverse':return replace(value,north=-value.north,east=-value.east)
                return replace(value,north=-value.east,east=value.north)
            with self.subTest(fault=fault),self.assertRaises(InterruptedError):world.run_with_bearings(sight)
            self.assertEqual(world.commands,baseline.commands)

    def test_bearings_cannot_initialize_an_unmeasured_circle(self):
        world=BearingWorld(stop_after_laps=None,duration=2)
        world.target=lambda:None
        with self.assertRaises(InterruptedError):world.run_with_bearings(world.sight)
        self.assertTrue(all(command==Control() for _,command in world.commands))
        self.assertFalse(any(k=='continuous_bearing_corrected' for k,_ in world.diagnostics))

    def test_duplicate_frame_is_corrected_once_and_cannot_create_a_lap(self):
        world=BearingWorld(stop_after_laps=None,duration=3,translation=False)
        frozen=Bearing(2.1,'fixed-marker',.65,.1)
        with self.assertRaises(InterruptedError):
            world.run_with_bearings(lambda:frozen if world.time>=2.4 else None)
        corrections=[d for k,d in world.diagnostics if k=='continuous_bearing_corrected']
        self.assertEqual(len(corrections),1)
        self.assertLessEqual(math.hypot(*corrections[0]['aircraft_correction_m']),.08)
        dx,dy=corrections[0]['aircraft_correction_m']
        self.assertAlmostEqual(dx*frozen.north+dy*frozen.east,0.)
        self.assertFalse(any(k=='orbit_lap_completed' for k,_ in world.diagnostics))

    def test_bearing_gap_keeps_motion_model_and_resumes_fresh_corrections(self):
        world=BearingWorld(stop_after_laps=None,duration=35)
        def sight():
            """Lose pixels for three seconds without changing flight authority."""
            return None if 12<=world.time<15 else world.sight()
        with self.assertRaisesRegex(InterruptedError,'simulation operator stop'):
            world.run_with_bearings(sight)
        self.assertGreaterEqual(len(world.laps),2)
        self.assertTrue(any(k=='continuous_bearing_corrected' and d['captured_at_mono']>15
                            for k,d in world.diagnostics))
        self.assertEqual(world.commands[-1][1],Control())


if __name__=='__main__':unittest.main()
