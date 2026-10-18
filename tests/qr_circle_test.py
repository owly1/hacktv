"""Autonomous QR gating and measured geometry, no aircraft SDK needed."""
from dataclasses import replace
import math
from pathlib import Path
import sys
import threading
import unittest
sys.path.insert(0, str(Path(__file__).parents[1]/'bridge'))
from qr_circle_core import ScanGate, acquisition_reason, camera_pitch, centered_move, circle
from qr_orbit_core import Limits, Marker, Vehicle

TEXT = 'EW1:Alpha|120|X|35|M|30|60|31|18|18'
LIMITS = Limits(segments=24, mission_seconds=90)


class GateTests(unittest.TestCase):
    def test_only_exact_fire_marker_can_be_selected_for_automatic_flight(self):
        for text in (TEXT+' ', TEXT.replace('Alpha', 'Ravine'), TEXT[:-2]+'19', '', None):
            with self.subTest(text=text), self.assertRaises(ValueError):
                ScanGate(text)

    def stable(self, gate):
        for i in range(6):
            gate.observe(TEXT, 100+i*.2, 100+i*.2)

    def test_incident_ack_and_five_fresh_scans_required_once(self):
        g = ScanGate(TEXT)
        self.stable(g)
        self.assertFalse(g.consume(101))
        for response in (None, {}, {'accepted':False,'id':'x'}, {'accepted':True}):
            self.assertFalse(g.acknowledge(response, 101))
        self.assertTrue(g.acknowledge({'accepted':True,'id':'x'},101))
        self.assertTrue(g.consume(101))
        self.assertFalse(g.consume(101))
        self.assertFalse(g.observe(TEXT, 102, 102))

    def test_cached_wrong_missing_future_stale_scans_never_start(self):
        for text, at, now in [(TEXT, 100, 102), (TEXT,103,102), ('wrong',102,102),(None,102,102)]:
            g = ScanGate(TEXT)
            for _ in range(20): g.observe(text,at,now)
            self.assertFalse(g.acknowledge({'accepted':True,'id':'x'}, now))
        g = ScanGate(TEXT)
        for _ in range(20): g.observe(TEXT,100,100)
        self.assertFalse(g.stable(100))

    def test_ack_is_invalidated_by_loss_and_expiry(self):
        g = ScanGate(TEXT); self.stable(g)
        g.acknowledge({'accepted':True,'id':'x'}, 101)
        g.observe(None,101.1,101.1)
        self.assertIsNone(g.ack_at)
        self.assertFalse(g.consume(101.1))
        g = ScanGate(TEXT); self.stable(g)
        g.acknowledge({'accepted':True,'id':'x'},101)
        for i in range(1,31): g.observe(TEXT,101+i*.2,101+i*.2)
        self.assertFalse(g.consume(107))


class GeometryTests(unittest.TestCase):
    def marker(self, at=100, forward=1, right=0):
        return Marker(at,TEXT,forward,right,1,0,0)

    def test_24_chords_stay_on_one_metre_radius_and_close_the_circle(self):
        x=y=yaw=0.
        for _ in range(24):
            dx,dy,dz,turn = centered_move(self.marker(),1,2*math.pi/24)
            x,y = x+dx*math.cos(yaw)-dy*math.sin(yaw), y+dx*math.sin(yaw)+dy*math.cos(yaw)
            yaw += turn
            self.assertAlmostEqual(math.hypot(x-1,y),1)
            self.assertEqual(dz,0)
        self.assertAlmostEqual(x,0); self.assertAlmostEqual(y,0)
        self.assertAlmostEqual(yaw,2*math.pi)

    def test_camera_points_to_measured_center_and_initial_move_corrects_radius(self):
        m = self.marker(forward=1.2,right=.1)
        dx,dy,_,yaw = centered_move(m,1)
        self.assertAlmostEqual(math.hypot(m.forward_m-dx,m.right_m-dy),1)
        self.assertAlmostEqual(yaw,math.atan2(.1,1.2))
        self.assertAlmostEqual(camera_pitch(self.marker()),-45)
        self.assertAlmostEqual(camera_pitch(replace(self.marker(),down_m=0)),0)
        self.assertIsNotNone(acquisition_reason(replace(m,forward_m=2),TEXT,LIMITS,100))

    def flight(self, fail=None, initial=1):
        now=[100.]; marker=[self.marker(forward=initial)]; moves=[]; events=[]
        aborted=threading.Event()
        def advance(seconds):
            now[0]+=seconds
            if fail != 'cached': marker[0]=replace(marker[0], at=now[0]-.001)
        def sample():
            v = Vehicle(now[0],True,'hovering',70,1,0,0)
            if fail == 'low-battery': v=replace(v,battery_pct=20)
            if fail == 'link-loss' and moves: v=replace(v,connected=False)
            return v, marker[0]
        class Driver:
            def move(self, offset, speed, check):
                moves.append(offset)
                advance(.4)
                if fail == 'cancel': aborted.set()
                if fail == 'marker-loss': marker[0]=None
                else: marker[0]=self_outer.marker(now[0]-.001)
                check()
        self_outer=self
        circle(Driver(),LIMITS,TEXT,sample,aborted,lambda *e:events.append(e),clock=lambda:now[0],sleep=advance)
        return moves,events

    def test_full_circle_uses_fresh_feedback_after_every_chord(self):
        moves,events=self.flight()
        self.assertEqual(len(moves),24)
        self.assertEqual([e[2] for e in events if e[0]=='circle'],list(range(1,25)))
        self.assertEqual(len(self.flight(initial=1.2)[0]),25)

    def test_bad_pose_missing_frames_link_battery_or_cancel_stops_movement(self):
        for failure in ['cached','low-battery','link-loss','cancel','marker-loss']:
            with self.subTest(failure=failure), self.assertRaises(InterruptedError):
                self.flight(fail=failure)
        with self.assertRaisesRegex(InterruptedError,'one metre'):
            self.flight(initial=2)


if __name__ == '__main__': unittest.main()
