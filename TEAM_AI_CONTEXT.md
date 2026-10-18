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
- [spec.md](spec.md) defines the target and acceptance criteria. Fleet stream
  isolation, the scrollable UI, combined observations and coordinated perimeter
  dives are planned work, not verified capabilities of current `main`. The older
  replay scout can enter the rendered fire footprint; that legacy behavior does
  not define the new perimeter-search requirement.

`fleet-demo-hardcode` implements the historical Replay portion: four simulated
aircraft, scrolling POV previews, coordinated exterior descents and shared
fictional leads. See [the demo guide](docs/FLEET_DEMO.md). This browser replay
does not implement per-drone live ingest or real fleet flight coordination.

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

`codex/autonomous-fire-response` is intentionally excluded from this baseline.
Do not merge it, cherry-pick its unique commits, or use it as the starting point
for team work unless the user explicitly changes that decision.

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
- The only fire QR is `EW1:Alpha|120|X|35|M|30|60|31|18|18`.
  Change all pinned copies and tests together if its identity changes.
- The dashboard/Gemini cannot pilot. Aircraft commands belong to an explicitly
  enabled terminal flight runtime; observation is separate. One SDK owner per
  aircraft; do not run competing receivers for the same drone.
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
- Unit tests, configured services and sent landing commands are not physical proof.

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
