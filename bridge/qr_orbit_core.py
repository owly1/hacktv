"""One-shot QR orbit logic. No SDK, network, takeoff or motor commands here."""
from dataclasses import dataclass
import math
import time

from fire_detection import FIRE_MARKER_PAYLOAD


@dataclass(frozen=True)
class Limits:
    radius_m: float = 1.0
    height_m: float = 1.0
    speed_mps: float = .25
    segments: int = 12
    arm_seconds: float = 20.0
    mission_seconds: float = 75.0

    def __post_init__(self):
        for value, low, high in ((self.radius_m, .75, 1.5), (self.height_m, .8, 1.5),
                                 (self.speed_mps, .1, .3), (self.arm_seconds, 5, 30),
                                 (self.mission_seconds, 30, 90)):
            if not math.isfinite(value) or not low <= value <= high:
                raise ValueError("Orbit settings exceed the bounded demonstration envelope")
        if not isinstance(self.segments, int) or not 12 <= self.segments <= 24:
            raise ValueError("Use 12-24 polygon segments")


@dataclass(frozen=True)
class Vehicle:
    at: float  # monotonic time of the oldest required received sensor event
    connected: bool
    state: str
    battery_pct: float
    altitude_m: float
    speed_mps: float
    tilt_deg: float
    controller_source_ok: bool = True


@dataclass(frozen=True)
class Marker:
    at: float  # capture time, never the time decoding finished
    text: str
    forward_m: float
    right_m: float
    down_m: float
    floor_tilt_deg: float
    reprojection_px: float


def vehicle_reason(v, limits, now, starting=False):
    if v is None or not v.connected or not 0 <= now - v.at <= 1.0:
        return "aircraft link or received sensor samples are stale"
    if v.controller_source_ok is not True:
        return "physical controller piloting source is unverified or has changed"
    values = (v.battery_pct, v.altitude_m, v.speed_mps, v.tilt_deg)
    if any(not isinstance(x, (int, float)) or not math.isfinite(x) for x in values):
        return "required aircraft state is unknown"
    if v.battery_pct < 40:
        return "battery below 40%"
    if v.state not in (("hovering",) if starting else ("hovering", "flying")):
        return "a pilot-established hover is required" if starting else "unexpected flight state"
    if abs(v.altitude_m - limits.height_m) > .2:
        return "height outside the planned hover band"
    if v.speed_mps > (.15 if starting else .45) or abs(v.tilt_deg) > (5 if starting else 12):
        return "aircraft is moving or tilted beyond the limit"
    return None


def marker_reason(m, expected, limits, now):
    if m is None or m.text != expected or not 0 <= now - m.at <= .8:
        return "the selected QR marker is missing or stale"
    numbers = (m.forward_m, m.right_m, m.down_m, m.floor_tilt_deg, m.reprojection_px)
    if not all(math.isfinite(x) for x in numbers):
        return "marker pose is invalid"
    if abs(m.forward_m - limits.radius_m) > .18 or abs(m.right_m) > .15:
        return "marker must be one orbit radius ahead, centered in the flight direction"
    if abs(m.down_m - limits.height_m) > .2 or m.floor_tilt_deg > 12 or m.reprojection_px > 2:
        return "marker must lie flat on the launch floor with a consistent calibrated pose"
    return None


