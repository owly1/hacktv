# Maxim: start here on combining-everything

Prepared 17 October 2026. Code snapshot `2bcce40`; comparison main `cd5689e`. These are pre-documentation code tips.

This is an earlier integrated fire-monitoring version. At this snapshot it is an ancestor of main: main has nine additional commits. Its name does not mean it contains all the later features.

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

## What is implemented here

The full bridge runs YOLO fire/smoke detection plus an `EW1:` QR test marker,
publishes telemetry/video/detections, and can adjust the gimbal. A detection
starts an episode and automatic Gemini analysis; the dashboard can request a
plan. Historical examples are available for explicit Demo replay.

The backend, schema initializer, Leaflet dashboard, spread model and bridge
contract are present. Main's later observation-only `anafi_observer.py`, Pi
restart scripts, provisioning notes and faster receiver work are absent here.
The separate QR preset and person-search work are also absent.

`bridge/anafi_bridge.py` has a legacy `--demo-flight` option, explicitly armed
from its terminal. It is not a QR-triggered preset and should not be presented
as a physically verified flight path. Its indoor home-plus-commanded-offset
position fallback is estimated, not measured GPS. Synthetic detection/contract
checks are not real-fire accuracy or full-flight proof.

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
| [TEAM_AI_CONTEXT.md](TEAM_AI_CONTEXT.md) | Architecture and earlier product decisions |
| [docs/BRIDGE_CONTRACT.md](docs/BRIDGE_CONTRACT.md) | Bridge payloads and backend expectations |
| [bridge/anafi_bridge.py](bridge/anafi_bridge.py) | Video, detection, geolocation and legacy flight |
| [bridge/setup.sh](bridge/setup.sh) | Linux Python/model preparation; requires Internet |
| [backend/server.mjs](backend/server.mjs) | HTTP integration, Gemini and storage |
| [dist/app.js](dist/app.js), [dist/model.js](dist/model.js) | UI and illustrative projection |

## Your next tasks

1. Run the backend and inspect a historical replay before adding hardware.
   Learn one telemetry message and one detection message from the contract.
2. If this branch is still needed for development, coordinate bringing in
   main's nine later commits; this documentation update deliberately does not
   do that merge. Otherwise start new work from the shared main baseline.
3. With the hardware owner, prepare the supported Linux/Olympe environment and
   run the bridge without `--demo-flight`. Do not connect a second competing
   receiver. Pi deployment instructions live on main, not this snapshot.
4. Verify cloud credentials and database round trips locally; qualify position
   estimates, AI plans and fire-spread projections in the presentation.
5. Bring in demo cases, person search and QR flight as reviewed feature changes,
   rather than assuming this branch already combines their latest code.

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
