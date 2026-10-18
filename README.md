# Emberwatch

Live wildfire monitoring from a Parrot ANAFI drone. The drone's camera feed is
checked for fire several times a second; when it finds one, the fire is pinned
on the map, its spread is projected, Gemini analyzes the scene and writes an
operational plan, and everything is stored in TigerData.
Read [TEAM_AI_CONTEXT.md](TEAM_AI_CONTEXT.md) for decisions, architecture and the API contract.

**Restart the configured Windows laptop and Pi:** use the desktop
`Start BOSCO.cmd` launcher or follow [the restart guide](docs/RESTART_CURRENT_LAPTOP.md).
Its source is `scripts/Start-BOSCO.ps1`; it uses the saved backend
configuration, SSH key and aircraft Wi-Fi profile. No API keys belong in Git.

**MacBook + Pi:** follow [the Mac setup guide](docs/MAC_SETUP.md). Run
`bash scripts/setup-mac.sh` once, then use `scripts/mac.py` to configure SSH,
deploy a separate Mac receiver directory, and start observation or QR testing.
Olympe runs on the Pi; the dashboard, RGB fire/smoke detector and QR preview
run on the Mac. Observation mode automatically starts fire detection: show
the [fire marker](http://127.0.0.1:8787/test-marker.html) to trigger the incident
and automatic analysis. The separate QR flight rehearsal is only an animation.

## 1. Backend + dashboard (Windows or WSL, Node 22+)

```bash
npm install
cp .env.example .env     # set INGEST_TOKEN and DASHBOARD_TOKEN (different), GEMINI_API_KEY
npm start                # http://127.0.0.1:8787 — opens live, no token needed on this computer
```

TigerData: put the service URL in `DATABASE_URL`, then `npm run db:init` once
(creates the hypertables, continuous aggregate and compression policy, then
proves an insert and read-back).

## 2. Bridge (WSL Ubuntu, on the drone's Wi-Fi)

```bash
bash bridge/setup.sh                     # once, with internet: venv deps + fire model + test marker
source ~/anafi-env/bin/activate
set -a; source .env; set +a              # INGEST_TOKEN
python3 bridge/anafi_bridge.py --backend http://127.0.0.1:8787
python3 bridge/anafi_bridge.py --backend http://127.0.0.1:8787 --demo-flight   # + autonomous demo circle
```

The drone's Wi-Fi has no internet: Gemini needs a second connection (phone
USB tether). Open the dashboard once while online so the UTSC map tiles are
cached.

### Pi 4B observation receiver (grounded hardware path)

The Pi 4B + USB Ethernet setup tested in this chat is included as
[`bridge/anafi_observer.py`](bridge/anafi_observer.py). It receives telemetry
and 640 × 360 JPEG frames at a configurable rate. The current Pi targets
10 FPS and measured about 8–9 FPS. It implements no
flight controls, gimbal movement or fire detection. The existing
`bridge/anafi_bridge.py` remains the team's separate detection/flight bridge.

See [Pi setup and launch paths](docs/PI_RUNTIME_HANDOFF.md),
[SDK build notes](docs/PI4_SDK_BUILD_NOTES.md) and
[AI handoff](docs/PI_OBSERVER_CONTEXT.md). The Pi Wi-Fi joins the aircraft;
Ethernet carries the encrypted backend tunnel to the laptop, whose Wi-Fi
stays online. The backend now relays these snapshots into the existing
dashboard camera viewer as well as retaining `/api/snapshot` compatibility.

On the Pi, from the repository root with its tested SDK environment and
local ingest token loaded:

```sh
set -a; . "$HOME/emberwatch/bridge.env"; set +a
bash "$HOME/emberwatch/sdk/olympe-8.5.0/products/olympe/linux/env/setenv" \
  python bridge/anafi_observer.py --camera --controller direct \
  --ip 192.168.42.1 --drone-id ANAFI-H084882 --backend http://127.0.0.1:8788 \
  --camera-transport frame --camera-fps 10
```

The Pi loopback port above is the current tunnel to laptop port 8787.
See [test the actual dashboard camera](docs/PI_CAMERA_TEST.md) for the current
working setup and a simple grounded test.

Run `python3 tests/observer_test.py` for the two mocked receiver tests.
The actual grounded reception check used ANAFI Extended firmware 1.8.2 / HW_03;
flight, controller coexistence and fire detection were not part of that test.

## 3. Test without a real fire

Print `http://127.0.0.1:8787/test-marker.html` at 100% (the code must measure
18 cm). The QR code stands in for a large fire and carries its details; the
drone reads it from up to ~2 m.

## Demo

For the new QR recognition rehearsal, run `python bridge/qr_orbit_rehearsal.py`
on the laptop and open <http://127.0.0.1:8789/>. It reads the existing camera
and animates a simulated orbit; it cannot command the aircraft.
The separate opt-in flight experiment is **not flight-tested or installed as
the Pi service**. See [QR orbit setup and physical checks](docs/QR_ORBIT_DEMO.md).
The [step-by-step cold-start guide](docs/QR_DEMO_FROM_OFF.md) includes grounded
calibration capture and a gated one-segment checkout before a full orbit.

The **Demo** button replays recorded historical fires from
`examples/historical-fires.mjs` and the drone's flight pattern. It is only
shown when requested.

## Tests

`npm test` — 42 backend contract tests (Gemini, TigerData and the drone are faked).
`python3 tests/observer_test.py` — two observation-receiver tests with a fake SDK.
`python -m unittest discover -s tests -p '*_test.py'` — observer, QR trigger,
geometry and orbit watchdog checks; SDK adapter checks also run in Olympe.
