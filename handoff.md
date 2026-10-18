# Team handoff

The shared features are integrated on `main`; old branch names are not setup
instructions. Start with [README.md](README.md) and give each assistant
[TEAM_AI_CONTEXT.md](TEAM_AI_CONTEXT.md).

## Work areas

| Owner area | Main files | Check before handoff |
|---|---|---|
| Dashboard | `dist/app.js`, `people.js`, `model.js`, `sim-camera.js` | Live/replay switching, stale input, exported brief |
| Backend/data | `backend/` | Auth, validation, storage, API tests |
| Aircraft/media | `bridge/`, hardware launchers in `scripts/` | One receiver, correct SDK, selected mode, landing evidence |
| Gemini/planning | Prompts/schemas in `backend/server.mjs` | Structured output, errors, evidence source, human review |

Agree who owns overlapping files before editing; this table names work areas,
not assigned people. Use the shared context's handoff template.

## Current boundaries

- Observation and the browser rehearsal do not command flight.
- Automatic preset and measured-marker circle are separate opt-in runtimes;
  see [automatic demo](docs/QR_AUTO_DEMO.md) and [measured circle](docs/QR_AUTO_CIRCLE.md).
- Person leads persist in `data/people/state.json`; telemetry, detections,
  analyses and plans use configured TigerData or explicit memory storage.
- Keep test/replay data separate from live evidence and keep secrets local.
- Read [verification](docs/VERIFIED.md) and [acceptance](docs/ACCEPTANCE.md)
  before making new hardware or cloud-service claims.
