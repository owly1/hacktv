"""Calibrated ground-plane fire localization and a continuously observed orbit.

The target must touch the verified launch ground plane. This is monocular
geometry, not general depth sensing: elevated, obscured or distant fires are
outside this flight mode. No artificial launch-relative centre is substituted.
"""
from dataclasses import dataclass
import json
import math
from pathlib import Path
import time
import cv2
import numpy as np
from qr_orbit_pose import rotation
from qr_circle_core import centered_move
from qr_orbit_core import vehicle_reason


@dataclass(frozen=True)
class FireTarget:
    at: float
    episode: str
    forward_m: float
    right_m: float
    down_m: float
    width_m: float


class GroundFirePose:
    def __init__(self, path):
        c=json.loads(Path(path).read_text())
        if c.get('fire_ground_plane_verified') is not True:
            raise ValueError('Fire ground-plane geometry needs physical verification in camera.local.json')
        self.size=tuple(c['image_size'])
        self.k=np.array(c['camera_matrix'],dtype=float)
        self.dist=np.array(c['distortion_coefficients'],dtype=float)
        self.offset=np.array(c['camera_offset_body_m'],dtype=float)
        self.ground_offset=float(c.get('ground_plane_offset_m',0))
        if (len(self.size)!=2 or any(type(x)!=int or x<=0 for x in self.size)
                or self.k.shape!=(3,3) or not np.isfinite(self.k).all()
                or self.k[0,0]<=0 or self.k[1,1]<=0 or not np.allclose(self.k[2],[0,0,1])
                or self.dist.size not in (4,5,8,12,14) or not np.isfinite(self.dist).all()
                or self.offset.shape!=(3,) or not np.isfinite(self.offset).all()
                or np.linalg.norm(self.offset)>.3 or not math.isfinite(self.ground_offset)
                or abs(self.ground_offset)>.3):
            raise ValueError('Measured intrinsics, camera offset and ground plane are required')

    def estimate(self, observation, telemetry, gimbal, at):
        if (observation['width'],observation['height'])!=self.size:
            raise ValueError('Tracking frame resolution differs from camera calibration')
        attitude=telemetry['attitude_deg']; height=telemetry['altitude_m']+self.ground_offset
        values=[height,*[attitude[k] for k in ('roll','pitch','yaw')],
                *[gimbal[k+'_absolute'] for k in ('roll','pitch','yaw')]]
        if not all(isinstance(x,(int,float)) and math.isfinite(x) for x in values) or not .6<=height<=1.5:
            raise ValueError('Reliable airborne height and camera attitude required for fire position')
        x1,y1,x2,y2=observation['bbox']
        if not all(math.isfinite(v) and 0<=v<=1 for v in (x1,y1,x2,y2)) or not x1<x2 or not y1<y2:
            raise ValueError('Invalid fire rectangle')
        if min(x1,y1)<.02 or max(x2,y2)>.98:
            raise ValueError('Fire rectangle is clipped; its ground contact cannot be located')
        y=(y1+y2)/2 if observation['source']=='qr-test' else y2
        points=np.array([[(x1+x2)/2*self.size[0], y*self.size[1]],
                         [x1*self.size[0],y*self.size[1]],[x2*self.size[0],y*self.size[1]]],dtype=float)
        normalized=cv2.undistortPoints(points.reshape(-1,1,2),self.k,self.dist).reshape(-1,2)
        cv_to_frd=np.array([[0,0,1],[1,0,0],[0,1,0]])
        transform=rotation(0,0,-attitude['yaw']) @ rotation(
            gimbal['roll_absolute'],gimbal['pitch_absolute'],gimbal['yaw_absolute']) @ cv_to_frd
        origin=rotation(attitude['roll'],attitude['pitch'],0) @ self.offset
        ground=[]
        for pixel in normalized:
            ray=transform @ np.array([*pixel,1.])
            if ray[2]<=.15:
                raise ValueError('Fire ground contact is too close to the horizon for reliable range')
            scale=(height-origin[2])/ray[2]
            ground.append(origin+scale*ray)
        center=ground[0]; width=float(np.linalg.norm(ground[2][:2]-ground[1][:2]))
        if not .5<=np.linalg.norm(center[:2])<=3 or width>.6:
            raise ValueError('Fire lies outside the 0.5–3 m tracking range or is too large for a 1 m orbit')
        return FireTarget(at,observation['episode_id'],*map(float,center),width)


def orbit_fire(driver, limits, sample, abort, report, episode, *, started,
               clock=time.monotonic, sleep=time.sleep):
    """Acquire the actual target, approach in <=20 cm steps, then repeat laps."""
    def check(require_target=True):
        if abort.is_set(): raise InterruptedError('Operator requested landing')
        if clock()-started>=300: raise InterruptedError('Five-minute response limit reached')
        vehicle,target=sample()
        reason=vehicle_reason(vehicle,limits,clock())
        if reason: raise InterruptedError(reason)
        if require_target and (target is None or target.episode!=episode or not 0<=clock()-target.at<=1):
            raise InterruptedError('Selected fire position is missing or stale')
        return vehicle,target

    # Camera has to see a coherent ground position after takeoff before XY motion.
    deadline=clock()+5; previous=None; hits=0; first=None
    while True:
        vehicle,target=check(False)
        if target and target.episode==episode and 0<=clock()-target.at<=1 and (previous is None or target.at>previous.at):
            stable=previous and math.hypot(target.forward_m-previous.forward_m,target.right_m-previous.right_m)<.12
            hits=hits+1 if stable else 1; first=first if stable else target.at
            previous=target
            if hits>=5 and target.at-first>=.8: break
        if clock()>deadline: raise InterruptedError('Fire location did not stabilize after takeoff')
        sleep(.05)
    step=0
    while True:
        _,target=check()
        distance=math.hypot(target.forward_m,target.right_m)
        bearing=math.atan2(target.right_m,target.forward_m)
        if abs(distance-limits.radius_m)>.12 or abs(bearing)>math.radians(12):
            correction=max(-.2,min(.2,distance-limits.radius_m))
            move=(correction*math.cos(bearing),correction*math.sin(bearing),0.,max(-.25,min(.25,bearing)))
            phase='climb'; message='Aligning to measured fire location'
        else:
            move=centered_move(target,limits.radius_m,2*math.pi/limits.segments)
            if math.hypot(*move[:2])>.5 or abs(move[3])>math.radians(35):
                raise InterruptedError('Measured fire correction exceeds orbit envelope')
            step+=1; phase='circle'; message=f'Tracking fire · lap {(step-1)//limits.segments+1}'
        report(phase,message,(step-1)%limits.segments+1 if step else None,limits.segments if step else None)
        actual=driver.move(move,limits.speed_mps,check)
        dx,dy,_,yaw=actual if actual is not None else move
        predicted=(math.cos(yaw)*(target.forward_m-dx)+math.sin(yaw)*(target.right_m-dy),
                   -math.sin(yaw)*(target.forward_m-dx)+math.cos(yaw)*(target.right_m-dy))
        completed=clock(); deadline=completed+2
        while True:
            vehicle,observed=check()
            if observed.at>completed and vehicle_reason(vehicle,limits,clock(),starting=True) is None:
                if math.hypot(observed.forward_m-predicted[0],observed.right_m-predicted[1])>.35:
                    raise InterruptedError('Tracked fire jumped away from the predicted location')
                break
            if clock()>deadline: raise InterruptedError('Fire position did not recover after movement')
            sleep(.05)
