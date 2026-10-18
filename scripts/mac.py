#!/usr/bin/env python3
"""Mac dashboard/QR tools and SSH launchers for the team's provisioned Linux Pi."""
import argparse
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import tarfile
import time
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / '.pi.local'
KEY = Path.home() / '.ssh/emberwatch_pi_ed25519'
KNOWN = Path.home() / '.ssh/emberwatch_pi_known_hosts'
OBSERVER_STOP = ROOT / '.observer-stop.local'
OBSERVER_LOCK = ROOT / '.observer-lock.local'
DEFAULTS = {
    'host': 'fe80::2ecf:67ff:fe80:173e%en8', 'user': 'pet',
    'directory': 'emberwatch/mac-' + os.environ.get('USER', 'operator'),
    'sdk': '/home/pet/emberwatch/sdk/olympe-8.5.0/products/olympe/linux/env/setenv',
    'pi_port': 8788, 'drone_ip': '192.168.42.1', 'drone_id': 'ANAFI-H084882',
    'wifi_profile': '64e43de0-e0ff-4ee0-a9cb-5d5cd824d732',
}
SOURCES = [p for p in (ROOT / 'bridge').iterdir()
           if p.suffix in ('.py', '.txt') and p.is_file()]


def settings():
    value = {**DEFAULTS, **(json.loads(CONFIG.read_text()) if CONFIG.exists() else {})}
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.:%_-]*', value['host']):
        raise ValueError('Invalid Pi hostname/address.')
    if not re.fullmatch(r'[a-z_][a-z0-9_-]*', value['user']):
        raise ValueError('Invalid Pi username.')
    if not re.fullmatch(r'emberwatch/mac-[A-Za-z0-9_-]+', value['directory']):
        raise ValueError('Use a separate emberwatch/mac-NAME deployment directory.')
    if not isinstance(value['pi_port'], int) or not 1024 <= value['pi_port'] <= 65535:
        raise ValueError('Pi port must be 1024-65535.')
    return value


def local_env():
    # Use Node's own dotenv parser. Secrets remain in captured memory, never logs/argv.
    result = subprocess.run(['node', '--env-file=' + str(ROOT / '.env'), '-e',
        'console.log(JSON.stringify(Object.fromEntries(["INGEST_TOKEN","DASHBOARD_TOKEN",'
        '"PORT","HOST"].map(k=>[k,process.env[k]]))))'],
        check=True, capture_output=True, text=True, cwd=ROOT)
    env = json.loads(result.stdout)
    if not env.get('INGEST_TOKEN') or not env.get('DASHBOARD_TOKEN'):
        raise ValueError('Set both local tokens in .env, or run setup-mac.sh for a new checkout.')
    if env['INGEST_TOKEN'] == env['DASHBOARD_TOKEN']:
        raise ValueError('Local tokens must be different.')
    if any(c in env['INGEST_TOKEN'] for c in '\r\n'):
        raise ValueError('INGEST_TOKEN must be one line.')
    if env.get('HOST', '127.0.0.1') != '127.0.0.1':
        raise ValueError('Use HOST=127.0.0.1 in .env for this local workflow.')
    env['PORT'] = int(env.get('PORT') or 8787)
    return env


def backend_status(env):
    base = f"http://127.0.0.1:{env['PORT']}"
    with urlopen(base + '/api/session', timeout=3) as response:
        session = json.load(response)
    if session.get('contract') != 'emberwatch.v1' or session.get('token') != env['DASHBOARD_TOKEN']:
        raise ValueError('The running backend does not match this checkout’s .env.')
    with urlopen(Request(base + '/api/status', headers={
        'Authorization': 'Bearer ' + env['DASHBOARD_TOKEN']}), timeout=5) as response:
        return json.load(response)


