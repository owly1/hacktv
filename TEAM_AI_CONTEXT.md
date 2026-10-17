# Emberwatch — shared context for the team's AI assistants

**Context version:** 2.0 · 17 October 2026 (branch `combining-everything`)
**Project:** 36-hour, four-person Parrot ANAFI wildfire-monitoring hackathon (Hack the Valley)
**Tracks:** TigerData (Timescale) and Gemini.
**Purpose of this file:** give each teammate's AI the same requirements, architecture, decisions and contracts. Read it before proposing or changing the project. Inspect current source before claiming anything is implemented or tested.

**Pi hardware addition, 17 October 2026:** the grounded ANAFI Extended → Pi 4B → encrypted Ethernet tunnel → laptop path passed actual telemetry and decoded 640 × 360 JPEG reception. This tested, observation-only receiver is added separately as `bridge/anafi_observer.py`; the team's existing `bridge/anafi_bridge.py` is retained. Snapshot ingest now feeds the existing camera relay so either receiver can populate that viewer. Read `docs/PI_OBSERVER_CONTEXT.md` before changing the Pi deployment. Hardware proof applies to the grounded receiver path, not detection, flight or controller coexistence. Cloud-service verification remains recorded separately in `docs/VERIFIED.md`.

Version 2.0 replaces the v1.0 "simulation-first" rules. The decisions in §1 were made by the team and are deliberate — do not revert them.

## 1. Product decisions (v2.0)

1. **Live by default.** Served from localhost, the dashboard connects to the backend automatically (no token pasting) and waits for genuine drone input. Simulation is not the default.
2. **Demo only on request.** The **Demo** button loads the recorded historical fires from `examples/historical-fires.mjs` and a replay of the drone's demo flight pattern. Example data never appears in the live workspace otherwise.
3. **The drone detects fire and everything activates.** The bridge runs fire detection on the ANAFI camera. A detection pins the fire on the map, starts the spread projection, triggers one automatic Gemini analysis, and feeds the planner.
4. **Fire position is computed confidently** from drone position, altitude, heading, camera tilt and where the fire sits in the frame (and, for the test marker, its known printed size). The UI shows it as the fire's position, without hedging.
5. **Test fires.** Indoors at the hackathon there is no real fire: a printed QR **test marker** (`bridge/make_test_marker.py`) stands in for a large fire and carries its details (name, area, intensity, spread rate, fuel, wind, temperature, humidity). Scanning it simulates that fire end to end.
6. **Response planning is operational.** Gemini writes a decisive operational plan (prioritized actions, owners, timing, staging, re-planning triggers) aimed at an advantage over standard planning. The v1.0 content restrictions on planning were removed. A named approver records approval.
7. **Gemini runs automatically** once per detection episode (still max one analysis per 30 s), plus a manual "Analyze current view" button. When Gemini is unreachable the panels show **"Cannot connect to Gemini"** with the reason.
8. **Incident personnel panel removed** entirely.
9. **Autonomous demo flight.** `--demo-flight` makes the drone take off, climb ~1 m, fly a 1 m-radius circle, return to its start and land. Started from the terminal only, after typing `FLY`; any of `x`+Enter, `l` in the video window or Ctrl+C lands immediately. Never triggered from the website.
10. **Spread conditions** (wind, direction, dryness, temperature, humidity) are manual inputs, initialized from the detected fire's reported conditions. They are not labelled as assumptions.
11. **Site:** flights stay at the University of Toronto Scarborough; the hackathon demo is indoors in the Sam Ibrahim Building (default map/home point 43.7866, −79.1903, configurable).

## 2. Status

| Area | Implementation | Verified |
|---|---|---|
| Bridge (`bridge/anafi_bridge.py`) | Olympe video + telemetry, YOLOv8 fire/smoke + QR marker detection, fire geolocation, gimbal auto-tilt, video relay, demo flight | Detection, geolocation and the full HTTP pipeline run against synthetic frames; Olympe flight/gimbal calls match the installed Olympe 8.5 API but **have not flown yet** |
| Fire model | `rabahdev/fire-smoke-yolov8n` (D-Fire, classes smoke/fire), ~26 ms/frame on CPU | Loads and runs; not yet tested on real flame imagery |
| QR test marker | `EW1:` payload, 18 cm print | Reads 10/10 at 0.8–2.0 m in synthetic tests; fails beyond ~2.5 m |
| Backend | emberwatch.v1 + live routes (§5), auto-analysis, plans, tile cache, session bootstrap | 41 contract tests (fake Gemini/storage); real Gemini analysis + plan round trips succeeded on `gemini-3.8-flash` |
| TigerData | Hypertables, `telemetry_1m` continuous aggregate, compression policy, `npm run db:init` | Schema written; **awaiting `DATABASE_URL`** for a real insert/read-back |
| Dashboard | Leaflet map (OSM tiles via caching proxy), live MJPEG video, detection/analysis/plan panels, Demo mode | Browser-checked against the simulated pipeline |

