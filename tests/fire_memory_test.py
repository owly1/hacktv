"""Independent world-motion simulation; intermittent sightings, no aircraft."""
import math
from pathlib import Path
import sys
import threading
import unittest
sys.path.insert(0,str(Path(__file__).parents[1]/'bridge'))
from fire_tracking import FireTarget,orbit_fire
from qr_orbit_core import Limits,Vehicle


class FireMemoryTests(unittest.TestCase):
    def test_polygon_timing_lower_bound_without_firmware_stops(self):
        # Ideal mathematical bound only: real extended_move_by endpoints add
        # braking/settling time. Timed hardware uses continuous_orbit instead;
        # its independent dynamics and lap timing live in continuous_orbit_test.
        now=[0.];seen=[0.];abort=threading.Event();swept=[0.];speeds=[]
        def sample():
            if now[0]-seen[0]>=14:seen[0]=now[0]
            return Vehicle(now[0],True,'hovering',80,1,0,0),FireTarget(now[0],'fire',1,0,1,.12)
        def advance(dt):now[0]+=dt
        class Driver:
            def move(self,move,speed,check):
                speeds.append(speed);advance(max(math.hypot(*move[:2])/speed,abs(move[3])/math.radians(45)))
                check();swept[0]+=move[3]
                if swept[0]>=2*math.pi-1e-9:abort.set()
                return move
        with self.assertRaisesRegex(InterruptedError,'Operator'):
            orbit_fire(Driver(),Limits(segments=24,speed_mps=.6,lap_seconds=15),sample,abort,lambda *x:None,
                       'fire',started=0,clock=lambda:now[0],sleep=advance,last_seen=lambda:seen[0])
        self.assertGreaterEqual(swept[0],2*math.pi-1e-9)
        self.assertLessEqual(now[0],15.);self.assertTrue(all(.1<=v<=.6 for v in speeds))

    def run_world(self,renew):
        now=[0.];seen=[0.];yaw=[0.];position=[-1.,0.];abort=threading.Event();moves=[];memories=[]
        def sample():
            visible=now[0]<.1 or renew and now[0]-seen[0]>=14.
            if visible:seen[0]=now[0]
            x,y=-position[0],-position[1];c,s=math.cos(yaw[0]),math.sin(yaw[0])
            t=FireTarget(now[0],'fire',c*x+s*y,-s*x+c*y,1.,.12) if visible else None
            return Vehicle(now[0],True,'hovering',80,1.,0,0),t
        def advance(dt):now[0]+=dt
        class Driver:
            def move(self,offset,speed,check):
                c,s=math.cos(yaw[0]),math.sin(yaw[0]);dx,dy,dz,turn=offset
                # Actual displacement, deliberately 10% short.
                dx*=.9;dy*=.9
                for _ in range(10):advance(.1);check()
                position[0]+=c*dx-s*dy;position[1]+=s*dx+c*dy;yaw[0]+=turn
                moves.append((now[0],math.hypot(*position)))
                if len(moves)>=80:abort.set()
                return dx,dy,dz,turn
        with self.assertRaisesRegex(InterruptedError,'Operator' if renew else '15 consecutive seconds'):
            orbit_fire(Driver(),Limits(segments=24),sample,abort,lambda *x:None,'fire',started=0,
                       clock=lambda:now[0],sleep=advance,last_seen=lambda:seen[0],remember=memories.append)
        return now[0],yaw[0],moves,memories

    def test_one_sighting_every_fourteen_seconds_drives_multiple_metre_radius_circles(self):
        now,yaw,moves,memories=self.run_world(True)
        self.assertGreater(yaw,4*math.pi)
        self.assertEqual(len(moves),80)
        self.assertLess(max(abs(radius-1.) for _,radius in moves),.15)
        self.assertTrue(any(t.position_source=='motion-propagated-fire' for t in memories))

    def test_expiry_during_movement_stops_at_fifteen_seconds_without_renewing_from_odometry(self):
        now,yaw,moves,memories=self.run_world(False)
        self.assertGreater(len(moves),1);self.assertLess(now,15.2)
        self.assertTrue(all(t.at==0 for t in memories))

    def run_noisy_world(self, persistent_bias=False):
        now=[0.];yaw=[0.];position=[-1.,0.];abort=threading.Event();moves=[];centres=[];phases=[]
        def sample():
            index=len(moves)
            # Noise is expressed in a fixed world frame, independently of the
            # controller's centre and displacement predictions.
            if not index:ex=ey=0.
            elif persistent_bias:ex,ey=.55,0.
            elif index%7==0:ex,ey=1.1,-.65  # isolated bad PnP result
            else:ex,ey=.28*math.sin(index*1.7),.28*math.cos(index*2.1)
            x,y=ex-position[0],ey-position[1];c,s=math.cos(yaw[0]),math.sin(yaw[0])
            return Vehicle(now[0],True,'hovering',80,1.,0,0),FireTarget(
                now[0],'fire',c*x+s*y,-s*x+c*y,1.,.12,position_uncertainty_m=.3)
        def advance(dt):now[0]+=dt
        def remember(target):
            c,s=math.cos(yaw[0]),math.sin(yaw[0])
            centres.append((position[0]+c*target.forward_m-s*target.right_m,
                            position[1]+s*target.forward_m+c*target.right_m))
        class Driver:
            def move(self,offset,speed,check):
                c,s=math.cos(yaw[0]),math.sin(yaw[0]);dx,dy,dz,turn=offset
                dx*=.9;dy*=.9
                for _ in range(5):advance(.1);check()
                position[0]+=c*dx-s*dy;position[1]+=s*dx+c*dy;yaw[0]+=turn
                moves.append(math.hypot(*position))
                if len(moves)>=96:abort.set()
                return dx,dy,dz,turn
        with self.assertRaisesRegex(InterruptedError,'Operator'):
            orbit_fire(Driver(),Limits(segments=24),sample,abort,lambda phase,*_:phases.append(phase),
                       'fire',started=0,clock=lambda:now[0],sleep=advance,
                       last_seen=lambda:now[0],remember=remember)
        return yaw[0],moves,centres,phases

    def test_noisy_centre_and_isolated_bad_poses_continue_multiple_rough_circles(self):
        yaw,moves,centres,phases=self.run_noisy_world()
        self.assertEqual(len(moves),96)
        self.assertGreater(yaw,4*math.pi)
        self.assertLess(max(abs(radius-1) for radius in moves),.35)
        self.assertGreater(phases.count('circle'),80)
        self.assertLessEqual(max(math.hypot(*centre) for centre in centres),.3+1e-9)

    def test_persistent_biased_measurements_cannot_walk_centre_away_from_acquisition(self):
        yaw,moves,centres,phases=self.run_noisy_world(persistent_bias=True)
        self.assertGreater(yaw,4*math.pi)
        self.assertLessEqual(max(math.hypot(*centre) for centre in centres),.3+1e-9)
        self.assertLess(max(abs(radius-1) for radius in moves),.4)

if __name__=='__main__':unittest.main()
