"""QR-circle decisions and geometry; no SDK, network, or motor commands."""
import math
import time

from fire_detection import FIRE_MARKER_PAYLOAD
from qr_orbit_core import marker_reason, vehicle_reason


class ScanGate:
    """One session: five distinct scans, an accepted incident, then one takeoff.

    A dropped frame resets confirmation. A backend acknowledgment expires after
    five seconds; neither an old incident nor a replay can authorize a mission.
    The caller serializes access with its takeoff lock.
    """
    def __init__(self, expected):
        """Restrict a one-use scan/incident gate to the pinned fire-marker payload."""
        if expected != FIRE_MARKER_PAYLOAD:
            raise ValueError('Only the FireSimulationDemo marker can authorize automatic flight')
        self.expected = expected
        self.last_at = self.first_at = None
        self.hits = 0
        self.ack_at = None
        self.used = False

    def observe(self, text, captured, now):
        """Count distinct fresh selected-QR frames, resetting gaps or mismatches."""
        if self.used:
            return False
        if text != self.expected or not 0 <= now-captured <= .8:
            self.hits, self.first_at, self.ack_at = 0, None, None
            return False
        if self.last_at is not None and captured <= self.last_at:
            return False
        if self.last_at is not None and captured-self.last_at > .5:
            self.hits, self.first_at, self.ack_at = 0, None, None
        self.last_at = captured
        if self.first_at is None:
            self.first_at = captured
        self.hits += 1
        return self.stable(now)

    def stable(self, now):
        """Require five hits spanning at least 0.8 seconds and a still-fresh latest frame."""
        return (not self.used and self.last_at is not None and self.hits >= 5
                and self.last_at-self.first_at >= .8 and 0 <= now-self.last_at <= .8)

    def acknowledge(self, response, now):
        """Accept a backend incident identifier only while its scan evidence remains stable."""
        if (isinstance(response, dict) and response.get('accepted') is True
                and isinstance(response.get('id'), str) and response['id'] and self.stable(now)):
            self.ack_at = now
            return True
        return False

    def consume(self, now):
        """Consume fresh recognition plus a recent backend acknowledgement exactly once."""
        if self.stable(now) and self.ack_at is not None and 0 <= now-self.ack_at <= 5:
            self.used = True
            return True
        return False


def acquisition_reason(marker, expected, limits, now):
    """Reject stale, off-floor or out-of-envelope measured marker geometry after takeoff."""
    if marker is None or marker.text != expected or not 0 <= now-marker.at <= .8:
        return 'selected QR pose missing or stale'
    values = (marker.forward_m, marker.right_m, marker.down_m,
              marker.floor_tilt_deg, marker.reprojection_px)
    if not all(math.isfinite(v) for v in values):
        return 'invalid QR geometry'
    radius = math.hypot(marker.forward_m, marker.right_m)
    bearing = math.atan2(marker.right_m, marker.forward_m)
    if abs(radius-limits.radius_m) > .3 or abs(bearing) > math.radians(20):
        return 'place the floor marker about one metre in front of the launch point'
    if abs(marker.down_m-limits.height_m) > .2 or marker.floor_tilt_deg > 12 or marker.reprojection_px > 2:
        return 'QR must be flat on the launch floor with a reliable calibrated pose'
    return None


def centered_move(marker, radius, angle=0):
    """End one radius from the measured center, with the aircraft facing it.

    Angle zero corrects the initial hover. Positive angles travel left around
    the marker in level body forward/right/down coordinates.
    """
    yaw = math.atan2(marker.right_m, marker.forward_m) + angle
    return (marker.forward_m-radius*math.cos(yaw),
            marker.right_m-radius*math.sin(yaw), 0.0, yaw)


def camera_pitch(marker, offset=(0, 0, 0)):
    """Calculate downward gimbal degrees toward the marker after camera-offset correction."""
    forward, right, down = (marker.forward_m-offset[0], marker.right_m-offset[1], marker.down_m-offset[2])
    return max(-90., min(0., -math.degrees(math.atan2(down, math.hypot(forward, right)))))


def circle(driver, limits, expected, sample, abort, report, *, started=None,
           clock=time.monotonic, sleep=time.sleep):
    """Acquire measured QR, correct a short offset, then one 24-chord circle.

    The caller owns takeoff and guaranteed landing in its finally block.
    Each chord is recalculated from the measured target, not fictitious GPS.
    """
    started = clock() if started is None else started
    def check(require_marker=True):
        """Poll cancellation, mission deadline, aircraft health and optional marker freshness."""
        if abort.is_set():
            raise InterruptedError('landing requested')
        if clock()-started > limits.mission_seconds:
            raise InterruptedError('mission time limit')
        v, m = sample()
        reason = vehicle_reason(v, limits, clock())
        if require_marker and (m is None or m.text != expected or not 0 <= clock()-m.at <= 1.5):
            reason = reason or 'selected QR marker lost'
        if reason:
            raise InterruptedError(reason)
        return v, m

    # No horizontal searching. Require five coherent, post-takeoff poses.
    deadline, last, first, hits = clock()+5, None, None, 0
    while True:
        v, m = check(False)
        reason = vehicle_reason(v, limits, clock(), starting=True) or acquisition_reason(m, expected, limits, clock())
        if reason:
            hits, first = 0, None
        elif last is None or m.at > last:
            if first is None or math.dist((m.forward_m, m.right_m), (first.forward_m, first.right_m)) > .08:
                first, hits = m, 0
            last, hits = m.at, hits+1
            if hits >= 5 and m.at-first.at >= .8:
                break
        if clock() >= deadline:
            raise InterruptedError(reason or 'QR pose did not stabilize after takeoff')
        sleep(.05)

    def settle(completed):
        """Require a fresh centred marker and stable hover after the last move, with a timeout."""
        until = clock()+2
        while True:
            v, m = check()
            if (m.at > completed and vehicle_reason(v, limits, clock(), starting=True) is None
                    and marker_reason(m, expected, limits, clock()) is None):
                return m
            if clock() >= until:
                raise InterruptedError('fresh centered QR pose did not recover after movement')
            sleep(.05)

    correction = centered_move(m, limits.radius_m)
    if math.hypot(*correction[:2]) > .35:
        raise InterruptedError('initial correction exceeds 35 cm')
    if math.hypot(*correction[:2]) > .03 or abs(correction[3]) > math.radians(2):
        report('climb', 'aligning to the measured one-metre radius', None, None)
        driver.move(correction, .15, check)
        m = settle(clock())
    for step in range(1, limits.segments+1):
        check()
        move = centered_move(m, limits.radius_m, 2*math.pi/limits.segments)
        if math.hypot(*move[:2]) > .5 or abs(move[3]) > math.radians(30):
            raise InterruptedError('measured correction exceeds the orbit envelope')
        report('circle', 'one-metre radius around the measured QR; camera tracking', step, limits.segments)
        driver.move(move, limits.speed_mps, check)
        m = settle(clock())