def ssh_args(config, interactive=False):
    return ['ssh', '-i', str(KEY), '-o', 'IdentitiesOnly=yes',
            '-o', 'UserKnownHostsFile=' + str(KNOWN), '-o', 'HostKeyAlias=emberwatch-pi',
            '-o', 'StrictHostKeyChecking=' + ('ask' if interactive else 'yes'),
            '-o', 'BatchMode=' + ('no' if interactive else 'yes'),
            '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=5',
            '-o', 'ServerAliveCountMax=3']


def remote(config, command, data=None, interactive=False):
    return subprocess.run(ssh_args(config, interactive) + ['-T', '-l', config['user'],
                          config['host'], command], input=data, check=True, timeout=60 if not interactive else None)


def fetch_flights(config):
    destination = ROOT/'anafi_out'/'flights'
    destination.mkdir(parents=True, exist_ok=True)
    host = '['+config['host']+']' if ':' in config['host'] else config['host']
    source = config['user']+'@'+host+':'+config['directory']+'/anafi_out/flights/.'
    subprocess.run(['scp', '-r']+ssh_args(config)[1:]+[source, str(destination)], check=True, timeout=300)
    print('Flight recordings saved to', destination, flush=True)
    subprocess.run([sys.executable, str(ROOT/'scripts'/'review_flights.py'), str(destination)], check=True)


def bundle(config, env):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as archive:
        for source in SOURCES:
            archive.add(source, arcname=source.name, recursive=False)
        data = ('export INGEST_TOKEN=' + shlex.quote(env['INGEST_TOKEN']) + '\n').encode()
        entry = tarfile.TarInfo('mac.env')
        entry.size, entry.mode = len(data), 0o600
        archive.addfile(entry, io.BytesIO(data))
    return output.getvalue()


def sync_clock(config):
    # The provisioned helper accepts whole seconds. Send near the start of a
    # second so SSH latency + rounding do not make fresh frames over 0.8 s old.
    time.sleep((1.05 - time.time() % 1) % 1)
    remote(config, f'sudo -n /usr/local/sbin/emberwatch-maintenance set-clock {int(time.time())} >/dev/null')


def prepare_command(config):
    return '\n'.join([
        'set -eu',
        "if ps -C python,python3,python3.11 -o args= | grep -qE '(hover_checkout|qr_orbit_bridge|qr_takeoff_demo|qr_preset_demo|qr_auto_circle|fire_response)\\.py'; then",
        "  echo 'A flight checkout is already running; use its terminal.' >&2; exit 73; fi",
        'systemctl --user stop emberwatch-bridge.service',
        "if ps -C python,python3,python3.11 -o args= | grep -qE '(anafi_observer|anafi_bridge)\\.py'; then",
        "  echo 'Another observation receiver is running; stop it in its own terminal.' >&2; exit 73; fi",
        'if [ "$(nmcli -g GENERAL.CON-UUID device show wlan0)" != ' + shlex.quote(config['wifi_profile']) + ' ]; then',
        '  sudo -n /usr/local/sbin/emberwatch-maintenance wifi-profile ' + shlex.quote(config['wifi_profile']),
        'fi',
    ])


def stop_observer_command(config):
    # Only the read-only observer in this Mac's deployment can be interrupted.
    # No process from a flight mode or another laptop's directory is selected.
    return stop_receiver_command(config,'anafi_observer.py','observation')


def stop_receiver_command(config,program,label):
    if program not in ('anafi_observer.py','fire_response.py'):
        raise ValueError('Unsupported receiver stop')
    code = '''import os, signal
from pathlib import Path
root = Path.home() / DIRECTORY
count = 0
for process in Path('/proc').iterdir():
    if not process.name.isdigit():
        continue
    try:
        argv = (process / 'cmdline').read_bytes().split(b'\\0')
        if (argv and Path(os.fsdecode(argv[0])).name.startswith('python')
                and (process / 'cwd').resolve() == root.resolve() and PROGRAM in argv):
            os.kill(int(process.name), signal.SIGINT)
            count += 1
    except (OSError, ProcessLookupError):
        pass
print(f'Requested graceful stop for {count} LABEL receiver(s).')
'''.replace('DIRECTORY', repr(config['directory'])).replace('PROGRAM',repr(program.encode())).replace('LABEL',label)
    return 'python3 -c ' + shlex.quote(code)