## 3. Architecture and data flow

All three components run on one laptop (bridge in WSL Ubuntu, backend + browser on Windows or WSL). Gemini, TigerData and first-time map tiles need internet; the drone's Wi-Fi has none, so use a phone USB tether alongside it.

```text
Parrot ANAFI --camera + state (Wi-Fi)--> bridge/anafi_bridge.py  (Olympe, WSL)
     ^                                     | YOLO + QR detection, geolocation, gimbal
     | demo-flight commands (terminal)     | HTTP, ingest token
                                           v
                         backend/server.mjs (Node 22, http://127.0.0.1:8787)
          /ingest/telemetry  /ingest/frame  /ingest/detection  /ingest/flight
               |                |                 |                  |
          TigerData       video relay       detections +       flight events
        (hypertables,    (MJPEG to the     auto Gemini          (memory)
         telemetry_1m)     dashboard)        analysis
               \                |                 |
                +------- dashboard token, polling + video stream ------+
                                           v
                              dist/ dashboard (Leaflet map, panels)
                                           |
                              /api/plan -> Gemini operational plan
```

Responsibilities:
- **Bridge:** the only process that talks to the drone. Sends telemetry (~1 Hz), JPEG video frames (~15 fps, 960 px), detection sightings, flight events. Writes local copies to `anafi_out/`.
- **Backend:** authenticates, validates, stores, relays video, archives detection frames in `data/detections/`, proxies + caches map tiles in `data/tiles/`, calls Gemini.
- **TigerData:** time series of telemetry, detections, analyses and plans; the dashboard's per-minute history chart reads the `telemetry_1m` continuous aggregate.
- **Dashboard:** read-only view plus planning; it cannot command the drone.

## 4. Source layout

```text
bridge/anafi_bridge.py      Drone bridge (run in the WSL venv ~/anafi-env)
bridge/make_test_marker.py  QR test-marker generator -> dist/test-marker.{png,html}
bridge/setup.sh             One-time venv + CPU PyTorch + fire model download
backend/server.mjs          API, storage adapters, Gemini, video relay, tile cache
backend/validation.mjs      Input validation (telemetry, frames, detections, flight)
backend/schema.sql          TigerData schema; backend/db-init.mjs applies + verifies it
dist/index.html, app.js     Dashboard; dist/model.js = spread model on real coordinates
dist/vendor/leaflet/        Leaflet 1.9.4, bundled so the page works offline
examples/historical-fires.mjs  Demo dataset (exports FIRES) + standalone page
tests/backend.test.mjs      Original contract suite; tests/live.test.mjs = live pipeline
docs/BRIDGE_CONTRACT.md     Bridge -> backend payloads
```

## 5. API contract: emberwatch.v1 (additive in v2.0)

All `/api/*` routes need `Authorization: Bearer <token>`: the **ingest** token for `/api/ingest/*`, the **dashboard** token for everything else. Tokens must differ. Timestamps are ISO 8601 with `Z`/offset and within ±30 s of the server clock.

| Method + path | Token | Purpose |
|---|---|---|
| GET `/api/session` | none (localhost only) | Returns the dashboard token to pages served on loopback; 403 otherwise |
| GET `/api/status` | dashboard | Contract, site, storage, Gemini (incl. last error), telemetry/video/camera freshness, detection, flight |
| POST `/api/ingest/telemetry` | ingest | Telemetry sample (unchanged shape; `extra` carries heading, gimbal pitch, position source, flight phase) |
| GET `/api/telemetry/latest`, `/history`, `/summary?minutes=` | dashboard | Latest, recent, per-minute buckets (`telemetry_1m` when on TigerData) |
| POST `/api/ingest/frame` | ingest | Raw JPEG body, `X-Captured-At`, optional `X-Detections` overlay JSON |
| GET `/api/video` | dashboard | `multipart/x-mixed-replace` stream of frames with the same headers |
| POST/GET `/api/ingest/snapshot`, `/api/snapshot` | ingest/dashboard | Still supported; the latest video frame also counts as the snapshot |
| POST `/api/ingest/detection` | ingest | Fire sighting (see BRIDGE_CONTRACT); first sighting of an episode triggers auto-analysis |
| GET `/api/incident` | dashboard | Latest episode: first/last seen, sightings, max confidence, latest sighting, `active`, image URL |
| POST `/api/incident/dismiss` | dashboard | `{episode_id}` → marks it a false alarm |
| GET `/api/detections`, `/api/detections/:id/image` | dashboard | Sighting history and archived frames |
| POST `/api/ingest/flight`, GET `/api/flight` | ingest/dashboard | Demo-flight phase events; flight path from telemetry |
| POST `/api/analyze`, GET `/api/analysis/latest` | dashboard | Manual analysis (409 no fresh evidence, 429 rate limit); latest + pending + last error |
| POST `/api/plan`, GET `/api/plan/latest` | dashboard | Gemini operational plan from objective, notes, scenario, projection |
| GET `/api/demo/fires` | dashboard | Historical fires for Demo mode |
| GET `/tiles/osm/{z}/{x}/{y}.png` | none | Caching OpenStreetMap tile proxy |

