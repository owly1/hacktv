"""GPS-followed forecast geometry and guarded movement, without an SDK import.

The 72-vertex outline is dist/model.js with reported weather and uniform fuel.
Boundary growth uses real elapsed minutes. Patrol traversal is 30 times the
head growth speed, bounded to 0.05–0.20 m/s so a tiny demo remains observable.
No visual observation, simulated position or commanded odometry is a GPS fix.
"""
from dataclasses import dataclass
import math
import time
from types import MappingProxyType

from qr_orbit_core import vehicle_reason

M_PER_DEG = 111320.
FORECAST_MINUTES = 5.
MAX_GPS_ACCURACY_M = .5
MAX_CONTOUR_RADIUS_M = 4.
MAX_LAUNCH_DISTANCE_M = 6.


def finite(value):
    """Accept finite physical numbers, excluding booleans and missing values."""
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def geographic_offset(origin, north, east):
    """Convert a local north/east displacement in metres into latitude/longitude."""
    return (origin[0] + north/M_PER_DEG,
            origin[1] + east/(M_PER_DEG*math.cos(math.radians(origin[0]))))


def local_offset(origin, position):
    """Project latitude/longitude onto north/east metres about a fixed origin."""
    return ((position[0]-origin[0])*M_PER_DEG,
            (position[1]-origin[1])*M_PER_DEG*math.cos(math.radians(origin[0])))


def effective_rate(details, minutes):
    """Match EmberModel's reported-condition head rate in metres per minute."""
    base = details['spread_m_per_min']
    return base*(1+.35*math.tanh(base*max(0., minutes)/300.))


def patrol_speed(details, minutes):
    """Scale tangential patrol to growth; real boundary expansion is independent."""
    rate = effective_rate(details, minutes)/60.
    return min(.2, max(.05, rate*30)) if rate > 0 else 0.


def footprint(details, minutes):
    """Return the exact 72 uniform-fuel model vertices as north/east metres."""
    radius = math.sqrt(details['area_ha']*10000/math.pi)
    minutes = max(0., minutes)
    growth = effective_rate(details, minutes)*minutes
    head, back = radius+growth, radius+growth*.12
    a = (head+back)/2
    b = max(radius, a/min(4., 1+details['wind_kmh']/35.))
    shift = (head-back)/2
    bearing = math.radians(details['wind_dir_deg'])
    points = []
    for index in range(72):
        angle = index/72*2*math.pi
        wobble = 1+.06*math.sin(angle*5+details['wind_dir_deg']/40)+.035*math.cos(angle*9)
        along, across = a*math.cos(angle)*wobble, b*math.sin(angle)*wobble
        points.append(((shift+along)*math.cos(bearing)-across*math.sin(bearing),
                       (shift+along)*math.sin(bearing)+across*math.cos(bearing)))
    return points


def perimeter(points):
    """Return closed-polyline length in metres, retaining the model's corners."""
    return sum(math.dist(point, points[(index+1) % len(points)]) for index, point in enumerate(points))


def point_at(points, fraction):
    """Interpolate along the closed polyline by arc-length fraction."""
    remaining = (fraction % 1)*perimeter(points)
    for index, point in enumerate(points):
        following = points[(index+1) % len(points)]
        length = math.dist(point, following)
        if remaining <= length:
            ratio = remaining/length if length else 0.
            return tuple(a+(b-a)*ratio for a, b in zip(point, following))
        remaining -= length
    return points[0]


def nearest_fraction(points, position):
    """Start at the nearest boundary point instead of crossing the entire fire."""
    total, walked, best = perimeter(points), 0., (float('inf'), 0.)
    for index, point in enumerate(points):
        following = points[(index+1) % len(points)]
        delta = tuple(b-a for a, b in zip(point, following))
        length = math.hypot(*delta)
        ratio = max(0., min(1., sum((v-a)*d for v, a, d in zip(position, point, delta))/length**2)) if length else 0.
        candidate = tuple(a+d*ratio for a, d in zip(point, delta))
        distance = math.dist(candidate, position)
        if distance < best[0]:
            best = (distance, (walked+ratio*length)/total)
        walked += length
    return best[1]


