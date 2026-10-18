"""Metric QR pose, optional ground-plane RGB localization, and observed orbit.

QR targets use their measured square size and corners, including targets below
the launch surface. RGB targets still require the verified ground plane; a
classifier rectangle alone does not provide arbitrary-scene depth.
"""
from dataclasses import dataclass, replace
from collections import deque
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
    position_uncertainty_m: float = 0.


class GroundTargetLock:
    """Confirm metric stability before taking off or freezing a height anchor."""
    def __init__(self):
        self.samples = deque(maxlen=32)

    def clear(self):
        self.samples.clear()

    def observe(self, target, altitude):
        if not math.isfinite(altitude):
            self.clear()
            return
        if self.samples:
            first, _ = self.samples[0]
            last, _ = self.samples[-1]
            if target.at <= last.at:
                return
            if (target.episode != last.episode or target.at-last.at > 1
                    or math.dist((target.forward_m,target.right_m,target.down_m),
                                 (first.forward_m,first.right_m,first.down_m)) > .15):
                self.clear()
        self.samples.append((target, altitude))

    def ready(self, now, episode):
        if len(self.samples) < 5:
            return False
        first, _ = self.samples[0]
        last, _ = self.samples[-1]
        return (last.episode == episode and last.at-first.at >= .8
                and 0 <= now-last.at <= .8)

    def vertical_anchor(self):
        # Only a confirmed grounded window may determine the flight's anchor.
        return float(np.median([target.down_m-altitude for target,altitude in self.samples]))


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

    def origin(self,telemetry):
        attitude=telemetry['attitude_deg']
        return rotation(attitude['roll'],attitude['pitch'],0) @ self.offset

    def estimate(self,observation,telemetry,gimbal,at,*,enforce_envelope=True):
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
        if not candidates:
            # IPPE can return a degenerate rotation for an exactly frontal
            # square (including a 180-degree camera-facing orientation).
            # A second planar solver may recover it; the original measured
            # corners, positive depth and two-pixel fit limit still apply.
            ok,r,t=cv2.solvePnP(self.object_points,points,self.k,self.dist,
                              flags=cv2.SOLVEPNP_ITERATIVE)
            if ok and np.isfinite(t).all() and t[2,0]>0:
                projected,_=cv2.projectPoints(self.object_points,r,t,self.k,self.dist)
                error=float(np.sqrt(np.mean(np.sum((projected.reshape(4,2)-points)**2,axis=1))))
                if math.isfinite(error) and error<=2:candidates.append((error,t.reshape(3)))
        if not candidates: raise ValueError('QR pose does not fit the measured square')
        candidates.sort(key=lambda x:x[0]);best=candidates[0]
        if any(error<=best[0]+.5 and np.linalg.norm(center-best[1])>.08 for error,center in candidates[1:]):
            raise ValueError('QR position is ambiguous')
        cv_to_frd=np.array([[0,0,1],[1,0,0],[0,1,0]])
        transform=rotation(0,0,-attitude['yaw']) @ rotation(*values[3:]) @ cv_to_frd
        origin=self.origin(telemetry)
        center=transform @ best[1]+origin
        if enforce_envelope and (not .25<=np.linalg.norm(center[:2])<=3 or not -.15<=center[2]<=4):
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
               clock=time.monotonic, sleep=time.sleep,min_battery_pct=40,flight_seconds=300,
               last_seen=None,remember=None):
    """Acquire the target; continuously align and orbit on capable hardware."""
    if min_battery_pct not in (25,40) or flight_seconds not in (60,300):
        raise ValueError('Use the normal or bounded short-test flight limits')
    if min_battery_pct==25 and flight_seconds!=60:raise ValueError('Reduced battery threshold requires the short-test time limit')
    continuous = bool(limits.lap_seconds and getattr(driver,'supports_continuous_orbit',False) is True)
    def check():
        if abort.is_set(): raise InterruptedError('Operator requested landing')
        if clock()-started>=flight_seconds: raise InterruptedError(f'{flight_seconds}-second response limit reached')
        if last_seen is not None and not continuous:
            seen=last_seen()
            if seen is None or not math.isfinite(seen) or not 0<=clock()-seen<15:
                raise InterruptedError('Fire has not been seen for 15 consecutive seconds')
        vehicle,target=sample()
        reason=vehicle_reason(vehicle,limits,clock(),min_battery_pct=min_battery_pct)
        if reason: raise InterruptedError(reason)
        return vehicle,target

    def valid(target, after):
        return (target is not None and target.episode==episode and after<target.at<=clock()
                and clock()-target.at<=1 and all(math.isfinite(x) for x in (
                    target.forward_m,target.right_m,target.down_m,target.width_m))
                and .25<=math.hypot(target.forward_m,target.right_m)<=3
                and -.15<=target.down_m<=4 and 0<target.width_m<=.6)

    def acquire(after, *, predicted=None, initial=False):
        # Lost/ambiguous frames pause the path. Do not descend for a single
        # decode miss, and do not fly toward a cached target while recovering.
        # Timed hardware may hold for late glare recovery or scale fitting.
        # Fresh vehicle/control state, battery and the mission budget still
        # apply on every iteration; a local wall-clock deadline adds no evidence
        # that a valid target is impossible to acquire.
        deadline=None if continuous else clock()+(15 if last_seen is not None else 10 if initial else 8)
        first=None;previous=None;hits=0;announced=False
        while True:
            vehicle,observed=check()
            coherent=valid(observed,after)
            if coherent and predicted is not None:
                coherent=math.dist((observed.forward_m,observed.right_m,observed.down_m),predicted)<=.35
            settled=vehicle_reason(vehicle,limits,clock(),starting=True,min_battery_pct=min_battery_pct) is None
            if coherent and settled and last_seen is not None:
                # The position has already passed calibrated metric checks.
                # Requiring another burst of QR decodes here prevents motion.
                return observed
            if coherent and settled and (previous is None or observed.at>previous.at):
                position=(observed.forward_m,observed.right_m,observed.down_m)
                stable=(first is not None and previous is not None and observed.at-previous.at<=1
                        and math.dist(position,(first.forward_m,first.right_m,first.down_m))<=.15)
                first=first if stable else observed
                hits=hits+1 if stable else 1
                previous=observed
                if hits>=(5 if initial else 3) and observed.at-first.at>=(.8 if initial else .3):
                    return observed
            elif not coherent or not settled:
                first=previous=None;hits=0
            if not announced and (initial or clock()-after>=.5):
                report('recover','Holding position; acquiring stable fire location' if initial else
                       'Holding position; reacquiring measured fire',None,None)
                announced=True
            if deadline is not None and clock()>=deadline:
                raise InterruptedError('Fire is visible but metric location is unavailable' if last_seen is not None
                                       else 'Fire location could not be reacquired during bounded hover')
            sleep(.05)

    # Count only observations captured after entering the airborne acquisition.
    target=acquire(clock()-1 if last_seen is not None else clock(),initial=True)
    if continuous:
        # Heading and camera geometry must update while the aircraft approaches
        # the ring. A blocking moveBy alignment followed by a predicted-position
        # gate stranded flight 105541: its fresh QR disagreed with displacement
        # memory, so neither the camera nor the continuous controller recovered.
        # The continuous controller already checks fresh measured startup,
        # corrects radius first, and steers heading toward the fixed 3D point.
        if remember is not None:remember(target)
        report('circle','Aligning and orbiting the measured fire location',1,limits.segments)
        driver.orbit_continuously(target,limits,check,report,remember,
                                  clock=clock,sleep=sleep)
        raise InterruptedError('Continuous orbit stopped')
    # A QR is stationary throughout this response. Keep a separate copy of its
    # first measured centre, propagated only by actual aircraft displacement.
    # Filtering must not turn repeated noisy observations into an unbounded
    # random walk of the orbit centre.
    anchor=(target.forward_m,target.right_m,target.down_m)
    position_after=target.at
    if remember is not None:remember(target)
    swept=0.;stalled=0;circle_started=None
    while True:
        vehicle,latest=check()
        if last_seen is not None:
            if valid(latest,position_after):
                measured=(latest.forward_m,latest.right_m,latest.down_m)
                previous=(target.forward_m,target.right_m,target.down_m)
                position_after=latest.at
                if math.dist(measured,previous)<=.6 and math.dist(measured,anchor)<=.65:
                    # Centimetre precision is unnecessary for this orbit.
                    # Accept moderate noise, but move the centre gently and
                    # keep its total correction within 30 cm of acquisition.
                    correction=tuple(.2*(new-old) for new,old in zip(measured,previous))
                    scale=min(1.,.05/max(1e-9,math.sqrt(sum(x*x for x in correction))))
                    filtered=tuple(old+change*scale for old,change in zip(previous,correction))
                    drift=math.dist(filtered,anchor)
                    if drift>.3:
                        filtered=tuple(base+(value-base)*.3/drift for base,value in zip(anchor,filtered))
                    target=replace(latest,forward_m=filtered[0],right_m=filtered[1],down_m=filtered[2],
                                   position_source='filtered-measured-fire')
                    if remember is not None:remember(target)
                # An inconsistent pose does not erase a previously measured
                # centre or trigger landing. Continue using measured motion;
                # only a real matching sighting can renew last_seen().
        elif not valid(target,clock()-1):
            target=acquire(clock(),predicted=(target.forward_m,target.right_m,target.down_m))
        distance=math.hypot(target.forward_m,target.right_m)
        bearing=math.atan2(target.right_m,target.forward_m)
        if abs(distance-limits.radius_m)>.12 or abs(bearing)>math.radians(12):
            correction=max(-.2,min(.2,distance-limits.radius_m))
            # Zero dZ preserves accumulated altitude errors. The latest flight
            # climbed almost 20 cm over successful short moves, so correct the
            # measured launch-relative height on every alignment step.
            dz=max(-.1,min(.1,.7*(vehicle.altitude_m-limits.height_m)))
            move=(correction*math.cos(bearing),correction*math.sin(bearing),dz,max(-.25,min(.25,bearing)))
            phase='climb'; message='Aligning to measured fire location'
        else:
            move=centered_move(target,limits.radius_m,2*math.pi/limits.segments)
            if math.hypot(*move[:2])>.5 or abs(move[3])>math.radians(35):
                raise InterruptedError('Measured fire correction exceeds orbit envelope')
            phase='circle';message=f'Tracking fire · lap {int(swept/(2*math.pi))+1}'
        speed=limits.speed_mps
        if phase=='circle' and limits.lap_seconds:
            if circle_started is None:circle_started=clock()
            due=(swept+2*math.pi/limits.segments)/(2*math.pi)*limits.lap_seconds
            remaining=due-(clock()-circle_started)-.1
            speed=min(limits.speed_mps,max(.1,math.hypot(*move[:2])/max(.05,remaining)))
        segment=int((swept%(2*math.pi))/(2*math.pi)*limits.segments)+1
        report(phase,message,segment if phase=='circle' else None,limits.segments if phase=='circle' else None)
        # While an already-authorized short movement completes, hard vehicle
        # and operator limits remain active. Target loss is handled by holding
        # at its end, not by abruptly converting a decode miss into a descent.
        actual=driver.move(move,speed,check)
        if (actual is None or len(actual)!=4
                or not all(isinstance(x,(int,float)) and math.isfinite(x) for x in actual)):
            raise InterruptedError('Movement did not provide a finite measured displacement')
        dx,dy,dz,yaw=actual
        requested_distance=math.hypot(*move[:2])
        if requested_distance>.05:
            progress=(dx*move[0]+dy*move[1])/requested_distance
            ineffective=progress < .2*requested_distance
        else:
            ineffective=abs(move[3])>.05 and yaw*math.copysign(1,move[3]) < .2*abs(move[3])
        stalled=stalled+1 if ineffective else 0
        if stalled>=3:
            raise InterruptedError('Aircraft made insufficient progress on three consecutive movements')
        predicted=(math.cos(yaw)*(target.forward_m-dx)+math.sin(yaw)*(target.right_m-dy),
                   -math.sin(yaw)*(target.forward_m-dx)+math.cos(yaw)*(target.right_m-dy),target.down_m-dz)
        if last_seen is not None:
            anchor=(math.cos(yaw)*(anchor[0]-dx)+math.sin(yaw)*(anchor[1]-dy),
                    -math.sin(yaw)*(anchor[0]-dx)+math.cos(yaw)*(anchor[1]-dy),anchor[2]-dz)
            # Preserve the capture timestamp: measured displacement updates
            # coordinates, never fabricates a new sighting or renews the timer.
            observed=replace(target,forward_m=predicted[0],right_m=predicted[1],down_m=predicted[2],
                             position_source='motion-propagated-fire')
            position_after=clock()
            if remember is not None:remember(observed)
            settle_until=clock()+(.05 if limits.lap_seconds else .4)
            while clock()<settle_until:
                check()  # Presence, LAND and vehicle guards also apply while settling.
                sleep(min(.05,settle_until-clock()))
        else:observed=acquire(clock(),predicted=predicted)
        if phase=='circle':
            # Count actual angular travel, not requested commands: undershoot
            # must not report a full lap before the aircraft completes one.
            turn=math.atan2(target.right_m-dy,target.forward_m-dx)-bearing
            swept+=math.atan2(math.sin(turn),math.cos(turn))
            swept=max(0.,swept)
        target=observed
