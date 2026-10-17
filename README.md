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
