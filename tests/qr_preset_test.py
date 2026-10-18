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
        for other in ("EW1:Ravine|300|X|35|M|45|90|31|18|18", TEXT + " ", "https://example.com"):
            with self.assertRaises(ValueError):
                RecognitionTrigger(other)

    def test_wrong_stale_future_and_prearm_frames_do_not_count(self):
        for observation in (None, Recognition(11, "EW1:other"), Recognition(9, TEXT),
                            Recognition(12, TEXT), Recognition(10, TEXT)):
            trigger = RecognitionTrigger(TEXT)
            trigger.arm(10)
            self.assertFalse(trigger.observe(observation, 11))
            self.assertEqual(trigger.hits, 0)

    def test_repeated_frame_does_not_accumulate_hits(self):
        trigger = RecognitionTrigger(TEXT)
        trigger.arm(10)
        for _ in range(10):
            self.assertFalse(trigger.observe(Recognition(10.1, TEXT), 10.1))
        self.assertEqual(trigger.hits, 1)

    def test_expiry_and_interrupted_streak_cannot_trigger(self):
        trigger = RecognitionTrigger(TEXT)
        trigger.arm(10)
        trigger.observe(Recognition(10.1, TEXT), 10.1)
        trigger.observe(None, 10.2)
        self.assertEqual(trigger.hits, 0)
        self.assertFalse(trigger.observe(Recognition(30, TEXT), 30))
        self.assertEqual(trigger.state, "cancelled")


class PresetFlightTests(unittest.TestCase):
    def fly(self, fault=None, confirmed=True, hold=30, started=10):
        now, abort, moves, reports, lands = [10.0], threading.Event(), [], [], []
        hold_started = [None]
        class Driver:
            def move(self, offset, speed, check):
                moves.append(offset)
                now[0] += .5
                if fault == "move":
                    raise RuntimeError("SDK move failure")
                if fault == "during-circle":
                    abort.set()
                check()
            def land(self):
                lands.append(now[0])
                return confirmed
        def sample():
            vehicle = Vehicle(now[0], True, "hovering", 70, 1, 0, 0)
            if fault == "stale" and moves:
                vehicle = replace(vehicle, at=now[0]-5)
            if fault == "battery":
                vehicle = replace(vehicle, battery_pct=39)
            if fault == "height":
                vehicle = replace(vehicle, altitude_m=1.5)
            return vehicle
        def report(*message):
            reports.append(message)
            if message[0] == "return":
                hold_started[0] = now[0]
        def advance(seconds):
            now[0] += seconds
            if fault == "during-hover" and hold_started[0] is not None and now[0]-hold_started[0] >= .2:
                abort.set()
        fly_preset(Driver(), LIMITS, sample, abort, report, hold_seconds=hold, flight_started=started,
                   clock=lambda: now[0], sleep=advance)
        return moves, reports, lands, hold_started[0]

    def test_one_complete_circle_then_hover_timeout_and_landing(self):
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
        for fault, count in (("during-circle", 1), ("during-hover", 12)):
            moves, reports, lands, _ = self.fly(fault)
            self.assertEqual(len(moves), count)
            self.assertEqual(len(lands), 1)
            self.assertEqual(reports[-1][0], "landed")

    def test_sensor_battery_height_and_sdk_faults_land(self):
        for fault, count in (("stale", 1), ("battery", 0), ("height", 0), ("move", 1)):
            moves, reports, lands, _ = self.fly(fault)
            self.assertEqual(len(moves), count)
            self.assertTrue(any(entry[0] == "aborted" for entry in reports))
            self.assertEqual(len(lands), 1)

    def test_total_flight_cap_and_invalid_hover_never_move(self):
        for options in ({"started": -100}, {"hold": 0}, {"hold": float("nan")}, {"hold": 31}):
            moves, reports, lands, _ = self.fly(**options)
            self.assertEqual(moves, [])
            self.assertEqual(len(lands), 1)
            self.assertEqual(reports[-1][0], "landed")

    def test_unconfirmed_landing_is_not_reported_as_landed(self):
        _, reports, _, _ = self.fly(confirmed=False)
        self.assertEqual(reports[-1][0], "error")
        self.assertFalse(any(entry[0] == "landed" for entry in reports))


if __name__ == "__main__":
    unittest.main()
