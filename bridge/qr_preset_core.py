"""QR recognition and a launch-relative preset path. No marker pose or SDK."""
from dataclasses import dataclass
import math
import time

from qr_orbit_core import polygon, vehicle_reason


@dataclass(frozen=True)
class Recognition:
    at: float
    text: str


class RecognitionTrigger:
    """An explicit arm and five fresh QR frames trigger one session, once."""
    def __init__(self, expected, arm_seconds=20):
        if not expected.startswith("EW1:") or len(expected) > 512:
            raise ValueError("Select an Emberwatch EW1 marker")
        self.expected, self.arm_seconds = expected, arm_seconds
        self.state, self.reason = "disarmed", "operator has not armed the preset"
        self.arm_at = self.first = self.last_at = None
        self.hits = 0

    def arm(self, now):
        if self.state != "disarmed":
            raise ValueError("This session is consumed; restart before another attempt")
        self.state, self.arm_at, self.reason = "armed", now, "waiting for selected QR"

    def cancel(self, reason="operator cancelled"):
        self.state, self.reason = "cancelled", reason

    def observe(self, observation, now):
        if self.state != "armed":
            return False
        if now-self.arm_at >= self.arm_seconds:
            self.cancel("QR arming expired without takeoff")
            return False
        if (observation is None or observation.text != self.expected
                or not 0 <= now-observation.at <= .8 or observation.at <= self.arm_at):
            self.first, self.hits, self.reason = None, 0, "waiting for a fresh selected QR"
            return False
        if self.last_at is not None and observation.at <= self.last_at:
            return False
        self.last_at = observation.at
        if self.first is None or observation.at-self.first > 2:
            self.first, self.hits = observation.at, 0
        self.hits += 1
        self.reason = f"fresh QR observations: {self.hits}/5"
        if self.hits >= 5 and observation.at-self.first >= .8:
            self.state, self.reason = "triggered", "QR recognized; one preset session triggered"
            return True
        return False


def fly_preset(driver, limits, sample, abort, report, hold_seconds=30, flight_started=None,
               clock=time.monotonic, sleep=time.sleep):
    """One polygon about a preset center, then firmware hover, then landing.

    This never estimates the object's position. QR is only the earlier trigger.
    The operator places the launch point one radius behind the intended center.
    The path nominally ends at the starting hover; no approach over an object
    or vision correction is commanded. All failures request controlled landing.
    """
    started = clock() if flight_started is None else flight_started

    def check(stationary=False):
        if abort.is_set():
            raise InterruptedError("operator requested landing")
        if clock()-started >= limits.mission_seconds:
            raise InterruptedError("preset flight time limit reached")
        vehicle = sample()
        reason = vehicle_reason(vehicle, limits, clock(), starting=stationary)
        if reason:
            raise InterruptedError(reason)
        return vehicle

    try:
        if not math.isfinite(hold_seconds) or not 1 <= hold_seconds <= 30:
            raise ValueError("Preset hover duration must be 1-30 seconds")
        check(stationary=True)
        moves = polygon(limits)
        for step, offset in enumerate(moves, 1):
            check()
            report("circle", f"PRESET PATH: segment {step}/{len(moves)}; object position is not tracked", step, len(moves))
            driver.move(offset, limits.speed_mps, check)
            settle_until = clock()+2
            while True:
                vehicle = check()
                if vehicle_reason(vehicle, limits, clock(), starting=True) is None:
                    break
                if clock() >= settle_until:
                    raise InterruptedError("aircraft did not settle into hover after the segment")
                sleep(.05)
        report("return", f"preset circle complete; hovering at current position until X or {hold_seconds:g} seconds", None, None)
        hold_until = clock()+hold_seconds
        while clock() < hold_until:
            check(stationary=True)
            sleep(.05)
        report("landing", "preset hover timeout reached", None, None)
    except Exception as error:
        report("aborted", str(error), None, None)
    finally:
        report("landing", "requesting landing at current position", None, None)
        try:
            confirmed = driver.land()
        except Exception:
            confirmed = False
        report("landed" if confirmed else "error", "aircraft confirmed landed" if confirmed else
               "LANDING UNCONFIRMED: check the aircraft", None, None)
