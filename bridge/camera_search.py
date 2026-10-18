"""Grounded pitch sweep. No SDK, aircraft movement or flight authorization."""

def image_bearing_ray(observation,calibration,camera):
    """Unit NED ray from fresh QR pixels; supplies direction, never range."""
    import math
    import cv2
    import numpy as np
    from qr_orbit_pose import rotation
    size=calibration['image_size']
    if [observation['width'],observation['height']]!=list(size):raise ValueError('Camera size changed')
    corners=np.asarray(observation['qr_corners'],dtype=float)
    if corners.shape!=(4,2) or not np.isfinite(corners).all():raise ValueError('Invalid QR corners')
    if np.any(corners<0) or np.any(corners[:,0]>=size[0]) or np.any(corners[:,1]>=size[1]):raise ValueError('QR outside frame')
    point=corners.mean(axis=0).reshape(1,1,2)
    x,y=cv2.undistortPoints(point,np.asarray(calibration['camera_matrix'],dtype=float),
                           np.asarray(calibration['distortion_coefficients'],dtype=float)).reshape(2)
    angles=[float(camera[k+'_absolute']) for k in ('roll','pitch','yaw')]
    if not all(math.isfinite(v) for v in angles):raise ValueError('Invalid camera attitude')
    ray=rotation(*angles) @ np.array([1.,x,y])
    return ray / np.linalg.norm(ray)


def image_bearing_pitch(observation,calibration,camera):
    """Camera aim from pixels and actual attitude; independent of QR size/PnP."""
    import math
    forward,right,down=image_bearing_ray(observation,calibration,camera)
    return max(-85.,min(85.,-math.degrees(math.atan2(down,math.hypot(forward,right)))))


class BearingAim:
    """Predict only recently observed angular motion; no fixed search direction."""
    def __init__(self):
        self.at=None;self.pitch=None;self.rate=0.

    def reset(self):self.__init__()

    def observe(self,at,pitch):
        if self.at is not None and at<=self.at:return
        if self.at is not None and .03<=at-self.at<=.5:
            self.rate=max(-60.,min(60.,(pitch-self.pitch)/(at-self.at)))
        else:self.rate=0.
        self.at=at;self.pitch=pitch

    def predict(self,now):
        if self.at is None or not 0<=now-self.at<=.8:return None
        # Extrapolate only a quarter second of measured angular motion.
        return max(-85.,min(85.,self.pitch+self.rate*min(.25,now-self.at)))


class AcquisitionAim(BearingAim):
    """Keep a rising aircraft's lost QR inside a bounded camera-only search.

    Metric QR scale is unavailable until after the climb. Consequently this
    controller uses the image bearing and independently measured altitude,
    never the nominal QR range. The caller authorizes reacquisition only
    before horizontal movement, with fresh sensors and an active mission.
    """
    def __init__(self):
        super().__init__()
        self.altitude=None;self.baseline_altitude=None
        self.search_at=None;self.search_command=None
        self.state='holding'

    def observe(self,at,pitch,altitude=None):
        import math
        if self.at is not None and at<=self.at:return
        if not all(isinstance(v,(int,float)) and math.isfinite(v) for v in (at,pitch)):return
        super().observe(at,pitch)
        self.altitude=(float(altitude) if isinstance(altitude,(int,float))
                       and math.isfinite(altitude) else None)
        # A late-climb sighting must not erase the measured climb. Otherwise
        # losing the QR at 0.98 m would prevent recovery at the 1 m hover.
        if self.baseline_altitude is None and self.altitude is not None:
            self.baseline_altitude=self.altitude
        self.search_at=None;self.search_command=None;self.state='tracking'

    def step(self,now,*,altitude,actual_pitch,bounds=(-85.,85.),reacquire=False):
        import math
        low,high=bounds
        low=max(-85.,low);high=min(85.,high)
        if not all(isinstance(v,(int,float)) and math.isfinite(v) for v in (now,low,high)) or low>high:
            self.state='holding';return None
        clamp=lambda value:max(low,min(high,value))
        visual=self.predict(now)
        if visual is not None:
            self.state='tracking';return clamp(visual)
        measured=(altitude,actual_pitch,self.altitude,self.baseline_altitude)
        if (not reacquire or self.at is None or now<self.at
                or not all(isinstance(v,(int,float)) and math.isfinite(v) for v in measured)
                or altitude-self.baseline_altitude<.05):
            self.search_at=None;self.search_command=None;self.state='holding';return None
        if self.search_command is None:
            self.search_command=clamp(actual_pitch)
            self.search_at=now
        dt=max(0.,min(.25,now-self.search_at));self.search_at=now
        self.search_command=clamp(self.search_command-15.*dt)
        self.state='searching'
        return self.search_command


class CameraSearch:
    def __init__(self):
        self.index=0
        self.at=None
        self.command=None
        self.arrived=None
        self.seen_at=float('-inf')
        self.hold=None
        self.state='off'

    def step(self,now,pitch,bounds,seen=False):
        low,high=bounds
        clamp=lambda value:max(low,min(high,value))
        dt=0 if self.at is None else max(0,min(.25,now-self.at))
        self.at=now
        if self.command is None:self.command=clamp(pitch)
        if seen:
            self.seen_at=now
            if self.hold is None:self.hold=clamp(pitch)
        if now-self.seen_at<=1.2:
            self.state='acquiring';self.command=self.hold
            self.arrived=None
            return self.command
        self.hold=None
        self.state='scanning'
        angles=list(dict.fromkeys(clamp(x) for x in (-30,-60,-85,0,30,60,85)))
        destination=angles[self.index%len(angles)]
        self.command+=max(-10*dt,min(10*dt,destination-self.command))
        if abs(pitch-destination)<=2 and abs(self.command-destination)<.1:
            if self.arrived is None:self.arrived=now
            if now-self.arrived>=1.2:self.index+=1;self.arrived=None
        else:self.arrived=None
        return self.command
