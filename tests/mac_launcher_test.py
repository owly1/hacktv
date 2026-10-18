"""Mac launcher checks: no network, Pi mutations or aircraft connections."""
import importlib.util
import io
from pathlib import Path
import shlex
import tarfile
import unittest
import contextlib
import subprocess
import tempfile
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('mac_launcher', Path(__file__).parents[1] / 'scripts/mac.py')
mac = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mac)


class MacLauncherTests(unittest.TestCase):
    def supervisor_context(self, directory):
        """Patch observation subprocesses and locks for an isolated supervisor test."""
        stack = contextlib.ExitStack()
        stack.enter_context(patch.object(mac, 'OBSERVER_LOCK', Path(directory) / 'lock'))
        stack.enter_context(patch.object(mac, 'OBSERVER_STOP', Path(directory) / 'stop'))
        stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        stack.enter_context(patch.object(mac, 'start_fire_monitor', return_value=Mock(poll=Mock(return_value=None))))
        stack.enter_context(patch.object(mac, 'stop_child'))
        return stack

    def test_flight_monitor_excludes_person_work_and_observer_retains_it(self):
        """The launch mode selects person inference before the child starts."""
        env = {'PORT': 8787, 'INGEST_TOKEN': 'test-ingest', 'DASHBOARD_TOKEN': 'test-dashboard'}
        with patch.object(mac.subprocess, 'Popen') as spawn:
            mac.start_fire_monitor(env)
            argv = spawn.call_args.args[0]
            self.assertIn('--flight-targets', argv)
            self.assertIn('--no-people', argv)
            mac.start_fire_monitor(env, observer=True)
            argv = spawn.call_args.args[0]
            self.assertNotIn('--flight-targets', argv)
            self.assertNotIn('--no-people', argv)

    def test_off_at_start_then_two_sessions_without_restarting_backend(self):
        """Verify off at start then two sessions without restarting backend."""
        # Missing Wi-Fi at startup, first live session loses link, next is
        # explicitly stopped. Each recovery reselects Wi-Fi and aligns clocks.
        with tempfile.TemporaryDirectory() as directory, self.supervisor_context(directory), \
             patch.object(mac, 'backend_status') as backend, \
             patch.object(mac, 'remote', side_effect=[subprocess.CalledProcessError(10, 'wifi'), None, None]) as remote, \
             patch.object(mac, 'sync_clock') as sync, \
             patch.object(mac.time, 'sleep'), \
             patch.object(mac.subprocess, 'Popen', side_effect=[Mock(wait=Mock(return_value=75)), Mock(wait=Mock(return_value=0))]) as launch:
            mac.supervise_observer(mac.DEFAULTS, {'PORT': 8787}, 'observer')
            self.assertEqual(launch.call_count, 2)
            self.assertEqual(backend.call_count, 3)
            self.assertEqual(remote.call_count, 3)
            self.assertEqual(sync.call_count, 2)

    def test_stop_while_drone_absent_cancels_retries(self):
        """Verify stop while drone absent cancels retries."""
        with tempfile.TemporaryDirectory() as directory, self.supervisor_context(directory), \
             patch.object(mac, 'backend_status'), \
             patch.object(mac, 'remote', side_effect=subprocess.CalledProcessError(10, 'wifi')) as remote, \
             patch.object(mac.time, 'sleep', side_effect=lambda _: mac.OBSERVER_STOP.touch()), \
             patch.object(mac.subprocess, 'Popen') as launch:
            mac.supervise_observer(mac.DEFAULTS, {'PORT': 8787}, 'observer')
            remote.assert_called_once()
            launch.assert_not_called()

    def test_competing_flight_session_stops_recovery(self):
        """Verify competing flight session stops recovery."""
        with tempfile.TemporaryDirectory() as directory, self.supervisor_context(directory), \
             patch.object(mac, 'backend_status'), \
             patch.object(mac, 'remote', side_effect=subprocess.CalledProcessError(73, 'guard')), \
             patch.object(mac.subprocess, 'Popen') as launch:
            with self.assertRaisesRegex(ValueError, 'Another receiver'):
                mac.supervise_observer(mac.DEFAULTS, {'PORT': 8787}, 'observer')
            launch.assert_not_called()

    def test_observer_never_enables_execution(self):
        """Verify observer never enables execution."""
        command = mac.runtime_command(mac.DEFAULTS, 'observe', False)
        self.assertIn('anafi_observer.py', command)
        self.assertIn('--camera-transport frame', command)
        self.assertIn('--camera-fps 0', command)
        self.assertNotIn('--execute', command)
        with self.assertRaises(ValueError):
            mac.runtime_command(mac.DEFAULTS, 'observe', True)

    def test_preset_and_hover_need_explicit_execution_option(self):
        """Verify preset and hover need explicit execution option."""
        for mode, program in [('qr-preset', 'qr_preset_demo.py'), ('hover', 'hover_checkout.py')]:
            rehearsal = mac.runtime_command(mac.DEFAULTS, mode, False)
            live = mac.runtime_command(mac.DEFAULTS, mode, True)
            self.assertIn('python -u ' + program, rehearsal)
            self.assertNotIn('--execute', rehearsal)
            self.assertIn('--execute', live)
            self.assertNotIn('ARM QR PRESET', live)
            self.assertNotIn('TAKEOFF TEST', live)

    def test_qr_circle_is_explicit_native_calibrated_and_not_supervised(self):
        """Verify qr circle is explicit native calibrated and not supervised."""
        observe = mac.runtime_command(mac.DEFAULTS, 'observe', False)
        live = mac.runtime_command(mac.DEFAULTS, 'qr-circle', True)
        preview = mac.runtime_command(mac.DEFAULTS, 'qr-circle', False)
        self.assertIn('python -u qr_auto_circle.py', live)
        self.assertIn('--video-width 0', live)
        self.assertIn('--camera-calibration camera.local.json', live)
        self.assertIn('--preflight-file current-preflight.local.json', live)
        self.assertIn('--execute', live)
        self.assertNotIn('--execute', preview)
        self.assertNotIn('--camera-calibration', preview)
        self.assertNotIn('python -u qr_auto_circle.py', observe)
        self.assertIn('qr_auto_circle', mac.prepare_command(mac.DEFAULTS))
        with self.assertRaises(ValueError):
            mac.runtime_command(mac.DEFAULTS, 'unknown', True)

    def test_automatic_preset_selects_fixed_path_without_calibration(self):
        """Verify automatic preset selects fixed path without calibration."""
        live=mac.runtime_command(mac.DEFAULTS,'qr-demo',True)
        rehearsal=mac.runtime_command(mac.DEFAULTS,'qr-demo',False)
        self.assertIn('qr_auto_circle.py',live)
        self.assertIn('--preset',live)
        self.assertIn('--video-fps 30',live)
        self.assertIn('--execute',live)
        self.assertNotIn('--execute',rehearsal)
        for text in (live,rehearsal):
            self.assertNotIn('--camera-calibration',text)
            self.assertNotIn('--preflight-file',text)
            self.assertNotIn('ARM QR PRESET',text)

    def test_fire_response_is_session_controlled_with_native_video(self):
        command=mac.runtime_command(mac.DEFAULTS,'fire-response',False)
        self.assertIn('python -u fire_response.py',command)
        self.assertIn('--video-width 0',command)
        self.assertIn('--video-fps 30',command)
        self.assertIn('--camera-calibration camera.local.json',command)
        self.assertNotIn('--execute',command)
        self.assertIn('fire_response',mac.prepare_command(mac.DEFAULTS))
        with self.assertRaisesRegex(ValueError,'dashboard session'):
            mac.runtime_command(mac.DEFAULTS,'fire-response',True)
        self.assertNotIn('--short-test',command)
        self.assertIn('--short-test',mac.runtime_command(mac.DEFAULTS,'fire-response',False,short_test=True))
        with self.assertRaises(ValueError):mac.runtime_command(mac.DEFAULTS,'qr-demo',True,short_test=True)

    def test_fire_supervisor_restarts_monitor_and_receiver_without_enabling(self):
        child=Mock(wait=Mock(side_effect=[subprocess.TimeoutExpired('receiver',1),0]))
        monitor=Mock(poll=Mock(side_effect=[None,1]))
        with tempfile.TemporaryDirectory() as directory, self.supervisor_context(directory), \
             patch.object(mac,'start_fire_monitor',side_effect=[monitor,Mock()]) as vision, \
             patch.object(mac,'backend_status'),patch.object(mac,'remote'), \
             patch.object(mac,'sync_clock'),patch.object(mac,'fetch_flights'), \
             patch.object(mac.subprocess,'Popen',return_value=child) as launch, \
             patch.object(mac.time,'sleep',side_effect=KeyboardInterrupt):
            mac.supervise_fire_response(mac.DEFAULTS,{'PORT':8787},'fire_response.py')
        self.assertEqual(vision.call_count,2)
        self.assertIn('-T',launch.call_args.args[0])
        self.assertNotIn('--execute',' '.join(launch.call_args.args[0]))

    def test_connection_guards_precede_runtime_start(self):
        """Verify connection guards precede runtime start."""
        preparation = mac.prepare_command(mac.DEFAULTS)
        self.assertLess(preparation.index('A flight checkout is already running'), preparation.index('systemctl --user stop'))
        self.assertLess(preparation.index('Another observation receiver'), preparation.index('wifi-profile'))
        command = mac.runtime_command(mac.DEFAULTS, 'qr-preset', False)
        self.assertLess(command.index('A flight checkout is already running'), command.index('exec /bin/bash'))
        self.assertLess(command.index('Another observation receiver'), command.index('exec /bin/bash'))
        self.assertIn('127.0.0.1:8788', command)
        self.assertNotIn('set-clock', command)
        self.assertNotIn('wifi-profile', command)

    def test_fire_supervisor_cleans_its_orphan_before_relaunch(self):
        first=Mock(wait=Mock(return_value=255))
        second=Mock(wait=Mock(side_effect=[KeyboardInterrupt,0]))
        commands=[]
        cleanup_attempts=0
        def remote_call(config,command):
            nonlocal cleanup_attempts
            commands.append(command)
            if 'Requested graceful stop' in command:
                cleanup_attempts+=1
                if cleanup_attempts==1:
                    raise subprocess.CalledProcessError(75,'still stopping')
        with tempfile.TemporaryDirectory() as directory, self.supervisor_context(directory), \
             patch.object(mac,'backend_status'),patch.object(mac,'remote',side_effect=remote_call), \
             patch.object(mac,'sync_clock'),patch.object(mac,'fetch_flights'), \
             patch.object(mac.time,'sleep'), \
             patch.object(mac.secrets,'token_hex',side_effect=['a'*32,'b'*32]), \
             patch.object(mac.subprocess,'Popen',side_effect=[first,second]) as launch:
            mac.supervise_fire_response(mac.DEFAULTS,{'PORT':8787},'receiver')
        self.assertEqual(launch.call_count,2)
        self.assertEqual(commands[0],mac.prepare_command(mac.DEFAULTS))
        self.assertEqual(commands[1],commands[2])  # retry cleanup, never launch over it
        self.assertIn('a'*32,commands[1])
        self.assertEqual(commands[3],mac.prepare_command(mac.DEFAULTS))
        self.assertIn('b'*32,commands[4])  # shutdown owns only the new receiver
        self.assertIn('EMBERWATCH_RECEIVER_OWNER='+'a'*32,launch.call_args_list[0].args[0][-1])

    def test_fire_supervisor_reselects_wifi_while_sdk_is_still_running(self):
        child=Mock(wait=Mock(side_effect=[subprocess.TimeoutExpired('receiver',1),0]))
        with tempfile.TemporaryDirectory() as directory, self.supervisor_context(directory), \
             patch.object(mac,'backend_status'),patch.object(mac,'remote') as remote, \
             patch.object(mac,'sync_clock'),patch.object(mac,'fetch_flights'), \
             patch.object(mac.subprocess,'Popen',return_value=child), \
             patch.object(mac.time,'monotonic',side_effect=[0,0,11,11]), \
             patch.object(mac.time,'sleep',side_effect=KeyboardInterrupt):
            mac.supervise_fire_response(mac.DEFAULTS,{'PORT':8787},'receiver')
        self.assertEqual(remote.call_args_list[1].args[1],mac.wifi_command(mac.DEFAULTS))
        self.assertIn('!=',mac.wifi_command(mac.DEFAULTS))

    def test_fire_supervisor_does_not_claim_another_receiver(self):
        with tempfile.TemporaryDirectory() as directory, self.supervisor_context(directory), \
             patch.object(mac,'backend_status'), \
             patch.object(mac,'remote',side_effect=subprocess.CalledProcessError(73,'guard')) as remote, \
             patch.object(mac.subprocess,'Popen') as launch:
            with self.assertRaisesRegex(ValueError,'Another receiver'):
                mac.supervise_fire_response(mac.DEFAULTS,{'PORT':8787},'receiver')
        remote.assert_called_once()
        launch.assert_not_called()

    def test_owned_cleanup_only_signals_matching_launch(self):
        owner='a'*32
        code=shlex.split(mac.stop_receiver_command(mac.DEFAULTS,'fire_response.py','fire response',owner))[-1]
        process=Mock()
        process.name='123'
        files={
            'cmdline':Mock(read_bytes=Mock(return_value=b'python\0fire_response.py\0')),
            'cwd':Mock(resolve=Mock(return_value=(Path('/home/pet')/mac.DEFAULTS['directory']).resolve())),
            'environ':Mock(read_bytes=Mock(return_value=('EMBERWATCH_RECEIVER_OWNER='+'b'*32).encode()))}
        process.__truediv__=Mock(side_effect=files.__getitem__)
        process.exists=Mock(return_value=False)
        for token,expected in [('b'*32,0),(owner,1)]:
            files['environ'].read_bytes.return_value=('EMBERWATCH_RECEIVER_OWNER='+token).encode()
            with self.subTest(owner=token), \
                 patch.object(Path,'home',return_value=Path('/home/pet')), \
                 patch.object(Path,'iterdir',return_value=iter([process])), \
                 patch.object(mac.os,'kill') as kill,contextlib.redirect_stdout(io.StringIO()):
                exec(code,{})
                self.assertEqual(kill.call_count,expected)
                if expected:kill.assert_called_once_with(123,mac.signal.SIGINT)
        self.assertIn('EMBERWATCH_RECEIVER_OWNER=',code)

    def test_stop_only_targets_the_observer_in_this_macs_directory(self):
        """Verify stop only targets the observer in this macs directory."""
        code = shlex.split(mac.stop_observer_command(mac.DEFAULTS))[-1]
        self.assertIn("b'anafi_observer.py' in argv", code)
        self.assertIn("(process / 'cwd').resolve() == root.resolve()", code)
        self.assertIn('signal.SIGINT', code)
        self.assertNotIn('qr_preset_demo.py', code)
        compile(code, '<remote-stop-observer>', 'exec')

    def test_fire_shutdown_signals_only_this_deployments_response_receiver(self):
        code=shlex.split(mac.stop_receiver_command(mac.DEFAULTS,'fire_response.py','fire response'))[-1]
        self.assertIn("b'fire_response.py' in argv",code)
        self.assertIn("(process / 'cwd').resolve() == root.resolve()",code)
        self.assertIn('signal.SIGINT',code)
        self.assertNotIn('SIGKILL',code)
        compile(code,'<remote-stop-response>','exec')

    def test_deployment_keeps_existing_pi_credentials_separate(self):
        """Verify deployment keeps existing pi credentials separate."""
        token = "test token with ' quotes and $dollars"
        data = mac.bundle(mac.DEFAULTS, {'INGEST_TOKEN': token})
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            names = archive.getnames()
            self.assertIn('anafi_observer.py', names)
            self.assertIn('qr_preset_demo.py', names)
            self.assertIn('flight_recording.py', names)
            self.assertNotIn('bridge.env', names)
            entry = archive.getmember('mac.env')
            self.assertEqual(entry.mode, 0o600)
            text = archive.extractfile(entry).read().decode()
            self.assertEqual(shlex.split(text), ['export', 'INGEST_TOKEN=' + token])
            self.assertNotIn('DASHBOARD_TOKEN', text)
            self.assertNotIn('DATABASE_URL', text)

    def test_deployment_refuses_source_changes_under_any_flight_receiver(self):
        command = mac.install_command(mac.DEFAULTS)
        self.assertLess(command.index('flight receiver is running'), command.index('mkdir -p'))
        guard = command[:command.index('umask 077')] + "printf 'deployment-allowed'"
        process_query = 'ps -C python,python3,python3.11 -o args='
        for program in ('fire_response.py', 'hover_checkout.py', 'qr_auto_circle.py',
                        'qr_orbit_bridge.py', 'qr_preset_demo.py', 'qr_takeoff_demo.py'):
            fake_processes = 'printf %s ' + shlex.quote('/usr/bin/python /other/operator/' + program)
            result = subprocess.run(['/bin/sh', '-c', guard.replace(process_query, fake_processes)],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 73, program)
            self.assertNotIn('deployment-allowed', result.stdout)
        # A read-only receiver does not arm anything, and normal startup stops
        # it before launching the freshly installed response receiver.
        result = subprocess.run(['/bin/sh', '-c', guard.replace(process_query,
                                "printf '%s' '/usr/bin/python anafi_observer.py'")],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, 'deployment-allowed')

    def test_normal_ssh_never_accepts_unverified_keys(self):
        """Verify normal ssh never accepts unverified keys."""
        args = mac.ssh_args(mac.DEFAULTS)
        self.assertIn('StrictHostKeyChecking=yes', args)
        self.assertIn('BatchMode=yes', args)
        self.assertIn('StrictHostKeyChecking=ask', mac.ssh_args(mac.DEFAULTS, interactive=True))

    def test_fetch_flights_uses_verified_ipv6_ssh_and_local_review(self):
        """Verify fetch flights uses verified ipv6 ssh and local review."""
        with tempfile.TemporaryDirectory() as folder, patch.object(mac,'ROOT',Path(folder)), \
             patch.object(mac.subprocess,'run') as run, contextlib.redirect_stdout(io.StringIO()):
            mac.fetch_flights(mac.DEFAULTS)
        copy, review = [call.args[0] for call in run.call_args_list]
        self.assertEqual(copy[:2],['scp','-r'])
        self.assertIn('StrictHostKeyChecking=yes',copy)
        self.assertTrue(copy[-2].startswith('pet@[fe80::'))
        self.assertTrue(copy[-2].endswith('/anafi_out/flights/.'))
        self.assertTrue(review[1].endswith('review_flights.py'))

    def test_native_resolution_is_opt_in_for_each_receiver(self):
        """Verify native resolution is opt in for each receiver."""
        for mode, flag in [('observe', '--camera-width 0'), ('qr-preset', '--video-width 0')]:
            self.assertIn(flag, mac.runtime_command(mac.DEFAULTS, mode, False, native=True))
            self.assertNotIn(flag, mac.runtime_command(mac.DEFAULTS, mode, False))


if __name__ == '__main__':
    unittest.main()
