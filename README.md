# Emberwatch

Live wildfire monitoring from a Parrot ANAFI drone. The drone's camera feed is
checked for fire several times a second; when it finds one, the fire is pinned
on the map, its spread is projected, Gemini analyzes the scene and writes an
operational plan, and everything is stored in TigerData.
Read [TEAM_AI_CONTEXT.md](TEAM_AI_CONTEXT.md) for decisions, architecture and the API contract.

## 1. Backend + dashboard (Windows or WSL, Node 22+)

```bash
npm install
cp .env.example .env     # set INGEST_TOKEN and DASHBOARD_TOKEN (different), GEMINI_API_KEY
npm start                # http://127.0.0.1:8787 — opens live, no token needed on this computer
```

TigerData: put the service URL in `DATABASE_URL`, then `npm run db:init` once
(creates the hypertables, continuous aggregate and compression policy, then
proves an insert and read-back).

### Demo cases (no drone)

```powershell
.\demo.ps1               # or: npm run demo   (add -Port 9000 to run beside another backend)
```

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

## 3. Test without a real fire

Print `http://127.0.0.1:8787/test-marker.html` at 100% (the code must measure
18 cm). The QR code stands in for a large fire and carries its details; the
drone reads it from up to ~2 m.

## Demo

The **Demo** button replays recorded historical fires from
`examples/historical-fires.mjs` and the drone's flight pattern. It is only
shown when requested.

## Tests

`npm test` — 41 backend contract tests (Gemini, TigerData and the drone are faked).
