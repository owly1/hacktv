"""GPS-followed forecast geometry and guarded movement, without an SDK import.

The 72-vertex outline is dist/model.js with reported weather and uniform fuel.
Boundary growth uses real elapsed minutes. Patrol traversal is 30 times the
head growth speed, bounded to 0.05–0.20 m/s so a tiny demo remains observable.
No visual observation, simulated position or commanded odometry is a GPS fix.
"""
from dataclasses import dataclass, replace
from datetime import datetime
import math
import time
from types import MappingProxyType

from qr_orbit_core import vehicle_reason
from fire_detection import parse_marker, TINY_FIRE_MARKER_PAYLOAD

M_PER_DEG = 111320.
FORECAST_MINUTES = 5.
MAX_GPS_ACCURACY_M = .5
MAX_CONTOUR_RADIUS_M = 4.
MAX_LAUNCH_DISTANCE_M = 6.
OUTDOOR_MAX_GPS_ACCURACY_M = 5.
OUTDOOR_MAX_CONTOUR_RADIUS_M = 100.
OUTDOOR_MAX_LAUNCH_DISTANCE_M = 125.
# The physical marker remains the same identity; this explicit outdoor profile
# changes its simulated initial fire diameter, never the measured QR dimensions.
OUTDOOR_DETAILS = MappingProxyType({**parse_marker(TINY_FIRE_MARKER_PAYLOAD),
                                   'area_ha': math.pi*25.**2/10000.})


@dataclass(frozen=True)
class OutdoorContourLimits:
    """Separate outdoor translation limits; legacy QR-circle limits stay unchanged."""
    height_m: float = 1.
    speed_mps: float = 1.
    lap_seconds: None = None

    def __post_init__(self):
        """Accept only the explicit one-metre course and bounded outdoor movement speeds."""
        if (not finite(self.height_m) or self.height_m != 1. or not finite(self.speed_mps)
                or not .1 <= self.speed_mps <= 1. or self.lap_seconds is not None):
            raise ValueError('Outdoor contour requires a 1 m height and 0.1–1 m/s movement limit')


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


def scenario_from(details):
    """Keep encoded temperature/humidity assumptions separate from measured wind."""
    return {'wind': details['wind_kmh'], 'direction': details['wind_dir_deg'],
            'dryness': max(0., min(100., 100.-details['rh_pct'])),
            'temp': details['temp_c'], 'rh': details['rh_pct']}


def base_rate(scenario):
    """Match the browser's illustrative wind/environment rate, in metres per minute."""
    environment = max(.5, min(2.2, 1+(scenario['dryness']-50)/120
                              +(scenario['temp']-20)/90-(scenario['rh']-40)/140))
    return (1.5+.505*min(60., max(0., scenario['wind']))**1.2)*environment


def effective_rate(details, minutes, scenario=None):
    """Scale the encoded base spread by current weather without changing its reference."""
    base = details['spread_m_per_min']
    if scenario is not None:
        base *= base_rate(scenario)/base_rate(scenario_from(details))
    return base*(1+.35*math.tanh(base*max(0., minutes)/300.))


def patrol_speed(details, minutes, scenario=None, *, outdoor=False):
    """Scale traversal to growth with explicit tiny/outdoor observable-speed limits."""
    rate = effective_rate(details, minutes, scenario)/60.
    minimum, maximum = (.5, 1.) if outdoor else (.05, .2)
    # Traversing a 50 m-wide demonstration takes an observable pace; this
    # multiplier changes patrol speed only, never the forecast's elapsed time.
    multiplier = 300 if outdoor else 30
    return min(maximum, max(minimum, rate*multiplier)) if rate > 0 else 0.


def footprint(details, minutes, scenario=None):
    """Return the exact 72 uniform-fuel model vertices as north/east metres."""
    radius = math.sqrt(details['area_ha']*10000/math.pi)
    minutes = max(0., minutes)
    weather = scenario_from(details) if scenario is None else scenario
    growth = effective_rate(details, minutes, scenario)*minutes
    head, back = radius+growth, radius+growth*.12
    a = (head+back)/2
    b = max(radius, a/min(4., 1+weather['wind']/35.))
    shift = (head-back)/2
    bearing = math.radians(weather['direction'])
    points = []
    for index in range(72):
        angle = index/72*2*math.pi
        wobble = 1+.06*math.sin(angle*5+weather['direction']/40)+.035*math.cos(angle*9)
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


