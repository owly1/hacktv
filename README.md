# Emberwatch

Wildfire-monitoring hackathon prototype (Parrot ANAFI + simulated fire-spread dashboard).
Read [TEAM_AI_CONTEXT.md](TEAM_AI_CONTEXT.md) for requirements, architecture and the `emberwatch.v1` API contract.

## Run the dashboard (no install, no keys)

Open `dist/index.html` in a browser, or serve it:

```
python3 -m http.server -d dist 8000
```

then visit http://localhost:8000.

## Status

- `dist/` — static frontend, simulation mode works offline. Connected mode expects the backend below.
- `backend/`, `bridge/`, `tests/`, `docs/` — not yet in this repo.
