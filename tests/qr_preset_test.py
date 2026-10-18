"""Recognition and preset-flight tests; no SDK or aircraft connections."""
from dataclasses import replace
import math
from pathlib import Path
import sys
import threading
import unittest

sys.path.insert(0, str(Path(__file__).parents[1]/"bridge"))
from qr_orbit_core import Limits, Vehicle
from qr_preset_core import Recognition, RecognitionTrigger, fly_preset

TEXT = "EW1:Alpha|120|X|35|M|30|60|31|18|18"
LIMITS = Limits(mission_seconds=90)


class RecognitionTests(unittest.TestCase):
    def test_unarmed_qr_never_triggers_and_armed_recognition_is_one_shot(self):
        """Verify unarmed qr never triggers and armed recognition is one shot."""
        trigger = RecognitionTrigger(TEXT)
        for at in (10.1, 10.3, 10.5, 10.7, 10.95):
            self.assertFalse(trigger.observe(Recognition(at, TEXT), at))
        trigger.arm(10)
        results = [trigger.observe(Recognition(at, TEXT), at) for at in (10.1, 10.3, 10.5, 10.7, 10.95)]
        self.assertEqual(results, [False]*4+[True])
        self.assertFalse(trigger.observe(Recognition(11, TEXT), 11))
        with self.assertRaises(ValueError):
            trigger.arm(11)

    def test_only_the_fire_marker_can_be_selected(self):
        """Verify only the fire marker can be selected."""
        for other in ("EW1:Ravine|300|X|35|M|45|90|31|18|18", TEXT + " ", "https://example.com"):
            with self.assertRaises(ValueError):
                RecognitionTrigger(other)

    def test_wrong_stale_future_and_prearm_frames_do_not_count(self):
        """Verify wrong stale future and prearm frames do not count."""
        for observation in (None, Recognition(11, "EW1:other"), Recognition(9, TEXT),
                            Recognition(12, TEXT), Recognition(10, TEXT)):
            trigger = RecognitionTrigger(TEXT)
            trigger.arm(10)
            self.assertFalse(trigger.observe(observation, 11))
            self.assertEqual(trigger.hits, 0)

    def test_repeated_frame_does_not_accumulate_hits(self):
        """Verify repeated frame does not accumulate hits."""
        trigger = RecognitionTrigger(TEXT)
        trigger.arm(10)
        for _ in range(10):
            self.assertFalse(trigger.observe(Recognition(10.1, TEXT), 10.1))
        self.assertEqual(trigger.hits, 1)

    def test_expiry_and_interrupted_streak_cannot_trigger(self):
        """Verify expiry and interrupted streak cannot trigger."""
        trigger = RecognitionTrigger(TEXT)
        trigger.arm(10)
        trigger.observe(Recognition(10.1, TEXT), 10.1)
        trigger.observe(None, 10.2)
        self.assertEqual(trigger.hits, 0)
        self.assertFalse(trigger.observe(Recognition(30, TEXT), 30))
        self.assertEqual(trigger.state, "cancelled")


