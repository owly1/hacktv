"""Bounded real-fire retreat decisions and camera geometry; no SDK or network."""
from dataclasses import dataclass
import math
import threading
import time

EDGE_BUFFER_M = 100.0


def finite(value):
    """Accept finite measurements, excluding booleans and missing values."""
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


@dataclass(frozen=True)
class Limits:
    origin_lat: float
    origin_lon: float
    ground_altitude_m: float  # target ground relative to takeoff, surveyed for this mission
    image_width: int
    image_height: int
    hfov_deg: float
    uncertainty_m: float  # verified upper bound for combined pose/extent error
    geofence_m: float
    min_altitude_m: float = 5.
    max_altitude_m: float = 100.
    step_m: float = 1.
    speed_mps: float = .5
    travel_m: float = 250.
    seconds: float = 600.
    max_wind_mps: float = 3.

    def __post_init__(self):
        """Reject unbounded or malformed configuration before any flight connection."""
        ranges = {'origin_lat': (-85, 85), 'origin_lon': (-180, 180),
                  'ground_altitude_m': (-100, 100), 'hfov_deg': (20, 100),
                  'uncertainty_m': (5, 100), 'geofence_m': (110, 500),
                  'min_altitude_m': (5, 100), 'max_altitude_m': (5, 120),
                  'step_m': (.2, 1), 'speed_mps': (.1, .5), 'travel_m': (1, 500),
                  'seconds': (10, 900), 'max_wind_mps': (.1, 5)}
        for key, (low, high) in ranges.items():
            value = getattr(self, key)
            if not finite(value) or not low <= value <= high:
                raise ValueError(f'invalid real-fire limit: {key}')
        if self.min_altitude_m >= self.max_altitude_m:
            raise ValueError('minimum altitude must be below maximum altitude')
        for value in (self.image_width, self.image_height):
            if type(value) is not int or not 240 <= value <= 4096:
                raise ValueError('verified native image dimensions are required')


def local_position(lat, lon, limits):
    """Convert measured GPS to local east/north metres within the bounded mission site."""
    if not finite(lat) or not finite(lon) or not -85 <= lat <= 85 or not -180 <= lon <= 180:
        raise ValueError('measured GPS is unavailable')
    return ((lon-limits.origin_lon)*111320*math.cos(math.radians(limits.origin_lat)),
            (lat-limits.origin_lat)*111320)


@dataclass(frozen=True)
class Fire:
    at: float  # original capture time on the monotonic clock
    drone_id: str
    east: float
    north: float
    radius: float  # enclosing circle of the projected box, not an equivalent-area radius


@dataclass(frozen=True)
class Vehicle:
    at: float  # oldest actual required sensor event, not a cache-read timestamp
    drone_id: str
    east: float
    north: float
    altitude: float
    heading: float
    speed: float
    tilt: float
    battery: float
    wind: float
    state: str
    connected: bool
    gps_fix: bool
    controller_ok: bool


