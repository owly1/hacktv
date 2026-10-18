# Emberwatch

Live wildfire monitoring from a Parrot ANAFI drone. The drone's camera feed is
checked for fire several times a second; when it finds one, the fire is pinned
on the map, its spread is projected, Gemini analyzes the scene and writes an
operational plan, and everything is stored in TigerData.
It also looks for **people who cannot ask for help**. Person detections are
geolocated with an explicit error model, confirmed from several angles, and
listed as rescue leads with a ±metres location for a responder to
acknowledge. See [docs/PERSON_SEARCH.md](docs/PERSON_SEARCH.md).
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
and automatic analysis. See the flight-mode table below for rehearsal and
explicitly enabled aircraft flight.

## 1. Backend + dashboard (macOS, Windows or Linux, Node 22+)

```bash
npm install
cp .env.example .env     # set INGEST_TOKEN and DASHBOARD_TOKEN (different), GEMINI_API_KEY
npm start                # http://127.0.0.1:8787 — opens live, no token needed on this computer
```

TigerData: put the service URL in `DATABASE_URL`, then `npm run db:init` once
(creates the hypertables, continuous aggregate and compression policy, then
proves an insert and read-back).

### Demo cases (no drone)

```sh
npm run demo                   # macOS, Windows and Linux
npm run demo -- --port 9000     # run beside another backend
```

The Windows wrapper ` .\demo.ps1 -Port 9000` is also supported.

Starts the backend and opens the dashboard in Demo mode (`/?demo`). The
historical fires from `examples/` are hardcoded in `dist/demo-cases.js`, each
with a simulated ANAFI-01 (telemetry + detection, labeled DEMO). **Analyze** and
**Generate plan** call Gemini live on the selected case through
`/api/demo/analyze` and `/api/demo/plan`. Demo results are never written to
TigerData.

Each case starts as a fresh sighting: the simulated drone, patrolling at 35 m
about 280 m from the fire, confirms the detection, geolocates the fire (pin
and spread appear on the map) and climbs to a 450 m survey orbit at 120 m.
Gemini analyzes the fire automatically about 5 s in. The map's T + 0 outline is
the fire the camera shows; the timeline grows it to the recorded burn area.
The camera panel shows a rendered view
(`dist/sim-camera.js`, WebGL): satellite imagery of the real location, a
modelled fire front and smoke, a HUD and the detection box. All of it is labeled
SIMULATED. Demo mode switches the map to satellite imagery (Esri, proxied and
cached by the backend like the street tiles); the drone button under the map zoom
controls follows the drone.
To show a real reference clip for a case instead, put it in `dist/demo-video/`
and list it in `dist/demo-video/videos.json` as
`{"<case id>": {"file": "clip.mp4", "credit": "source and licence"}}`. It is
labeled as not recorded by ANAFI-01.

If scripts are blocked, run
`powershell -ExecutionPolicy Bypass -File .\demo.ps1`.

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
and JPEG frames at a configurable resolution and rate. The Mac launcher uses
the available source frame rate; `--native-video` preserves the source resolution.
The standalone example below caps transmission at 10 FPS. It implements no
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

