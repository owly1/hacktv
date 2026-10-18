# BOSCO 

Wildfire-monitoring prototype for a Parrot ANAFI: live camera and telemetry,
fire detection, illustrative spread, incident questions, and human-reviewed plans.
Person search adds rescue leads, location uncertainty, and coverage views.

## Start here

- New teammate: [codebase tour](explain_max.md).
- AI assistant: [shared context](TEAM_AI_CONTEXT.md).
- Architecture: [system flow](docs/SYSTEM_FLOW.md).
- Current evidence and limits: [verification record](docs/VERIFIED.md).

## Run the dashboard

Use Node 22+ from the repository root:

```sh
npm ci
cp .env.example .env
# Set distinct INGEST_TOKEN and DASHBOARD_TOKEN in .env.
npm start
```

On PowerShell, use `Copy-Item .env.example .env` instead of `cp`.
Open <http://127.0.0.1:8787/>. Live mode waits for real input. Gemini and
TigerData are optional; configure their values in `.env` using [KEYS.md](docs/KEYS.md).
Run `npm run db:init` once when configuring a database; it applies the schema
and checks an insert/readback.

For a demonstration without an aircraft:

```sh
npm run demo
npm run demo -- --port 9000
```

Replay offers simulated person searches, historical incidents, and a flight
pattern. On-demand questions and planning require a configured Gemini key; scene
analysis is removed from replay/live dashboards and automatic analysis is off.
Replay results stay out
of live storage. The Windows wrapper is `.\demo.ps1 -Port 9000`.

Historical fire cases include a four-drone perimeter-search replay. Scroll
the camera cards or click a map drone to choose its 3D POV and matching
telemetry. Drones orbit the growing fire; one at a time descends beside its
edge to find fictional people, then climbs back to observation. “Follow
searches” selects the active search drone automatically. The shared counter
counts each fictional person once, retaining source drones and named review
actions. Switching cases preserves each case's clock, leads and review state.
Replay defaults to 2×; choose 4× to see every drone search in about 50 seconds.
Demo observations never enter live storage. See the [fleet demo testing
guide](docs/FLEET_DEMO.md) for launch instructions and a walkthrough.
If another checkout already serves port 8787, the launcher reports that
mismatch; use port 9000 or stop the old backend before relaunching.

## Source map

| Path | Responsibility |
|---|---|
| `backend/server.mjs` | HTTP routes, storage, Gemini, video relay, tile cache |
| `backend/validation.mjs` | Ingest validation and shared QR contract |
| `backend/people*.mjs` | Rescue-lead logic and deterministic simulations |
| `backend/schema.sql` | TigerData tables and telemetry aggregate |
| `dist/` | Browser dashboard; plain JavaScript/CSS, no build step |
| `bridge/` | Linux aircraft receivers, detection, calibration and flight experiments |
| `scripts/` | Laptop setup, launchers and flight-recording review |
| `examples/` | Historical fire dataset and standalone example renderer |
| `tests/` | Isolated Node/Python checks; SDK tests mock the aircraft |

`dist/vendor/` contains third-party Leaflet files; keep upstream code intact.

## Choose a hardware workflow

Only one receiver may own the aircraft connection at a time. Ordinary
dashboard startup and observation do not start a flight.

| Task | Guide |
|---|---|
| Provisioned Windows laptop + Pi | [Restart](docs/RESTART_CURRENT_LAPTOP.md) |
| Mac + provisioned Pi | [Mac setup](docs/MAC_SETUP.md) |
| First Ethernet/SSH connection | [Pi Ethernet](docs/PI4_ETHERNET_SETUP.md) |
| Pi paths, ports and service | [Runtime](docs/PI_RUNTIME_HANDOFF.md) |
| Check a real camera stream | [Camera test](docs/PI_CAMERA_TEST.md) |
| Windows Skycontroller camera only | [USB camera](docs/SKYCONTROLLER_USB_CAMERA.md) |
| Short hover and terminal landing | [Hover checkout](docs/TERMINAL_FLIGHT_TEST.md) |
| Automatic QR-triggered preset | [Automatic demo](docs/QR_AUTO_DEMO.md) |
| Automatic orbit around a measured QR | [Measured circle](docs/QR_AUTO_CIRCLE.md) |
| Older typed-arm preset | [Preset](docs/QR_PRESET_DEMO.md) |
| Calibration and staged orbit test | [Cold start](docs/QR_DEMO_FROM_OFF.md), [checkout](docs/QR_FLIGHT_CHECKOUT.md) |
| Recognition-only browser preview | [Rehearsal](docs/QR_ORBIT_DEMO.md) |

Print the selected fire QR from <http://127.0.0.1:8787/test-marker.html>.
Only the exact payload in `bridge/orbit-marker.txt` is accepted as a test fire.
For flight modes, read the selected guide before enabling `--execute`:
automatic modes can take off as soon as the marker is recognized.

## Test

```sh
npm test
python3 -m unittest discover -s tests -p '*_test.py'
```

Run Python checks in Linux/WSL or the Mac environment from its setup guide.
Some require OpenCV/NumPy; Olympe adapter checks skip without the SDK.
Tests use fixtures and mocked aircraft, not live cloud services or motors.

## Further reading

- [API contract](docs/BRIDGE_CONTRACT.md), [person search](docs/PERSON_SEARCH.md).
- [Acceptance checklist](docs/ACCEPTANCE.md), [team handoff](handoff.md).
- [Pi observer context](docs/PI_OBSERVER_CONTEXT.md), [SDK build notes](docs/PI4_SDK_BUILD_NOTES.md).
- [Work areas](docs/EXECUTION_PLAN.md), [Gemini handoff](docs/HANDOFF_D.md).
- [Proposed orbit-loop extension](spec.md), [integration references](docs/SOURCES.md).

Spread and rescue locations are model estimates. A reviewer evaluates plans;
the dashboard and Gemini do not issue aircraft commands or dispatch crews.

## Live detection extension

On `dive-dashboard`, run `npm run live-demo` with the existing receiver and
`npm run vision` for laptop fire/QR/person recognition. Live mode consumes
actual camera detections; it does not generate fictional people. See
[the live dashboard guide](docs/LIVE_DEMO_DASHBOARD.md).