def validate_scenario(details, *, minutes=5., flight_seconds=None, scenario=None, outdoor=False):
    """Reject nonphysical forecasts; open-ended flights recheck size on every cycle."""
    for key in ('area_ha', 'spread_m_per_min', 'wind_kmh', 'wind_dir_deg', 'temp_c', 'rh_pct'):
        if not finite(details.get(key)):
            raise ValueError('Contour scenario has missing or invalid '+key)
    if not (details['area_ha'] > 0 and details['spread_m_per_min'] >= 0
            and 0 <= details['wind_kmh'] <= 60 and 0 <= details['wind_dir_deg'] <= 360):
        raise ValueError('Contour scenario is outside the supported physical range')
    if not finite(minutes) or minutes < 5 or flight_seconds not in (None, 60, 300):
        raise ValueError('Contour requires the five-minute horizon and supported mission duration')
    if scenario is not None:
        if not all(finite(scenario.get(key)) for key in ('wind', 'direction', 'dryness', 'temp', 'rh')):
            raise ValueError('Contour live-weather scenario has missing or invalid values')
        if not (0 <= scenario['wind'] <= 60 and 0 <= scenario['direction'] < 360
                and 0 <= scenario['dryness'] <= 100 and 0 <= scenario['rh'] <= 100):
            raise ValueError('Contour live weather is outside the supported physical range')
    radius_limit = OUTDOOR_MAX_CONTOUR_RADIUS_M if outdoor else MAX_CONTOUR_RADIUS_M
    end = footprint(details, minutes+(flight_seconds or 0)/60., scenario)
    if max(math.hypot(*point) for point in end) > radius_limit:
        raise ValueError(f'Forecast contour exceeds the {radius_limit:g} m demo radius; use the Tiny marker')


@dataclass(frozen=True)
class GPSFix:
    """An actual SDK location event; accuracy is horizontal root-sum-square metres."""
    at: float
    latitude: float
    longitude: float
    accuracy_m: float
    fixed: bool


def gps_accuracy_from_components(latitude_accuracy, longitude_accuracy):
    """Bound integer SDK precision conservatively; zero means sub-metre, not perfect GPS.

    The SDK fields are whole metres, with negative values meaning unavailable.
    Adding one metre per axis covers either rounding or truncation before RSS.
    """
    if not all(finite(value) and value >= 0 for value in (latitude_accuracy, longitude_accuracy)):
        return None
    return math.hypot(latitude_accuracy+1., longitude_accuracy+1.)


def gps_reason(fix, now, *, max_accuracy_m=MAX_GPS_ACCURACY_M):
    """Fail closed on stale, unknown, synthetic or insufficiently accurate GPS."""
    if fix is None or fix.fixed is not True:
        return 'Contour requires an actual aircraft GPS fix; no indoor/simulated fallback'
    if not all(finite(value) for value in (fix.at, fix.latitude, fix.longitude, fix.accuracy_m)):
        return 'Contour GPS coordinates or reported accuracy are unavailable'
    if not 0 <= now-fix.at <= 1.5:
        return 'Contour GPS location event is stale'
    if not -85 <= fix.latitude <= 85 or not -180 <= fix.longitude <= 180:
        return 'Contour GPS coordinates are invalid'
    if not 0 < fix.accuracy_m <= max_accuracy_m:
        return f'Contour requires reported horizontal GPS accuracy of {max_accuracy_m:g} m or better'
    return None


class GPSMovementWatchdog:
    """Cross-check received GPS against acknowledged movement; never supply navigation.

    Commands are not measurements. Only successful moveByEnd displacement is
    accumulated, rotated with the measured heading at that command's start.
    This independent fault detector catches a fresh but frozen GPS stream.
    """

    def __init__(self):
        """Wait for the first valid GPS baseline before accumulating measured displacement."""
        self.baseline = None
        self.north_m = self.east_m = self.travel_m = 0.

    def record(self, actual, yaw):
        """Accumulate acknowledged body displacement in north/east metres, never requested moves."""
        if self.baseline is None:
            raise InterruptedError('Contour movement consistency has no GPS baseline')
        if (not isinstance(actual, (list, tuple)) or len(actual) < 2
                or not all(finite(value) for value in (actual[0], actual[1], yaw))):
            raise InterruptedError('Contour acknowledged displacement is invalid')
        self.north_m += actual[0]*math.cos(yaw)-actual[1]*math.sin(yaw)
        self.east_m += actual[0]*math.sin(yaw)+actual[1]*math.cos(yaw)
        self.travel_m += math.hypot(actual[0], actual[1])

    def observe(self, fix, *, allow_reset=False):
        """Reject divergent GPS and reset only after a coherent ten-metre GPS displacement."""
        if self.baseline is None:
            self.baseline = fix
            return
        gps = local_offset((self.baseline.latitude, self.baseline.longitude),
                           (fix.latitude, fix.longitude))
        measured = (self.north_m, self.east_m)
        # Two reported GPS bounds, a two-metre event-latency margin and 10%
        # allowance for accumulated moveByEnd uncertainty tolerate quantization.
        allowance = self.baseline.accuracy_m+fix.accuracy_m+2.+.1*self.travel_m
        if math.dist(gps, measured) > allowance:
            raise InterruptedError('Contour GPS disagrees with acknowledged aircraft movement; location may be frozen')
        # A pending command can already move the GPS before moveByEnd arrives.
        # Reset only after its actual displacement has been recorded, otherwise
        # the new baseline would include motion not yet in the acknowledgement.
        if allow_reset and self.travel_m > 0 and math.hypot(*gps) >= max(10., 2.*fix.accuracy_m):
            self.baseline = fix
            self.north_m = self.east_m = self.travel_m = 0.


