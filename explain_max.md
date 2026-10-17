# Maxim: start here on main

Updated 17 October 2026 after merging `feat/qr-orbit-rehearsal` into main.

This is the shared dashboard, Pi observation and QR preset codebase. The historical-case Gemini routes and person-search feature remain on their separate branches.

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

- `backend/server.mjs`: `emberwatch.v1` API, authenticated ingest, camera relay,
  Gemini analysis/plan endpoints, storage adapters and cached map tiles.
- `backend/schema.sql` and `backend/db-init.mjs`: Timescale tables, the
  per-minute telemetry aggregate, and schema/insert/readback initialization.
- `dist/`: live dashboard and explicitly requested historical-fire replay.
- `bridge/anafi_bridge.py`: fuller fire/QR detection bridge; it includes an
  older terminal-confirmed `--demo-flight` route. That route is not the new
  QR-scanned preset demo, and main's normal startup does not invoke it.
- `bridge/anafi_observer.py`: observation-only Pi receiver, with configurable
  camera FPS. Current recorded Pi target is 10 FPS, measured around 8-9 FPS.
- `bridge/qr_orbit_rehearsal.py`: laptop QR recognition and simulated orbit preview.
- `bridge/qr_preset_demo.py`: explicitly armed QR-triggered takeoff, preset circle, bounded hover and landing; see [the current preset guide](docs/QR_PRESET_DEMO.md).
- `scripts/Start-BOSCO.ps1`: restart helper for the already provisioned laptop
  and Pi, not a universal installer for an arbitrary teammate's computer.

Grounded Pi camera/telemetry reception was physically verified. Existing
Gemini and TigerData round-trip evidence is in `docs/VERIFIED.md`. It does not
prove that every teammate's credentials work or that the entire flight/fire
pipeline has been tested. The standalone short-hover success belongs to the
QR feature work. The actual QR circle and X-key landing still need physical verification; merging source does not establish flight acceptance.

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
| [docs/RESTART_CURRENT_LAPTOP.md](docs/RESTART_CURRENT_LAPTOP.md) | Start the configured Windows/Pi setup |
| [docs/PI_RUNTIME_HANDOFF.md](docs/PI_RUNTIME_HANDOFF.md) | Pi receiver, SDK and network details |
| [docs/BRIDGE_CONTRACT.md](docs/BRIDGE_CONTRACT.md) | Exact bridge-to-backend messages |
| [backend/server.mjs](backend/server.mjs) | Backend integration point |
| [dist/app.js](dist/app.js), [dist/model.js](dist/model.js) | Dashboard and spread illustration |
| [docs/VERIFIED.md](docs/VERIFIED.md) | Recorded cloud-service verification |

## Your next tasks

1. Start the backend, then follow the restart guide with the hardware owner.
   Confirm an advancing picture timestamp and current telemetry with Replay off.
2. Ask for a current Gemini analysis and verify TigerData with the database
   owner. Record results and evidence timestamps; never paste keys into chat.
3. Review `handoff.md` and `docs/QR_PRESET_DEMO.md`, then record physical
   terminal-landing and circle checks before treating the QR flight as verified.
4. Review `democases` and `person-search` as separate integrations. Their
   backend/frontend/bridge changes can overlap; resolve and test those together.
5. Keep response plans visibly subject to human review and spread outputs
   labeled as projections. Do not promote synthetic scenario locations to GPS.

## Where the other work lives

| Branch | Purpose |
|---|---|
| `main` | Shared dashboard/backend, Pi observation, QR rehearsal and opt-in preset flight |
| `democases` | No-drone historical-fire presentation with live Gemini calls |
| `person-search` | Person observations, uncertain rescue leads, coverage and simulated search |
Older `master` and `combining-everything` code is already incorporated or superseded in main; archive tags preserve their branch-specific onboarding documents.

These documents describe each branch at its own tip; they do not merge its
feature code into the others. To receive the documentation, use
`git pull --ff-only` from a clean checkout of your branch. If Git reports local
changes or divergent history, preserve that work and coordinate with its owner.
Do not reset a teammate's checkout to make the instructions fit.
