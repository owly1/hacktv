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
                          validate_scenario, OUTDOOR_DETAILS, gps_accuracy_from_components, effective_rate,
                          OutdoorContourLimits, GPSMovementWatchdog)
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

    def harness(self, *, fault=None, move_limit=12, flight_seconds=None, outdoor=False):
        """Exercise asynchronous movement watchdogs using measured-feedback test doubles."""
        details = dict(OUTDOOR_DETAILS) if outdoor else parse_marker(TINY_FIRE_MARKER_PAYLOAD)
        state = {'time': 10., 'position': geographic_offset(self.origin, -.9, 0), 'yaw': 0.,
                 'moves': [], 'trajectory': []}
        abort = threading.Event()
        limits = OutdoorContourLimits() if outdoor else Limits(speed_mps=.2)
        plan = ContourPlan(self.origin, state['position'], details, 10., 10000., outdoor=outdoor)

        def clock():
            """Return the deterministic elapsed-flight clock."""
            return state['time']

        def sleep(seconds):
            """Advance test time without sleeping or touching aircraft."""
            state['time'] += seconds

        def sample():
            """Supply current received sensor values, optionally injecting a safety fault."""
            vehicle = Vehicle(clock(), True, 'hovering', 80, 1., .5 if outdoor else .1, 0.)
            coordinate = state['position']
            if outdoor:
                north, east = local_offset(self.origin, coordinate)
                coordinate = geographic_offset(self.origin, round(north), round(east))
            fix = GPSFix(clock(), *coordinate, 2.8 if outdoor else .2, True)
            if fault == 'gps' or (fault == 'gps-during-move' and state['moves']):
                fix = replace(fix, at=clock()-2)
            if fault == 'battery':vehicle = replace(vehicle, battery_pct=20)
            if fault == 'altitude':vehicle = replace(vehicle, altitude_m=2)
            if fault == 'envelope':fix = replace(fix, latitude=fix.latitude+.001)
            if fault == 'gps-frozen':
                latitude, longitude = geographic_offset(self.origin, -.9, 0.)
                fix = replace(fix, latitude=latitude, longitude=longitude)
            if fault == 'session' or (fault == 'session-during-move' and state['moves']):
                raise InterruptedError('Session expired')
            if fault == 'gps-jump' and state['moves']:
                latitude, longitude = geographic_offset(self.origin, 3.2, 0.)
                fix = replace(fix, latitude=latitude, longitude=longitude)
            return vehicle, fix, state['yaw']

        def wind():
            """Publish fresh measured-wind fixtures, with a fault during an in-flight watchdog."""
            if (fault == 'wind-missing'
                    or fault == 'wind-recovery' and len(state['moves']) < 3
                    or fault == 'wind-loss-and-recovery' and 2 <= len(state['moves']) < 5):
                return None
            if fault == 'wind-error':
                raise RuntimeError('SDK weather callback failed')
            changed = fault in ('wind-change', 'wind-loss-and-recovery') and len(state['moves']) >= 5
            return {'source': 'flight-controller', 'speed_mps': 20. if fault == 'wind-invalid' else 5. if changed else 2.,
                    'direction_deg': 120. if changed else 60.,
                    'observed_at': '2026-10-18T12:00:00Z',
                    'age_s': 6 if fault == 'wind-stale' or fault == 'wind-during-move' and state['moves'] else 0}

        def accept_plan(updated):
            """Record the exact immutable forecast used by movement, as a runtime status would."""
            state['plan'] = updated
            state.setdefault('weather_states', []).append(updated.status(clock())['wind_status'])

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
                                  started=10., flight_seconds=flight_seconds, clock=clock, sleep=sleep,
                                  wind_snapshot=wind if outdoor and fault != 'wind-no-provider' else None,
                                  report_plan=accept_plan if outdoor else None), state

    def test_outdoor_wind_matches_browser_and_preserves_encoded_reference(self):
        """Live wind changes both speed of growth and shape without cancelling the reference ratio."""
        plan = ContourPlan(self.origin, self.origin, OUTDOOR_DETAILS, 10., 10000., outdoor=True)
        self.assertAlmostEqual(math.sqrt(plan.details['area_ha']*10000/math.pi)*2, 50.)
        previous = None
        for speed, direction in ((0., None), (1., 359.), (5., 1.), (10., 120.)):
            raw = {'source': 'flight-controller', 'speed_mps': speed, 'direction_deg': direction,
                   'age_s': .1, 'observed_at': '2026-10-18T12:00:00Z'}
            current = plan.with_weather(raw)
            script = """require('./dist/model.js');const m=globalThis.EmberModel;
const d=JSON.parse(process.argv[1]),sc=JSON.parse(process.argv[2]);
console.log(JSON.stringify(m.footprint([43.78,-79.19],5,sc,d,1,{uniformFuel:true})));"""
            result = subprocess.run(['node', '-e', script, json.dumps(dict(current.details)),
                                     json.dumps(dict(current.scenario))], cwd=Path(__file__).parents[1],
                                    capture_output=True, text=True, check=True)
            for point, coordinate in zip(footprint(current.details, 5., current.scenario), json.loads(result.stdout)):
                self.assertLess(math.dist(point, local_offset(self.origin, coordinate)), .0002)
            self.assertEqual(current.details['wind_kmh'], .2)
            self.assertEqual(current.scenario['wind'], speed*3.6)
            self.assertEqual(current.wind['direction_deg'], direction)
            self.assertIsNone(plan.scenario)
            with self.assertRaises(TypeError):current.scenario['wind'] = 99
            growth = effective_rate(current.details, 5., current.scenario)
            if previous is not None:self.assertGreater(growth, previous)
            previous = growth
        self.assertEqual(current.status(10.)['profile'], 'outdoor-50m-live-wind')
        self.assertEqual(current.status(10.)['wind']['source'], 'flight-controller')

    def test_strict_wind_validation_rejects_missing_stale_or_invented_measurements(self):
        """Invalid inputs cannot become measured evidence, even when the flight continues."""
        plan = ContourPlan(self.origin, self.origin, OUTDOOR_DETAILS, 10., 10000., outdoor=True)
        valid = {'source': 'flight-controller', 'speed_mps': 1., 'direction_deg': 60.,
                 'age_s': 0., 'observed_at': '2026-10-18T12:00:00Z'}
        for bad in (None, {**valid, 'source': 'qr'}, {**valid, 'age_s': 6},
                    {**valid, 'speed_mps': None}, {**valid, 'speed_mps': 20},
                    {**valid, 'speed_mps': .01, 'direction_deg': None},
                    {**valid, 'direction_deg': None}, {**valid, 'observed_at': 'invalid'}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):plan.with_weather(bad)
        for fault in ('wind-missing', 'wind-stale', 'wind-during-move', 'wind-error', 'wind-no-provider', 'wind-invalid'):
            run, state = self.harness(outdoor=True, fault=fault)
            with self.subTest(fault=fault), self.assertRaisesRegex(InterruptedError, 'Operator requested landing'):
                run()
            self.assertEqual(len(state['moves']), 12)
            status = state['plan'].status(state['time'])
            if fault == 'wind-during-move':
                self.assertEqual(status['wind']['source'], 'flight-controller')
                self.assertEqual(status['wind_status'], 'stale')
                self.assertEqual(status['effective_scenario']['wind'], 7.2)
                self.assertGreater(status['wind']['age_s'], 5.)
            else:
                self.assertEqual(status['wind']['source'], 'qr-scenario-assumption')
                self.assertEqual(status['wind_status'], 'assumed')
                self.assertIsNone(status['wind']['observed_at'])
                self.assertIsNone(status['wind']['age_s'])
                self.assertEqual(status['effective_scenario']['wind'], .2)

    def test_weather_loss_keeps_last_estimate_and_true_age_then_recovers(self):
        """A missing estimate never resets the forecast clock, GPS anchor or measured sample age."""
        plan = ContourPlan(self.origin, self.origin, OUTDOOR_DETAILS, 10., 10000., outdoor=True)
        raw = {'source': 'flight-controller', 'speed_mps': 5., 'direction_deg': 90.,
               'age_s': 1., 'observed_at': '2026-10-18T12:00:00Z'}
        measured = plan.update_weather(raw, 10.)
        stale = measured.update_weather(None, 20., 'Aircraft wind unavailable')
        again = stale.update_weather(None, 30.)
        self.assertEqual(again.status(30.)['wind']['age_s'], 21.)
        self.assertEqual(again.status(30.)['wind_status'], 'stale')
        self.assertEqual(again.scenario, measured.scenario)
        self.assertEqual(again.model_started, 10.)
        self.assertEqual(again.anchor, self.origin)
        self.assertEqual(measured.status(20.)['wind_status'], 'stale')
        recovered = again.update_weather({**raw, 'speed_mps': 2., 'age_s': 0.}, 31.)
        self.assertEqual(recovered.status(31.)['wind_status'], 'measured')
        self.assertEqual(recovered.status(31.)['wind']['age_s'], 0.)
        self.assertEqual(recovered.scenario['wind'], 7.2)
        self.assertIsNone(recovered.wind_reason)

    def test_contour_continues_and_restores_real_wind_after_weather_loss(self):
        """Movement and forecast updates continue through initial or mid-command wind absence."""
        for fault, first in (('wind-recovery', 'assumed'), ('wind-loss-and-recovery', 'measured')):
            run, state = self.harness(outdoor=True, fault=fault, move_limit=30)
            with self.subTest(fault=fault), self.assertRaisesRegex(InterruptedError, 'Operator requested landing'):
                run()
            self.assertEqual(len(state['moves']), 30)
            self.assertEqual(state['weather_states'][0], first)
            self.assertEqual(state['weather_states'][-1], 'measured')
            if fault == 'wind-loss-and-recovery':self.assertIn('stale', state['weather_states'])

    def test_integer_gps_accuracy_is_conservative_and_outdoor_gate_remains_real(self):
        """Whole-metre zero precision is usable for a large course but never the tiny course."""
        accuracy = gps_accuracy_from_components(0, 0)
        self.assertAlmostEqual(accuracy, math.sqrt(2))
        self.assertAlmostEqual(gps_accuracy_from_components(2, 2), math.sqrt(18))
        for missing in (-1, None, float('nan'), True):
            self.assertIsNone(gps_accuracy_from_components(missing, 0))
        fix = GPSFix(10., *self.origin, accuracy, True)
        self.assertIsNotNone(gps_reason(fix, 10.))
        self.assertIsNone(gps_reason(fix, 10., max_accuracy_m=5))
        for bad in (replace(fix, fixed=False), replace(fix, accuracy_m=5.1), replace(fix, at=7.)):
            self.assertIsNotNone(gps_reason(bad, 10., max_accuracy_m=5))

    def test_outdoor_limits_are_separate_from_the_unchanged_circle_limits(self):
        """The new speed cannot be rejected by legacy limits or loosen the existing circle."""
        self.assertEqual(OutdoorContourLimits(speed_mps=.5).height_m, 1.)
        self.assertEqual(OutdoorContourLimits().speed_mps, 1.)
        with self.assertRaises(ValueError):Limits(speed_mps=1., lap_seconds=None)
        for invalid in ({'height_m':2}, {'speed_mps':1.1}, {'lap_seconds':15}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):OutdoorContourLimits(**invalid)

    def test_movement_cross_check_uses_actual_heading_and_defers_baseline_reset_until_ack(self):
        """Measured body displacement must align with GPS, without rebasing in-flight commands."""
        guard = GPSMovementWatchdog()
        initial = GPSFix(10., *self.origin, 2.8, True)
        guard.observe(initial)
        for index in range(1, 7):
            # A two-metre forward movement at east-facing yaw is two metres east.
            guard.record((2., 0., 0., 0.), math.pi/2)
            fix = GPSFix(10.+index, *geographic_offset(self.origin, 0., 2.*index), 2.8, True)
            guard.observe(fix)
        self.assertIs(guard.baseline, initial)
        self.assertAlmostEqual(guard.east_m, 12.)
        guard.observe(fix, allow_reset=True)
        self.assertIs(guard.baseline, fix)
        self.assertEqual(guard.travel_m, 0.)
        # An acknowledged zero movement adds nothing regardless of requested motion.
        guard.record((0., 0., 0., 0.), 0.)
        self.assertEqual(guard.travel_m, 0.)

    def test_fresh_but_frozen_gps_cannot_repeat_outdoor_movements_indefinitely(self):
        """Fresh timestamps do not disguise GPS that contradicts received movement results."""
        run, state = self.harness(outdoor=True, fault='gps-frozen', move_limit=100)
        with self.assertRaisesRegex(InterruptedError, 'GPS disagrees.*frozen'):run()
        self.assertLessEqual(len(state['moves']), 7)
        self.assertGreater(len(state['moves']), 1)
        self.assertLess(math.hypot(*local_offset(self.origin, state['position'])), 20.)

    def test_outdoor_path_progresses_with_whole_metre_gps_and_real_wind(self):
        """A large closed route must actually move through a lap despite quantized GPS."""
        run, state = self.harness(outdoor=True, move_limit=200)
        with self.assertRaisesRegex(InterruptedError, 'Operator requested landing'):run()
        self.assertEqual(len(state['moves']), 200)
        angles = []
        for at, coordinate in state['trajectory'][20:]:
            point = local_offset(self.origin, coordinate)
            self.assertTrue(15 < math.hypot(*point) < 40)
            angles.append(math.atan2(point[1], point[0]))
        winding = sum((b-a+math.pi) % (2*math.pi)-math.pi for a, b in zip(angles, angles[1:]))
        self.assertGreater(winding, 2*math.pi)
        for offset, speed in state['moves']:
            self.assertLessEqual(math.hypot(*offset[:2]), 2.000001)
            self.assertTrue(.5 <= speed <= 1.)
        self.assertEqual(state['plan'].scenario['wind'], 7.2)

    def test_outdoor_envelope_growth_and_speed_remain_bounded(self):
        """The larger profile is explicit; excessive live-wind forecasts still stop."""
        with self.assertRaises(ValueError):validate_scenario(OUTDOOR_DETAILS)
        validate_scenario(OUTDOOR_DETAILS, outdoor=True)
        plan = ContourPlan(self.origin, self.origin, OUTDOOR_DETAILS, 10., 10000., outdoor=True)
        windy = plan.with_weather({'source': 'flight-controller', 'speed_mps': 60/3.6,
                                  'direction_deg': 60., 'age_s': 0.,
                                  'observed_at': '2026-10-18T12:00:00Z'})
        with self.assertRaisesRegex(ValueError, '100 m demo radius'):
            validate_scenario(windy.details, minutes=400., scenario=windy.scenario, outdoor=True)
        self.assertEqual(patrol_speed(windy.details, 5., windy.scenario, outdoor=True), 1.)
        self.assertEqual(patrol_speed(plan.details, 5., outdoor=True), .5)

    def test_outdoor_wind_changes_update_actual_flight_plan_without_rewriting_baseline(self):
        """A new FC estimate reaches the movement controller and its reported immutable plan."""
        run, state = self.harness(outdoor=True, fault='wind-change', move_limit=30)
        with self.assertRaisesRegex(InterruptedError, 'Operator requested landing'):run()
        self.assertEqual(state['plan'].scenario['wind'], 18.)
        self.assertEqual(state['plan'].scenario['direction'], 120.)
        self.assertEqual(state['plan'].details['wind_kmh'], .2)
        self.assertGreater(state['moves'][-1][1], state['moves'][0][1])

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