Print [the fire marker](http://127.0.0.1:8787/test-marker.html). Only its exact
FireSimulationDemo payload counts as a QR fire; other QR codes, including other
`EW1:` payloads, are ignored by the detector and rejected by backend ingest.
Printed size does not select or change the automatic preset path. The separate
measured-marker orbit requires the actual printed size in its calibration.

## Automatic QR flight experiment

### Autonomous fire response (this branch)

On a provisioned Mac, `npm start` starts the backend and a **disarmed** Pi fire
response receiver. Use **Enable this session** in the live dashboard to permit
confirmed RGB fire detections or the approved QR fire marker to trigger takeoff.
The camera displays the current fire rectangle and distinguishes confirmation
from a located target. Smoke, other QR codes, replay, old detections and a
single unconfirmed frame cannot authorize flight.

For a floor target while the drone is resting on a table, use **Down 45°**
or **Down 70°** in the camera-only controls. **Level** restores the horizontal
view. These controls work before flight calibration is complete, require a
connected stationary grounded aircraft and autonomous response OFF, and never
authorize takeoff. The displayed camera angle comes from aircraft telemetry.

The receiver locates the approved QR in 3D using its measured black-square width,
four image corners, calibrated intrinsics and actual camera attitude. Its height
is measured separately from its horizontal distance: a QR on the floor below a
table launch no longer gets projected onto the tabletop. It aligns to a **1 m
horizontal radius**, repeatedly circles the measured target, and updates camera
aim from its measured height. Flight height remains approximately **1 m above
takeoff**, not 1 m above the QR. Initial QR range is 0.25–3 m horizontally, with
up to 4 m below the camera. The entire QR must stay visible.

`camera.local.json` needs measured `qr_black_square_side_m`,
`camera_offset_body_m`, intrinsics at the streamed resolution, and
`qr_pose_verified: true` only after independent physical checks. Keep the QR
screen size fixed. A failed or ambiguous QR pose never falls back to an assumed
floor height. The dashboard rectangle can appear before flight geometry is ready.

To evaluate a suspected constant QR height error, run the offline check:

```bash
.venv/bin/python scripts/check_qr_bias.py \
  anafi_out/fire-ground-checks/qr-metric-check-results.local.json \
  anafi_out/fire-ground-checks/measured-13cm-75cm-live-check.local.json \
  --down-offset-m -0.20 --output /tmp/qr-bias-review.json
```

Use an output file that does not already exist. The check compares the requested
vertical offset with offset/scale candidates fitted using only the first setup,
reports errors on the remaining setups, and preserves horizontal errors. Repeated
frames at one setup count once. Its default 5 cm tolerance is a diagnostic target,
not a flight authorization threshold. Checks at one height cannot establish how
either correction behaves after takeoff. The tool never changes flight calibration
or marks a pose verified; add independently measured setups at different heights
and camera angles before considering a correction for flight.

RGB fire localization still uses the visible ground contact on a **verified
launch ground plane**. It requires `ground_plane_offset_m` and
`fire_ground_plane_verified: true`, supports an initial range of 0.5–3 m and a
visible base at most 0.6 m wide. RGB classification alone cannot locate an
arbitrary fire above or below that plane. QR and RGB verification are independent.

**LAND & disable**, closing the controlling live page, stale control/telemetry,
lost or inconsistent target position, low battery, and the five-minute limit
request landing. A completed flight disables the session; enable again for a
new fire episode. The same episode cannot trigger repeated takeoffs. Backend
and receiver restarts always return to OFF. Video and movement diagnostics are
recorded and copied back to the Mac after flight.

Normal flight requires at least 40% battery and has a five-minute limit. For
an explicitly selected short test, launch `EMBERWATCH_FIRE_TEST=1 npm start`
(or add `--short-test` to the fire-response receiver command). This profile
requires at least 30% to start, requests landing below 25%, and caps the entire
flight at 60 seconds. The dashboard displays the active limits. This does not
change firmware protections, calibration requirements, or the session control.

To run the backend without automatically starting the Pi receiver:
`EMBERWATCH_RECEIVER=off npm start`. To start the receiver separately, use
`.venv/bin/python scripts/mac.py pi --mode fire-response --headless` after stopping
the observer. The laptop RGB detector runs alongside it; no `--execute` flag
is used. Only one laptop may own the aircraft connection at a time.
The automatic launcher and laptop detector are currently supported on macOS;
the existing Windows QR launchers retain their previous behavior. This new
mode has software and mocked-SDK coverage, but its real-flight localization
and orbit accuracy have not yet been physically validated.

### Existing QR modes

These modes are included in main. Ordinary observation and historical replay
do not enable flight. Both automatic flight modes require the exact fire marker,
five fresh scans and an accepted backend incident before takeoff.

| Mode | Behaviour | Guide |
| --- | --- | --- |
| Browser rehearsal | Recognizes QR and animates a flight; no aircraft commands | [Mac setup](docs/MAC_SETUP.md) |
| Automatic preset (`qr-demo` / `QrAutoPreset`) | Repeats 1 m-radius circles around a centre 1 m ahead of launch, aiming the camera there; no visual QR position tracking or camera calibration required | [Automatic preset](docs/QR_AUTO_DEMO.md) |
| Measured-marker orbit (`qr-circle` / `QrAutoCircle`) | One calibrated orbit around the measured QR centre with camera tracking; requires measured calibration and physical preflight | [Measured orbit](docs/QR_AUTO_CIRCLE.md) |

Live launchers require `--execute` on Mac or `-Execute` on Windows. The repeated
preset lands on operator request, a protection limit, or its five-minute cap.
Flight-enabled sessions record video and diagnostics; the Mac launcher copies
them back and creates MP4 previews and flight review reports after exit.

## Demo

For the new QR recognition rehearsal, run `python bridge/qr_orbit_rehearsal.py`
on the laptop and open <http://127.0.0.1:8789/>. It reads the existing camera
and animates a simulated orbit; it cannot command the aircraft.
Live flight modes remain opt-in and are not installed as the default Pi service.
The latest repeated-circle changes have automated test coverage; a complete
hardware flight remains to be verified. See [QR orbit setup and physical checks](docs/QR_ORBIT_DEMO.md).
The [step-by-step cold-start guide](docs/QR_DEMO_FROM_OFF.md) includes grounded
calibration capture and a gated one-segment checkout before a full orbit.

The **Demo** button opens a simulated person search: multi-view revisits, a
hot rock that never confirms, and a radio outage with delayed alerts. It also
replays recorded historical fires from `examples/historical-fires.mjs` and the
drone's flight pattern. It is only
shown when requested.

## Tests

`npm test` — backend contract and person-search tests (Gemini, TigerData and the drone are faked).
`python3 tests/observer_test.py` — two observation-receiver tests with a fake SDK.
`python -m unittest discover -s tests -p '*_test.py'` — observer, QR trigger,
geometry and orbit watchdog checks; SDK adapter checks also run in Olympe.