def project_fire(hit, telemetry, shape, captured, limits):
    """Enclose all four camera-box ground intersections in a conservative circle.

    Requires verified unzoomed camera geometry, a level aircraft/gimbal yaw,
    and the mission's surveyed flat ground. Caller validates capture/pose ages.
    A clipped box or any near-horizon ray cannot supply an extent for control.
    """
    t = telemetry or {}
    if (not hit or hit.get('source') != 'yolo' or hit.get('label') != 'fire'
            or not finite(hit.get('confidence')) or hit['confidence'] < .8
            or t.get('provenance') != 'live' or t.get('gps_fix') is not True
            or (t.get('extra') or {}).get('position_source') != 'gps'
            or not finite(captured) or not t.get('drone_id')):
        raise ValueError('real, confident fire evidence and measured GPS are required')
    if tuple(shape[:2]) != (limits.image_height, limits.image_width):
        raise ValueError('camera resolution differs from verified calibration')
    box = hit.get('bbox') or []
    if len(box) != 4 or not all(finite(v) for v in box):
        raise ValueError('invalid fire box')
    x1, y1, x2, y2 = box
    if not .02 < x1 < x2 < .98 or not .02 < y1 < y2 < .98:
        raise ValueError('partial or clipped fire extent')
    extra, attitude = t.get('extra') or {}, t.get('attitude_deg') or {}
    altitude, heading, pitch = t.get('altitude_m'), extra.get('heading_deg'), extra.get('gimbal_pitch_deg')
    if not all(finite(v) for v in (altitude, heading, pitch, attitude.get('roll'), attitude.get('pitch'))):
        raise ValueError('camera pose is incomplete')
    if max(abs(attitude['roll']), abs(attitude['pitch'])) > 5 or not -90 <= pitch <= -5:
        raise ValueError('level, downward-looking camera pose required')
    height = altitude-limits.ground_altitude_m
    if height <= 1:
        raise ValueError('camera must be above the surveyed ground plane')
    east, north = local_position(t.get('latitude'), t.get('longitude'), limits)
    yaw, down = math.radians(heading), math.radians(-pitch)
    half = math.tan(math.radians(limits.hfov_deg)/2)
    points = []
    for x, y in ((x1, y1), (x2, y1), (x2, y2), (x1, y2)):
        u = (2*x-1)*half
        v = (2*y-1)*half*limits.image_height/limits.image_width
        forward, ray_down = math.cos(down)-v*math.sin(down), math.sin(down)+v*math.cos(down)
        if ray_down <= .1:
            raise ValueError('fire extent crosses the near-horizon region')
        f, r = height*forward/ray_down, height*u/ray_down
        if math.hypot(f, r) > 500:
            raise ValueError('fire extent exceeds the camera range envelope')
        points.append((east+f*math.sin(yaw)+r*math.cos(yaw), north+f*math.cos(yaw)-r*math.sin(yaw)))
    ce, cn = (sum(p[i] for p in points)/4 for i in (0, 1))
    radius = max(math.hypot(e-ce, n-cn) for e, n in points)
    if not 0 < radius <= 500:
        raise ValueError('invalid projected fire extent')
    return Fire(captured, t['drone_id'], ce, cn, radius)


def vehicle_reason(v, limits, now, settled=False):
    """Reject stale or out-of-envelope measured aircraft state and pilot authority."""
    if v is None or not finite(v.at) or not 0 <= now-v.at <= 1.5:
        return 'required aircraft sensor events are stale'
    if v.connected is not True or v.gps_fix is not True or v.controller_ok is not True:
        return 'aircraft link, GPS fix or pilot control is unavailable'
    if not all(finite(x) for x in (v.east, v.north, v.altitude, v.heading, v.speed, v.tilt, v.battery, v.wind)):
        return 'required aircraft measurement is unknown'
    if v.state not in (('hovering',) if settled else ('hovering', 'flying')):
        return 'pilot-established hover required' if settled else 'unexpected aircraft state'
    if (not limits.min_altitude_m <= v.altitude <= limits.max_altitude_m
            or not 40 <= v.battery <= 100 or not 0 <= v.heading < 360 or abs(v.tilt) > 5 or v.wind > limits.max_wind_mps
            or v.wind < 0 or v.speed < 0 or v.speed > (.2 if settled else 1.)):
        return 'altitude, battery, attitude, wind or speed limit'
    if math.hypot(v.east, v.north) > limits.geofence_m-2:
        return 'aircraft is outside the verified flight area'
    return None


def plan(fire, vehicle, limits, now):
    """Compute an outward body-frame step toward 100 m + uncertainty + 2 m margin.

    Already farther away means hold, never approach. Both the next point and
    full target must fit the verified convex flight area before any movement.
    """
    reason = vehicle_reason(vehicle, limits, now)
    if reason:
        raise ValueError(reason)
    if (fire is None or not all(finite(x) for x in (fire.at, fire.east, fire.north, fire.radius))
            or not 0 <= now-fire.at <= 1.5 or fire.drone_id != vehicle.drone_id or not 0 < fire.radius <= 500):
        raise ValueError('fresh same-drone fire extent required')
    e, n = vehicle.east-fire.east, vehicle.north-fire.north
    distance = math.hypot(e, n)
    if distance <= fire.radius+limits.uncertainty_m:
        raise ValueError('aircraft overlaps uncertain fire extent; operator intervention required')
    target = fire.radius+EDGE_BUFFER_M+limits.uncertainty_m+2.
    gap = max(0., target-distance)
    if gap <= .1:
        return None
    e, n = e/distance, n/distance
    end = (vehicle.east+e*gap, vehicle.north+n*gap)
    if math.hypot(*end) > limits.geofence_m-2:
        raise ValueError('required buffer lies outside the verified flight area')
    step = min(limits.step_m, gap)
    heading = math.radians(vehicle.heading)
    return (step*(e*math.sin(heading)+n*math.cos(heading)),
            step*(e*math.cos(heading)-n*math.sin(heading)), 0., 0.)


