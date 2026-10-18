"""Exercise real runtime wiring with a fake SDK surface; no Olympe, radio or network."""
import argparse
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import ModuleType, SimpleNamespace
import unittest
from datetime import datetime, timezone
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parents[1]/'bridge'))
from real_fire_test import limits
import fire_monitor  # Load native OpenCV/NumPy before restoring the isolated SDK module map.


class Message:
    """Record SDK message arguments and sequencing without a real SDK binding."""
    def __init__(self, name, args, kwargs):
        """Retain the complete fake command for assertions."""
        self.name, self.args, self.kwargs = name, args, kwargs

    def __rshift__(self, other):
        """Represent ordered command/expectation composition."""
        return (self, other)


def message(name):
    """Return an SDK-shaped constructor that can never reach aircraft hardware."""
    return lambda *args, **kwargs: Message(name, args, kwargs)


class FakeBase:
    """Minimum observer state needed by the new subclass; no connect implementation."""
    def __init__(self, args, publisher, detector):
        """Initialize only in-memory state, making radio access impossible."""
        self.args, self.publisher, self.detector = args, publisher, detector
        self.lock = threading.RLock()
        self.running = self.connected = True
        self.telemetry = None
        self.controller_kind = args.controller
        self.last_frame_time = time.time()
        self.drone = Mock()
        self._state = Mock(return_value={'source': 'SkyController'})
        self._aircraft_link = Mock(return_value=True)


def load_adapter():
    """Load production adapter against isolated SDK modules, restoring imports afterward."""
    base = ModuleType('anafi_bridge')
    base.AnafiBridge = FakeBase
    base.FireDetector = base.Publisher = Mock()
    base.argument_parser = argparse.ArgumentParser
    base.olympe = SimpleNamespace(listen_event=lambda event: lambda fn: fn)
    base.gimbal = SimpleNamespace(attitude=message('gimbal'))
    for name in ('GpsLocationChanged','GPSFixStateChanged','BatteryStateChanged','WindSpeed',
                 'FlyingStateChanged','Landing','moveBy'):
        setattr(base, name, message(name))
    sensors = ModuleType('qr_orbit_bridge'); sensors.SensorAges = type('Sensors', (), {})
    modules = {'anafi_bridge': base, 'qr_orbit_bridge': sensors}
    for path, name in [('olympe.messages.move','extended_move_by'),
                       ('olympe.messages.ardrone3.PilotingEvent','moveByEnd'),
                       ('olympe.messages.skyctrl.CoPilotingState','pilotingSource')]:
        module = ModuleType(path); setattr(module, name, message(name)); modules[path] = module
    spec = importlib.util.spec_from_file_location('isolated_real_fire_bridge', Path(__file__).parents[1]/'bridge/real_fire_bridge.py')
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, modules):
        spec.loader.exec_module(module)
    return module


adapter = load_adapter()