class Trigger:
    """Explicit arm -> five fresh, consistent observations -> exactly one flight.

    A code visible before arming cannot count. Expiry, cancellation, or completion
    consumes this instance; restart and explicitly arm again for another attempt.
    """
    def __init__(self, expected, limits):
        if expected != FIRE_MARKER_PAYLOAD:
            raise ValueError(f"Only the fire marker {FIRE_MARKER_PAYLOAD} can be selected")
        self.expected, self.limits = expected, limits
        self.state = "disarmed"
        self.arm_at = self.last_at = None
        self.hits = 0
        self.first = None
        self.reason = "pilot has not armed the orbit"

    def arm(self, now):
        if self.state != "disarmed":
            raise ValueError("This arming session is already consumed; restart to try again")
        self.state, self.arm_at, self.reason = "armed", now, "waiting for the selected QR marker"

    def cancel(self, reason="operator cancelled"):
        self.state, self.reason = "cancelled", reason

    def observe(self, marker, vehicle, now, rehearsal=False):
        if self.state != "armed":
            return False
        if now - self.arm_at >= self.limits.arm_seconds:
            self.cancel("arming expired")
            return False
        reason = None if rehearsal else vehicle_reason(vehicle, self.limits, now, starting=True)
        if reason is None:
            reason = (None if marker and marker.text == self.expected and 0 <= now-marker.at <= 2
                      else "the selected QR marker is missing or stale") if rehearsal else marker_reason(
                          marker, self.expected, self.limits, now)
        if reason:
            self.hits, self.first, self.reason = 0, None, reason
            return False
        if marker.at <= self.arm_at or (self.last_at is not None and marker.at <= self.last_at):
            return False  # A repeated video frame is never another recognition.
        self.last_at = marker.at
        if self.first is None or marker.at - self.first.at > 2:
            self.first, self.hits = marker, 0
        if not rehearsal and math.hypot(marker.forward_m-self.first.forward_m,
                                        marker.right_m-self.first.right_m) > .08:
            self.first, self.hits = marker, 0
        self.hits += 1
        self.reason = f"stable QR observations: {self.hits}/5"
        if self.hits >= 5 and marker.at - self.first.at >= .8:
            self.state, self.reason = "triggered", "one-shot orbit triggered"
            return True
        return False


def polygon(limits):
    """Body axes: x forward, y right, z down. Face the center after each chord.

    QR center is (radius, 0) from the starting hover. Rotation does not bend
    an Olympe relative move. Each chord ends with a 360/N heading change.
    """
    angle = 2 * math.pi / limits.segments
    return [(limits.radius_m * (1-math.cos(angle)), -limits.radius_m * math.sin(angle),
             0.0, angle) for _ in range(limits.segments)]


def fly_once(driver, limits, expected, sample, abort, report, clock=time.monotonic, sleep=time.sleep,
             one_segment=False):
    """Driver.move is cancellable and bounded; driver.land must confirm landed.

    No takeoff: the pilot supplies the initial hover. A watchdog failure lands
    at the current location rather than searching for a lost marker.
    """
    started = clock()

    def check():
        if abort.is_set():
            raise InterruptedError("operator requested landing")
        if clock() - started > limits.mission_seconds:
            raise InterruptedError("mission time limit")
        v, m = sample()
        reason = vehicle_reason(v, limits, clock())
        if reason is None:
            # During a chord the bearing changes, so check full pose at each hover.
            if m is None or m.text != expected or not 0 <= clock()-m.at <= 1.5:
                reason = "selected QR marker lost"
        if reason:
            raise InterruptedError(reason)

    try:
        check()
        v, m = sample()
        reason = vehicle_reason(v, limits, clock(), starting=True) or marker_reason(m, expected, limits, clock())
        if reason:
            raise InterruptedError(reason)
        moves = polygon(limits)[:1] if one_segment else polygon(limits)
        for step, move in enumerate(moves, 1):
            check()
            report("circle", f"QR TEST: segment {step}/{len(moves)} of a {limits.segments}-sided path", step, len(moves))
            driver.move(move, limits.speed_mps, check)
            # Require a genuinely new frame captured after this move completed.
            completed, settle_until = clock(), clock() + 2.0
            while True:
                check()
                v, m = sample()
                if (m and m.at > completed and v.state == "hovering"
                        and marker_reason(m, expected, limits, clock()) is None):
                    break
                if clock() >= settle_until:
                    raise InterruptedError("marker pose/hover did not recover after the segment")
                sleep(.05)
    except Exception as error:
        report("aborted", str(error), None, None)
    finally:
        report("landing", "requesting landing at current location", None, None)
        try:
            confirmed = driver.land()
        except Exception:
            confirmed = False
        if confirmed:
            report("landed", "aircraft confirmed landed", None, None)
        else:
            report("error", "LANDING UNCONFIRMED: pilot intervention required", None, None)
