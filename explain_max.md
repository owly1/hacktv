# Maxim: start here on master

Prepared 17 October 2026. Code snapshot `084b40b`; comparison main `cd5689e`.

This is an **older prototype**, not the project's default branch. Main is
`main`. This branch has one unique standalone-camera commit and is missing
21 main commits at this snapshot. Do not use it as the latest integrated demo.

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


## What exists in this version

The static dashboard in `dist/` has a fictional exercise map, simulated
spread, simulated personnel and a local review draft. Its default is
simulation. An Integrations dialog can connect it to authenticated backend
telemetry and time-separated snapshots; connected mode hides the simulated
fire map rather than pretending that it is measured fire data.

`backend/server.mjs` provides the earlier `emberwatch.v1` telemetry/snapshot
API, optional TigerData adapter, and Gemini analysis with evidence tools.
Gemini can request the latest telemetry, history and snapshot, then return
observations, unknowns and falsifiers with `gemini-unverified` provenance.
This is not the later live detection/plan/video pipeline.

`anafi_stream.py` is a standalone Linux Olympe camera window with telemetry
overlay. It does **not** send observations to the dashboard backend. Seeing
video in that window does not mean the browser is receiving it. This branch
has no `bridge/` directory, Pi launcher, current QR preset or person search.
The old README's statement that `docs/` is absent is stale; those documents
exist in the tree.

## Data path and configuration

```text
ANAFI Wi-Fi -> anafi_stream.py -> local OpenCV video window
                                      (no backend upload)

A separately implemented authenticated uploader -> Node backend -> browser
                                                        |-> TigerData
                                                        |-> Gemini
```

The backend is the laptop's HTTP server. TigerData stores records; it does
not create the UI or carry the camera video. The browser uses a dashboard
token, and an uploader uses a different ingest token. API keys and database
credentials belong only in the server's local configuration.

This version's map is a fictional schematic, so it requires no map API key.
It does not have the later road-tile integration. `dist/model.js` generates
the illustrative spread; it is not a trained prediction model.

## First run

For the simplest offline look, open `dist/index.html` or, from this branch's
root in a Python terminal, run:

```sh
python3 -m http.server -d dist 8000
```

Visit <http://localhost:8000>. For the old backend, use Node 22+; Linux/WSL is
the appropriate starting environment for this older source and its drone SDK:

```sh
npm install
# Only if there is no existing local .env:
cp .env.example .env
# Edit the two different nonempty tokens and optional cloud settings.
node --env-file=.env backend/server.mjs
```

Visit <http://127.0.0.1:8787/> and use Integrations to enter that backend URL
and the dashboard token locally. Unlike later branches, this package's
`npm start` does **not** load `.env`; the explicit Node command above does.
`DATABASE_URL` and TLS CA settings enable TigerData; this version has
`backend/schema.sql` but no `npm run db:init`. Coordinate schema application
with the database owner. `GEMINI_API_KEY`/`GEMINI_MODEL` enable Gemini; a set
key is not proof of success. Run `npm test` for fake-service contract tests.

The standalone viewer needs a supported Linux Olympe/OpenCV environment and
aircraft Wi-Fi. The source mentions a requirements file that is absent from
this branch; do not assume a fresh clone provisions that environment. Ask the
drone owner for the tested SDK setup or use the maintained Pi path on main.

## Files worth opening

| File | What to learn |
|---|---|
| [anafi_stream.py](anafi_stream.py) | Standalone camera receiver, no backend publisher |
| [backend/server.mjs](backend/server.mjs) | Earlier backend API and Gemini tools |
| [backend/schema.sql](backend/schema.sql) | Older database schema |
| [dist/app.js](dist/app.js), [dist/model.js](dist/model.js) | Simulation and authenticated connected mode |
| [tests/backend.test.mjs](tests/backend.test.mjs) | Backend contract checks |
| [TEAM_AI_CONTEXT.md](TEAM_AI_CONTEXT.md) | Historical requirements and contracts |

## Your next tasks

1. View the static dashboard to learn the original layout and distinction
   between simulated and real inputs.
2. For current development, start from main or the relevant maintained feature
   branch. Do not merge this whole older tree over the newer backend.
3. If the viewer contains a useful fix, compare and port only that fix to the
   maintained bridge with the hardware owner, then test reception.
4. Use the branch guides below to find the current demo, QR flight and person
   search work. None is added here by this documentation commit.

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
