# Maxim: start here on person-search

Prepared 17 October 2026. Code snapshot `c23a912`; comparison main `cd5689e`. These are pre-documentation code tips.

This branch adds person detection and rescue-lead review, fire-aware search simulations, coverage mapping and more resilient Gemini calls. It has seven unique commits and is missing main's one later camera-FPS commit.

## The project in plain English

BOSCO/Emberwatch is a hackathon prototype around a Parrot ANAFI Extended drone.
The browser is the dashboard; the **backend** is the Node.js program on the
laptop; a Python **bridge** is the adapter between Parrot's Olympe drone SDK
and our HTTP API. **Telemetry** means measurements such as battery, height,
speed and flight state. A **branch** is a separate version of the project.
Changing branches can change the available features and start commands.

Gemini provides evidence-based analysis and a response-plan draft where that
workflow exists. A human must review its output; generated text is not a
validated assessment or a flight command. The animated spread is an
illustration driven by assumptions, not a scientifically validated forecast.
Keep simulated incidents, real observations and AI interpretation distinct.

## What is new on this branch

- `bridge/anafi_bridge.py` adds a person detector, simple tracking, timestamped
  camera/drone pose, small crops and an on-disk retry outbox for disconnected
  observations. Standard ANAFI Extended supplies visible RGB, not thermal;
  a thermal model flag does not create a thermal sensor.
- `backend/people.mjs` turns observations into uncertain rescue leads. It
  combines viewing angles and location-error estimates, records negative
  looks, suggests another viewpoint, and requires a responder to acknowledge
  or close a lead. A candidate is not a confirmed person or diagnosis.
- Leads persist in `data/people/state.json`, **not TigerData**. Crops, delayed
  observations, coverage and lead state use the branch's people API routes.
- `dist/people.js` draws lead cards, uncertainty/coverage and review controls.
- `backend/people-sim.mjs` simulates a search that circles outside the fire
  first, then surveys its projected path. It includes a stationary person,
  walker, hot-rock distractor and radio outage, at UTSC and example fires.
  These suggested/replayed routes do not command a real aircraft.
- The shared spread model estimates fire arrival at leads. This is a
  projection, not a validated arrival-time forecast. Terrain is flat unless
  supplied; no real canopy reconstruction or breathing radar is implemented.
- Gemini transport has a 45-second upstream timeout, fallback-model retries
  and a five-minute cooldown for a model that stopped responding. Planning
  includes leads and flags claims that an area or route is safe/clear.

`c23a912` also tracks a `node_modules` symbolic link. It may be unusable on
another OS; it is not a portable dependency installation. Ask its owner to
remove it in a separate cleanup change if needed; this handoff preserves it.

## Where the data goes

```text
Drone -> Linux/Pi Olympe bridge -> authenticated laptop backend -> browser
                                             |-> TigerData records
                                             |-> Gemini evidence / draft
```

The Pi uses aircraft Wi-Fi and Ethernet to the laptop, allowing the laptop to
keep Internet Wi-Fi. In the provisioned setup an SSH reverse tunnel maps Pi
localhost port 8788 to laptop localhost port 8787. Each device has its own
localhost; 127.0.0.1 in your browser means your laptop. This network setup is
separate from installing Node dependencies.

The backend validates messages and tokens, serves the page, relays current
JPEG/MJPEG video, archives detection images on disk and reads/writes records.
TigerData is PostgreSQL with Timescale time-series features. It stores
telemetry, detections and analysis/plan records; it is not the video-streaming
server. The browser reads backend APIs rather than database credentials.
Gemini's API key stays on the backend. A configured indicator does not prove
that today's cloud request succeeded.

Leaflet draws the map. The dashboard's OSM tile proxy provides road-map tiles;
no Google Maps API key is required for that implementation. Tiles need
Internet until cached. `dist/model.js` grows a wind-driven ellipse using
spread/weather inputs; Gemini does not generate the map animation.

## Try the feature without an aircraft

After configuration, open the dashboard's Demo controls and select
**Person search - fire first** (the displayed separator may be a middle dot).
Try UTSC and one historical fire. Follow one candidate through multiple
angles, its location uncertainty, delayed alert and responder acknowledgement.
This is seeded simulation through the people pipeline, not a live rescue.

