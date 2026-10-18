"""Real-fire closed-loop tests: simulated aircraft, injected clock, no SDK or radio."""
from dataclasses import replace
import math
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parents[1]/'bridge'))
from real_fire_core import Limits, Fire, Vehicle, Session, plan, project_fire
from real_fire_driver import Driver


def limits(**changes):
    """Return a deliberately fake verified-site configuration for geometry tests."""
    return replace(Limits(43., -79., 0., 1280, 720, 69., 5., 400.), **changes)


def vehicle(at=100., **changes):
    """Create a hovering aircraft north of a ten-metre-radius fixture fire."""
    return replace(Vehicle(at, 'A', 0., 50., 30., 0., 0., 0., 80., 1., 'hovering', True, True, True), **changes)


class World:
    """A moving fake aircraft with fire growth and real-time frame/sensor feedback."""
    def __init__(self, execute=True, config=None):
        """Wire a session to this deterministic world and record every physical command."""
        self.now = 100.
        self.vehicle = vehicle()
        self.fire = Fire(self.now, 'A', 0., 0., 10.)
        self.moves, self.events = [], []
        self.stops = 0
        self.stop_ok = True
        self.fail = None
        self.session = Session(config or limits(), 'A', lambda: (self.vehicle, self.fire), self,
                               lambda *event: self.events.append(event), execute, lambda: self.now)

    def advance(self, seconds=.2):
        """Advance capture and sensor timestamps unless testing frozen feedback."""
        self.now += seconds
        if self.fail != 'cached-vehicle':
            self.vehicle = replace(self.vehicle, at=self.now)
        if self.fire is not None and self.fail != 'cached-fire':
            self.fire = replace(self.fire, at=self.now)

    def move(self, offset, speed, check):
        """Integrate body-frame motion while continuously polling the real watchdog."""
        check()
        self.moves.append(offset)
        for _ in range(10):
            self.advance(.2)
            if self.fail == 'lost-fire':
                self.fire = None
            if self.fail == 'gps':
                self.vehicle = replace(self.vehicle, gps_fix=False)
            if self.fail == 'abort':
                self.session.aborted.set()
            if self.fail == 'move-rejected':
                raise RuntimeError('move rejected')
            yaw = math.radians(self.vehicle.heading)
            self.vehicle = replace(self.vehicle, state='flying', speed=speed,
                east=self.vehicle.east+(offset[0]*math.sin(yaw)+offset[1]*math.cos(yaw))/10,
                north=self.vehicle.north+(offset[0]*math.cos(yaw)-offset[1]*math.sin(yaw))/10)
            check()
        self.vehicle = replace(self.vehicle, state='hovering', speed=0.)

    def stop(self):
        """Record physical stop attempts separately from SDK expectation cancellation."""
        self.stops += 1
        return self.stop_ok

    def tick(self, count=1):
        """Advance a fresh camera frame before each control decision."""
        for _ in range(count):
            self.advance()
            self.session.tick()


