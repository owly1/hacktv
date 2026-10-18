"""Metric QR pose, optional ground-plane RGB localization, and observed orbit.

QR targets use their measured square size and corners, including targets below
the launch surface. RGB targets still require the verified ground plane; a
classifier rectangle alone does not provide arbitrary-scene depth.
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
    position_source: str = 'calibrated-ground-plane'


class MetricQRPose:
    """Use a measured square's perspective, without a target-height assumption.

    camera_only is an offline measurement mode, never used by the flight
    receiver. It permits checking intrinsics/QR scale before body offsets and
    physical verification have been supplied.
    """
    def __init__(self,path,*,camera_only=False):
        c=json.loads(Path(path).read_text())
        self.size=tuple(c['image_size'])
        self.k=np.array(c['camera_matrix'],dtype=float)
        self.dist=np.array(c['distortion_coefficients'],dtype=float)
        try: self.side=float(c['qr_black_square_side_m'])
        except (KeyError,TypeError,ValueError): raise ValueError('Measure the displayed QR black-square width') from None
        self.offset=np.zeros(3) if camera_only else np.array(c['camera_offset_body_m'],dtype=float)
        if (len(self.size)!=2 or any(type(v)!=int or v<=0 for v in self.size)
                or self.k.shape!=(3,3) or not np.isfinite(self.k).all()
                or min(self.k[0,0],self.k[1,1])<=0 or not np.allclose(self.k[2],[0,0,1])
                or self.dist.size not in (4,5,8,12,14) or not np.isfinite(self.dist).all()):
            raise ValueError('Valid camera intrinsics at the streamed resolution are required')
        if not math.isfinite(self.side) or not .03<=self.side<=.6:
            raise ValueError('Measured QR black-square width must be 3–60 cm')
        if (self.offset.shape!=(3,) or not np.isfinite(self.offset).all()
                or np.linalg.norm(self.offset)>.3):
            raise ValueError('Measure the camera-to-drone offset before verifying QR position')
        if not camera_only and c.get('qr_pose_verified') is not True:
            raise ValueError('Metric QR position needs independent physical verification')
        self.camera_only=camera_only
        s=self.side/2
        self.object_points=np.array([[-s,s,0],[s,s,0],[s,-s,0],[-s,-s,0]],dtype=float)

    def estimate(self,observation,telemetry,gimbal,at):
        if observation.get('source')!='qr-test': raise ValueError('Metric QR localization requires QR corners')
        if (observation['width'],observation['height'])!=self.size:
            raise ValueError('Tracking frame resolution differs from camera calibration')
        points=np.asarray(observation.get('qr_corners'),dtype=float)
        if points.shape!=(4,2) or not np.isfinite(points).all(): raise ValueError('Four fresh QR corners are required')
        if (np.any(points<2) or np.any(points[:,0]>self.size[0]-3) or np.any(points[:,1]>self.size[1]-3)
                or min(np.linalg.norm(points[i]-points[(i+1)%4]) for i in range(4))<20
                or not cv2.isContourConvex(points.astype(np.float32))):
            raise ValueError('QR is clipped, too small, or has invalid corners')
        attitude=telemetry['attitude_deg']
        values=[attitude[k] for k in ('roll','pitch','yaw')]+[gimbal[k+'_absolute'] for k in ('roll','pitch','yaw')]
        if not all(isinstance(v,(float,int)) and math.isfinite(v) for v in values):
            raise ValueError('Actual camera and aircraft attitudes are required')
        ok,rvecs,tvecs,_=cv2.solvePnPGeneric(self.object_points,points,self.k,self.dist,flags=cv2.SOLVEPNP_IPPE_SQUARE)
        candidates=[]
        if ok:
            for r,t in zip(rvecs,tvecs):
                if not np.isfinite(t).all() or t[2,0]<=0: continue
                projected,_=cv2.projectPoints(self.object_points,r,t,self.k,self.dist)
                error=float(np.sqrt(np.mean(np.sum((projected.reshape(4,2)-points)**2,axis=1))))
                if error<=2: candidates.append((error,t.reshape(3)))
        if not candidates: raise ValueError('QR pose does not fit the measured square')
        candidates.sort(key=lambda x:x[0]);best=candidates[0]
        if any(error<=best[0]+.5 and np.linalg.norm(center-best[1])>.08 for error,center in candidates[1:]):
            raise ValueError('QR position is ambiguous')
        cv_to_frd=np.array([[0,0,1],[1,0,0],[0,1,0]])
        transform=rotation(0,0,-attitude['yaw']) @ rotation(*values[3:]) @ cv_to_frd
        origin=rotation(attitude['roll'],attitude['pitch'],0) @ self.offset
        center=transform @ best[1]+origin
        if not .25<=np.linalg.norm(center[:2])<=3 or not -.15<=center[2]<=4:
            raise ValueError('QR position is outside the 0.25–3 m horizontal / 4 m below-camera envelope')
        return FireTarget(at,observation['episode_id'],*map(float,center),self.side,
                          'camera-relative-qr-check' if self.camera_only else 'measured-qr-3d')


class FirePose:
    """Select only verified geometry for each detection source; no fallback plane for QR."""
    def __init__(self,path):
        self.models={};self.errors={}
        for source,model in [('qr-test',MetricQRPose),('yolo',GroundFirePose)]:
            try:self.models[source]=model(path)
            except (OSError,ValueError,TypeError,KeyError) as error:self.errors[source]=str(error)
        if not self.models: raise ValueError('QR: '+self.errors['qr-test']+'; RGB: '+self.errors['yolo'])
        self.offset=next(iter(self.models.values())).offset

    def estimate(self,observation,telemetry,gimbal,at):
        source=observation['source']
        if source not in self.models: raise ValueError(self.errors.get(source,'Unsupported target source'))
        return self.models[source].estimate(observation,telemetry,gimbal,at)


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
               clock=time.monotonic, sleep=time.sleep,min_battery_pct=40,flight_seconds=300):
    """Acquire the actual target, approach in <=20 cm steps, then repeat laps."""
    if min_battery_pct not in (25,40) or flight_seconds not in (60,300):
        raise ValueError('Use the normal or bounded short-test flight limits')
    if min_battery_pct==25 and flight_seconds!=60:raise ValueError('Reduced battery threshold requires the short-test time limit')
    def check(require_target=True):
        if abort.is_set(): raise InterruptedError('Operator requested landing')
        if clock()-started>=flight_seconds: raise InterruptedError(f'{flight_seconds}-second response limit reached')
        vehicle,target=sample()
        reason=vehicle_reason(vehicle,limits,clock(),min_battery_pct=min_battery_pct)
        if reason: raise InterruptedError(reason)
        if require_target and (target is None or target.episode!=episode or not 0<=clock()-target.at<=1):
            raise InterruptedError('Selected fire position is missing or stale')
        return vehicle,target

    # Camera has to see a coherent 3D position after takeoff before XY motion.
    deadline=clock()+5; previous=None; hits=0; first=None
    while True:
        vehicle,target=check(False)
        if target and target.episode==episode and 0<=clock()-target.at<=1 and (previous is None or target.at>previous.at):
            stable=previous and math.dist((target.forward_m,target.right_m,target.down_m),
                                         (previous.forward_m,previous.right_m,previous.down_m))<.12
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
        dx,dy,dz,yaw=actual if actual is not None else move
        predicted=(math.cos(yaw)*(target.forward_m-dx)+math.sin(yaw)*(target.right_m-dy),
                   -math.sin(yaw)*(target.forward_m-dx)+math.cos(yaw)*(target.right_m-dy),target.down_m-dz)
        completed=clock(); deadline=completed+2
        while True:
            vehicle,observed=check()
            if observed.at>completed and vehicle_reason(vehicle,limits,clock(),starting=True,min_battery_pct=min_battery_pct) is None:
                if math.dist((observed.forward_m,observed.right_m,observed.down_m),predicted)>.35:
                    raise InterruptedError('Tracked fire jumped away from the predicted location')
                break
            if clock()>deadline: raise InterruptedError('Fire position did not recover after movement')
            sleep(.05)