class AdapterTests(unittest.TestCase):
    def bridge(self, execute=True):
        """Construct the actual runtime with the fake SDK base and an in-memory detector."""
        args = SimpleNamespace(controller='skycontroller3', execute=execute, drone_id='A')
        return adapter.RealFireBridge(args, Mock(), Mock(), limits())

    def test_runtime_sends_physical_relative_move_and_reads_displacement(self):
        """Verify core driver commands reach the SDK adapter with the expected units."""
        b = self.bridge(); b.session.active = True
        pending = Mock(done=lambda: True, success=lambda: True)
        pending.matched_events.return_value.last.return_value = SimpleNamespace(args={
            'error': 'ok', 'dX': -1., 'dY': 0., 'dZ': 0., 'dPsi': 0.})
        b.drone.return_value = pending
        b.driver.move((-1., 0., 0., 0.), .5, lambda: None)
        command, expectation = b.drone.call_args.args[0]
        self.assertEqual(command.name, 'extended_move_by')
        self.assertEqual(command.args[:5], (-1., 0., 0., 0., .5))
        self.assertEqual(expectation.name, 'moveByEnd')

    def test_disabled_disarmed_and_cancelled_never_send_a_move(self):
        """Runtime dispatch rechecks gates even if an external caller bypasses Session.tick."""
        for mode in ('disabled', 'disarmed', 'cancelled'):
            b = self.bridge(execute=mode!='disabled')
            b.session.active = mode!='disarmed'
            if mode=='cancelled': b.session.aborted.set()
            with self.assertRaises(ValueError): b._send_move((-1.,0.,0.,0.), .5)
            b.drone.assert_not_called()

    def test_stop_sends_zero_move_and_requires_new_hover_confirmation(self):
        """Stopping is a physical command, not cancellation of a Python expectation."""
        b = self.bridge(); hover = Mock(success=lambda: True); b.drone.return_value = hover
        self.assertTrue(b.driver.stop())
        hover_message, stop_message = [call.args[0] for call in b.drone.call_args_list]
        self.assertEqual(hover_message.kwargs['_policy'], 'wait')
        self.assertEqual(stop_message.name, 'moveBy')
        self.assertEqual(stop_message.args, (0.,0.,0.,0.))
        hover.success = lambda: False
        self.assertFalse(b.driver.stop())

    def test_control_handoff_does_not_fight_pilot_with_another_command(self):
        """Lost aircraft authority must report unconfirmed stop without sending new motion."""
        b = self.bridge(); b._state.return_value = {'source': 'Controller'}
        self.assertFalse(b.driver.stop()); self.assertFalse(b.driver.land())
        b.drone.assert_not_called()

    def test_shutdown_stops_but_does_not_land_near_fire(self):
        """Only explicit LAND may choose landing; generic cleanup cannot."""
        b = self.bridge(); b.session.active = True
        b.driver.stop = Mock(return_value=True); b.driver.land = Mock(return_value=True)
        b._land()
        b.driver.stop.assert_called_once(); b.driver.land.assert_not_called()
        b._request_landing(); b.driver.land.assert_called_once()

    def test_read_only_landing_sends_nothing(self):
        """Operator keys cannot bypass the process-level execution flag."""
        b = self.bridge(execute=False); b._request_landing()
        b.drone.assert_not_called()

    def test_detection_consumes_real_camera_and_rejects_qr_and_bad_alignment(self):
        """Exercise the real capture pipeline without an aircraft or detector model."""
        import numpy as np
        b = self.bridge()
        b.telemetry = {'drone_id':'A', 'provenance':'live', 'gps_fix':True, 'latitude':43., 'longitude':-79.,
            'altitude_m':30., 'observed_at':datetime.now(timezone.utc).isoformat(),
            'attitude_deg':{'roll':0.,'pitch':0.},
            'extra':{'heading_deg':0.,'gimbal_pitch_deg':-45.,'position_source':'gps'}}
        b._state.return_value = {'yaw_absolute':0.,'roll_absolute':0.}
        b.detector.detect.return_value = {'source':'yolo','label':'fire','confidence':.9,'bbox':[.4,.4,.6,.6]}
        frame = np.zeros((720,1280,3), dtype=np.uint8)
        b._detect_step(frame, time.time()); self.assertIsNotNone(b.fire)
        b.detector.detect.return_value['source'] = 'qr-test'
        b._detect_step(frame, time.time()); self.assertIsNone(b.fire)
        b.detector.detect.return_value['source'] = 'yolo'
        b._state.return_value['yaw_absolute'] = 30.
        b._detect_step(frame, time.time()); self.assertIsNone(b.fire)
        b.drone.assert_not_called()

    def test_setup_requires_recent_matching_measured_configuration(self):
        """False examples, expired verification and changed limits cannot enable flight."""
        from dataclasses import asdict
        config = {'limits':asdict(limits()), 'camera_and_ground_measured':True}
        names = ('pilot_present','controller_override_tested','zero_move_stop_tested','landing_control_tested',
                 'flight_area_clear','flat_ground_verified','extent_and_gps_error_bound_verified',
                 'camera_unzoomed_yaw_aligned','wind_and_energy_checked','single_receiver_verified')
        preflight = {**dict.fromkeys(names, True), 'mission_limits':config['limits'], 'checked_at_unix':time.time()}
        with tempfile.TemporaryDirectory() as directory:
            c, p = Path(directory)/'config.json', Path(directory)/'preflight.json'
            c.write_text(json.dumps(config)); p.write_text(json.dumps(preflight))
            self.assertEqual(adapter.read_setup(c, p, True), limits())
            for change in ({'zero_move_stop_tested':False}, {'checked_at_unix':0}, {'mission_limits':{}}):
                p.write_text(json.dumps({**preflight, **change}))
                with self.assertRaises(ValueError): adapter.read_setup(c, p, True)
            config['camera_and_ground_measured'] = False; c.write_text(json.dumps(config))
            with self.assertRaises(ValueError): adapter.read_setup(c, p, True)
            self.assertEqual(adapter.read_setup(c, execute=False), limits())

    def test_existing_local_receiver_blocks_startup_without_stopping_it(self):
        """Inspect fake process metadata only; never signal a process in this test."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); process = root/'99999999'; process.mkdir()
            command = process/'cmdline'
            command.write_bytes(b'python\0/mission/anafi_observer.py\0--camera\0')
            with self.assertRaisesRegex(ValueError, 'another aircraft'):
                adapter.assert_single_receiver(root)
            self.assertTrue(command.exists())
            command.write_bytes(b'python\0unrelated.py\0')
            adapter.assert_single_receiver(root)

    def test_cli_rejects_direct_execution_before_setup_or_aircraft(self):
        """Live flight requires the controller route before model or SDK construction."""
        parser = argparse.ArgumentParser()
        parser.set_defaults(demo_flight=False, no_yolo=False, detect_smoke=False,
                            gimbal_pitch=None, controller='direct')
        with patch.object(adapter, 'argument_parser', return_value=parser), \
             patch.object(sys, 'argv', ['real_fire_bridge.py', '--mission-config', 'unused.json', '--execute']), \
             patch.object(sys.stdin, 'isatty', return_value=True), \
             patch.object(adapter, 'read_setup') as setup, patch.object(adapter, 'RealFireBridge') as runtime:
            with self.assertRaises(SystemExit): adapter.main()
            setup.assert_not_called(); runtime.assert_not_called()

    def test_sensor_cache_reads_do_not_refresh_flight_evidence(self):
        """Fresh telemetry serialization cannot hide stale underlying GPS or wind events."""
        b = self.bridge()
        b.telemetry = {'drone_id':'A', 'latitude':43., 'longitude':-79., 'gps_fix':True,
            'altitude_m':30., 'battery_pct':80., 'state':'hovering', 'ground_speed_mps':0.,
            'attitude_deg':{'roll':0., 'pitch':0.},
            'extra':{'position_source':'gps', 'heading_deg':0., 'fc_wind_available':True, 'fc_wind_speed_mps':1.}}
        b.sensor_ages = SimpleNamespace(ages=dict.fromkeys(('altitude','speed','attitude','camera','gps','wind','battery'), 100.))
        with patch.object(adapter.time, 'monotonic', return_value=100.):
            self.assertEqual(b.sample()[0].at, 100.)
            b.sensor_ages.ages['gps'] = 95.
            self.assertEqual(b.sample()[0].at, 95.)
            b.telemetry['extra']['fc_wind_available'] = False
            self.assertIsNone(b.sample()[0].wind)


if __name__ == '__main__':
    unittest.main()