class PresetFlightTests(unittest.TestCase):
    def fly(self, fault=None, confirmed=True, hold=30, started=10, circles=1):
        """Exercise flight logic against fake moves and a controlled clock, without aircraft access."""
        now, abort, moves, reports, lands = [10.0], threading.Event(), [], [], []
        hold_started = [None]
        class Driver:
            def move(self, offset, speed, check):
                """Record the requested relative move and simulate its result or injected failure."""
                moves.append(offset)
                now[0] += .5
                if fault == "move":
                    raise RuntimeError("SDK move failure")
                if fault == "during-circle":
                    abort.set()
                if fault == "after-two-laps" and len(moves) == 25:
                    abort.set()
                check()
            def land(self):
                """Record a fake landing attempt and return the fixture confirmation result."""
                lands.append(now[0])
                return confirmed
        def sample():
            """Return the current fake vehicle/marker sample and any injected fault."""
            vehicle = Vehicle(now[0], True, "hovering", 70, 1, 0, 0)
            if fault == "stale" and moves:
                vehicle = replace(vehicle, at=now[0]-5)
            if fault == "battery":
                vehicle = replace(vehicle, battery_pct=39)
            if fault == "height":
                vehicle = replace(vehicle, altitude_m=1.5)
            return vehicle
        def report(*message):
            """Collect emitted phase/progress messages for flight assertions."""
            reports.append(message)
            if message[0] == "return":
                hold_started[0] = now[0]
        def advance(seconds):
            """Advance the fake clock and refresh test sensor timestamps."""
            now[0] += seconds
            if fault == "during-hover" and hold_started[0] is not None and now[0]-hold_started[0] >= .2:
                abort.set()
        fly_preset(Driver(), LIMITS, sample, abort, report, hold_seconds=hold, flight_started=started,
                   clock=lambda: now[0], sleep=advance, circles=circles)
        return moves, reports, lands, hold_started[0]

    def test_one_complete_circle_then_hover_timeout_and_landing(self):
        """Verify one complete circle then hover timeout and landing."""
        moves, reports, lands, held_at = self.fly()
        self.assertEqual(len(moves), 12)
        self.assertGreaterEqual(lands[0]-held_at, 30)
        self.assertEqual(reports[-1][0], "landed")
        x = y = yaw = 0
        for dx, dy, dz, turn in moves:
            x, y = x+dx*math.cos(yaw)-dy*math.sin(yaw), y+dx*math.sin(yaw)+dy*math.cos(yaw)
            yaw += turn
            self.assertEqual(dz, 0)
        self.assertAlmostEqual(x, 0)
        self.assertAlmostEqual(y, 0)

    def test_x_during_circle_or_hover_stops_and_lands(self):
        """Verify x during circle or hover stops and lands."""
        for fault, count in (("during-circle", 1), ("during-hover", 12)):
            moves, reports, lands, _ = self.fly(fault)
            self.assertEqual(len(moves), count)
            self.assertEqual(len(lands), 1)
            self.assertEqual(reports[-1][0], "landed")

    def test_sensor_battery_height_and_sdk_faults_land(self):
        """Verify sensor battery height and sdk faults land."""
        for fault, count in (("stale", 1), ("battery", 0), ("height", 0), ("move", 1)):
            moves, reports, lands, _ = self.fly(fault)
            self.assertEqual(len(moves), count)
            self.assertTrue(any(entry[0] == "aborted" for entry in reports))
            self.assertEqual(len(lands), 1)

    def test_total_flight_cap_and_invalid_hover_never_move(self):
        """Verify total flight cap and invalid hover never move."""
        for options in ({"started": -100}, {"hold": 0}, {"hold": float("nan")}, {"hold": 31}):
            moves, reports, lands, _ = self.fly(**options)
            self.assertEqual(moves, [])
            self.assertEqual(len(lands), 1)
            self.assertEqual(reports[-1][0], "landed")

    def test_unconfirmed_landing_is_not_reported_as_landed(self):
        """Verify unconfirmed landing is not reported as landed."""
        _, reports, _, _ = self.fly(confirmed=False)
        self.assertEqual(reports[-1][0], "error")
        self.assertFalse(any(entry[0] == "landed" for entry in reports))

    def test_repeated_laps_only_end_when_operator_stops_or_time_limit_is_reached(self):
        """Verify repeated laps only end when operator stops or time limit is reached."""
        moves, reports, lands, _ = self.fly(fault='after-two-laps', circles=0)
        self.assertEqual(len(moves), 25)
        self.assertEqual(len(lands), 1)
        self.assertTrue(any('lap 3' in r[1] for r in reports))
        self.assertTrue(any('operator requested' in r[1] for r in reports))
        moves, reports, lands, _ = self.fly(circles=0)
        self.assertGreater(len(moves), 24)
        self.assertTrue(any('time limit' in r[1] for r in reports))
        self.assertEqual(len(lands), 1)

    def test_measured_endpoint_errors_are_corrected_in_next_waypoint(self):
        """Verify measured endpoint errors are corrected in next waypoint."""
        now, commands, reports = [0.], [], []
        class Driver:
            def move(self, offset, speed, check):
                """Record the requested relative move and simulate its result or injected failure."""
                commands.append(offset)
                now[0] += .5
                if len(commands) == 1:
                    return (offset[0]+.1, offset[1], 0., offset[3])
                return offset
            def land(self):
                """Record a fake landing attempt and return the fixture confirmation result."""
                return True
        fly_preset(Driver(), LIMITS, lambda: Vehicle(now[0],True,'hovering',70,1,0,0),
                   threading.Event(), lambda *x: reports.append(x), hold_seconds=1,
                   clock=lambda:now[0], sleep=lambda s:now.__setitem__(0,now[0]+s))
        from qr_orbit_core import polygon
        base = polygon(LIMITS)[1]
        self.assertAlmostEqual(commands[1][0], base[0]-.1*math.cos(math.pi/6))
        self.assertAlmostEqual(commands[1][1], base[1]+.1*math.sin(math.pi/6))
        self.assertEqual(len(commands),12)
        self.assertEqual(reports[-1][0],'landed')


if __name__ == "__main__":
    unittest.main()
