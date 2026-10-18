"""Bounded real GPS search before anchoring a QR fire, without an aircraft import.

The caller owns takeoff, the single SDK driver, camera scanning and landing.
All offsets are metres from the pre-takeoff GPS fix, never scenario coordinates.
"""
from dataclasses import replace
import math
import time

from fire_contour import (finite, gps_reason, local_offset, contour_vehicle_reason,
                          MAX_GPS_ACCURACY_M, OUTDOOR_MAX_GPS_ACCURACY_M, GPSMovementWatchdog)

SEARCH_HEIGHT_M = 1.
SEARCH_RADIUS_M = 2.
SEARCH_SPEED_MPS = .1
SEARCH_POINTS = ((.8, 0.), (.8, .8), (-.8, .8), (-.8, -.8), (.8, -.8), (.8, 0.), (0., 0.))
OUTDOOR_SEARCH_RADIUS_M = 20.
OUTDOOR_SEARCH_SPEED_MPS = .5
OUTDOOR_SEARCH_POINTS = ((10., 0.), (10., 10.), (-10., 10.), (-10., -10.),
                         (10., -10.), (10., 0.), (0., 0.))


def search_check(limits, launch, sample, abort, *, started, flight_seconds,
                 min_battery_pct, clock, outdoor=False, movement_watchdog=None):
    """Build the shared per-command search watchdog with received GPS jump checks."""
    previous = None

    def check(*, acquiring_height=False):
        """Check authorization/sensors and forbid GPS substitution or escaping the search area."""
        nonlocal previous
        now = clock()
        if abort.is_set():
            raise InterruptedError('Operator requested landing')
        if flight_seconds is not None and now-started >= flight_seconds:
            raise InterruptedError(f'{flight_seconds}-second contour response limit reached')
        vehicle, fix, yaw = sample()
        # Firmware chooses takeoff height; an initial measured climb/descent
        # may correct it, but only inside the inherited 1.5 m checkout ceiling.
        initial_height_ok = (vehicle is not None and finite(vehicle.altitude_m)
                             and .35 <= vehicle.altitude_m <= 1.5)
        checked = replace(vehicle, altitude_m=SEARCH_HEIGHT_M) if acquiring_height and initial_height_ok else vehicle
        reason = (contour_vehicle_reason(checked, limits, now, min_battery_pct=min_battery_pct,
                                         outdoor=outdoor)
                  or gps_reason(fix, now, max_accuracy_m=OUTDOOR_MAX_GPS_ACCURACY_M
                                if outdoor else MAX_GPS_ACCURACY_M))
        if reason:
            raise InterruptedError(reason)
        if not finite(yaw):
            raise InterruptedError('Contour search requires measured aircraft heading')
        position = (fix.latitude, fix.longitude)
        radius = OUTDOOR_SEARCH_RADIUS_M if outdoor else SEARCH_RADIUS_M
        if math.hypot(*local_offset(launch, position)) > radius:
            raise InterruptedError(f'Contour search exceeded the {radius:g} m launch envelope')
        if previous is not None:
            if fix.at < previous.at:
                raise InterruptedError('Contour search GPS location events arrived out of order')
            if fix.at > previous.at:
                distance = math.hypot(*local_offset((previous.latitude, previous.longitude), position))
                if distance > (1.25 if outdoor else .45)*(fix.at-previous.at)+fix.accuracy_m+previous.accuracy_m+.15:
                    raise InterruptedError('Contour search GPS jumped beyond measured-motion bounds')
        if previous is None or fix.at > previous.at:
            previous = fix
        if movement_watchdog is not None:
            movement_watchdog.observe(fix)
        return vehicle, fix, yaw

    return check


def hold_height(driver, check, *, clock=time.monotonic, sleep=time.sleep, initial=False,
                movement_watchdog=None):
    """Reach 1 m using received altitude, bounded vertical commands and progress deadlines."""
    deadline, failed = clock()+15., 0

    def guard():
        """Preserve all watchdogs during a vertical correction's acknowledgement wait."""
        return check(acquiring_height=initial)

    while True:
        vehicle, _, yaw = guard()
        error = vehicle.altitude_m-SEARCH_HEIGHT_M
        if abs(error) <= .05:
            return
        if clock() >= deadline:
            raise InterruptedError('Contour could not establish the measured 1 m height')
        down = max(-.1, min(.1, error))
        actual = driver.move((0., 0., down, 0.), SEARCH_SPEED_MPS, guard)
        if movement_watchdog is not None:
            movement_watchdog.record(actual, yaw)
        # Both SDK displacement and fresh altitude must show actual progress.
        sleep(.05)
        after, fix, _ = guard()
        if movement_watchdog is not None:
            movement_watchdog.observe(fix, allow_reset=True)
        progress = abs(error)-abs(after.altitude_m-SEARCH_HEIGHT_M)
        failed = failed+1 if actual[2]*down <= 0 or progress < abs(down)*.2 else 0
        if failed >= 3:
            raise InterruptedError('Contour height made insufficient progress on three movements')


