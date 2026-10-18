# Shared AI context

Read this first, then inspect the relevant source. Keep this file short;
put procedures in the linked guides and explain local behavior at its function.

## Project

- Name: BOSCO / Emberwatch, a wildfire-monitoring prototype moving from one
  Parrot ANAFI to a coordinated fleet.
- Stack: Node 22+ HTTP backend, plain browser JavaScript, Python/Olympe on Linux.
- Target path: fleet → receivers → authenticated ingest → combined fire model
  → fleet dashboard/Gemini/storage. Preserve source drone and capture time.
- `main` is the shared integration baseline for every teammate. It includes
  live fire/QR overlays, real-camera person observations and rescue leads,
  historical rescue-scout replay, incident Q&A, wind-driven spread, QR flight
  experiments, calibration capture and local flight recording.

## Current product direction

- The fleet surrounds the fire along its evolving perimeter, collecting views
  from multiple sectors. Encircling provides observation coverage, not suppression.
- Combine camera observations, telemetry and available environmental estimates
  into one predictive model of the fire's boundary, spread direction/rate and
  future extent. Show observation age, uncertainty and assumptions.
- Extend the existing main drone/camera area into a scrollable fleet view.
  Each drone has its own camera feed, synchronized telemetry, identity, role and
  freshness state; selecting a drone highlights it on the shared incident map.
- Individual drones intermittently perform controlled person-search descents
  ("dives") along the **perimeter**, then ascend and resume their sector.
  Timing may appear sporadic; coordinate it so the rest of the fleet maintains
  coverage. A dive is an observation maneuver, not an impact or entry into fire.
- Person sightings from all drones feed shared rescue leads with source evidence
  and uncertainty. The dashboard/Gemini remain observation and planning tools;
  real maneuvers require the separately enabled flight runtime.
- [spec.md](spec.md) defines the target and acceptance criteria. The scrollable
  fleet UI, shared fictional leads and coordinated perimeter descents are
  implemented for Replay. Live fleet stream isolation, combined real
  observations and physical coordination remain planned work; the replay does
  not establish real fleet flight capability.

`fleet-demo-hardcode` implements the historical Replay portion: four simulated
aircraft, scrolling POV previews, coordinated exterior descents and shared
fictional leads. See [the demo guide](docs/FLEET_DEMO.md). This browser replay
does not implement per-drone live ingest or real fleet flight coordination.
Fleet patrols follow the map's exact +20-minute forecast contour with exterior
descent/search offsets. The dedicated +20-minute marker/preset is removed;
the map opens at Now, and patrol motion includes lateral weaving and banking.
Solid red marks the current fire. Both hardcoded fleet and fire-first fixtures
place people outside the forecast border and reject inside-current-fire targets.
This demo restriction does not filter real person observations in live ingest.
The dropdown also includes a fictional forest hold with a presenter-only
Detected button. Four drones start stationary at 150–210 m, at least 1.5 km apart.
No fire or observations exist before the click; afterwards
all aircraft approach continuously before joining the exterior search schedule.
Reselecting resets the exercise. Camera terrain/trees, map and telemetry use
one simulated pose; no live ingest or aircraft command is issued.

The shared replay/live UI no longer includes scene analysis, incident Q&A or
response planning, and makes no Gemini requests. Backend automatic scene
analysis defaults off; authenticated legacy AI APIs remain for compatibility.
Fire-first person-search replay now includes a 3D ANAFI-01 camera with matching
map pose, heading, altitude, speed and power, sourced only from its simulated
snapshot. Its thermal observations are fictional illustrations, not ANAFI hardware.

The new BOSCO dark/light UI now runs the existing app/people/fleet controllers
at `/`; it is the shared live and replay workspace. Home/teardown lives at
`/bosco/index.html`; its primary action opens `/?demo`, and a separate action
opens live monitoring. `/bosco/dashboard.html` forwards to `/`, retaining query
parameters. `/home.html` forwards to the new home. Keep runtime IDs and API
routes stable: `dist/bosco/dashboard.js` owns presentation only, never incident
or review state. Theme tokens and connected overrides live in
`dist/bosco/tokens.css` and `dashboard.css`. The fixture-only controller/data is
removed. Replay case links use `?demo&case=<selector value>` (including
`forest-detection`, `people`, and `flight`). Use the launch table in README;
restart from the current checkout if localhost shows older assets.

