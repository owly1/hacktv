"""Aircraft-independent guarded driver protocol; callbacks own SDK message bindings."""
import math
import time


class Driver:
    """Bounded acknowledged motion and explicit stop/landing; injectable for tests."""
    def __init__(self, send_move, send_stop, send_land, clock=time.monotonic, sleep=time.sleep):
        """Bind movement/stop/landing callbacks without connecting to an aircraft."""
        self.send_move, self.send_stop, self.send_land = send_move, send_stop, send_land
        self.clock, self.sleep = clock, sleep

    def move(self, offset, speed, check):
        """Send one horizontal step and verify its completion and measured displacement.

        send_move returns (expectation, read_actual). Every wait rechecks current
        evidence; cancelling the expectation is not considered a physical stop.
        The session always calls stop() after a failed or interrupted move.
        """
        if (len(offset) != 4 or not all(math.isfinite(v) for v in offset)
                or math.hypot(*offset[:2]) > 1.001 or offset[2:] != (0., 0.)
                or not .1 <= speed <= .5):
            raise ValueError('driver rejected out-of-envelope movement')
        check()
        pending, actual = self.send_move(offset, speed)
        deadline = self.clock()+8
        try:
            while not pending.done():
                check()
                if self.clock() >= deadline:
                    raise TimeoutError('retreat command timed out')
                self.sleep(.05)
            check()
            if not pending.success():
                raise RuntimeError('aircraft rejected retreat')
            values = actual()
            if (values is None or len(values) != 4 or not all(math.isfinite(v) for v in values)
                    or math.hypot(values[0]-offset[0], values[1]-offset[1]) > .2
                    or abs(values[2]) > .1 or abs(values[3]) > .1):
                raise RuntimeError('retreat displacement was not confirmed within tolerance')
        finally:
            pending.cancel()

    def stop(self):
        """Interrupt physical relative movement and require a new confirmed hover."""
        return self.send_stop()

    def land(self):
        """Land only on an explicit operator request, with confirmed touchdown required."""
        return self.send_land()