def runtime_command(config, mode, execute, native=False,short_test=False):
    if mode not in ("observe", "qr-preset", "hover", "qr-circle", "qr-demo", "fire-response"):
        raise ValueError("Unknown receiver mode")
    if short_test and mode!='fire-response':raise ValueError('Short test applies only to fire response')
    directory = shlex.quote(config['directory'])
    common = ['--controller', 'direct', '--ip', config['drone_ip'], '--drone-id', config['drone_id'],
              '--backend', f"http://127.0.0.1:{config['pi_port']}"]
    if mode == 'observe':
        if execute:
            raise ValueError('Observation mode cannot execute flight commands.')
        program = ['anafi_observer.py', '--camera', '--camera-transport', 'frame',
                   '--camera-fps', '0', '--camera-width', '0' if native else '640']
    else:
        program = [{'qr-preset': 'qr_preset_demo.py', 'hover': 'hover_checkout.py',
                    'qr-circle': 'qr_auto_circle.py', 'qr-demo': 'qr_auto_circle.py',
                    'fire-response': 'fire_response.py'}[mode],
                   '--no-window', '--out-dir', 'anafi_out']
        if mode == 'qr-demo':
            program += ['--preset', '--video-fps', '30']
        if mode == 'fire-response':
            if execute: raise ValueError('Fire response is enabled by the dashboard session control, not --execute')
            program += ['--video-fps','30','--camera-calibration','camera.local.json']
            if short_test:program+=['--short-test']
        if mode == 'qr-circle' and execute:
            program += ['--camera-calibration', 'camera.local.json',
                        '--preflight-file', 'current-preflight.local.json']
        if native or mode in ('qr-circle','fire-response'):
            program += ['--video-width', '0']
        if execute:
            program += ['--execute']
    # Recheck for competing receivers immediately before opening the SDK link.
    return '\n'.join([
        'set -eu', f'cd "$HOME"/{directory}', 'test -r mac.env',
        "if ps -C python,python3,python3.11 -o args= | grep -qE '(hover_checkout|qr_orbit_bridge|qr_takeoff_demo|qr_preset_demo|qr_auto_circle|fire_response)\\.py'; then",
        "  echo 'A flight checkout is already running; use its terminal.' >&2; exit 73; fi",
        "if ps -C python,python3,python3.11 -o args= | grep -qE '(anafi_observer|anafi_bridge)\\.py'; then",
        "  echo 'Another observation receiver is running; stop it in its own terminal.' >&2; exit 73; fi",
        '. ./mac.env', 'export PYOPENGL_PLATFORM=glx',
        'exec /bin/bash ' + shlex.quote(config['sdk']) + ' python -u ' + shlex.join(program + common),
    ])


def receiver_ssh(config, env, command, headless=False):
    return ssh_args(config) + ['-T' if headless else '-tt', '-o', 'ExitOnForwardFailure=yes', '-R',
        f"127.0.0.1:{config['pi_port']}:127.0.0.1:{env['PORT']}",
        '-l', config['user'], config['host'], command]


def start_fire_monitor(env):
    return subprocess.Popen([sys.executable, '-u', str(ROOT / 'bridge/fire_monitor.py'),
        '--backend', f"http://127.0.0.1:{env['PORT']}"], cwd=ROOT,
        env={**os.environ, 'INGEST_TOKEN': env['INGEST_TOKEN'], 'DASHBOARD_TOKEN': env['DASHBOARD_TOKEN']})


