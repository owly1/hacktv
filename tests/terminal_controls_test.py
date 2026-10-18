"""No-aircraft tests for immediate terminal landing input."""
import os
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parents[1] / "bridge"))
from terminal_controls import CommandInput, immediate_keys


class InputTests(unittest.TestCase):
    def test_landing_key_preempts_typed_arm_in_the_same_batch(self):
        """Verify landing key preempts typed arm in the same batch."""
        for key in (b"x", b"X", b"\x1b"):
            parser = CommandInput()
            parser.feed(b"ARM QR ")
            self.assertEqual(parser.feed(b"ORBIT\n"+key), ["LAND"])
            self.assertEqual(parser.feed(b"\n"), [])

    def test_arm_requires_enter_and_survives_fragmentation(self):
        """Verify arm requires enter and survives fragmentation."""
        parser = CommandInput()
        self.assertEqual(parser.feed(b"ARM QR "), [])
        self.assertEqual(parser.feed(b"ORBIT"), [])
        self.assertEqual(parser.feed(b"\r\n"), ["ARM QR ORBIT"])

    def test_land_line_backspace_eof_and_length_bound(self):
        """Verify land line backspace eof and length bound."""
        parser = CommandInput()
        self.assertEqual(parser.feed(b"LANF\x7fD\n"), ["LAND"])
        self.assertEqual(parser.feed(b"ARM\x04"), ["CLOSE"])
        parser.feed(b"A"*1000)
        self.assertLessEqual(len(parser.pending), 128)

    @unittest.skipUnless(os.name == "posix", "Pi/Linux terminal settings")
    def test_terminal_settings_are_restored_after_error(self):
        """Verify terminal settings are restored after error."""
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
                restored = termios.tcgetattr(slave)
                # Darwin sets PENDIN when restoring canonical mode so queued
                # input can be retyped. This is kernel state, not an unrestored
                # operator setting; still compare every other flag and byte.
                if sys.platform == "darwin":
                    restored[3] &= ~termios.PENDIN
                    original[3] &= ~termios.PENDIN
                self.assertEqual(restored, original)
        finally:
            os.close(master)
            os.close(slave)


if __name__ == "__main__":
    unittest.main()