Direction convention everywhere: degrees clockwise from north that the fire spreads / wind blows **toward**.

Gemini analysis output: `summary`, `severity` (low/moderate/high/extreme), `observations[]`, `spread_outlook`, `unknowns[]`, `falsifiers[]`, `limitations`, plus `trigger` (`auto-detection`/`manual`), `episode_id`, `tool_trace`, `provenance: gemini-unverified`. Plans: `title`, `situation`, `objectives[]`, `actions[{priority, action, owner, timing, rationale}]`, `resources[]`, `triggers[]`, `risks[]`, `advantage`, `next_update`. The backend retries an overloaded Gemini model once and then tries `GEMINI_FALLBACK_MODELS`.

## 6. Map and spread model

Leaflet with OpenStreetMap tiles through the backend's caching proxy (light road style via CSS filter); any area viewed once online keeps working offline, otherwise a grid is shown. The spread model (`dist/model.js`) starts from the detected fire's area (reported by the marker, or estimated from the bounding box and range) and grows a wind-driven ellipse: head at the spread rate, slow backing spread, length/width ratio from wind speed, rate scaled by temperature, dryness and humidity. The timeline projects 0–60 minutes ahead in layered intensity bands.

## 7. Planning and review

Objectives: initial attack, containment line, resource staging, structure & community protection, incident handoff. Plans are stored in TigerData with the detection episode they were built on. Changing conditions or inputs marks the plan stale. Approval records an approver name locally.

## 8. Team ownership

| Developer | Ownership |
|---|---|
| A | Dashboard, visual integration, release |
| B | Backend API, TigerData, tokens, integration tests |
| C | ANAFI hardware, bridge, detection, demo flight, hardware QA |
| D | Gemini prompts/schemas, planning workflow, documentation and pitch |

Pull before you start and before you commit. Work happens on branches; `main` merges are decided by the team.

## 9. Configuration and startup

`.env` (never committed; `.env.example` lists every key): `INGEST_TOKEN`, `DASHBOARD_TOKEN`, `DATABASE_URL`, `PG_CA_FILE`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_FALLBACK_MODELS`, `ALLOWED_ORIGINS`, `SITE_NAME/LAT/LON`, `PORT`, `HOST`.

```bash
npm install && npm start                     # backend + dashboard on http://127.0.0.1:8787
npm run db:init                              # once DATABASE_URL is set: schema + read-back proof
bash bridge/setup.sh                         # WSL, once, with internet
python3 bridge/anafi_bridge.py --backend http://127.0.0.1:8787 [--demo-flight]
```

## 10. Validation

```bash
npm test                                     # 41 backend contract tests
node --check dist/app.js && node --check backend/server.mjs
python3 -m py_compile bridge/anafi_bridge.py
```

Still to verify with hardware/credentials: a real flight of `--demo-flight` (start with the drone on the floor in an open space, a person on the controller), gimbal auto-tilt on the real gimbal, the fire model on real flame imagery, and a TigerData insert/read-back via `npm run db:init`.

## 11. How each AI should work and hand off

Establish the teammate's role and task, inspect the files involved, preserve the contracts in §5 and the decisions in §1, test what you change, and hand off a short record: what changed, interfaces touched, checks run, what still needs hardware or credentials.

## 12. QR orbit experiment (17 October 2026)

The new source is separate from the deployed observation-only Pi receiver.
`bridge/qr_orbit_rehearsal.py` is a laptop companion on port 8789 that only reads
the local camera and previews a simulated path. `qr_orbit_bridge.py` defaults to
rehearsal and has an explicit `--execute` option, calibrated pose requirements,
recent physical preflight acknowledgments and a one-time typed pilot arming.
It starts only from a pilot-established hover; it never takes off automatically.
The user has an indoor cleared/netted area, but has **not tested a pilot landing
control with the Pi connected**. No flight or controller coexistence was tested
by this change. Do not install/arm this experiment through Start BOSCO.
Gemini, dashboard actions and encoded QR fire data cannot issue flight commands.
See `docs/QR_ORBIT_DEMO.md` for the precise integration and acceptance steps.
