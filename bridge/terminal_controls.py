"""Terminal command input only. Contains no SDK, network or motor commands."""
import os
import select
from contextlib import contextmanager


class CommandInput:
    def __init__(self):
        self.pending = bytearray()

    def feed(self, data):
        # Landing wins over every other command in a pasted/read batch.
        if any(key in data for key in (b"\x1b", b"x", b"X")):
            self.pending.clear()
            return ["LAND"]
        result = []
        for value in data:
            if value == 4:  # Ctrl+D in noncanonical mode.
                self.pending.clear()
                return ["CLOSE"]
            if value in (10, 13):
                command = self.pending.decode("ascii", errors="ignore").strip().upper()
                self.pending.clear()
                if command:
                    result.append(command)
            elif value in (8, 127):
                if self.pending:
                    self.pending.pop()
            elif 32 <= value < 127:
                self.pending.append(value)
                if len(self.pending) > 128:
                    self.pending.clear()
        return result


@contextmanager
def immediate_keys(stream):
    """Linux/Pi TTY: retain signals and kernel echo, disable line buffering."""
    import termios
    if not stream.isatty():
        raise ValueError("An interactive Pi terminal is required for immediate landing keys")
    fd = stream.fileno()
    original = termios.tcgetattr(fd)
    current = termios.tcgetattr(fd)
    current[3] = (current[3] | termios.ISIG | termios.ECHO) & ~termios.ICANON
    current[6][termios.VMIN], current[6][termios.VTIME] = 1, 0
    termios.tcsetattr(fd, termios.TCSANOW, current)
    try:
        yield fd
    finally:
        try:
            termios.tcsetattr(fd, termios.TCSANOW, original)
        except (OSError, termios.error):
            pass  # A closed SSH terminal cannot be restored.


def commands(stream, stopped=lambda: False):
    parser = CommandInput()
    with immediate_keys(stream) as fd:
        while not stopped():
            ready, _, _ = select.select([fd], [], [], .1)
            if not ready:
                continue
            data = os.read(fd, 128)
            if not data:
                return
            for command in parser.feed(data):
                if command == "CLOSE":
                    return
                yield command