def validate_scenario(details, *, minutes=5., flight_seconds=None):
    """Reject nonphysical forecasts; open-ended flights recheck size on every cycle."""
    for key in ('area_ha', 'spread_m_per_min', 'wind_kmh', 'wind_dir_deg', 'temp_c', 'rh_pct'):
        if not finite(details.get(key)):
            raise ValueError('Contour scenario has missing or invalid '+key)
    if not (details['area_ha'] > 0 and details['spread_m_per_min'] >= 0
            and 0 <= details['wind_kmh'] <= 60 and 0 <= details['wind_dir_deg'] <= 360):
        raise ValueError('Contour scenario is outside the supported physical range')
    if not finite(minutes) or minutes < 5 or flight_seconds not in (None, 60, 300):
        raise ValueError('Contour requires the five-minute horizon and supported mission duration')
    end = footprint(details, minutes+(flight_seconds or 0)/60.)
    if max(math.hypot(*point) for point in end) > MAX_CONTOUR_RADIUS_M:
        raise ValueError('Forecast contour exceeds the 4 m demo radius; use the Tiny marker')


@dataclass(frozen=True)
class GPSFix:
    """An actual SDK location event; accuracy is horizontal root-sum-square metres."""
    at: float
    latitude: float
    longitude: float
    accuracy_m: float
    fixed: bool


def gps_reason(fix, now):
    """Fail closed on stale, unknown, synthetic or insufficiently accurate GPS."""
    if fix is None or fix.fixed is not True:
        return 'Contour requires an actual aircraft GPS fix; no indoor/simulated fallback'
    if not all(finite(value) for value in (fix.at, fix.latitude, fix.longitude, fix.accuracy_m)):
        return 'Contour GPS coordinates or reported accuracy are unavailable'
    if not 0 <= now-fix.at <= 1.5:
        return 'Contour GPS location event is stale'
    if not -85 <= fix.latitude <= 85 or not -180 <= fix.longitude <= 180:
        return 'Contour GPS coordinates are invalid'
    if not 0 < fix.accuracy_m <= MAX_GPS_ACCURACY_M:
        return 'Contour requires reported horizontal GPS accuracy of 0.5 m or better'
    return None


@dataclass(frozen=True)
class ContourPlan:
    """Frozen general-area anchor, original launch GPS and monotonic model epoch."""
    anchor: tuple
    launch: tuple
    details: dict
    model_started: float
    started_at: float

    def __post_init__(self):
        """Detach immutable scenario inputs so later status/control writes cannot alter flight."""
        object.__setattr__(self, 'details', MappingProxyType(dict(self.details)))

    def minutes(self, now):
        """Use monotonic real time so clock or browser replay changes cannot accelerate flight."""
        return FORECAST_MINUTES+max(0., now-self.model_started)/60.

    def status(self, now):
        """Expose the exact model inputs and measured anchor for the dashboard overlay."""
        return {'anchor': {'latitude': self.anchor[0], 'longitude': self.anchor[1], 'position_source': 'gps'},
                'forecast_minutes': FORECAST_MINUTES, 'started_at': self.started_at,
                'details': dict(self.details), 'speed_mps': patrol_speed(self.details, self.minutes(now))}