@dataclass(frozen=True)
class ContourPlan:
    """Frozen general-area anchor, original launch GPS and monotonic model epoch."""
    anchor: tuple
    launch: tuple
    details: dict
    model_started: float
    started_at: float
    scenario: dict = None
    outdoor: bool = False
    wind: dict = None
    wind_status: str = None
    wind_reason: str = None
    wind_updated_at: float = None

    def __post_init__(self):
        """Detach immutable scenario inputs so later status/control writes cannot alter flight."""
        object.__setattr__(self, 'details', MappingProxyType(dict(self.details)))
        if self.scenario is not None:
            object.__setattr__(self, 'scenario', MappingProxyType(dict(self.scenario)))
        if self.wind is not None:
            object.__setattr__(self, 'wind', MappingProxyType(dict(self.wind)))

    def with_weather(self, snapshot):
        """Replace live wind immutably; missing, stale or invalid estimates never use QR wind."""
        if not isinstance(snapshot, dict) or snapshot.get('source') != 'flight-controller':
            raise ValueError('Contour requires a fresh flight-controller wind estimate')
        speed, direction, age = (snapshot.get(key) for key in ('speed_mps', 'direction_deg', 'age_s'))
        if not finite(age) or not 0 <= age <= 5:
            raise ValueError('Contour flight-controller wind estimate is stale')
        if not finite(speed) or not 0 <= speed <= 60/3.6:
            raise ValueError('Contour flight-controller wind speed is unavailable or outside model limits')
        if direction is None and speed == 0:
            # Calm has no observed direction. Zero is solely the model's canonical
            # orientation; the raw provenance retains its actual null bearing.
            direction = 0.
        if not finite(direction) or not 0 <= direction < 360:
            raise ValueError('Contour flight-controller wind direction is unavailable')
        try:
            observed = datetime.fromisoformat(snapshot['observed_at'].replace('Z', '+00:00'))
            if observed.tzinfo is None:
                raise ValueError('missing timezone')
        except (KeyError, AttributeError, TypeError, ValueError) as error:
            raise ValueError('Contour flight-controller wind observation time is invalid') from error
        scenario = {**scenario_from(self.details), 'wind': min(60., speed*3.6), 'direction': direction}
        validate_scenario(self.details, scenario=scenario, outdoor=self.outdoor)
        return replace(self, scenario=scenario, wind=dict(snapshot), wind_status='measured',
                       wind_reason=None)

    def wind_age(self, now):
        """Age the original aircraft observation using monotonic elapsed time, never UI time."""
        if self.wind is None or self.wind.get('source') != 'flight-controller':
            return None
        age = self.wind.get('age_s')
        if not finite(age):
            return None
        return age+max(0., now-self.wind_updated_at) if finite(self.wind_updated_at) else age

    def update_weather(self, snapshot, now, reason=None):
        """Use valid wind or continue with a labelled last estimate/encoded assumption.

        Missing weather does not end flight. A retained aircraft estimate keeps
        its original receipt time; an initial marker assumption has no invented
        measurement time. Actual GPS, aircraft and forecast bounds remain gates.
        """
        try:
            updated = self.with_weather(snapshot)
        except ValueError as error:
            explanation = reason or str(error)
            if self.wind is not None and self.wind.get('source') == 'flight-controller' and self.scenario is not None:
                return replace(self, wind_status='stale', wind_reason=explanation)
            assumed = {'source': 'qr-scenario-assumption',
                       'speed_mps': self.details['wind_kmh']/3.6,
                       'direction_deg': self.details['wind_dir_deg'],
                       'observed_at': None, 'age_s': None}
            return replace(self, scenario=scenario_from(self.details), wind=assumed,
                           wind_status='assumed', wind_reason=explanation, wind_updated_at=None)
        return replace(updated, wind_updated_at=now)

    def minutes(self, now):
        """Use monotonic real time so clock or browser replay changes cannot accelerate flight."""
        return FORECAST_MINUTES+max(0., now-self.model_started)/60.

    def status(self, now):
        """Expose the exact model inputs and measured anchor for the dashboard overlay."""
        result = {'anchor': {'latitude': self.anchor[0], 'longitude': self.anchor[1], 'position_source': 'gps'},
                'forecast_minutes': FORECAST_MINUTES, 'started_at': self.started_at,
                'details': dict(self.details), 'speed_mps': patrol_speed(self.details, self.minutes(now), self.scenario, outdoor=self.outdoor)}
        if self.outdoor:
            wind = dict(self.wind) if self.wind is not None else None
            age = self.wind_age(now)
            if wind is not None and wind.get('source') == 'flight-controller':
                wind['age_s'] = age
            stale = age is not None and age > 5
            result.update(profile='outdoor-50m-live-wind',
                          effective_scenario=dict(self.scenario) if self.scenario is not None else None,
                          wind=wind, wind_status='stale' if stale else self.wind_status,
                          wind_reason=(self.wind_reason or 'Wind observation is stale; continuing with the last valid estimate')
                                      if stale else self.wind_reason,
                          patrol_growth_multiplier=300, patrol_min_speed_mps=.5,
                          patrol_max_speed_mps=1.)
        return result