class Session:
    """One explicitly armed continuous retreat session with latched aborts.

    Driver.move polls check() during movement; driver.stop interrupts relative
    movement and verifies hover. A failed stop must never be reported as held.
    All commands serialize through command_lock; halt sets abort before waiting.
    """
    def __init__(self, limits, drone_id, sample, driver, report, execute=False, clock=time.monotonic):
        """Inject snapshot, aircraft driver and clock dependencies for deterministic tests."""
        self.limits, self.drone_id = limits, drone_id
        self.sample, self.driver, self.report, self.execute, self.clock = sample, driver, report, execute, clock
        self.command_lock = threading.RLock()
        self.aborted = threading.Event()
        self.used = self.active = False
        self.started = None
        self.travel = 0.
        self.last_fire = None
        self.first_at = None
        self.hits = 0
        self.completed_at = None
        self.last_status = None

    def _check(self):
        """Recheck evidence, control authority and limits during every SDK wait."""
        if self.aborted.is_set():
            raise ValueError('session stopped; deliberate restart required')
        if self.started is not None and self.clock()-self.started > self.limits.seconds:
            raise ValueError('mission deadline reached')
        vehicle, fire = self.sample()
        if vehicle is None or vehicle.drone_id != self.drone_id:
            raise ValueError('wrong aircraft identity')
        plan(fire, vehicle, self.limits, self.clock())
        if self.started is not None and fire.at <= self.started and self.hits == 0:
            return vehicle, fire
        if self.last_fire is None or fire.at > self.last_fire.at:
            if self.last_fire is not None:
                gap = fire.at-self.last_fire.at
                if gap > .75 or math.hypot(fire.east-self.last_fire.east, fire.north-self.last_fire.north) > 10+2*gap:
                    raise ValueError('fire track changed or confirmation gap exceeded')
            if self.first_at is None:
                self.first_at = fire.at
            self.hits += 1
            self.last_fire = fire
        elif fire.at < self.last_fire.at:
            raise ValueError('out-of-order fire observation')
        return vehicle, fire

    def arm(self):
        """Consume one execution authorization only in a fresh pilot-established hover."""
        with self.command_lock:
            if not self.execute or self.used:
                raise ValueError('execution disabled or session already consumed')
            self.last_fire = self.first_at = None
            self.hits = 0
            vehicle, _ = self._check()
            reason = vehicle_reason(vehicle, self.limits, self.clock(), settled=True)
            if reason:
                raise ValueError(reason)
            self.used = self.active = True
            self.started = self.clock()
            self.last_fire = self.first_at = None
            self.hits = 0
            self.report('preflight', 'real-fire buffer armed; confirming five distinct fire frames')

    def halt(self, reason):
        """Latch cancellation and confirm a stop; never automatically land over a fire."""
        self.aborted.set()
        with self.command_lock:
            if not self.active:
                return
            self.active = False
            try:
                confirmed = self.driver.stop()
            except Exception:
                confirmed = False
            self.report('aborted' if confirmed else 'error',
                        f'{reason}; ' + ('hover confirmed; pilot intervention required' if confirmed else
                                         'STOP UNCONFIRMED; pilot intervention required'))

    def tick(self):
        """Confirm evidence, retreat once, then demand post-move feedback before continuing."""
        if not self.active:
            return
        with self.command_lock:
            try:
                vehicle, fire = self._check()
                if self.completed_at is not None:
                    if vehicle.at <= self.completed_at or fire.at <= self.completed_at or vehicle.state != 'hovering' or vehicle.speed > .2:
                        if self.clock()-self.completed_at > 3:
                            raise ValueError('fresh settled feedback did not recover after retreat')
                        return
                    self.completed_at = None
                if self.hits < 5 or fire.at-self.first_at < .8:
                    return
                reason = vehicle_reason(vehicle, self.limits, self.clock(), settled=True)
                if reason:
                    raise ValueError(reason)
                move = plan(fire, vehicle, self.limits, self.clock())
                if move is None:
                    if self.last_status != 'hold':
                        self.report('preflight', 'estimated 100 m edge buffer established; monitoring growth')
                    self.last_status = 'hold'
                    return
                length = math.hypot(*move[:2])
                if self.travel+length > self.limits.travel_m:
                    raise ValueError('total retreat travel limit')
                self.travel += length  # reserve even if transmission or acknowledgement fails
                self.last_status = 'retreat'
                self.report('return', 'retreating from estimated fire edge to 100 m buffer')
                self.driver.move(move, self.limits.speed_mps, self._check)
                self.completed_at = self.clock()
            except Exception as error:
                self.halt(str(error))
