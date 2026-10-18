# Mac + provisioned Pi

The Mac runs Node/dashboard and laptop vision tools. The Linux Pi runs the
existing Olympe SDK; its Wi-Fi joins the aircraft while Mac Wi-Fi stays online.
Connect Ethernet between them and power the Pi separately.

## First setup

Install Node 22+ and `uv`, then run from the checkout:

```sh
bash scripts/setup-mac.sh
.venv/bin/python scripts/mac.py doctor
networksetup -listallhardwareports
ifconfig en8
.venv/bin/python scripts/mac.py configure --host 'fe80::2ecf:67ff:fe80:173e%en8'
.venv/bin/python scripts/mac.py authorize-pi
```

Replace `en8` with the actual Ethernet interface. The provisioned Pi user is
`pet`; `configure --user` can change it. Confirm the SSH fingerprint with the
Pi owner and enter the password in your terminal. Private keys stay on the Mac.
Settings go to ignored `.pi.local`; verified identity to
`~/.ssh/emberwatch_pi_known_hosts`.

Setup creates a Python 3.11 `.venv`, installs laptop dependencies/fire weights,
and preserves an existing `.env`. A new `.env` gets distinct random tokens;
add optional cloud settings locally. This workflow reuses a provisioned Pi;
it does not build Olympe or prepare a blank SD card.

## Start observation

```sh
.venv/bin/python scripts/mac.py install-pi
.venv/bin/python scripts/mac.py check-pi
npm start
```

Keep the backend open. In a second terminal:

```sh
.venv/bin/python scripts/mac.py pi
```

Open <http://127.0.0.1:8787/> with Replay off. Keep Skycontroller/FreeFlight
off for this direct route. The launcher deploys into `~/emberwatch/mac-<user>`,
checks for competing receivers, aligns the Pi clock and tunnels Pi loopback
8788 to this backend. Repeat `install-pi` after bridge/token changes.

Observation starts the Pi receiver plus `fire_monitor.py` on the Mac. It
retries disconnected sessions; **flight modes never auto-restart**. Fresh
camera/telemetry timestamps establish reception. The selected fire marker
creates a labeled test incident and automatic analysis; video alone does not
prove detector readiness. `/api/status.vision` reports detector health.

To stop this Mac's observation/retry loop:

```sh
.venv/bin/python scripts/mac.py stop-observer
```

It targets this deployment's observation process, not another laptop or a flight.
Keep the receiver terminal open while using it; Ctrl+C stops reception.

## Select another mode

Stop observation first; use only one receiver. Without `--execute`, flight
modes have no motor commands. With it, each mode follows its own trigger:

| Command suffix after `scripts/mac.py pi` | Behavior / guide |
|---|---|
| `--mode hover --execute` | Type `TAKEOFF TEST`; [short hover](TERMINAL_FLIGHT_TEST.md) |
| `--mode qr-preset --execute` | Type `ARM QR PRESET`; [older preset](QR_PRESET_DEMO.md) |
| `--mode qr-demo --execute` | Selected QR can automatically start repeated fixed laps; [automatic demo](QR_AUTO_DEMO.md) |
| `--mode qr-circle --execute` | Selected QR can automatically start one measured orbit; [measured circle](QR_AUTO_CIRCLE.md) |

For the recognition-only browser animation while observing:

```sh
.venv/bin/python scripts/mac.py rehearsal
# Add --test-image to use the supplied PNG without an aircraft.
```

Open <http://127.0.0.1:8789/>. The animation cannot pilot.

## Calibration and recordings

Use `pi --native-video` for native-resolution observation. With the drone
grounded, capture from the browser:

```sh
.venv/bin/python bridge/calibrate_camera.py capture --web --directory anafi_out/calibration-browser
.venv/bin/python bridge/calibrate_camera.py fit --directory anafi_out/calibration-browser --square-mm 20 --qr-side-cm 18
```

Open <http://127.0.0.1:8791/>. Use actual measured square/QR dimensions.
Board defaults are 10 × 7 squares (9 × 6 inner corners); set the real dimensions
before accepted captures. Keep the board rigid and cover different tilts,
distances and image positions. Saved and detected counts differ. Resume the
same folder or start a new set without deleting previous evidence; `--photos`
sets the total target. See [calibration](QR_DEMO_FROM_OFF.md).

For measured flight, copy verified files using `install-pi --camera-calibration
<file> --preflight-file <file>`. Never mark physical checks complete from tests.

Flight-enabled sessions record on the Pi and copy footage back after exit.
After an interrupted copy, run `.venv/bin/python scripts/mac.py fetch-flights`.
See [recording details](QR_AUTO_DEMO.md#recordings).

Run `npm test` and `.venv/bin/python -m unittest discover -s tests -p '*_test.py'`.
SDK tests require Olympe and skip on the laptop; hardware evidence is separate
in [VERIFIED.md](VERIFIED.md).
