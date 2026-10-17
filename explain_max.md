# Maxim: start here on feat/qr-orbit-rehearsal

Prepared 17 October 2026 from code `9200d24`; main comparison `cd5689e`.
This branch adds the QR flight experiment. Read [handoff.md](handoff.md) for
the precise comparison, changed components and acceptance record.

## What we are building

BOSCO/Emberwatch is a hackathon dashboard for a Parrot ANAFI Extended drone.
It displays camera images and flight measurements, illustrates possible fire
spread, and asks Gemini for an assessment and a response-plan draft. A person
must review that draft. This is a prototype, not a validated fire forecast or
an autonomous firefighting system.

A **branch** is one version of the same project. `main` is the shared baseline.
This branch contains four extra code commits for QR recognition and flight.
`democases` adds a separate no-drone presentation, `person-search` adds rescue
leads, `combining-everything` is an earlier integration, and `master` is an
older prototype. Those separate features do not all appear in this branch.

## How the pieces connect

1. The drone supplies camera frames and telemetry: battery, height, state and
   other measurements. Indoor GPS may be unavailable; unknown is not zero.
2. The Raspberry Pi connects to aircraft Wi-Fi. Python code uses **Olympe**,
   Parrot's drone SDK, to receive data and, only in an explicitly armed flight
   mode, send aircraft commands.
3. Ethernet connects Pi to laptop. An **SSH tunnel** carries Pi HTTP traffic
   through an encrypted connection. Pi `127.0.0.1:8788` forwards to the laptop's
   `127.0.0.1:8787`; each machine has its own localhost.
4. The laptop runs `backend/server.mjs`: a Node.js server. This is the
   **backend**, the program that validates incoming observations, serves the
   dashboard and calls cloud services. The laptop keeps Internet Wi-Fi.
5. The browser loads `dist/` from that server, polls measurements and views
   JPEG/MJPEG camera frames. It does not talk directly to TigerData or Gemini.
6. **TigerData** is PostgreSQL with Timescale time-series features: telemetry,
   detections and analysis/plan records. Current frames are relayed by the
   backend; detection images are archived on disk and referenced by records.
   The database is not the video transport and does not push the whole UI.
7. **Gemini** receives selected evidence/context through the backend and
   returns structured observations, unknowns, falsifiers and a plan draft.
   It has no aircraft control authority. The map is Leaflet with road tiles;
   `dist/model.js` draws a simple wind-driven ellipse, not a trained wildfire
   predictor. The dashboard OSM tile route needs no Google Maps key.

## What is new here

The current mode is **QrPreset**. After explicit terminal arming, recognizing
the chosen QR can request takeoff, one preset circle and nearby hover. It
does not track the QR or measure where the object is. Place the intended
center 1 m in front of the aligned launch point; the circle is relative to
that launch geometry. The full explanation is in
[docs/QR_PRESET_DEMO.md](docs/QR_PRESET_DEMO.md).

Without `-Execute`, the program only receives video and rehearses recognition.
Real execution also requires typing `ARM QR PRESET`. X/Esc requests landing
without Enter. Hover ends automatically after 30 seconds and the flight is
capped at 90 seconds; it does not hover forever waiting for X.

The physical short hover and automatic landing passed. Grounded QR recognition
passed. **The real circle and the X-key landing have not been physically
confirmed.** The 67 Python checks used fake aircraft drivers. Do not describe
the simulation or software tests as proof that the full flight works.

## Files worth opening, in order

| File | Why it matters |
|---|---|
| [handoff.md](handoff.md) | Exact differences from main and what has/has not been tested |
| [docs/QR_PRESET_DEMO.md](docs/QR_PRESET_DEMO.md) | Current selected demo and launch geometry |
| [scripts/Start-HoverCheckout.ps1](scripts/Start-HoverCheckout.ps1) | Windows entry point for rehearsal and flight modes |
| [bridge/qr_preset_demo.py](bridge/qr_preset_demo.py) | QR recognition -> one armed takeoff session |
| [bridge/qr_preset_core.py](bridge/qr_preset_core.py) | Circle segments, bounded hover and landing |
| [backend/server.mjs](backend/server.mjs) | Authenticated API, video relay, storage and Gemini |
| [dist/app.js](dist/app.js), [dist/model.js](dist/model.js) | Dashboard behavior and illustrative spread |
| [docs/BRIDGE_CONTRACT.md](docs/BRIDGE_CONTRACT.md) | JSON messages shared by bridge and backend |

## First run: no flight

Use a terminal in this branch's repository root. Node 22+ is required.

```powershell
npm install
# Only if this checkout has no .env:
Copy-Item .env.example .env
# Edit .env locally, then:
npm start
```

Set different, nonempty `INGEST_TOKEN` and `DASHBOARD_TOKEN`. The first lets
the Pi write observations; the second lets the browser read/request analysis.
`GEMINI_API_KEY` and an account-enabled `GEMINI_MODEL` enable Gemini;
`DATABASE_URL` and its TLS CA setting enable TigerData. No database URL means
memory storage. A configured service must still pass a real round trip.
Never overwrite an existing working `.env` or put secrets in Git.

Open <http://127.0.0.1:8787/>. With no receiver, a blank/stale live feed is
expected. Use Demo explicitly for simulated data. Run `npm test` separately
for backend checks; these do not need an aircraft.

On the **already provisioned** laptop/Pi, with backend running and grounded
aircraft, a second terminal can run the non-flight QR rehearsal:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-HoverCheckout.ps1 -Mode QrPreset
```

The launcher needs the team's Pi SSH setup and the source installed by
`scripts/Install-QrDemo.ps1`; a fresh clone alone does not supply those.
Follow the preset guide. Keep the controller off for direct Pi mode and run
one aircraft receiver at a time. Do not start by adding `-Execute`.

## Your next tasks

1. Get the dashboard running and explain the data path above to another
   teammate. Confirm a real picture's timestamp advances with Replay off.
2. Rehearse the selected printed QR without execution. Save the terminal
   result and which branch/commit you used.
3. Help the drone owner record a physical X-landing check during the short
   hover, then one preset circle. Use the acceptance sequence in the guides;
   do not mark these complete based on code tests.
4. Coordinate integration of the demo and person-search branches. Avoid
   replacing their backend/bridge changes wholesale; run contract tests after
   resolving conflicts and keep generated plans subject to human review.

For the complete shared architecture see [TEAM_AI_CONTEXT.md](TEAM_AI_CONTEXT.md),
but some status paragraphs describe earlier stages. Prefer the dated handoff
and current preset guide for this branch's flight behavior. Pull updates with
`git pull --ff-only` when your working tree is clean. Documentation updates on
other branches do not merge their feature code into this one.