def supervise_fire_response(config, env, command):
    """Restart only in disabled state; dashboard leases never survive reconnect."""
    lock=OBSERVER_LOCK.open('w')
    deadline=time.monotonic()+8
    while True:
        try:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic()>deadline:
                lock.close()
                raise ValueError('Another local receiver is running; stop it before fire response')
            time.sleep(.2)
    vision=start_fire_monitor(env)
    child=None
    try:
        while True:
            try:
                if vision.poll() is not None: vision=start_fire_monitor(env)
                backend_status(env)
                remote(config,prepare_command(config))
                sync_clock(config)
                child=subprocess.Popen(receiver_ssh(config,env,command,headless=True))
                while True:
                    try:
                        code=child.wait(timeout=1); break
                    except subprocess.TimeoutExpired:
                        if vision.poll() is not None: vision=start_fire_monitor(env)
                child=None
                try: fetch_flights(config)
                except (OSError,subprocess.SubprocessError): pass
                if code==73: raise ValueError('Another receiver is running; stop it before fire response')
            except subprocess.CalledProcessError as error:
                if error.returncode==73: raise ValueError('Another receiver owns the Pi') from None
                print('Waiting for Pi/drone. Autonomous response remains disabled.',flush=True)
            except (subprocess.TimeoutExpired,OSError):
                print('Waiting for Pi/drone. Autonomous response remains disabled.',flush=True)
            time.sleep(3)
    except KeyboardInterrupt:
        pass
    finally:
        stop_child(vision)
        if child is not None:
            # A headless SSH exit does not reliably signal its remote process.
            # Ask this deployment's receiver to land/stop before closing its
            # tunnel. Network loss is covered by the receiver's own watchdog.
            try: remote(config,stop_receiver_command(config,'fire_response.py','fire response'))
            except (OSError,subprocess.SubprocessError): child.terminate()
            try: child.wait(timeout=25)
            except subprocess.TimeoutExpired: child.kill(); child.wait()
        lock.close()