def contour_vehicle_reason(vehicle, limits, now, *, min_battery_pct=40, outdoor=False):
    """Retain inherited protections, with an explicit 1.25 m/s outdoor motion ceiling."""
    reason = vehicle_reason(vehicle, limits, now, min_battery_pct=min_battery_pct)
    if (outdoor and reason == 'aircraft is moving or tilted beyond the limit'
            and finite(vehicle.speed_mps) and 0 <= vehicle.speed_mps <= 1.25
            and finite(vehicle.tilt_deg) and abs(vehicle.tilt_deg) <= 12):
        return None
    return reason


def run_contour(driver, limits, plan, sample, abort, report, *, started,
                flight_seconds=None, min_battery_pct=40, clock=time.monotonic, sleep=time.sleep,
                wind_snapshot=None, report_plan=None, wind_reason=None):
    """Follow growing GPS waypoints with bounded SDK moves and per-command watchdogs.

    `sample` owns live session/heartbeat checks and returns vehicle, GPS and yaw.
    Every movement rechecks it while awaiting acknowledgement. The caller owns
    takeoff and guaranteed landing; this function never owns a second aircraft.
    """
    if min_battery_pct not in (25, 40) or (min_battery_pct == 25 and flight_seconds != 60):
        raise ValueError('Reduced battery threshold requires the short-test time limit')
    validate_scenario(plan.details, minutes=plan.minutes(clock()), flight_seconds=flight_seconds,
                      scenario=plan.scenario, outdoor=plan.outdoor)
    previous_fix = None
    movement_watchdog = GPSMovementWatchdog() if plan.outdoor else None
    accuracy_limit = OUTDOOR_MAX_GPS_ACCURACY_M if plan.outdoor else MAX_GPS_ACCURACY_M
    launch_limit = OUTDOOR_MAX_LAUNCH_DISTANCE_M if plan.outdoor else MAX_LAUNCH_DISTANCE_M
    move_limit, motion_ceiling = (2., 1.25) if plan.outdoor else (.2, .45)

    def check():
        """Update weather without ending flight; validate aircraft, GPS and launch displacement."""
        nonlocal previous_fix, plan
        now = clock()
        if abort.is_set():
            raise InterruptedError('Operator requested landing')
        if flight_seconds is not None and now-started >= flight_seconds:
            raise InterruptedError(f'{flight_seconds}-second contour response limit reached')
        if plan.outdoor or wind_snapshot is not None:
            try:
                snapshot = wind_snapshot() if wind_snapshot is not None else None
                explanation = wind_reason() if wind_reason is not None and snapshot is None else None
            except Exception as error:
                snapshot = None
                explanation = f'Aircraft wind estimate unavailable ({type(error).__name__})'
            plan = plan.update_weather(snapshot, now, explanation)
            try:
                validate_scenario(plan.details, minutes=plan.minutes(now),
                                  scenario=plan.scenario, outdoor=plan.outdoor)
            except ValueError as error:
                raise InterruptedError(str(error)) from error
            if report_plan is not None:
                report_plan(plan)
        vehicle, fix, yaw = sample()
        reason = (contour_vehicle_reason(vehicle, limits, now, min_battery_pct=min_battery_pct,
                                         outdoor=plan.outdoor)
                  or gps_reason(fix, now, max_accuracy_m=accuracy_limit))
        if reason:
            raise InterruptedError(reason)
        if not finite(yaw):
            raise InterruptedError('Contour requires a measured aircraft heading')
        position = (fix.latitude, fix.longitude)
        if math.hypot(*local_offset(plan.launch, position)) > launch_limit:
            raise InterruptedError(f'Contour exceeded the {launch_limit:g} m launch envelope')
        if previous_fix is not None and fix.at < previous_fix.at:
            raise InterruptedError('Contour GPS location events arrived out of order')
        if previous_fix is not None and fix.at > previous_fix.at:
            distance = math.hypot(*local_offset((previous_fix.latitude, previous_fix.longitude), position))
            allowance = motion_ceiling*(fix.at-previous_fix.at)+fix.accuracy_m+previous_fix.accuracy_m+.15
            if distance > allowance:
                raise InterruptedError('Contour GPS jumped beyond measured-motion bounds')
        if previous_fix is None or fix.at > previous_fix.at:
            previous_fix = fix
        if movement_watchdog is not None:
            movement_watchdog.observe(fix)
        return vehicle, fix, yaw

    vehicle, fix, yaw = check()
    points = footprint(plan.details, plan.minutes(clock()), plan.scenario)
    phase = nearest_fraction(points, local_offset(plan.anchor, (fix.latitude, fix.longitude)))
    last, failures, joined = clock(), 0, False
    report('contour', 'Following the GPS +5-minute outdoor fire forecast' if plan.outdoor
           else 'Following the GPS +5-minute Tiny fire contour at real-time growth')
    while True:
        vehicle, fix, yaw = check()
        now = clock()
        minutes = plan.minutes(now)
        # An operator-ended flight must still never outgrow its safe footprint.
        try:
            validate_scenario(plan.details, minutes=minutes, flight_seconds=None,
                              scenario=plan.scenario, outdoor=plan.outdoor)
        except ValueError as error:
            raise InterruptedError(str(error)) from error
        points = footprint(plan.details, minutes, plan.scenario)
        speed = patrol_speed(plan.details, minutes, plan.scenario, outdoor=plan.outdoor)
        position = local_offset(plan.anchor, (fix.latitude, fix.longitude))
        if plan.outdoor:
            # Place the next target ahead of the received GPS projection. A
            # centimetre target cannot be followed by whole-metre GPS: its
            # virtual phase can otherwise stall while every real fix is noisy.
            nearest = nearest_fraction(points, position)
            entry = point_at(points, nearest)
            joined = joined or math.dist(position, entry) <= max(1., fix.accuracy_m)
            lookahead = max(2., 2.*fix.accuracy_m) if joined else 0.
            phase = nearest+lookahead/perimeter(points)
        else:
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
                actual = driver.move((0., 0., down, 0.), .1, check)
                if movement_watchdog is not None:
                    movement_watchdog.record(actual, yaw)
                    _, updated_fix, _ = check()
                    movement_watchdog.observe(updated_fix, allow_reset=True)
            else:
                sleep(.1)
            continue
        step = min(move_limit, distance)
        north, east = north*step/distance, east*step/distance
        forward = north*math.cos(yaw)+east*math.sin(yaw)
        right = -north*math.sin(yaw)+east*math.cos(yaw)
        bearing = math.atan2(-position[1], -position[0])
        turn = max(-.2, min(.2, (bearing-yaw+math.pi) % (2*math.pi)-math.pi))
        down = max(-.1, min(.1, .7*(vehicle.altitude_m-limits.height_m)))
        actual = driver.move((forward, right, down, turn), max(.05, speed), check)
        if movement_watchdog is not None:
            movement_watchdog.record(actual, yaw)
            _, updated_fix, _ = check()
            movement_watchdog.observe(updated_fix, allow_reset=True)
        progress = (actual[0]*forward+actual[1]*right)/step
        failures = failures+1 if progress < step*.2 else 0
        if failures >= 3:
            raise InterruptedError('Contour aircraft made insufficient progress on three movements')
        sleep(.05)