## Branching for every teammate

Start each new task from an up-to-date `origin/main`:

```sh
git status
git fetch origin
git switch main
git pull --ff-only origin main
git switch -c <your-name>/<task>
```

Commit or stash existing work before switching. Push the task branch and open
a pull request targeting `main`; coordinate overlapping files before merging.
For an existing task branch, fetch and merge `origin/main` before integration;
do not reset away teammates' work. After integration, start the next task from
updated `main` instead of reusing an old feature branch. Branch names in older
handoff documents describe their original work, not the current starting point.

The user explicitly approved integrating `codex/autonomous-fire-response` into
`main`. Its measured QR orbit, camera tracking, detector and flight gates are
the aircraft-control baseline; the current BOSCO UI, fleet replay, person
search and other product features remain the main baseline. Future work starts
from updated `main`. See [the integration handoff](docs/DRONE_MAIN_INTEGRATION.md).

`main` also includes `codex/circle` bearing-feedback tuning and the separate
`codex/fire-contour-mode` runtime. Circle retains visible QR direction when
metric depth is rejected; contour uses its frozen GPS anchor without visual
steering after claim. See [their integration handoff](docs/CIRCLE_CONTOUR_INTEGRATION.md).

## Where to work

| Concern | Source / reference |
|---|---|
| Routes, Gemini, database, video | `backend/server.mjs`, [contract](docs/BRIDGE_CONTRACT.md) |
| Validation and marker identity | `backend/validation.mjs`, `bridge/fire_detection.py` |
| Person leads / camera-only sightings | `backend/people.mjs`, `backend/person-sightings.mjs`, `dist/people.js`, [person search](docs/PERSON_SEARCH.md) |
| Historical person simulation | `backend/people-sim.mjs`, `dist/demo-scout.js`, [scout handoff](docs/DEMO_SCOUT_HANDOFF.md) |
| Dashboard / wind spread / incident Q&A | `dist/app.js`, `dist/model.js`, `backend/site-landmarks.json`; [fleet target](spec.md) |
| Camera replay | `dist/sim-camera.js`, `dist/demo-cases.js` |
| Observation-only receiver | `bridge/anafi_observer.py`, [Pi runtime](docs/PI_RUNTIME_HANDOFF.md) |
| Detection and common aircraft link | `bridge/anafi_bridge.py`, `bridge/fire_monitor.py` |
| Laptop fire/person inference | `bridge/fire_location.py`, `bridge/person_detection.py`, `scripts/vision.mjs`, [live demo](docs/LIVE_DEMO_DASHBOARD.md) |
| Flight gates, geometry, SDK adapter | `bridge/qr_*`, `bridge/hover_checkout.py` |
| Laptop startup | `scripts/`, [Windows](docs/RESTART_CURRENT_LAPTOP.md), [Mac](docs/MAC_SETUP.md) |
| Evidence already recorded | [VERIFIED.md](docs/VERIFIED.md) |

## Contracts to preserve

- Live is the default; replay is explicit and never silently replaces live input.
- Ingest and dashboard tokens differ; cloud/database credentials stay server-side.
- Contract: `emberwatch.v1`. Missing measurements remain null; simulated site
  coordinates are not measured GPS. Altitude is height above takeoff.
- Fleet work must carry stable `drone_id` and capture timestamps through camera,
  telemetry and detection paths, isolating freshness, track IDs and reconnects
  per aircraft. Existing single-stream routes are not already fleet support;
  coordinate compatible contract changes and update the bridge guide with code.
- Angles are clockwise from north; wind/spread directions point **toward**.
- Prefer an available flight-controller wind estimate over Gemini's tilt-derived
  estimate; retain source labels and disclose disagreement. Neither is an anemometer.
  Encoded fire-QR weather remains the reproducible scenario input. Wind curves,
  projected arrival times and incident Q&A are illustrative decision support.