`.env.example` adds `SEARCH_SECTOR` (south,west,north,east coordinates),
`CAMERA_HFOV_DEG` and `COVERAGE_CELL_M`. Leave a sector unset until the team
has an agreed test area. Model names/fallback order are local configuration;
use a model enabled for your key and prove it with a current round trip.

## First run on your laptop

Open a terminal **in this branch's repository root**, where `package.json` is.
Install Node 22+ first. For a new checkout:

```powershell
npm install
# Run the next line only if .env does not already exist:
Copy-Item .env.example .env
# Edit .env locally before starting:
npm start
```

Open <http://127.0.0.1:8787/>. `INGEST_TOKEN` lets the bridge write observations;
`DASHBOARD_TOKEN` lets the browser read data and request analysis. They must be
nonempty and different. `GEMINI_API_KEY` plus an account-enabled `GEMINI_MODEL`
enable Gemini; `DATABASE_URL` plus the appropriate TLS CA setting enable
TigerData. With no database URL, the backend uses memory, which is lost on
restart. Set up tables with `npm run db:init` only against the intended service
after the database owner supplies local configuration. Never overwrite a
working `.env` or commit credentials, SSH keys, captures or runtime data.

Run `npm test` for automated backend checks with fake cloud/drone services.
An empty live feed with no receiver is expected; it is not proof of a camera
failure. Show Demo explicitly when using simulated incidents. A fresh capture
timestamp and a new analysis tied to that evidence are better checks than a
green configured badge.

## Files worth opening, in order

| File | What to learn |
|---|---|
| [docs/PERSON_SEARCH.md](docs/PERSON_SEARCH.md) | Detailed behavior, assumptions and missing work |
| [backend/people.mjs](backend/people.mjs) | Geolocation, uncertainty, fusion and lead state |
| [backend/people-sim.mjs](backend/people-sim.mjs) | Simulated scenarios and fire-first route |
| [dist/people.js](dist/people.js) | Lead cards and map overlays |
| [bridge/anafi_bridge.py](bridge/anafi_bridge.py) | Detector, crops and retry outbox |
| [tests/people.test.mjs](tests/people.test.mjs) | Tests with synthetic observations |
| [docs/BRIDGE_CONTRACT.md](docs/BRIDGE_CONTRACT.md) | Added person-ingest contract |

## Your next tasks

1. Run the demo and explain why a one-angle candidate differs from a
   possible person. Verify uncertainty, hot-rock rejection, delayed delivery,
   acknowledgement and restart persistence without assuming ground truth.
2. Run `npm test`. Hardware/detector accuracy, geographic uncertainty and the
   full live pipeline still require field evidence; simulation is not that proof.
3. Coordinate main's camera-FPS change and the QR branch's edits to the same
   bridge. Preserve person observations/outbox and flight connection ownership
   when resolving conflicts. Do not drive a flight directly from a lead card.
4. With the backend owner, design database tables/migrations if leads must
   move to TigerData. Current JSON persistence is real; database persistence
   for these leads is future work.
5. Measure the detector and location errors on appropriate test data, improve
   terrain/coverage assumptions, and keep all responder suggestions human-reviewed.

## Where the other work lives

| Branch | Purpose |
|---|---|
| `main` | Shared dashboard/backend and provisioned Pi observation baseline |
| `feat/qr-orbit-rehearsal` | Terminal hover checkout, QR rehearsal and opt-in preset flight |
| `democases` | No-drone historical-fire presentation with live Gemini calls |
| `person-search` | Person observations, uncertain rescue leads, coverage and simulated search |
| `combining-everything` | Earlier integration of fire/QR detection, backend and map |
| `master` | Older simulation/API prototype and standalone drone camera viewer |

These documents describe each branch at its own tip; they do not merge its
feature code into the others. To receive the documentation, use
`git pull --ff-only` from a clean checkout of your branch. If Git reports local
changes or divergent history, preserve that work and coordinate with its owner.
Do not reset a teammate's checkout to make the instructions fit.
