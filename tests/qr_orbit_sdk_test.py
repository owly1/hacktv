"""SDK binding checks with a fake aircraft. Never connects or sends over a radio.

Run on the Pi inside the installed Olympe environment. Skips without Olympe.
"""
import importlib.util
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parents[1]/"bridge"))
HAS_SDK = importlib.util.find_spec("olympe") is not None
if HAS_SDK:
    import qr_orbit_bridge
    from anafi_bridge import AnafiBridge
    from qr_orbit_bridge import OlympeOrbitDriver, QROrbitBridge, read_preflight
    from qr_orbit_core import Limits
    from hover_checkout import HoverCheckout


@unittest.skipUnless(HAS_SDK, "Run inside the Pi's Olympe environment")
class AdapterTests(unittest.TestCase):
    def controller_args(self, mode="skycontroller3"):
        """Build explicit controller-route arguments for SDK adapter checks."""
        return SimpleNamespace(ip=None, controller=mode, home_lat=0, home_lon=0,
                               gimbal_pitch=None, execute=False)

    def test_missing_or_nonfinite_gimbal_state_stays_unknown(self):
        bridge = AnafiBridge(self.controller_args(), SimpleNamespace(), SimpleNamespace())
        for state in (None, [], Mock(), {}, {'pitch_absolute':float('nan')}, {0:{}}):
            with patch.object(bridge, '_state', return_value=state):
                self.assertIsNone(bridge._gimbal_pitch())
        with patch.object(bridge, '_state', return_value={0:{'pitch_absolute':-45.}}):
            self.assertEqual(bridge._gimbal_pitch(), -45.)

    def test_skycontroller_class_and_default_ip_without_piloting_commands(self):
        """Verify skycontroller class and default ip without piloting commands."""
        drone = Mock(connected=True)
        drone.connect.return_value = drone.drone_connection_state.return_value = True
        bridge = AnafiBridge(self.controller_args(), SimpleNamespace(), SimpleNamespace())
        with patch("anafi_bridge.olympe.SkyController3", return_value=drone) as factory, \
             patch("anafi_bridge.olympe.Anafi", side_effect=AssertionError("wrong SDK class")), \
             patch.object(bridge, "_start_video", return_value=True), \
             patch.object(bridge, "_probe_wind_capability") as wind_probe:
            self.assertTrue(bridge._connect())
        factory.assert_called_once_with("192.168.53.1")
        wind_probe.assert_called_once_with(drone)
        self.assertTrue(bridge._aircraft_link())
        drone.assert_not_called()  # No piloting-source, joystick, gimbal or flight commands.

    def test_main_wind_telemetry_is_additive_and_preserves_takeoff_altitude(self):
        """Telemetry reads keep FC wind direction/availability separate from flight state."""
        import anafi_bridge as module
        args = self.controller_args()
        args.drone_id = 'test'
        bridge = AnafiBridge(args, SimpleNamespace(), SimpleNamespace())
        wind, available, warning = object(), object(), object()
        states = {wind: {'north': 0., 'east': 2.}, available: {'is_wind_speed_available': True},
                  warning: {'state': SimpleNamespace(name='ok')}, module.AltitudeChanged: {'altitude': 1.}}
        with patch.multiple(module, WindSpeed=wind, FlightDataState=available, WindStateChanged=warning), \
             patch.object(bridge, '_state', side_effect=lambda message: states.get(message)):
            bridge._poll_telemetry()
        self.assertEqual(bridge.telemetry['altitude_m'], 1.)
        self.assertEqual(bridge.telemetry['extra']['fc_wind_speed_mps'], 2.)
        self.assertEqual(bridge.telemetry['extra']['fc_wind_direction_deg'], 90.)
        self.assertTrue(bridge.telemetry['extra']['fc_wind_available'])
        self.assertEqual(bridge.telemetry['extra']['fc_wind_state'], 'ok')
        self.assertEqual(module.fc_wind(0, 0), (0.0, None))

    def test_wind_capability_probe_sends_only_read_only_state_request(self):
        """Connection probing adds a state query, never a piloting command."""
        import anafi_bridge as module
        bridge = AnafiBridge(self.controller_args(), SimpleNamespace(), SimpleNamespace())
        command = Mock()
        request, event = object(), object()
        command.GetState.return_value = request
        drone = Mock()
        drone.get_state.return_value = {'is_wind_speed_available': True}
        with patch.multiple(module, FlightDataCommand=command, FlightDataState=event):
            bridge._probe_wind_capability(drone)
        command.GetState.assert_called_once_with(include_default_capabilities=True)
        drone.assert_called_once_with(request)
        drone.return_value.wait.assert_called_once_with(_timeout=5)
        drone.get_state.assert_called_once_with(event)

    def test_controller_connection_without_paired_aircraft_is_not_a_drone_link(self):
        """Verify controller connection without paired aircraft is not a drone link."""
        drone = Mock(connected=True)
        drone.connect.return_value = True
        drone.drone_connection_state.return_value = False
        bridge = AnafiBridge(self.controller_args(), SimpleNamespace(), SimpleNamespace())
        with patch("anafi_bridge.olympe.SkyController3", return_value=drone), \
             patch("anafi_bridge.time.monotonic", side_effect=[0, 9]), \
             patch.object(bridge, "_start_video") as video:
            self.assertFalse(bridge._connect())
        video.assert_not_called()
        drone.disconnect.assert_called_once()
        drone.destroy.assert_called_once()
        drone.assert_not_called()

    def test_physical_controller_source_must_be_explicitly_reported(self):
        """Verify physical controller source must be explicitly reported."""
        bridge = QROrbitBridge(self.controller_args(), SimpleNamespace(), SimpleNamespace(), None, Limits(),
                               "EW1:Alpha|120|X|35|M|30|60|31|18|18")
        for state, accepted in ((None, False), ({"source": "Controller"}, False),
                                ({"source": SimpleNamespace(name="SkyController")}, True)):
            with patch.object(bridge, "_state", return_value=state):
                self.assertEqual(bridge._controller_source_ok(), accepted)
        bridge.controller_kind = "direct"
        with patch.object(bridge, "_state", return_value={"source": "SkyController"}):
            self.assertFalse(bridge._controller_source_ok())

    def test_live_direct_mode_rejected_before_aircraft_construction(self):
        """Verify live direct mode rejected before aircraft construction."""
        with patch.object(sys, "argv", ["qr_orbit_bridge.py", "--execute"]), \
             patch.object(qr_orbit_bridge, "QROrbitBridge") as factory, \
             contextlib.redirect_stderr(io.StringIO()) as output, \
             self.assertRaises(SystemExit) as exit:
            qr_orbit_bridge.main()
        self.assertEqual(exit.exception.code, 2)
        self.assertIn("requires --controller skycontroller3", output.getvalue())
        factory.assert_not_called()

    def test_terminal_mode_requires_its_own_landing_record(self):
        """Verify terminal mode requires its own landing record."""
        import time
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/"preflight.json"
            record = {key: True for key in ("cleared_area", "pilot_present", "landing_control_tested_with_pi",
                                           "marker_on_launch_floor", "calibration_checked_at_known_positions")}
            record["checked_at_unix"] = time.time()
            path.write_text(json.dumps(record))
            with self.assertRaises(ValueError):
                read_preflight(path, terminal_control=True)
            record.update(terminal_landing_tested_with_pi=True, controller_powered_off=True)
            path.write_text(json.dumps(record))
            read_preflight(path, terminal_control=True)

    def test_terminal_land_key_uses_existing_driver_before_any_report(self):
        """Verify terminal land key uses existing driver before any report."""
        args = self.controller_args(mode="direct")
        args.execute = True
        bridge = QROrbitBridge(args, SimpleNamespace(), SimpleNamespace(), None, Limits(),
                               "EW1:Alpha|120|X|35|M|30|60|31|18|18")
        bridge.connected = True
        order = []
        bridge.driver = SimpleNamespace(request_land=lambda: order.append("LAND"))
        with patch("qr_orbit_bridge.terminal_commands", return_value=iter(["LAND"])):
            bridge._terminal()
        self.assertTrue(bridge.abort_flight.is_set())
        self.assertTrue(bridge.input_closed.is_set())
        self.assertEqual(order[0], "LAND")

    def test_hover_checkout_has_no_horizontal_or_qr_commands(self):
        """Verify hover checkout has no horizontal or qr commands."""
        args = self.controller_args(mode="direct")
        args.execute, args.terminal_control, args.hover_seconds = True, True, 1
        bridge = HoverCheckout(args, SimpleNamespace(), SimpleNamespace())
        calls, now = [], [0.0]
        pending = SimpleNamespace(done=lambda: True, success=lambda: True, cancel=lambda: None)
        bridge.connected = True
        bridge.last_frame_time = time.time()
        bridge.sensor_ages = SimpleNamespace(ages={key: now[0] for key in ("altitude", "speed", "attitude")})
        bridge.telemetry = {"state": "landed", "battery_pct": 50, "altitude_m": 0,
                            "ground_speed_mps": 0, "attitude_deg": {"roll": 0, "pitch": 6.7}}
        def receive(message):
            """Supply a controlled SDK state/frame update to the tested flight runtime."""
            calls.append(message)
            bridge.telemetry["state"] = "motor_ramping"
            return pending
        bridge.drone = receive
        def advance(seconds):
            """Advance the fake clock and refresh test sensor timestamps."""
            now[0] += seconds
            bridge.sensor_ages.ages = {key: now[0] for key in ("altitude", "speed", "attitude")}
            bridge.telemetry["state"] = "motor_ramping" if now[0] < .25 else "takingoff" if now[0] < .5 else "hovering"
            if now[0] >= .5:
                bridge.telemetry.update(altitude_m=1, attitude_deg={"roll": 0, "pitch": 0})
        with patch.object(bridge, "_aircraft_link", return_value=True), \
             patch.object(bridge, "_land") as land, \
             patch("hover_checkout.time.monotonic", side_effect=lambda: now[0]), \
             patch("hover_checkout.time.sleep", side_effect=advance):
            bridge._hover()
        self.assertEqual(len(calls), 1)  # TakeOff only; mocked landing tested separately.
        self.assertIn("TakeOff", str(calls[0]))
        self.assertGreaterEqual(now[0], 1.5)  # The full hover completed after startup.
        messages = [entry[1] for entry in list(bridge.status_queue.queue)]
        self.assertTrue(any("'motor_ramping'" in message for message in messages))
        self.assertFalse(any("unexpected flight state" in message for message in messages))
        land.assert_called_once()

    def test_hover_checkout_abort_before_takeoff_never_sends_takeoff(self):
        """Verify hover checkout abort before takeoff never sends takeoff."""
        args = self.controller_args(mode="direct")
        args.execute, args.terminal_control, args.hover_seconds = True, True, 1
        bridge = HoverCheckout(args, SimpleNamespace(), SimpleNamespace())
        bridge.drone = Mock()
        bridge.abort_flight.set()
        with patch.object(bridge, "checkout_reason", return_value=None), \
             patch.object(bridge, "_land") as land:
            bridge._hover()
        self.assertTrue(all("Landing" in str(call.args[0]) for call in bridge.drone.call_args_list))
        land.assert_called_once()

    def test_hover_checkout_resting_attitude_is_separate_from_airborne_limit(self):
        """Verify hover checkout resting attitude is separate from airborne limit."""
        import time
        bridge = HoverCheckout(self.controller_args(mode="direct"), SimpleNamespace(), SimpleNamespace())
        bridge.connected = True
        bridge.sensor_ages = SimpleNamespace(ages={key: time.monotonic() for key in ("altitude", "speed", "attitude")})
        bridge.last_frame_time = time.time()
        bridge.telemetry = {"state": "landed", "battery_pct": 50, "altitude_m": 0,
                            "ground_speed_mps": 0, "attitude_deg": {"roll": .9, "pitch": 14.4}}
        with patch.object(bridge, "_aircraft_link", return_value=True):
            self.assertIsNone(bridge.checkout_reason(starting=True))
            bridge.telemetry.update(state="takingoff", altitude_m=.3)
            self.assertIsNone(bridge.checkout_reason())
            bridge.telemetry.update(state="motor_ramping", altitude_m=0)
            self.assertIsNone(bridge.checkout_reason())
            self.assertIn("grounded", bridge.checkout_reason(starting=True))
            bridge.telemetry.update(state="hovering", altitude_m=1)
            self.assertIn("maximum 10 in hovering", bridge.checkout_reason())
            bridge.telemetry["attitude_deg"]["pitch"] = 0
            self.assertIsNone(bridge.checkout_reason())
            self.assertIn("grounded", bridge.checkout_reason(starting=True))
            bridge.telemetry.update(state="landed", altitude_m=0)
            bridge.telemetry["attitude_deg"]["pitch"] = 21
            self.assertIn("maximum 20 in landed", bridge.checkout_reason(starting=True))
            bridge.telemetry["attitude_deg"]["pitch"] = 0
            for state in ("landing", "emergency", "emergency_landing", "usertakeoff", "unknown", None):
                bridge.telemetry["state"] = state
                self.assertEqual(bridge.checkout_reason(), f"unexpected flight state: {state!r}")
        self.assertIsNone(bridge.driver)

    def test_landing_keys_after_confirmed_landing_do_not_restart_cleanup(self):
        """Verify landing keys after confirmed landing do not restart cleanup."""
        args = self.controller_args(mode="direct")
        args.execute = True
        bridge = HoverCheckout(args, SimpleNamespace(), SimpleNamespace())
        bridge.connected = bridge.land_confirmed = True
        bridge.driver = Mock()
        with patch("hover_checkout.terminal_commands", return_value=iter(["LAND"])):
            bridge._terminal()
        bridge.driver.request_land.assert_not_called()
        self.assertTrue(bridge.land_confirmed)

    def test_reports_do_not_write_to_terminal_from_flight_worker(self):
        """Verify reports do not write to terminal from flight worker."""
        bridge = HoverCheckout(self.controller_args(mode="direct"), SimpleNamespace(), SimpleNamespace())
        with patch("builtins.print", side_effect=AssertionError("flight worker must not print")):
            bridge.report("landing", "test")
        self.assertEqual(bridge.status_queue.get_nowait()[:1], ("landing",))

    def setup_fake(self):
        """Install guarded fake aircraft/expectation objects for SDK adapter tests."""
        pending = SimpleNamespace(done=lambda: False, success=lambda: False,
                                  cancel=lambda: setattr(self, "cancelled", True))
        self.calls, self.cancelled, self.now = [], False, 10.0
        class Drone:
            connected = True
            def __call__(_, message):
                """Return a controlled SDK expectation for the submitted test command."""
                self.calls.append(message)
                return pending
        bridge = SimpleNamespace(drone=Drone(), connected=True,
                                 sensor_ages=SimpleNamespace(landed_at=float("-inf"),
                                     state='landing',state_at=10.,emergency_at=float('-inf'),ages={}),
                                 _state=lambda event: {'roll':0.,'pitch':0.,'speedX':0.,'speedY':0.,'speedZ':0.})
        return OlympeOrbitDriver(bridge), bridge

    def test_abort_is_checked_before_issuing_move(self):
        """Verify abort is checked before issuing move."""
        driver, _ = self.setup_fake()
        def abort():
            """Raise the injected cancellation used to test interruptible SDK movement."""
            raise InterruptedError("operator stop")
        with self.assertRaises(InterruptedError):
            driver.move((.1, -.5, 0, .5), .25, abort)
        self.assertEqual(self.calls, [])

    def test_bounded_move_is_interruptible_without_blocking_wait(self):
        """Verify bounded move is interruptible without blocking wait."""
        driver, _ = self.setup_fake()
        checks = [0]
        def abort():
            """Raise the injected cancellation used to test interruptible SDK movement."""
            checks[0] += 1
            if checks[0] > 1:
                raise InterruptedError("operator stop")
        with self.assertRaises(InterruptedError):
            driver.move((.1, -.5, 0, .5), .25, abort)
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(self.cancelled)

    def test_movement_uses_matching_event_not_sdk_cache_and_records_actual_result(self):
        """Verify movement uses matching event not sdk cache and records actual result."""
        requested = (.034, -.259, 0., .262)
        actual = (.13, -.259, 0., .262)  # 9.6 cm endpoint error is corrected next step.
        pending = Mock()
        pending.done.return_value = pending.success.return_value = True
        result = dict(zip(('dX','dY','dZ','dPsi'),actual), error='ok')
        pending.matched_events.return_value.last.return_value = SimpleNamespace(args=result)
        drone = Mock(return_value=pending)
        drone.get_state.side_effect = AssertionError('cached event is not command acknowledgement')
        publisher = Mock()
        driver = OlympeOrbitDriver(SimpleNamespace(drone=drone, publisher=publisher, path_reference='launch-heading'))
        self.assertEqual(driver.move(requested,.25,lambda:None),actual)
        self.assertEqual(publisher.diagnostic.call_args_list[-1].args[0], 'move_completed')
        for change in ({'dX':.5}, {'dPsi':1.}, {'dY':float('nan')}, {'error':'interrupted'}):
            pending.matched_events.return_value.last.return_value = SimpleNamespace(args={**result,**change})
            with self.assertRaises(RuntimeError):
                driver.move(requested,.25,lambda:None)
            pending.cancel.assert_called()
            self.assertEqual(publisher.diagnostic.call_args_list[-1].args[0], 'move_failed')
        pending.matched_events.return_value.last.return_value = None
        with self.assertRaisesRegex(RuntimeError,'without its displacement event'):
            driver.move(requested,.25,lambda:None)

    def test_measured_fire_replans_recorded_undershoot_but_rejects_drift(self):
        # Flight 20261018T083321Z: SDK reported success and a 9.8 cm shortfall.
        requested=(-.1986341183633339,-.023334245692138024,0.,.116937554623745)
        actual=(-.10045764595270157,-.016285628080368042,-.01569056510925293,.115997314453125)
        pending=Mock();pending.done.return_value=pending.success.return_value=True
        result=dict(zip(('dX','dY','dZ','dPsi'),actual),error='ok')
        pending.matched_events.return_value.last.return_value=SimpleNamespace(args=result)
        publisher=Mock()
        driver=OlympeOrbitDriver(SimpleNamespace(drone=Mock(return_value=pending),
                                publisher=publisher,path_reference='measured-fire'))
        self.assertEqual(driver.move(requested,.25,lambda:None),actual)
        self.assertEqual(publisher.diagnostic.call_args.args[0],'move_replan')
        for change in ({'dX':.03},{'dX':-.01},{'dX':-.30}, {'dY':.10},
                       {'dZ':.09},{'dPsi':.3},{'error':'interrupted'}):
            with self.subTest(change=change):
                pending.matched_events.return_value.last.return_value=SimpleNamespace(args={**result,**change})
                with self.assertRaises(RuntimeError):driver.move(requested,.25,lambda:None)

    def continuous_fake(self):
        now = [10.]
        pending = Mock()
        pending.done.return_value = pending.success.return_value = True
        pending.wait.return_value = pending
        drone = Mock(return_value=pending, connected=True)
        drone.start_piloting.return_value = drone.piloting.return_value = True
        states = {qr_orbit_bridge.MaxTiltChanged: {'current':20., 'min':1., 'max':40.},
                  qr_orbit_bridge.MaxRotationSpeedChanged: {'current':90., 'min':3., 'max':200.},
                  qr_orbit_bridge.MaxVerticalSpeedChanged: {'current':1., 'min':.1, 'max':4.},
                  qr_orbit_bridge.AttitudeChanged: {'roll':0., 'pitch':0., 'yaw':1.25},
                  qr_orbit_bridge.SpeedChanged: {'speedX':.12, 'speedY':-.27, 'speedZ':-.03},
                  qr_orbit_bridge.AltitudeChanged: {'altitude':1.04}}
        bridge = SimpleNamespace(drone=drone, publisher=Mock(), _state=lambda event:states.get(event),
            connected=True, sensor_ages=SimpleNamespace(ages={'speed':9.9, 'attitude':9.95, 'altitude':9.97},
                state='hovering', state_at=9.8, emergency_at=float('-inf')))
        def advance(seconds): now[0] += seconds
        return OlympeOrbitDriver(bridge), bridge, states, pending, now, advance

    def test_continuous_driver_uses_raw_motion_acknowledged_scales_and_finite_lease(self):
        from continuous_orbit import Control
        driver, bridge, states, pending, now, advance = self.continuous_fake()
        limits=Limits(lap_seconds=15.,speed_mps=.6)
        check=Mock(); report=Mock(); remember=Mock(); target=object()
        def run(received_target, received_limits, guarded, motion, command, reporting, **kwargs):
            self.assertIs(received_target,target);self.assertIs(received_limits,limits)
            self.assertIs(guarded,check);self.assertIs(reporting,report)
            self.assertIs(kwargs['remember'],remember)
            measured=motion()
            self.assertEqual((measured.at,measured.yaw_rad,measured.vx,measured.vy,measured.vz,measured.altitude),
                             (9.9,1.25,.12,-.27,-.03,1.04))
            self.assertEqual(measured.velocity_at,9.9)
            command(Control(-8,3,42,-5))
            self.assertEqual(bridge.drone.call_count,3)  # All three settings ACKed first.
            raise InterruptedError('bounded simulation stopped')
        with patch('continuous_orbit.run_continuous_orbit',side_effect=run), \
             self.assertRaisesRegex(InterruptedError,'bounded simulation'):
            driver.orbit_continuously(target,limits,check,report,remember,clock=lambda:now[0],sleep=advance)
        self.assertEqual(bridge.drone.piloting.call_args_list[0].args,(-8,3,42,-5))
        self.assertTrue(all(c.kwargs['piloting_time']==.20 for c in bridge.drone.piloting.call_args_list))
        self.assertEqual(bridge.drone.piloting.call_args_list[-1].args,(0,0,0,0))
        self.assertIn('PCMD',str(bridge.drone.call_args.args[0]))
        bridge.drone.stop_piloting.assert_called_once()
        self.assertFalse(driver._piloting_active)
        self.assertEqual(len(driver._piloting_restore),3)  # No mid-flight setting restoration.

    def test_continuous_settings_rejection_prevents_piloting_and_timeout_stays_interruptible(self):
        for failure in ('unsupported','rejected','timeout','abort'):
            with self.subTest(failure=failure):
                driver,bridge,states,pending,now,advance=self.continuous_fake()
                if failure=='unsupported':states[qr_orbit_bridge.MaxTiltChanged]['max']=5.
                if failure=='rejected':pending.success.return_value=False
                if failure in ('timeout','abort'):pending.done.return_value=False
                def check():
                    if failure=='abort' and now[0]>=10.1:raise InterruptedError('operator land')
                with patch('continuous_orbit.run_continuous_orbit') as core, self.assertRaises((RuntimeError,InterruptedError,TimeoutError)):
                    driver.orbit_continuously(object(),Limits(lap_seconds=15.),check,Mock(),clock=lambda:now[0],sleep=advance)
                bridge.drone.start_piloting.assert_not_called();bridge.drone.piloting.assert_not_called();core.assert_not_called()
                self.assertLess(now[0],12.1)

    def test_land_neutralizes_before_landing_and_latches_out_later_commands(self):
        from continuous_orbit import Control
        driver,bridge,states,pending,now,advance=self.continuous_fake()
        order=[]
        bridge.drone.side_effect=lambda message:order.append(str(message)) or pending
        bridge.drone.piloting.side_effect=lambda *args,**kwargs:order.append(tuple(args)) or True
        driver._piloting_active=True
        driver._continuous_command(Control(0,0,0,20))
        driver.request_land()
        with self.assertRaisesRegex(InterruptedError,'Landing requested'):
            driver._continuous_command(Control(0,0,0,20))
        driver._continuous_command(Control())  # Cleanup does not restart the SDK timer.
        self.assertEqual(order[:2],[(0,0,0,20),(0,0,0,0)])
        self.assertIn('PCMD',order[2]);self.assertIn('Landing',order[3])
        self.assertFalse(driver._piloting_active)

    def test_installed_sdk_expires_continuous_lease_to_neutral(self):
        # Exercise the installed SDK's actual expiry implementation on a plain
        # fake holder; never construct a Drone or a network controller.
        from olympe.controllers.controller import PilotingCommand
        now=[100.]
        command=PilotingCommand(time_function=lambda:now[0])
        holder=SimpleNamespace(_piloting_command=command,_send_command_impl=Mock())
        command.update_piloting_command(-10,4,40,5,.20)
        qr_orbit_bridge.olympe.Drone._send_piloting_command(holder)
        self.assertEqual(holder._send_command_impl.call_args.args[1]['gaz'],5)
        now[0]+=.21
        qr_orbit_bridge.olympe.Drone._send_piloting_command(holder)
        self.assertEqual(holder._send_command_impl.call_args.args[1],
                         {'flag':0,'roll':0,'pitch':0,'yaw':0,'gaz':0,'timestampAndSeqNum':0})

    def test_continuous_motion_rejects_missing_nonfinite_values_and_preserves_received_age(self):
        driver,bridge,states,*_=self.continuous_fake()
        self.assertEqual(driver._continuous_motion().at,9.9)
        for bad in (None,float('nan'),float('inf')):
            states[qr_orbit_bridge.SpeedChanged]['speedX']=bad
            with self.assertRaises(InterruptedError):driver._continuous_motion()
        states[qr_orbit_bridge.SpeedChanged]['speedX']=0.
        bridge.sensor_ages.ages.pop('speed')
        with self.assertRaises(InterruptedError):driver._continuous_motion()

    def test_continuous_height_uses_takeoff_reference_not_changing_ground_clearance(self):
        from olympe.messages.ardrone3.PilotingState import AltitudeAboveGroundChanged
        driver,bridge,states,*_=self.continuous_fake()
        states[qr_orbit_bridge.AltitudeChanged]={'altitude':1.}
        bridge._state=Mock(side_effect=lambda event:states.get(event))
        # Leaving a 30 cm launch box, then crossing a lower floor, increases
        # clearance without changing the aircraft's height above its launch.
        for clearance in (1.,1.3,1.8):
            states[AltitudeAboveGroundChanged]={'altitude':clearance}
            self.assertEqual(driver._continuous_motion().altitude,1.)
        self.assertTrue(all(call.args[0] is not AltitudeAboveGroundChanged
                            for call in bridge._state.call_args_list))
        # A real rise in takeoff-relative altitude is not hidden or re-zeroed.
        states[qr_orbit_bridge.AltitudeChanged]={'altitude':1.3}
        self.assertEqual(driver._continuous_motion().altitude,1.3)

    def test_continuous_velocity_timestamp_is_independent_of_other_sensor_updates(self):
        driver,bridge,states,*_=self.continuous_fake()
        bridge.sensor_ages.ages={'speed':9.9,'altitude':9.7,'attitude':9.8}
        first=driver._continuous_motion()
        self.assertEqual((first.at,first.velocity_at),(9.7,9.9))
        bridge.sensor_ages.ages.update(altitude=9.95,attitude=9.96)
        other_sensors=driver._continuous_motion()
        self.assertEqual((other_sensors.at,other_sensors.velocity_at),(9.9,9.9))
        self.assertEqual((other_sensors.vx,other_sensors.vy),(first.vx,first.vy))
        bridge.sensor_ages.ages.update(speed=10.1)
        states[qr_orbit_bridge.SpeedChanged]['speedX']=.2
        new_velocity=driver._continuous_motion()
        self.assertEqual((new_velocity.at,new_velocity.velocity_at),(9.95,10.1))
        self.assertEqual(new_velocity.vx,.2)

    def test_continuous_commands_reject_invalid_percentages(self):
        from continuous_orbit import Control
        driver,bridge,*_=self.continuous_fake();driver._piloting_active=True
        for value in (float('nan'),float('inf'),101.,-101.):
            with self.assertRaises(ValueError):driver._continuous_command(Control(value,0,0,0))
        bridge.drone.piloting.assert_not_called()

    def test_continuous_recording_preserves_raw_motion_and_distinct_speed_timestamps(self):
        driver,bridge,states,*_=self.continuous_fake()
        bridge.sensor_ages.ages={'speed':9.9,'altitude':9.7,'attitude':9.8,'camera':9.85}
        driver._continuous_motion();driver._continuous_motion()
        motion_calls=[c for c in bridge.publisher.diagnostic.call_args_list if c.args[0]=='continuous_motion']
        self.assertEqual(len(motion_calls),1)
        recorded=motion_calls[0].args[1]
        self.assertEqual(recorded['sample_times_mono'],bridge.sensor_ages.ages)
        self.assertEqual(recorded['velocity_ned_mps'],{'north':.12,'east':-.27,'down':-.03})
        self.assertEqual(recorded['attitude_rad'],{'roll':0.,'pitch':0.,'yaw':1.25})
        self.assertEqual((recorded['yaw_rad'],recorded['altitude_m']),(1.25,1.04))
        self.assertEqual((recorded['oldest_sensor_at_mono'],recorded['velocity_at_mono']),(9.7,9.9))
        bridge.sensor_ages.ages.update(altitude=10.,attitude=10.)
        driver._continuous_motion()
        self.assertEqual(bridge.publisher.diagnostic.call_count,1)
        bridge.sensor_ages.ages['speed']=10.1
        states[qr_orbit_bridge.SpeedChanged]['speedX']=.2
        driver._continuous_motion()
        self.assertEqual(bridge.publisher.diagnostic.call_count,2)
        self.assertEqual(bridge.publisher.diagnostic.call_args.args[1]['velocity_ned_mps']['north'],.2)

    def test_continuous_recording_logs_each_applied_command_and_cleanup_lease(self):
        from continuous_orbit import Control
        driver,bridge,*_=self.continuous_fake();driver._piloting_active=True
        with patch('qr_orbit_bridge.time.monotonic',return_value=12.5):
            driver._continuous_command(Control(-8,3,42,-5))
            driver._continuous_command(Control(-8,3,42,-5))
            driver._neutralize_continuous_controls()
        rows=[c.args[1] for c in bridge.publisher.diagnostic.call_args_list if c.args[0]=='continuous_pcmd']
        self.assertEqual(len(rows),3)
        for row in rows:
            self.assertEqual(row['issued_at_mono'],12.5)
            self.assertEqual(row['lease_seconds'],.20)
            self.assertTrue(row['accepted'])
        self.assertEqual(rows[0]['command'],{'roll':-8,'pitch':3,'yaw':42,'gaz':-5})
        self.assertEqual(rows[-1]['command'],{'roll':0,'pitch':0,'yaw':0,'gaz':0})
        self.assertEqual(rows[-1]['reason'],'landing_or_cleanup')

    def test_continuous_high_cadence_diagnostics_require_an_active_recorder(self):
        from continuous_orbit import Control
        driver,bridge,*_=self.continuous_fake();driver._piloting_active=True
        bridge.publisher.recorder=None
        driver._continuous_motion();driver._continuous_command(Control(-8,3,42,-5))
        bridge.publisher.diagnostic.assert_not_called()

    def test_recording_continues_while_backend_video_upload_is_blocked(self):
        """Verify recording continues while backend video upload is blocked."""
        import threading
        from anafi_bridge import Publisher
        from flight_recording import FlightRecorder
        gate, entered = threading.Event(), threading.Event()
        with tempfile.TemporaryDirectory() as root:
            publisher = Publisher(root)
            def blocked(*args):
                """Block a fake network operation to verify recording/control remain independent."""
                entered.set()
                gate.wait(3)
            with patch.object(publisher,'_post',side_effect=blocked):
                publisher.start_recording()
                try:
                    publisher.frame(b'jpeg-a',100.,[])
                    self.assertTrue(entered.wait(1))
                    for i in range(20):
                        publisher.frame(b'jpeg-b',100.1+i/30,[])
                    publisher.diagnostic('flight_control',{'phase':'landed'})
                    publisher.close()
                    self.assertEqual(publisher.recorder.stats['frames'],21)
                    self.assertLessEqual(publisher.frame_uploads.qsize(),1)
                    self.assertIn('landed',(publisher.recorder.path/'events.jsonl').read_text())
                finally:
                    gate.set()
                    publisher.close()

    def test_person_outbox_recovery_and_flight_recording_coexist(self):
        """Verify person outbox recovery and flight recording coexist."""
        from anafi_bridge import Publisher
        with tempfile.TemporaryDirectory() as root:
            publisher = Publisher(root, 'http://test.invalid', 'test-token')
            try:
                with patch.object(publisher, '_post', return_value=None):
                    publisher.start_recording()
                    publisher.person({'obs_id':'merge-test-person'})
                self.assertEqual(len(publisher.outbox), 1)
                self.assertIn('merge-test-person', Path(publisher.outbox_path).read_text())
                with patch.object(publisher, '_post', return_value={}) as post:
                    publisher.telemetry({'state':'hovering','altitude_m':1})
                    publisher.flight('landed','merge integration test')
                self.assertEqual(publisher.outbox, [])
                self.assertEqual(Path(publisher.outbox_path).read_text(), '')
                self.assertIn('/api/ingest/person', [call.args[0] for call in post.call_args_list])
            finally:
                publisher.close()
            evidence = (publisher.recorder.path/'events.jsonl').read_text()
            self.assertIn('telemetry', evidence)
            self.assertIn('landed', evidence)

    def test_bridge_shutdown_flushes_recording_after_disconnect(self):
        """Verify bridge shutdown flushes recording after disconnect."""
        args = self.controller_args(mode='direct')
        args.no_window, args.demo_flight = True, False
        publisher = Mock()
        bridge = AnafiBridge(args, publisher, Mock())
        bridge.running = False
        order = []
        publisher.close.side_effect = lambda: order.append('recording closed')
        with patch('anafi_bridge.threading.Thread'), \
             patch.object(bridge, '_disconnect', side_effect=lambda: order.append('disconnected')):
            bridge.run()
        self.assertEqual(order, ['disconnected', 'recording closed'])

    def test_legacy_demo_does_not_report_landed_when_confirmation_fails(self):
        bridge=AnafiBridge(self.controller_args(mode='direct'),Mock(),Mock());bridge.drone=Mock()
        listener=Mock();driver=Mock();driver.land.return_value=False
        with patch('qr_orbit_bridge.SensorAges',return_value=listener), \
             patch('qr_orbit_bridge.OlympeOrbitDriver',return_value=driver):bridge._land()
        self.assertEqual(bridge.flight_phase,'error')
        self.assertFalse(any(c.args[0]=='landed' for c in bridge.publisher.flight.call_args_list))
        listener.subscribe.assert_called_once();listener.unsubscribe.assert_called_once()

    def test_frame_receipt_timestamp_survives_queue_and_conversion_delay(self):
        import numpy as np
        args=self.controller_args(mode='direct');args.no_window=True;args.demo_flight=False
        bridge=AnafiBridge(args,Mock(),Mock());frames=[Mock(),Mock(),Mock()]
        with patch('anafi_bridge.time.time',side_effect=[100.,100.1,100.2]):
            for frame in frames:bridge._yuv_frame_cb(frame)
        frames[0].unref.assert_called_once()
        frames[1].unref.assert_not_called()
        def convert(frame):bridge.running=False;return np.zeros((2,2,3),dtype=np.uint8)
        with patch('anafi_bridge.threading.Thread'),patch('anafi_bridge.time.time',return_value=105.), \
             patch.object(bridge,'_to_bgr',side_effect=convert),patch.object(bridge,'_disconnect'):
            bridge.run()
        self.assertEqual(bridge.latest_bgr[1],100.1)
        self.assertEqual(bridge.last_frame_time,100.1)
        frames[1].unref.assert_called_once()

    def test_landing_requires_a_received_landed_event(self):
        """Verify landing requires a received landed event."""
        driver, bridge = self.setup_fake()
        driver._restore_continuous_controls=Mock()
        def sleep(seconds):
            """Advance simulated waiting while injecting the test landing-state event."""
            self.now += seconds
            bridge.sensor_ages.ages={'attitude':self.now,'speed':self.now}
        with patch("qr_orbit_bridge.time.monotonic", side_effect=lambda: self.now), \
             patch("qr_orbit_bridge.time.sleep", side_effect=sleep):
            self.assertFalse(driver.land())
        driver._restore_continuous_controls.assert_not_called()
        self.assertTrue(self.cancelled)
        self.assertGreater(len(self.calls), 1)  # Landing retries, no real aircraft.
        # A fresh landed event after the first request permits confirmation.
        bridge.sensor_ages.landed_at = self.now
        bridge.sensor_ages.state='landed'
        bridge.sensor_ages.state_at=self.now
        with patch("qr_orbit_bridge.time.monotonic", side_effect=lambda: self.now), \
             patch("qr_orbit_bridge.time.sleep", side_effect=sleep):
            self.assertTrue(driver.land())
        driver._restore_continuous_controls.assert_called_once()

    def test_landing_rejects_successful_expectation_when_aircraft_is_in_emergency(self):
        driver,bridge=self.setup_fake()
        pending=Mock();pending.success.return_value=True
        bridge.drone=Mock(return_value=pending,connected=True)
        bridge.sensor_ages.state='emergency';bridge.sensor_ages.emergency_at=self.now
        bridge.sensor_ages.landed_at=self.now
        driver.first_land_request=self.now-1
        with patch('qr_orbit_bridge.time.monotonic',side_effect=lambda:self.now):
            self.assertFalse(driver.land())
        self.assertIn('emergency',driver.landing_error)
        self.assertFalse(any('Landing(' in str(c) for c in self.calls))
        pending.cancel.assert_called_once()

    def test_rehearsal_never_constructs_a_flight_driver(self):
        """Verify rehearsal never constructs a flight driver."""
        args = SimpleNamespace(ip="192.168.42.1", home_lat=0, home_lon=0, execute=False)
        with patch("qr_orbit_bridge.OlympeOrbitDriver", side_effect=AssertionError("flight driver forbidden")):
            bridge = QROrbitBridge(args, SimpleNamespace(), SimpleNamespace(), None, Limits(),
                                   "EW1:Alpha|120|X|35|M|30|60|31|18|18")
            self.assertIsNone(bridge.driver)
            bridge._land()  # No landing command in rehearsal, even on shutdown.
            with patch("builtins.print", side_effect=BrokenPipeError):
                bridge.report("landing", "a lost stdout cannot block cleanup")
            self.assertFalse(bridge.status_queue.empty())

    def test_incomplete_or_old_physical_preflight_rejected(self):
        """Verify incomplete or old physical preflight rejected."""
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/"preflight.json"
            path.write_text('{}')
            with self.assertRaises(ValueError):
                read_preflight(path)
            c = {key: True for key in ("cleared_area", "pilot_present", "landing_control_tested_with_pi",
                                       "marker_on_launch_floor", "calibration_checked_at_known_positions")}
            c["checked_at_unix"] = 1
            path.write_text(json.dumps(c))
            with self.assertRaises(ValueError):
                read_preflight(path)


if __name__ == "__main__":
    unittest.main()