- Exact fire QR allowlist: original `EW1:Alpha|120|X|35|M|30|60|31|18|18`
  and tiny contour demo `EW1:Tiny|0.0001|L|0.01|G|0.2|60|22|45|18`.
  Alpha remains unchanged. Tiny represents 1 m², growing at 0.01 m/min.
  Change pinned copies and tests together; never accept arbitrary EW1 payloads.
- Aircraft commands belong to a separately enabled flight runtime. The Live
  dashboard's Start BOSCO / LAND controls authorize and end its expiring
  session; ordinary dashboard startup, Replay, maps and Gemini cannot pilot.
  Observation remains separate. One SDK owner per aircraft; do not run competing receivers.
- Automatic `qr-demo` and `qr-circle` can take off after recognition when
  `--execute` is enabled. Preserve their one-shot, freshness and landing gates.
- Person leads carry uncertainty and require human review. Their state is JSON
  under `data/people/`, not TigerData; standard ANAFI RGB is not thermal hardware.
- Real-camera people without usable synchronized pose remain unlocated sightings
  with no fabricated map pin. Fictional people belong only to Replay. Missing
  model weights must be reported, never replaced with simulated detections.
- `npm run live-demo` opens live monitoring; `npm run vision` starts laptop
  inference with installed weights. `npm run demo` selects historical Replay.
  Run only one monitor per stream; the Mac observer launcher already starts one.
- On a provisioned Mac, `npm start` starts a disarmed response receiver and
  flight detector. `EMBERWATCH_RECEIVER=off npm start` serves only the dashboard.
  The QR controller holds altitude above takeoff, retains a fixed measured
  fire location through visual gaps, and renews correction attempts on measured
  progress. Keep its control and sensor watchdogs separate from UI/replay pacing.
- Unit tests, configured services and sent landing commands are not physical proof.
- The separate Live GPS contour action uses a fixed general-area marker anchor
  and the uniform-fuel +5-minute forecast, advancing on real elapsed time.
  Its explicit takeoff action first launches one drone into a bounded 1 m-high
  GPS search, then acquires Marker 2 and switches to contour flight. Search
  ownership is claimed separately from the accepted fire incident. Normal
  contour runs until LAND or a protection fault; short tests remain 60 seconds.
  See [the airborne search handoff](docs/AIRBORNE_CONTOUR_HANDOFF.md).
  It requires Tiny plus fresh accurate GPS; it never substitutes scenario/home
  coordinates. Default Start BOSCO remains the existing circular response.
  Frontend Pi/fleet architecture describes expansion potential; live ingest
  and aircraft control still serve one drone. See [contour mode](docs/FIRE_CONTOUR_MODE.md).

## Working routine

1. Check `git status`, fetch, and preserve teammates' edits. Follow the shared
   `main` branching routine above; use a different base only when requested.
2. Read the source and linked workflow before changing a shared contract.
3. Keep function comments focused on purpose, units, side effects and failure cases.
   Preserve third-party assets and useful existing comments.
4. Run `npm test` and relevant Python checks. Report SDK skips and any environment
   limitation separately from failures. Full Python discovery belongs on
   Linux/WSL or Mac (`mac_launcher_test.py` imports POSIX `fcntl`); OpenCV/NumPy
   are required for image checks. Never connect to hardware just to run tests.
5. Keep secrets, recordings, model weights and generated runtime files out of Git.

## Handoff template

```text
Task / owner:
Branch / commit:
Changed files and behavior:
Contracts or decisions changed:
Checks run (including skips):
Hardware/cloud evidence (or not checked):
Open issue / next step:
```

Current assignment and temporary notes belong in the chat or a handoff; avoid
copying dated test counts, active branch lists or machine logs into this file.

Fleet pacing follow-up: default 8× (1/2/4/8 selectable), with a 16× manual
forest approach completing in about 17 presentation seconds. Detection opens
a +30-minute forecast; arrival refits the map. Drones continuously orbit the
roughly +20-minute forecast contour even during searches; only actual flown
trails are drawn, never a prewritten patrol ring. Live aircraft are unaffected.

Presentation copy: dashboard labels use Fleet / Person search / ANAFI and omit
simulated/fictional wording from banners, POV HUDs, cards, dropdown groups and
forest incident text. This is a wording-only change; API provenance, demo mode
isolation and exported source metadata remain explicit.