def run_contour(driver, limits, plan, sample, abort, report, *, started,
                flight_seconds=None, min_battery_pct=40, clock=time.monotonic, sleep=time.sleep):
    """Follow growing GPS waypoints with bounded SDK moves and per-command watchdogs.

    `sample` owns live session/heartbeat checks and returns vehicle, GPS and yaw.
    Every movement rechecks it while awaiting acknowledgement. The caller owns
    takeoff and guaranteed landing; this function never owns a second aircraft.
    """
    if min_battery_pct not in (25, 40) or (min_battery_pct == 25 and flight_seconds != 60):
        raise ValueError('Reduced battery threshold requires the short-test time limit')
    validate_scenario(plan.details, minutes=plan.minutes(clock()), flight_seconds=flight_seconds)
    previous_fix = None

    def check():
        """Validate vehicle, authorization, GPS freshness and bounded launch displacement."""
        nonlocal previous_fix
        now = clock()
        if abort.is_set():
            raise InterruptedError('Operator requested landing')
        if flight_seconds is not None and now-started >= flight_seconds:
            raise InterruptedError(f'{flight_seconds}-second contour response limit reached')
        vehicle, fix, yaw = sample()
        reason = vehicle_reason(vehicle, limits, now, min_battery_pct=min_battery_pct) or gps_reason(fix, now)
        if reason:
            raise InterruptedError(reason)
        if not finite(yaw):
            raise InterruptedError('Contour requires a measured aircraft heading')
        position = (fix.latitude, fix.longitude)
        if math.hypot(*local_offset(plan.launch, position)) > MAX_LAUNCH_DISTANCE_M:
            raise InterruptedError('Contour exceeded the 6 m launch envelope')
        if previous_fix is not None and fix.at < previous_fix.at:
            raise InterruptedError('Contour GPS location events arrived out of order')
        if previous_fix is not None and fix.at > previous_fix.at:
            distance = math.hypot(*local_offset((previous_fix.latitude, previous_fix.longitude), position))
            allowance = .45*(fix.at-previous_fix.at)+fix.accuracy_m+previous_fix.accuracy_m+.15
            if distance > allowance:
                raise InterruptedError('Contour GPS jumped beyond measured-motion bounds')
        if previous_fix is None or fix.at > previous_fix.at:
            previous_fix = fix
        return vehicle, fix, yaw

    vehicle, fix, yaw = check()
    points = footprint(plan.details, plan.minutes(clock()))
    phase = nearest_fraction(points, local_offset(plan.anchor, (fix.latitude, fix.longitude)))
    last, failures = clock(), 0
    report('contour', 'Following the GPS +5-minute Tiny fire contour at real-time growth')
    while True:
        vehicle, fix, yaw = check()
        now = clock()
        minutes = plan.minutes(now)
        # An operator-ended flight must still never outgrow its safe footprint.
        try:
            validate_scenario(plan.details, minutes=minutes, flight_seconds=None)
        except ValueError as error:
            raise InterruptedError(str(error)) from error
        points = footprint(plan.details, minutes)
        speed = patrol_speed(plan.details, minutes)
        position = local_offset(plan.anchor, (fix.latitude, fix.longitude))
        previous_target = point_at(points, phase)
        if math.dist(position, previous_target) <= .25:
            phase += speed*max(0., now-last)/perimeter(points)
        last = now
        target = point_at(points, phase)
        north, east = (target[index]-position[index] for index in range(2))
        distance = math.hypot(north, east)
        if distance <= .04:
            down = max(-.1, min(.1, vehicle.altitude_m-limits.height_m))
            if abs(down) > .05:
                driver.move((0., 0., down, 0.), .1, check)
            else:
                sleep(.1)
            continue
        step = min(.2, distance)
        north, east = north*step/distance, east*step/distance
        forward = north*math.cos(yaw)+east*math.sin(yaw)
        right = -north*math.sin(yaw)+east*math.cos(yaw)
        bearing = math.atan2(-position[1], -position[0])
        turn = max(-.2, min(.2, (bearing-yaw+math.pi) % (2*math.pi)-math.pi))
        down = max(-.1, min(.1, .7*(vehicle.altitude_m-limits.height_m)))
        actual = driver.move((forward, right, down, turn), max(.05, speed), check)
        progress = (actual[0]*forward+actual[1]*right)/step
        failures = failures+1 if progress < step*.2 else 0
        if failures >= 3:
            raise InterruptedError('Contour aircraft made insufficient progress on three movements')
        sleep(.05)
