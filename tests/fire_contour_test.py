"""Forecast/GPS controller checks with synthetic sensors and no aircraft SDK."""
from dataclasses import replace
import json
import math
from pathlib import Path
import subprocess
import sys
import threading
import unittest

sys.path.insert(0, str(Path(__file__).parents[1]/'bridge'))
from fire_contour import (ContourPlan, GPSFix, footprint, geographic_offset, gps_reason,
                          local_offset, nearest_fraction, patrol_speed, perimeter, point_at, run_contour,
                          validate_scenario)
from fire_detection import parse_marker, FIRE_MARKER_PAYLOAD, TINY_FIRE_MARKER_PAYLOAD
from qr_orbit_core import Limits, Vehicle


class ContourTests(unittest.TestCase):
    """Keep the new mode bounded while comparing it against the actual browser model."""

    def setUp(self):
        """Use exact Tiny scenario details and a frozen representative GPS origin."""
        self.details = parse_marker(TINY_FIRE_MARKER_PAYLOAD)
        self.origin = (43.78, -79.19)

    def test_uniform_fuel_geometry_matches_browser_at_every_vertex(self):
        """Guard formula, wind convention, hectare conversion and future growth parity."""
        script = """require('./dist/model.js'); const m=globalThis.EmberModel; const d=JSON.parse(process.argv[1]);
console.log(JSON.stringify([0,5,6,10].map(t=>m.footprint([43.78,-79.19],t,m.scenarioFrom(d),d))));"""
        result = subprocess.run(['node', '-e', script, json.dumps(self.details)],
                                cwd=Path(__file__).parents[1], capture_output=True, text=True, check=True)
        for minutes, browser in zip((0, 5, 6, 10), json.loads(result.stdout)):
            actual = footprint(self.details, minutes)
            self.assertEqual(len(actual), 72)
            for point, coordinate in zip(actual, browser):
                self.assertLess(math.dist(point, local_offset(self.origin, coordinate)), .00001)
        self.assertGreater(perimeter(footprint(self.details, 10)), perimeter(footprint(self.details, 5)))

    def test_tiny_fits_full_mission_but_original_alpha_cannot_take_off(self):
        """Reject the original large scenario rather than silently scaling it to fit."""
        validate_scenario(self.details)
        with self.assertRaisesRegex(ValueError, '4 m demo radius'):
            validate_scenario(parse_marker(FIRE_MARKER_PAYLOAD))
        for field, value in [('area_ha', 0), ('spread_m_per_min', -1), ('wind_kmh', 90), ('area_ha', float('nan'))]:
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                validate_scenario({**self.details, field: value})

    def test_real_time_horizon_and_growth_related_speed_are_independent_of_replay(self):
        """Advance exactly one model minute per real minute and freeze the supplied details."""
        plan = ContourPlan(self.origin, self.origin, self.details, 100., 100000.)
        self.assertEqual(plan.minutes(100), 5)
        self.assertEqual(plan.minutes(160), 6)
        self.details['spread_m_per_min'] = 30
        self.assertEqual(plan.details['spread_m_per_min'], .01)
        with self.assertRaises(TypeError):
            plan.details['spread_m_per_min'] = 40
        self.assertEqual(patrol_speed(plan.details, 5), .05)
        growing = {**plan.details, 'spread_m_per_min': .2}
        self.assertGreater(patrol_speed(growing, 10), patrol_speed(growing, 5))
        self.assertEqual(patrol_speed({**plan.details, 'spread_m_per_min': 0}, 5), 0)
        self.assertEqual(patrol_speed({**plan.details, 'spread_m_per_min': 100}, 5), .2)
        self.assertEqual(plan.status(160)['anchor']['position_source'], 'gps')

    def test_gps_requires_received_fresh_precise_measurements(self):
        """Missing precision or GPS fix must never turn home/commanded offsets into GPS."""
        fix = GPSFix(10., *self.origin, .3, True)
        self.assertIsNone(gps_reason(fix, 10.1))
        for bad in (None, replace(fix, fixed=False), replace(fix, at=8), replace(fix, at=11),
                    replace(fix, accuracy_m=.51), replace(fix, accuracy_m=0),
                    replace(fix, accuracy_m=float('nan')), replace(fix, latitude=500)):
            self.assertIsNotNone(gps_reason(bad, 10.1))

    def harness(self, *, fault=None, move_limit=12, flight_seconds=None):
        """Exercise asynchronous movement watchdogs using measured-feedback test doubles."""
        details = parse_marker(TINY_FIRE_MARKER_PAYLOAD)
        state = {'time': 10., 'position': geographic_offset(self.origin, -.9, 0), 'yaw': 0.,
                 'moves': [], 'trajectory': []}
        abort = threading.Event()
        limits = Limits(speed_mps=.2)
        plan = ContourPlan(self.origin, state['position'], details, 10., 10000.)

        def clock():
            """Return the deterministic elapsed-flight clock."""
            return state['time']

        def sleep(seconds):
            """Advance test time without sleeping or touching aircraft."""
            state['time'] += seconds

        def sample():
            """Supply current received sensor values, optionally injecting a safety fault."""
            vehicle = Vehicle(clock(), True, 'hovering', 80, 1., .1, 0.)
            fix = GPSFix(clock(), *state['position'], .2, True)
            if fault == 'gps' or (fault == 'gps-during-move' and state['moves']):
                fix = replace(fix, at=clock()-2)
            if fault == 'battery':vehicle = replace(vehicle, battery_pct=20)
            if fault == 'altitude':vehicle = replace(vehicle, altitude_m=2)
            if fault == 'envelope':fix = replace(fix, latitude=fix.latitude+.001)
            if fault == 'session' or (fault == 'session-during-move' and state['moves']):
                raise InterruptedError('Session expired')
            if fault == 'gps-jump' and state['moves']:
                latitude, longitude = geographic_offset(self.origin, 3.2, 0.)
                fix = replace(fix, latitude=latitude, longitude=longitude)
            return vehicle, fix, state['yaw']

        class Driver:
            """A measured-displacement fake; each completion checks authorization again."""
            def move(inner, offset, speed, check):
                """Apply a bounded body movement and expose elapsed time to watchdogs."""
                check()
                state['moves'].append((offset, speed))
                north = offset[0]*math.cos(state['yaw'])-offset[1]*math.sin(state['yaw'])
                east = offset[0]*math.sin(state['yaw'])+offset[1]*math.cos(state['yaw'])
                state['position'] = geographic_offset(state['position'], north, east)
                state['yaw'] += offset[3]
                sleep(max(.1, math.hypot(*offset[:2])/speed))
                state['trajectory'].append((clock(), state['position']))
                if len(state['moves']) >= move_limit:abort.set()
                check()
                return offset

        return lambda:run_contour(Driver(), limits, plan, sample, abort, lambda *_:None,
                                  started=10., flight_seconds=flight_seconds, clock=clock, sleep=sleep), state

    def test_follows_non_circular_growth_without_visual_samples_and_stops_on_abort(self):
        """Verify actual path commands, bounded speed and termination without any QR stream."""
        run, state = self.harness()
        with self.assertRaisesRegex(InterruptedError, 'Operator requested landing'):
            run()
        self.assertEqual(len(state['moves']), 12)
        for offset, speed in state['moves']:
            self.assertLessEqual(math.hypot(*offset[:2]), .200001)
            self.assertLessEqual(abs(offset[3]), .2)
            self.assertLessEqual(abs(offset[2]), .1)
            self.assertTrue(.05 <= speed <= .2)
        self.assertGreater(state['time'], 10.)

    def test_safety_faults_prevent_the_first_command(self):
        """Retain GPS, launch envelope, altitude, battery and external session gates."""
        for fault in ('gps', 'battery', 'altitude', 'envelope', 'session'):
            run, state = self.harness(fault=fault)
            with self.subTest(fault=fault), self.assertRaises(InterruptedError):run()
            self.assertEqual(state['moves'], [])

    def test_command_watchdog_detects_gps_loss_jump_and_session_expiry(self):
        """An already-authorized movement must still stop on new control or sensor faults."""
        for fault, message in (('gps-during-move', 'GPS location event is stale'),
                               ('gps-jump', 'GPS jumped'), ('session-during-move', 'Session expired')):
            run, state = self.harness(fault=fault)
            with self.subTest(fault=fault), self.assertRaisesRegex(InterruptedError, message):run()
            self.assertEqual(len(state['moves']), 1)

    def test_operator_ended_mission_continues_past_five_minutes_without_qr(self):
        """Complete multiple real-time contour laps until an explicit LAND, beyond the old cap."""
        run, state = self.harness(move_limit=1200)
        with self.assertRaisesRegex(InterruptedError, 'Operator requested landing'):
            run()
        self.assertGreaterEqual(state['time'], 310.)
        angles = []
        for at, coordinate in state['trajectory'][5:]:
            position = local_offset(self.origin, coordinate)
            points = footprint(self.details, 5+(at-10)/60)
            nearest = point_at(points, nearest_fraction(points, position))
            self.assertLess(math.dist(position, nearest), .08)
            angles.append(math.atan2(position[1], position[0]))
        winding = sum((b-a+math.pi) % (2*math.pi)-math.pi for a, b in zip(angles, angles[1:]))
        self.assertGreater(winding, 4*math.pi)

    def test_explicit_short_test_still_lands_at_sixty_seconds(self):
        """The operator-ended default does not remove the deliberately selected short test."""
        run, state = self.harness(move_limit=10000, flight_seconds=60)
        with self.assertRaisesRegex(InterruptedError, '60-second contour response limit'):
            run()
        self.assertGreaterEqual(state['time'], 70.)

    def test_operator_ended_contour_cannot_outgrow_the_demo_envelope(self):
        """An unlimited duration still rejects an excessively grown real-time forecast."""
        with self.assertRaisesRegex(ValueError, '4 m demo radius'):
            validate_scenario(self.details, minutes=400, flight_seconds=None)

    def test_polyline_interpolation_closes_and_stays_on_model_edges(self):
        """Do not substitute an ellipse/circle or disconnect the final segment."""
        points = footprint(self.details, 5)
        self.assertEqual(point_at(points, 0), points[0])
        self.assertEqual(point_at(points, 1), points[0])
        expected = tuple((a+b)/2 for a, b in zip(points[0], points[1]))
        self.assertLess(math.dist(point_at(points, math.dist(points[0], points[1])/2/perimeter(points)), expected), 1e-12)


if __name__ == '__main__':
    unittest.main()
