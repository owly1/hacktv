# BOSCO 

Wildfire-monitoring prototype for a Parrot ANAFI: live camera and telemetry,
fire detection, illustrative spread, and person-search observations.
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
Open <http://127.0.0.1:8787/>. Live mode waits for real input. Gemini is not
required by the dashboard. TigerData is optional; configure storage in `.env`
using [KEYS.md](docs/KEYS.md).
Run `npm run db:init` once when configuring a database; it applies the schema
and checks an insert/readback.

On a provisioned Mac, `npm start` also starts the disarmed Pi fire-response
receiver and laptop detector. **Start BOSCO** in Live explicitly enables that
page's flight session; **LAND / STOP** ends it. Use
`EMBERWATCH_RECEIVER=off npm start` for the dashboard alone. See
[Mac setup](docs/MAC_SETUP.md) for calibration, launch-relative height and
the continuous QR orbit. Replay never enables aircraft control.

The separate **Start contour response** action follows the Tiny fire's growing
five-minute forecast outline using a fixed GPS anchor. **Start BOSCO** retains
the original circular response. Use **Preview tiny contour** to inspect the
shape and motion without an aircraft. The small physical course requires GPS
accuracy of 0.5 m or better; missing/ordinary coarse GPS blocks contour flight.
See [contour setup and limits](docs/FIRE_CONTOUR_MODE.md). The Pi/fleet diagram
describes the architecture; the live demo still uses only one drone.

For a demonstration without an aircraft:

```sh
npm run demo
npm run demo -- --port 9000
```

Replay offers simulated person searches, historical incidents, and a flight
pattern. Scene analysis, incident Q&A and response planning are removed from
replay/live dashboards; the dashboard makes no Gemini requests. Fire-first
person searches include a simulated ANAFI-01 camera and synchronized telemetry.
Replay results stay out of live storage. The Windows wrapper is `.\demo.ps1 -Port 9000`.

Historical fire cases include a four-drone perimeter-search replay. Scroll
the camera cards or click a map drone to choose its 3D POV and matching
telemetry. Drones pace outside the evolving +20-minute forecast border; one at
a time descends toward its exterior edge to find fictional people, then climbs
back to observation. The map opens at Now; solid red marks the current fire.
Patrols include lateral movement and banking, with no dedicated +20-minute
marker. Simulated sightings exclude people
inside the current fire. “Follow
searches” selects the active search drone automatically. The shared counter
counts each fictional person once, retaining source drones and named review
actions. Switching cases preserves each case's clock, leads and review state.
Replay defaults to 8× to make orbiting visible; all four initial searches take
about 25 seconds. Choose 1×/2×/4× for slower presentations. Only flown trails
are drawn; there is no prewritten patrol line.
Demo observations never enter live storage. See the [fleet demo testing
guide](docs/FLEET_DEMO.md) for launch instructions and a walkthrough.
The same dropdown includes **Forest patrol · press Detected**: four drones
hold widely separated positions at 150–210 m without a fire until the presenter
presses **Detected**. A fire then
appears near ANAFI-01 with a +30-minute prediction. The fleet converges in about
17 seconds at the default rate, then orbits the predicted +20-minute boundary
throughout descents, searches and ascents. The map reframes on arrival.
Reselecting the case resets the exercise. All camera footage is rendered replay.
If another checkout already serves port 8787, the launcher reports that
mismatch; use port 9000 or stop the old backend before relaunching.

## Connected BOSCO interface

The new dark/light BOSCO interface is the main dashboard, backed by the same
live APIs and replay controllers. There is no separate fixture-only dashboard.

| Open | What it shows |
|---|---|
| `http://127.0.0.1:8787/bosco/index.html` | New home, drone teardown, demo and live entry points |
| `http://127.0.0.1:8787/?demo` | Historical four-drone fleet replay |
| `http://127.0.0.1:8787/?demo&case=forest-detection` | Forest hold; press **Detected** to start the incident |
| `http://127.0.0.1:8787/?demo&case=people` | Fire-first person-search replay at UTSC |
| `http://127.0.0.1:8787/?demo&case=flight` | Flight-pattern replay |
| `http://127.0.0.1:8787/` | Live camera, telemetry, detections and rescue leads |

The **Replay case** selector switches between all historical and person-search
cases. Selected cases stay in the URL for reloads and shared links; each reload
starts a new replay session. **Exit replay** returns to live monitoring and
clears the replay URL. The sun/moon button saves the dashboard theme locally.
Existing `/bosco/dashboard.html` bookmarks forward to the same dashboard.
`/home.html` forwards to the new home.

After pulling `main`, restart the backend from this checkout and refresh the
browser. If port 8787 belongs to another checkout, use
`npm run demo -- --port 9012` and open `http://127.0.0.1:9012/?demo`.
The launcher checks the served UI assets before reusing an existing server.

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
Print the second, 1 m² fire QR from <http://127.0.0.1:8787/tiny-marker.html>.
Only the two exact payloads in `bridge/orbit-marker.txt` and
`bridge/tiny-marker.txt` are accepted as test fires. The original automatic
preset/circle entry points retain their original Alpha marker selection.
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

Spread and rescue locations are model estimates. A reviewer evaluates plans.
Only the explicitly enabled Live BOSCO session authorizes the separate
aircraft runtime; map, replay and Gemini features never command it or dispatch crews.

## Live detection extension

On `dive-dashboard`, run `npm run live-demo` with the existing receiver and
`npm run vision` for laptop fire/QR/person recognition. Live mode consumes
actual camera detections; it does not generate fictional people. See
[the live dashboard guide](docs/LIVE_DEMO_DASHBOARD.md).
