"""No-aircraft tests for immediate terminal landing input."""
import os
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parents[1] / "bridge"))
from terminal_controls import CommandInput, immediate_keys


class InputTests(unittest.TestCase):
    def test_landing_key_preempts_typed_arm_in_the_same_batch(self):
        for key in (b"x", b"X", b"\x1b"):
            parser = CommandInput()
            parser.feed(b"ARM QR ")
            self.assertEqual(parser.feed(b"ORBIT\n"+key), ["LAND"])
            self.assertEqual(parser.feed(b"\n"), [])

    def test_arm_requires_enter_and_survives_fragmentation(self):
        parser = CommandInput()
        self.assertEqual(parser.feed(b"ARM QR "), [])
        self.assertEqual(parser.feed(b"ORBIT"), [])
        self.assertEqual(parser.feed(b"\r\n"), ["ARM QR ORBIT"])

    def test_land_line_backspace_eof_and_length_bound(self):
        parser = CommandInput()
        self.assertEqual(parser.feed(b"LANF\x7fD\n"), ["LAND"])
        self.assertEqual(parser.feed(b"ARM\x04"), ["CLOSE"])
        parser.feed(b"A"*1000)
        self.assertLessEqual(len(parser.pending), 128)

    @unittest.skipUnless(os.name == "posix", "Pi/Linux terminal settings")
    def test_terminal_settings_are_restored_after_error(self):
        import pty
        import termios
        master, slave = pty.openpty()
        try:
            with os.fdopen(slave, "r", closefd=False) as stream:
                original = termios.tcgetattr(slave)
                with self.assertRaises(RuntimeError):
                    with immediate_keys(stream):
                        self.assertFalse(termios.tcgetattr(slave)[3] & termios.ICANON)
                        raise RuntimeError("operator loop stopped")
                self.assertEqual(termios.tcgetattr(slave), original)
        finally:
            os.close(master)
            os.close(slave)


if __name__ == "__main__":
    unittest.main()
