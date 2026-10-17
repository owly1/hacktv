# Emberwatch

Wildfire-monitoring hackathon prototype (Parrot ANAFI + simulated fire-spread dashboard).
Read [TEAM_AI_CONTEXT.md](TEAM_AI_CONTEXT.md) for requirements, architecture and the `emberwatch.v1` API contract.

## Run the dashboard (no install, no keys)

Open `dist/index.html` in a browser, or serve it:

```
python3 -m http.server -d dist 8000
```

then visit http://localhost:8000.

## Run the backend (connected mode)

```
cp .env.example .env        # set INGEST_TOKEN + DASHBOARD_TOKEN (must differ)
node backend/server.mjs     # serves the dashboard + API on http://127.0.0.1:8787
```

Optional TigerData: `npm install` (for `pg`), apply `backend/schema.sql` to the
provisioned service, set `DATABASE_URL`, then `npm start`.

## Status

- `dist/` — static frontend, simulation mode works offline.
- `backend/` — emberwatch.v1 API: token auth, origin allowlist, telemetry/snapshot ingest + history, TigerData/pg adapter, memory fallback mode. `/api/analyze` runs Gemini as an evidence-seeking agent: function-calling tools (`get_latest_telemetry`, `get_telemetry_history`, `get_snapshot`) let the model pull live evidence before writing a structured assessment whose `falsifiers` field states what would overturn it; every record carries `provenance: gemini-unverified` and a `tool_trace`. Verified by 24 contract tests + a real round-trip on gemini-3.8-flash.
- `tests/` — `node --test` runs the backend contract suite.
- `bridge/`, `docs/` — not yet in this repo.