class RealFireTests(unittest.TestCase):
    def test_full_retreat_holds_100m_edge_buffer_and_tracks_later_growth(self):
        """Physically integrate a 67 m retreat, then verify renewed retreat after growth."""
        w = World(); w.session.arm(); w.tick(90)
        self.assertTrue(w.session.active, w.events[-1])
        self.assertGreaterEqual(w.vehicle.north-w.fire.radius, 100+w.session.limits.uncertainty_m)
        self.assertAlmostEqual(w.vehicle.north, 117.)
        count = len(w.moves)
        w.tick(10)
        self.assertEqual(len(w.moves), count)
        w.fire = replace(w.fire, radius=20.)
        w.tick(15)
        self.assertAlmostEqual(w.vehicle.north, 127.)
        w.fire = replace(w.fire, radius=5.)
        count = len(w.moves); w.tick(10)
        self.assertEqual(len(w.moves), count, 'a shrinking fire must not cause an approach')
        self.assertEqual(w.stops, 0)
        self.assertTrue(all(math.hypot(*m[:2]) <= 1.001 and m[2:] == (0., 0.) for m in w.moves))

    def test_100m_is_from_edge_not_centre(self):
        """A drone 105 m from a 20 m radius fire still requires physical retreat."""
        self.assertIsNotNone(plan(Fire(100, 'A', 0, 0, 20), vehicle(north=105), limits(), 100))
        self.assertIsNone(plan(Fire(100, 'A', 0, 0, 20), vehicle(north=127), limits(), 100))

    def test_outward_vector_is_correct_for_each_heading(self):
        """Body-relative commands always increase world distance from the fire."""
        for heading in (0, 90, 180, 270):
            move = plan(Fire(100, 'A', 0, 0, 10), vehicle(heading=heading), limits(), 100)
            yaw = math.radians(heading)
            self.assertAlmostEqual(move[0]*math.sin(yaw)+move[1]*math.cos(yaw), 0.)
            self.assertAlmostEqual(move[0]*math.cos(yaw)-move[1]*math.sin(yaw), 1.)

    def test_no_execution_without_explicit_arm_and_five_new_frames(self):
        """Execution flag, arming and distinct post-arm images are independent gates."""
        w = World(execute=False)
        with self.assertRaises(ValueError): w.session.arm()
        w.tick(10); self.assertEqual(w.moves, [])
        w = World(); w.tick(10); self.assertEqual(w.moves, [])
        w.session.arm()
        for _ in range(20): w.session.tick()
        self.assertEqual(w.moves, [])
        w.tick(4); self.assertEqual(w.moves, [])
        w.tick(2); self.assertGreater(len(w.moves), 0)

    def test_unsuccessful_arm_can_be_retried_from_a_new_pilot_hover(self):
        """An initial moving aircraft must not poison the unused confirmation gate."""
        w = World(); w.vehicle = replace(w.vehicle, speed=.3)
        with self.assertRaises(ValueError): w.session.arm()
        w.advance(2.)
        w.vehicle = replace(w.vehicle, speed=0.)
        w.session.arm(); w.tick(6)
        self.assertTrue(w.session.active)
        self.assertGreater(len(w.moves), 0)

    def test_airborne_faults_stop_and_never_auto_resume(self):
        """Lost data, cancellation and rejected moves latch stop, with no second command."""
        for failure in ('lost-fire', 'gps', 'abort', 'move-rejected', 'cached-fire', 'cached-vehicle'):
            with self.subTest(failure=failure):
                w = World(); w.session.arm(); w.tick(4); w.fail = failure; w.tick(10)
                self.assertFalse(w.session.active, w.events)
                self.assertEqual(w.stops, 1)
                self.assertLessEqual(len(w.moves), 1)
                w.fail = None; w.vehicle = vehicle(w.now); w.fire = Fire(w.now, 'A', 0, 0, 10)
                w.tick(10)
                with self.assertRaises(ValueError): w.session.arm()
                self.assertLessEqual(len(w.moves), 1)

    def test_failed_stop_is_not_reported_as_hover(self):
        """A lost stop acknowledgement must stay visibly unconfirmed."""
        w = World(); w.session.arm(); w.stop_ok = False
        w.session.halt('test failure')
        self.assertEqual(w.events[-1][0], 'error')
        self.assertIn('STOP UNCONFIRMED', w.events[-1][1])

    def test_geofence_and_overlap_prevent_an_unverified_escape(self):
        """Reject impossible target positions and an aircraft inside uncertain fire extent."""
        for fire in (Fire(100, 'A', 0, 0, 50), Fire(100, 'A', 0, -300, 400)):
            with self.assertRaises(ValueError): plan(fire, vehicle(), limits(), 100)
        with self.assertRaisesRegex(ValueError, 'outside'):
            plan(Fire(100, 'A', 0, 0, 10), vehicle(), limits(geofence_m=110), 100)

    def test_energy_weather_pose_source_and_identity_are_required(self):
        """Every rejected state fails before a move can be selected."""
        for changes in ({'battery': 39}, {'wind': 4}, {'wind': None}, {'at': 98}, {'at': 101},
                        {'altitude': 1}, {'gps_fix': False}, {'connected': False},
                        {'controller_ok': False}, {'state': 'landed'}, {'tilt': 6}, {'heading': float('nan')}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                plan(Fire(100, 'A', 0, 0, 10), vehicle(**changes), limits(), 100)
        with self.assertRaises(ValueError):
            plan(Fire(100, 'B', 0, 0, 10), vehicle(), limits(), 100)

    def test_travel_time_and_track_jump_latch_stop(self):
        """Bound total motion/time and reject a switch to a different fire."""
        w = World(config=limits(travel_m=2)); w.session.arm(); w.tick(15)
        self.assertEqual(len(w.moves), 2); self.assertFalse(w.session.active)
        w = World(config=limits(seconds=10)); w.session.arm(); w.tick(20)
        self.assertFalse(w.session.active)
        w = World(); w.session.arm(); w.tick(3)
        w.fire = replace(w.fire, east=30); w.tick()
        self.assertEqual(w.moves, []); self.assertFalse(w.session.active)

    def test_requires_new_sensor_and_camera_feedback_after_move(self):
        """A completed command cannot launch another move from old capture/position data."""
        w = World(); w.session.arm(); w.tick(6)
        count = len(w.moves)
        for _ in range(10): w.session.tick()
        self.assertEqual(len(w.moves), count)


class ProjectionTests(unittest.TestCase):
    def pose(self):
        """Return level, downward-looking camera telemetry over surveyed flat ground."""
        return {'drone_id': 'A', 'provenance': 'live', 'gps_fix': True, 'latitude': 43., 'longitude': -79.,
                'altitude_m': 30., 'attitude_deg': {'roll': 0., 'pitch': 0.},
                'extra': {'heading_deg': 0., 'gimbal_pitch_deg': -90., 'position_source': 'gps'}}

    def hit(self):
        """Return an unoccluded real-fire box suitable for projection."""
        return {'source': 'yolo', 'label': 'fire', 'confidence': .9, 'bbox': [.4, .4, .6, .6]}

    def test_nadir_geometry_encloses_the_box_corners_and_scales_with_size(self):
        """Compare the enclosing radius against independently derived ground dimensions."""
        f = project_fire(self.hit(), self.pose(), (720, 1280), 100, limits())
        width = 60*.2*math.tan(math.radians(69)/2)
        expected = math.hypot(width/2, width*720/1280/2)
        self.assertAlmostEqual(f.radius, expected)
        self.assertAlmostEqual(f.east, 0.); self.assertAlmostEqual(f.north, 0.)
        large = project_fire({**self.hit(), 'bbox': [.3, .3, .7, .7]}, self.pose(), (720,1280), 100, limits())
        self.assertAlmostEqual(large.radius, 2*f.radius)

    def test_qr_smoke_simulation_clipped_and_unknown_geometry_are_rejected(self):
        """No indoor scenario or missing ground/camera measurement may authorize retreat."""
        for changes in ({'source': 'qr-test'}, {'label': 'smoke'}, {'confidence': .5},
                        {'bbox': [0, .1, .5, .5]}, {'bbox': [.1, .1, 1, .5]}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                project_fire({**self.hit(), **changes}, self.pose(), (720,1280), 100, limits())
        for changes in ({'provenance': 'demo-simulated'}, {'gps_fix': False}, {'altitude_m': None},
                        {'extra': {'heading_deg': 0., 'gimbal_pitch_deg': 0., 'position_source': 'gps'}}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                project_fire(self.hit(), {**self.pose(), **changes}, (720,1280), 100, limits())
        with self.assertRaises(ValueError): project_fire(self.hit(), self.pose(), (360,640), 100, limits())

    def test_limits_reject_invalid_envelopes(self):
        """Prevent configuration from disabling movement/uncertainty bounds."""
        for changes in ({'uncertainty_m': 0}, {'speed_mps': 20}, {'step_m': 100},
                        {'geofence_m': float('nan')}, {'seconds': True}, {'image_width': 0}):
            with self.subTest(changes=changes), self.assertRaises(ValueError): limits(**changes)


class DriverTests(unittest.TestCase):
    def test_wait_has_deadline_and_polls_abort_during_movement(self):
        """A hung SDK expectation cannot block the flight worker indefinitely."""
        from unittest.mock import Mock
        now = [100.]
        def advance(seconds):
            """Advance fake time without sleeping."""
            now[0] += seconds
        pending = Mock(done=lambda: False)
        check = Mock()
        driver = Driver(lambda *args: (pending, lambda: None), lambda: True, lambda: True,
                        clock=lambda: now[0], sleep=advance)
        with self.assertRaises(TimeoutError): driver.move((1.,0.,0.,0.), .5, check)
        self.assertGreater(check.call_count, 100)
        self.assertLess(now[0]-100., 8.1)
        pending.cancel.assert_called_once()

    def test_move_acknowledgement_and_displacement_are_both_required(self):
        """An SDK success without matching measured displacement is not completion."""
        from unittest.mock import Mock
        for actual in ((1.,0.,0.,0.), None, (0.,0.,0.,0.), (1.,0.,.5,0.)):
            pending = Mock(done=lambda: True, success=lambda: True)
            driver = Driver(lambda *args: (pending, lambda: actual), lambda: True, lambda: True)
            if actual == (1.,0.,0.,0.):
                driver.move((1.,0.,0.,0.), .5, lambda: None)
            else:
                with self.assertRaises(RuntimeError): driver.move((1.,0.,0.,0.), .5, lambda: None)
            pending.cancel.assert_called_once()

    def test_command_bounds_and_pre_dispatch_abort(self):
        """No invalid or already-cancelled command reaches the aircraft callback."""
        from unittest.mock import Mock
        send = Mock(); driver = Driver(send, lambda: True, lambda: True)
        for move in ((2.,0.,0.,0.), (0.,0.,1.,0.), (0.,0.,0.,1.)):
            with self.assertRaises(ValueError): driver.move(move, .5, lambda: None)
        def abort():
            """Raise an injected stop before dispatch."""
            raise ValueError('aborted')
        with self.assertRaises(ValueError): driver.move((1.,0.,0.,0.), .5, abort)
        send.assert_not_called()


if __name__ == '__main__':
    unittest.main()