def stop_child(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def supervise_observer(config, env, command):
    """Keep only the observation receiver alive, never re-arm a flight mode."""
    with OBSERVER_LOCK.open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('This Mac already has an observation supervisor running.')
        OBSERVER_STOP.unlink(missing_ok=True)
        child = None
        vision = start_fire_monitor(env)
        print('Automatic observation recovery enabled. Drone may start off. Ctrl+C stops recovery.', flush=True)
        try:
            while not OBSERVER_STOP.exists():
                if vision.poll() is not None:
                    print('Restarting fire monitor.', flush=True)
                    vision = start_fire_monitor(env)
                try:
                    backend_status(env)
                    # NetworkManager may have returned to another saved network.
                    remote(config, prepare_command(config))
                    if OBSERVER_STOP.exists():
                        break
                    sync_clock(config)
                    child = subprocess.Popen(receiver_ssh(config, env, command))
                    while not OBSERVER_STOP.exists():
                        try:
                            code = child.wait(timeout=1)
                            break
                        except subprocess.TimeoutExpired:
                            if vision.poll() is not None:
                                print('Restarting fire monitor.', flush=True)
                                vision = start_fire_monitor(env)
                            continue
                    else:
                        break
                    child = None
                    if code == 0:
                        break  # An operator deliberately stopped the observer.
                    if code == 73:
                        raise ValueError('Another receiver is active; automatic recovery stopped.')
                except subprocess.CalledProcessError as error:
                    if error.returncode == 73:
                        raise ValueError('Another receiver is active; automatic recovery stopped.') from None
                    print('Pi/drone connection unavailable.', flush=True)
                except (OSError, subprocess.TimeoutExpired):
                    print('Waiting for the Pi and localhost backend.', flush=True)
                print('Retrying observation in 5 seconds; localhost stays running.', flush=True)
                for _ in range(10):
                    if OBSERVER_STOP.exists():
                        break
                    time.sleep(.5)
        except KeyboardInterrupt:
            print('\nStopping observation and automatic recovery.', flush=True)
        finally:
            stop_child(vision)
            if child is not None:
                try:
                    remote(config, stop_observer_command(config))
                except (OSError, subprocess.SubprocessError):
                    pass
                try:
                    child.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    child.terminate()
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('doctor', help='Check laptop imports, Ethernet and backend; no drone connection')
    commands.add_parser('backend', help='Start the local Node backend')
    configure = commands.add_parser('configure', help='Save the Pi address in ignored .pi.local')
    configure.add_argument('--host', required=True, help='Example: fe80::2ecf:67ff:fe80:173e%%en8')
    configure.add_argument('--user', default='pet')
    commands.add_parser('authorize-pi', help='Interactive first SSH login; install this Mac’s public key')
    install = commands.add_parser('install-pi', help='Copy source and this Mac’s ingest token into its own Pi directory')
    install.add_argument('--camera-calibration', help='Measured JSON to copy as camera.local.json')
    install.add_argument('--preflight-file', help='Completed physical checks to copy as current-preflight.local.json')
    commands.add_parser('check-pi', help='Check remote SDK imports without connecting to the drone')
    commands.add_parser('stop-observer', help='Stop only this Mac’s read-only Pi observer')
    commands.add_parser('fetch-flights', help='Copy saved flight video/diagnostics from the Pi and generate review reports')
    rehearsal = commands.add_parser('rehearsal', help='Local QR recognition; no aircraft commands')
    rehearsal.add_argument('--test-image', action='store_true')
    rehearsal.add_argument('--port', type=int, default=8789)
    pi = commands.add_parser('pi', help='Foreground Pi receiver plus reverse tunnel')
    pi.add_argument('--mode', choices=['observe', 'qr-preset', 'hover', 'qr-circle', 'qr-demo', 'fire-response'], default='observe')
    pi.add_argument('--execute', action='store_true', help='Enable flight: qr-demo and qr-circle start after QR/incident confirmation; other modes require typed arming')
    pi.add_argument('--native-video', action='store_true')
    pi.add_argument('--headless',action='store_true',help='Dashboard-controlled fire response without an operator terminal')
    pi.add_argument('--short-test',action='store_true',help='Bound fire response to 60 seconds; start at 30%%, request landing below 25%%')
    args = parser.parse_args()
    os.chdir(ROOT)
    config = settings()
    if args.command == 'configure':
        config.update(host=args.host, user=args.user)
        # Validate before writing.
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.:%_-]*', args.host) or not re.fullmatch(r'[a-z_][a-z0-9_-]*', args.user):
            parser.error('Invalid Pi host or username.')
        CONFIG.write_text(json.dumps(config, indent=2) + '\n')
        CONFIG.chmod(0o600)
        print('Saved Pi connection settings to .pi.local.')
        return
    if args.command == 'authorize-pi':
        if not sys.stdin.isatty():
            raise ValueError('Run authorize-pi in your own interactive terminal for password entry.')
        public_key = Path(str(KEY) + '.pub').read_bytes()
        print('Verify the Pi host fingerprint, then enter its login password in this terminal.', flush=True)
        remote(config, 'set -eu; umask 077; mkdir -p ~/.ssh; chmod 700 ~/.ssh; '
               'IFS= read -r key; touch ~/.ssh/authorized_keys; '
               'grep -qxF "$key" ~/.ssh/authorized_keys || printf "%s\\n" "$key" >> ~/.ssh/authorized_keys; '
               'chmod 600 ~/.ssh/authorized_keys', public_key, interactive=True)
        return
    env = local_env()
    if args.command == 'fetch-flights':
        fetch_flights(config)
        return
    if args.command == 'doctor':
        print('Python:', sys.version.split()[0])
        for module in ['cv2', 'numpy', 'segno']:
            print(module + ':', 'available' if importlib.util.find_spec(module) else 'MISSING')
        print('Pi:', config['user'] + '@' + config['host'])
        print('Dedicated SSH key:', 'present' if KEY.exists() else 'MISSING')
        print('Verified Pi host file:', 'present' if KNOWN.exists() else 'not configured')
        interface = config['host'].split('%', 1)[-1] if '%' in config['host'] else None
        if interface:
            result = subprocess.run(['ifconfig', interface], capture_output=True, text=True)
            print('Ethernet link:', 'ACTIVE' if 'status: active' in result.stdout else 'INACTIVE or interface missing')
        try:
            status = backend_status(env)
            print('Backend: reachable; camera:', json.dumps(status.get('camera')))
        except Exception:
            print('Backend: unavailable or config mismatch; run npm start.')
        return
    if args.command == 'backend':
        os.execvp('node', ['node', '--env-file=' + str(ROOT / '.env'), 'backend/server.mjs'])
    if args.command == 'rehearsal':
        command = [sys.executable, 'bridge/qr_orbit_rehearsal.py', '--backend',
                   f"http://127.0.0.1:{env['PORT']}", '--port', str(args.port)]
        if args.test_image:
            command += ['--image', 'dist/test-marker.png']
        os.execv(sys.executable, command)
    if args.command == 'install-pi':
        directory = shlex.quote(config['directory'])
        remote(config, f'umask 077; mkdir -p "$HOME"/{directory} && '
               f'chmod 700 "$HOME"/{directory} && tar -xzf - -C "$HOME"/{directory}', bundle(config, env))
        for source, target in ((args.camera_calibration, 'camera.local.json'),
                               (args.preflight_file, 'current-preflight.local.json')):
            if source:
                data = Path(source).read_bytes()
                json.loads(data)  # Reject malformed JSON before copying it.
                remote(config, f'umask 077; cat > "$HOME"/{directory}/{target}', data)
        print('Installed source and this Mac’s ingest token in', config['directory'])
        return
    if args.command == 'check-pi':
        remote(config, 'cd "$HOME"/' + shlex.quote(config['directory']) +
               ' && PYOPENGL_PLATFORM=glx /bin/bash ' + shlex.quote(config['sdk']) +
               ' python check_environment.py --camera')
        return
    if args.command == 'stop-observer':
        OBSERVER_STOP.touch()
        remote(config, stop_observer_command(config))
        return
    if args.command == 'pi':
        if args.headless and args.mode!='fire-response':
            raise ValueError('Only dashboard-controlled fire response can run headless')
        if not sys.stdin.isatty() and not args.headless:
            raise ValueError('Start the Pi receiver in an interactive operator terminal.')
        command = runtime_command(config, args.mode, args.execute, args.native_video,args.short_test)
        print('Keep the Skycontroller off and FreeFlight closed for this direct Pi connection.', flush=True)
        if args.mode=='fire-response':
            print('Flight starts OFF. Enable autonomous response in the live dashboard.',flush=True)
            supervise_fire_response(config,env,command)
            return
        print('Flight is ' + ('AUTOMATIC AFTER QR + INCIDENT' if args.execute and args.mode in ('qr-circle','qr-demo')
              else 'ENABLED AFTER TYPED ARMING' if args.execute else 'DISABLED'), flush=True)
        if args.mode == 'observe':
            supervise_observer(config, env, command)
            return
        backend_status(env)
        remote(config, prepare_command(config))
        # Sync after leaving Internet Wi-Fi, so NTP cannot overwrite the Mac's
        # clock alignment between preparation and the first camera frame.
        sync_clock(config)
        # Never reuse an unknown tunnel: bind failure stops the receiver startup.
        try:
            child = subprocess.Popen(receiver_ssh(config, env, command))
            # SSH owns operator input/signals. Keep the parent alive until its
            # remote landing/cleanup finishes, then collect the recording.
            previous = signal.signal(signal.SIGINT, signal.SIG_IGN)
            try:
                result = child.wait()
            finally:
                signal.signal(signal.SIGINT, previous)
            if result:
                raise subprocess.CalledProcessError(result, child.args)
        finally:
            if args.execute:
                try:
                    fetch_flights(config)
                except (OSError, subprocess.SubprocessError) as error:
                    print('Flight files remain on the Pi. Retry: python scripts/mac.py fetch-flights', flush=True)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        # A failed subprocess can contain the argv but no secret values are passed there.
        print('Setup failed:', error, file=sys.stderr)
        sys.exit(1)