def run_airborne_search(driver, limits, launch, sample, abort, report, seen, acquire, *,
                        started, flight_seconds=None, min_battery_pct=40,
                        clock=time.monotonic, sleep=time.sleep, outdoor=False):
    """Patrol a small measured GPS course at 1 m until a stable Tiny plan is claimed.

    `seen` only pauses movement for a fresh exact marker. `acquire` must validate
    post-stop metric samples and claim the fire; its result becomes the frozen
    contour plan. Failed localization resumes search after a bounded hold.
    """
    if flight_seconds not in (None, 60) or min_battery_pct not in (25, 40):
        raise ValueError('Contour search supports an operator-ended mission or explicit short test')
    if min_battery_pct == 25 and flight_seconds != 60:
        raise ValueError('Reduced battery threshold requires the short-test time limit')
    movement_watchdog = GPSMovementWatchdog() if outdoor else None
    check = search_check(limits, launch, sample, abort, started=started,
                         flight_seconds=flight_seconds, min_battery_pct=min_battery_pct, clock=clock,
                         outdoor=outdoor, movement_watchdog=movement_watchdog)
    points = OUTDOOR_SEARCH_POINTS if outdoor else SEARCH_POINTS
    speed = OUTDOOR_SEARCH_SPEED_MPS if outdoor else SEARCH_SPEED_MPS
    report('holding', 'Establishing the measured 1 m search height')
    hold_height(driver, check, initial=True, clock=clock, sleep=sleep,
                movement_watchdog=movement_watchdog)
    index, failures, held_since, retry_at = 0, 0, None, float('-inf')
    report('airborne-search', 'One drone searching for Marker 2 at 1 m above launch')
    while True:
        hold_height(driver, check, clock=clock, sleep=sleep, movement_watchdog=movement_watchdog)
        vehicle, fix, yaw = check()
        now = clock()
        if seen() and now >= retry_at:
            if held_since is None:
                held_since = now
                report('acquiring', 'Marker 2 found; holding at 1 m to confirm position and encoded wind')
            if now-held_since >= .3:
                plan = acquire()
                if plan is not None:
                    check()
                    report('tracking', 'Marker 2 anchored; following its GPS five-minute forecast contour')
                    return plan
            if now-held_since < 8.:
                sleep(.05)
                continue
            retry_at = now+3.
            report('holding', 'Marker position not yet stable; resuming the bounded search')
        if held_since is not None:
            held_since = None
            report('airborne-search', 'One drone searching for Marker 2 at 1 m above launch')
        # A GPS waypoint is re-evaluated after every acknowledged move.
        position = local_offset(launch, (fix.latitude, fix.longitude))
        target = points[index]
        north, east = (target[axis]-position[axis] for axis in range(2))
        distance = math.hypot(north, east)
        tolerance = max(1., fix.accuracy_m) if outdoor else .12
        if distance <= tolerance:
            index = (index+1) % len(points)
            sleep(.05)
            continue
        step = min(2. if outdoor else .2, distance)
        forward = (north*math.cos(yaw)+east*math.sin(yaw))*step/distance
        right = (-north*math.sin(yaw)+east*math.cos(yaw))*step/distance
        direction = math.atan2(east, north)
        turn = max(-.2, min(.2, (direction-yaw+math.pi) % (2*math.pi)-math.pi))
        actual = driver.move((forward, right, 0., turn), speed, check)
        if movement_watchdog is not None:
            movement_watchdog.record(actual, yaw)
            _, updated_fix, _ = check()
            movement_watchdog.observe(updated_fix, allow_reset=True)
        progress = (actual[0]*forward+actual[1]*right)/step
        failures = failures+1 if progress < step*.2 else 0
        if failures >= 3:
            raise InterruptedError('Contour search made insufficient progress on three movements')
        sleep(.05)
