"""Real flight-search decisions exercised with deterministic sensors; no SDK/radio."""
from dataclasses import replace
import math
from pathlib import Path
import sys
import threading
import unittest

sys.path.insert(0, str(Path(__file__).parents[1]/'bridge'))
from contour_search import run_airborne_search
from fire_contour import ContourPlan, GPSFix, geographic_offset, local_offset, run_contour
from fire_detection import parse_marker, TINY_FIRE_MARKER_PAYLOAD
from qr_orbit_core import Limits, Vehicle


class SearchTests(unittest.TestCase):
    """Verify measured height, actual search movement, anchoring and continued contour flight."""

    def harness(self, *, height=.6, fault=None, find_after=4, stop_after=25, flight_seconds=None):
        """Build a feedback-controlled synthetic aircraft with injectable faults and QR timing."""
        origin=(43.78,-79.19)
        state={'time':10.,'height':height,'position':origin,'yaw':0.,'moves':[],'phases':[],
               'acquired_at':None,'horizontal':0,'plan':None,'hold_started':None}
        abort=threading.Event()
        limits=Limits(speed_mps=.1)

        def clock():
            """Return the synthetic monotonic clock."""
            return state['time']

        def sleep(seconds):
            """Advance test time without touching a clock or aircraft."""
            state['time']+=seconds

        def sample():
            """Publish actual synthetic measurements with the requested failure injection."""
            vehicle=Vehicle(clock(),True,'hovering',80,state['height'],.1,0.)
            fix=GPSFix(clock(),*state['position'],.2,True)
            if fault=='battery':vehicle=replace(vehicle,battery_pct=20)
            if fault=='disconnect':vehicle=replace(vehicle,connected=False)
            if fault=='gps':fix=replace(fix,at=clock()-2)
            if fault=='gps-during-move' and state['moves']:fix=replace(fix,fixed=False)
            if fault=='envelope':fix=replace(fix,latitude=origin[0]+.001)
            return vehicle,fix,state['yaw']

        class Driver:
            """A moveBy fake that supplies actual measured displacement and watchdog callbacks."""
            def move(inner,offset,speed,check):
                """Apply the bounded command, update received sensors and honor operator LAND."""
                check()
                before=state['height'];state['moves'].append((offset,speed,before))
                stalled=fault in ('no-progress','height-no-progress')
                actual=tuple(0. for _ in offset) if stalled else offset
                north=actual[0]*math.cos(state['yaw'])-actual[1]*math.sin(state['yaw'])
                east=actual[0]*math.sin(state['yaw'])+actual[1]*math.cos(state['yaw'])
                state['position']=geographic_offset(state['position'],north,east)
                state['height']-=actual[2];state['yaw']+=actual[3]
                if math.hypot(*offset[:2])>.01:state['horizontal']+=1
                sleep(max(.1,math.sqrt(sum(value*value for value in offset[:3]))/speed))
                if len(state['moves'])>=stop_after:abort.set()
                check()
                return actual

        def report(phase,message):
            """Record mission stages and the start of each stationary acquisition window."""
            state['phases'].append(phase)
            if phase=='acquiring':state['hold_started']=clock()

        def seen():
            """Present an exact decoded Tiny marker after actual search movement."""
            return find_after is not None and state['horizontal']>=find_after

        def acquire():
            """Require post-stop frames before freezing the anchored scenario and its wind."""
            if fault=='unstable-marker' or clock()-state['hold_started']<1.:
                return None
            state['acquired_at']=clock()
            plan=ContourPlan(geographic_offset(state['position'],.5,0),origin,
                             parse_marker(TINY_FIRE_MARKER_PAYLOAD),clock(),clock()*1000)
            state['plan']=plan
            return plan

        driver=Driver()
        def run():
            """Execute real search commands and transfer the same driver to GPS contour following."""
            plan=run_airborne_search(driver,limits,origin,sample,abort,report,seen,acquire,
                started=10.,flight_seconds=flight_seconds,clock=clock,sleep=sleep)
            run_contour(driver,limits,plan,sample,abort,report,
                started=10.,flight_seconds=flight_seconds,clock=clock,sleep=sleep)

        return run,state,abort

    def test_takes_measured_height_then_moves_search_then_contour_until_land(self):
        """The full flow issues real bounded movement with Tiny wind after acquiring at 1 m."""
        run,state,_=self.harness()
        with self.assertRaisesRegex(InterruptedError,'Operator requested landing'):run()
        self.assertEqual(state['phases'][:4],['holding','airborne-search','acquiring','tracking'])
        self.assertIn('contour',state['phases'])
        self.assertIsNotNone(state['acquired_at'])
        self.assertEqual(state['plan'].details['wind_kmh'],.2)
        self.assertEqual(state['plan'].launch,(43.78,-79.19))
        self.assertEqual(len(state['moves']),25)
        for offset,speed,height in state['moves']:
            self.assertLessEqual(math.hypot(*offset[:2]),.200001)
            self.assertLessEqual(abs(offset[2]),.100001)
            if math.hypot(*offset[:2])>.01:self.assertLessEqual(abs(height-1.),.05)
        self.assertGreater(state['horizontal'],4)

    def test_search_stays_airborne_and_actively_moves_without_any_qr_past_five_minutes(self):
        """No marker and no old timer may silently end the explicitly authorized flight."""
        run,state,_=self.harness(height=1.,find_after=None,stop_after=200)
        with self.assertRaisesRegex(InterruptedError,'Operator requested landing'):run()
        self.assertGreater(state['time'],310.)
        self.assertEqual(state['horizontal'],200)
        self.assertIsNone(state['plan'])
        self.assertLess(math.hypot(*local_offset((43.78,-79.19),state['position'])),2.)

    def test_no_marker_short_test_honors_explicit_sixty_second_limit(self):
        """A manually selected short test applies across both search and later tracking."""
        run,state,_=self.harness(height=1.,find_after=None,stop_after=1000,flight_seconds=60)
        with self.assertRaisesRegex(InterruptedError,'60-second contour response limit'):run()
        self.assertGreaterEqual(state['time'],70.)

    def test_safety_faults_stop_search_before_any_horizontal_command(self):
        """Preserve battery, link, GPS, geofence and measured altitude gates."""
        for fault in ('battery','disconnect','gps','envelope'):
            run,state,_=self.harness(fault=fault)
            with self.subTest(fault=fault),self.assertRaises(InterruptedError):run()
            self.assertEqual(state['moves'],[])
        run,state,_=self.harness(height=1.6)
        with self.assertRaisesRegex(InterruptedError,'height outside'):run()
        self.assertEqual(state['moves'],[])

    def test_operator_land_and_gps_loss_interrupt_pending_moves(self):
        """Watchdog callbacks run inside a movement acknowledgement wait."""
        run,state,abort=self.harness()
        abort.set()
        with self.assertRaisesRegex(InterruptedError,'Operator requested landing'):run()
        self.assertEqual(state['moves'],[])
        run,state,_=self.harness(fault='gps-during-move')
        with self.assertRaisesRegex(InterruptedError,'actual aircraft GPS'):run()
        self.assertEqual(len(state['moves']),1)

    def test_no_progress_is_bounded_for_height_and_horizontal_search(self):
        """An acknowledgement with no achieved movement cannot loop forever."""
        for height,fault,message in ((.6,'height-no-progress','height made insufficient'),
                                     (1.,'no-progress','search made insufficient')):
            run,state,_=self.harness(height=height,fault=fault)
            with self.subTest(fault=fault),self.assertRaisesRegex(InterruptedError,message):run()
            self.assertEqual(len(state['moves']),3)

    def test_unstable_qr_has_bounded_acquisition_hold_and_search_resumes(self):
        """A visible but unlocalizable marker must not trap the aircraft in an endless wait."""
        run,state,_=self.harness(height=1.,fault='unstable-marker',find_after=2,stop_after=10)
        with self.assertRaisesRegex(InterruptedError,'Operator requested landing'):run()
        self.assertIsNone(state['plan'])
        self.assertGreater(state['phases'].count('airborne-search'),1)
        self.assertEqual(state['horizontal'],10)


if __name__=='__main__':unittest.main()
