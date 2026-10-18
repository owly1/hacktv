"""Fresh flight-controller wind observations, independent of an aircraft SDK.

Only received vector events can refresh a measurement. Availability and feature
capabilities are separate: a supported sensor may have no usable estimate yet.
"""
from datetime import datetime, timezone
import math
import threading


MAX_WIND_AGE_S = 5.


def finite(value):
    """Accept physical numbers without interpreting booleans as measurements."""
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def wind_vector(north, east):
    """Convert received NED metres/second into speed and clockwise TOWARD degrees."""
    if not finite(north) or not finite(east):
        raise ValueError('Flight-controller wind vector is invalid')
    speed = math.hypot(north, east)
    if not math.isfinite(speed):
        raise ValueError('Flight-controller wind vector magnitude is invalid')
    return speed, math.degrees(math.atan2(east, north)) % 360. if speed else None


class WindMeasurement:
    """Keep connection-local sensor evidence under a callback/polling lock."""

    def __init__(self, *, sdk_available=True):
        """Start unknown; an SDK import is never evidence of aircraft support."""
        self.sdk_available = sdk_available
        self.supported = None
        self.available = None
        self.sample = None
        self.invalid_reason = None
        self.state_received = threading.Event()
        self.lock = threading.RLock()

    def receive_state(self, values):
        """Record only explicit device availability/capabilities, including an empty feature list."""
        if not isinstance(values, dict):
            return
        with self.lock:
            availability = values.get('is_wind_speed_available')
            if isinstance(availability, bool):
                self.available = availability
                if not availability:
                    # A new availability period needs its own vector. An old
                    # estimate cannot spring back to life after sensor loss.
                    self.sample = None
            capabilities = values.get('default_capabilities')
            if isinstance(capabilities, dict) and isinstance(capabilities.get('supported_features'), (list, tuple)):
                features = capabilities['supported_features']
                self.supported = any((isinstance(value, int) and not isinstance(value, bool) and value == 0)
                                     or str(getattr(value, 'name', value)).upper().split('.')[-1] == 'WIND_SPEED_ESTIMATION'
                                     for value in features)
            self.state_received.set()

    def receive_vector(self, values, at, epoch):
        """Timestamp an actual SDK event once, preserving calm without inventing direction."""
        with self.lock:
            try:
                if not finite(at) or not finite(epoch) or not isinstance(values, dict):
                    raise ValueError('Flight-controller wind event time is invalid')
                speed, direction = wind_vector(values.get('north'), values.get('east'))
                if self.sample is not None and at < self.sample[0]:
                    raise ValueError('Flight-controller wind events arrived out of order')
                observed = datetime.fromtimestamp(epoch, timezone.utc).isoformat().replace('+00:00', 'Z')
                self.sample = (at, speed, direction, observed)
                self.invalid_reason = None
            except (ValueError, OverflowError, OSError) as error:
                self.sample = None
                self.invalid_reason = str(error)

    def reason(self, now):
        """Explain why a numeric wind sample cannot currently drive the forecast."""
        with self.lock:
            if not self.sdk_available:
                return 'This SDK does not expose numeric flight-controller wind telemetry'
            if self.supported is False:
                return 'This aircraft does not report support for numeric flight-controller wind estimates'
            if self.available is False:
                return 'Flight-controller wind estimate is not currently available'
            if self.available is not True:
                return 'Waiting for the aircraft wind availability report'
            if self.invalid_reason:
                return self.invalid_reason
            if self.sample is None:
                return 'Waiting for a measured flight-controller wind vector'
            if not finite(now) or not 0 <= now-self.sample[0] <= MAX_WIND_AGE_S:
                return 'Flight-controller wind measurement is stale'
            return None

    def snapshot(self, now):
        """Return a fresh measured vector with its original receipt timestamp, or None."""
        with self.lock:
            if self.reason(now):
                return None
            at, speed, direction, observed = self.sample
            return {'speed_mps': speed, 'direction_deg': direction, 'observed_at': observed,
                    'age_s': now-at, 'source': 'flight-controller'}

    def diagnostics(self, now):
        """Expose age and capability truth even when the numeric estimate is unusable."""
        with self.lock:
            age = now-self.sample[0] if self.sample is not None and finite(now) else None
            return {'available': self.available, 'supported': self.supported,
                    'observed_at': self.sample[3] if self.sample is not None else None,
                    'age_s': age if age is not None and age >= 0 else None}
