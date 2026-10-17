# Emberwatch — shared context for the team's AI assistants

**Context version:** 1.0 · 16 October 2026  
**Project:** 36-hour, four-person Parrot ANAFI wildfire-monitoring hackathon  
**Scheduling constraint:** three developers start at H0; the fourth arrives at H4.  
**Purpose of this file:** give each teammate's AI the same requirements, architecture, terminology, implementation status and integration contracts. Read it before proposing or changing the project. Treat its verification statements as a dated baseline and inspect current source before claiming anything new is implemented or tested.

## 1. Project objective and priorities

Build a coherent demonstration that combines drone observations, an animated fire-spread scenario, descriptive Gemini analysis and a briefing workflow requiring human review.

The primary dashboard feature must be a **large animated fire-spread heatmap over a light road-style map**, rather than satellite imagery. Other required panels are drone camera/telemetry, Gemini analysis, fictional incident personnel/roles, integration status and incident response planning.

Priorities, in order:

1. A polished, interactive simulation that works without keys or hardware.
2. Honest separation of simulated, observed, inferred, stale and unavailable information.
3. Optional real ANAFI telemetry and low-rate RGB snapshots.
4. Real TigerData persistence and Gemini analysis through the backend when credentials are available.
5. A reproducible demo, formal execution plan, blackboard-copyable system flow and usable source.

The response planner prepares evidence, assumptions, unknowns and coordination questions for an authorized human. It must not generate autonomous tactical firefighting commands, crew dispatches, suppression decisions, safe-route claims, evacuation orders or aircraft commands.

## 2. Status: distinguish delivered work from future work

| Item | Current implementation | Verification boundary |
|---|---|---|
| Frontend | Buildless HTML/CSS/JavaScript, responsive panels and interactions | Browser checked at narrow/mobile and desktop widths |
| Base map | Fictional SVG roads, river, woodland, labels and facilities | No real geographic map provider or map key |
| Spread overlay | Deterministic JavaScript polygon illustration controlled by time, wind and dryness | No trained model, calibrated probabilities or validated fire forecast |
| Demo camera | Locally drawn animated canvas illustration | Synthetic, not drone footage |
| Connected camera | Authenticated latest-JPEG snapshot interface; Linux bridge can send approximately one frame every two seconds | Hardware conversion and live camera path not physically tested |
| Telemetry | Simulation plus authenticated real-data ingest/read interfaces | In-memory API tests passed; no physical drone test |
| Gemini | Labeled demo fixture plus a real server-side structured-response adapter | Adapter tested using an injected fake transport; no real Google API request |
| TigerData | PostgreSQL adapter and Timescale schema for telemetry and analyses | No real service credentials, insert/readback or hypertable inspection |
| Personnel | Four fictional exercise identities and responsibilities | Not the developer roster or a real deployment roster |
| Response planner | Deterministic briefing templates, checklist, named local review and JSON/Markdown export | Review identity is self-reported; page state clears on reload |
| Image archive | Not implemented | Only the latest live JPEG is kept in backend memory |
| Historical charts | Not implemented | Dashboard currently displays latest telemetry; database can retain records |

At the baseline, **seven automated tests passed**. The Python bridge passed syntax compilation, which does not verify Olympe imports or drone compatibility. Real ANAFI, TigerData and Gemini integration remains unverified.

Private prototype reference, created for this project: https://emberwatch-anafi-36h.openbard256.chatgpt.site

The published Site hosts the static simulation. It does not run the Node backend or Python bridge. Do not change the Site's audience as part of an unrelated coding task.

## 3. Correct architecture and data flow

The Linux bridge, backend and browser can all run on the **same Linux laptop**. They are software components, not necessarily separate computers. Cloud TigerData and Gemini require a tested Internet connection.

```text
Pilot manually operates the drone
                  |
                  v
Parrot ANAFI --camera + state--> Linux/Python Olympe bridge
                                         |
                               authenticated HTTP ingest
                                         |
                                         v
                                  Node backend/API
                                    /     |      \
                                   /      |       \
                    telemetry + analyses |        selected fresh evidence
                                 /       |          \
                                v        v           v
                            TigerData  latest JPEG   Gemini API
                                ^      in memory         |
                                |                        |
                                +---- backend reads -----+
                                         |
                               authenticated API response
                                         |
                                         v
                               Browser dashboard

Independent Simulation branch:
synthetic telemetry + camera + fictional SVG map + spread illustration
                                         |
                                         v
                               Browser dashboard

Dashboard -> briefing draft -> human checks + name -> local review/export
```

Responsibilities:

- **Bridge:** receives drone state and decoded camera frames, timestamps observations and forwards them. It contains no takeoff, landing or movement command.
- **Backend:** authenticates requests, validates units/time/provenance, queries storage, serves snapshots and calls Gemini. The API is the interface exposed by this backend, not an additional physical device.
- **TigerData:** stores timestamped structured telemetry and analysis records. It does not independently push data to the webpage or draw maps. The backend queries it when the dashboard requests information.
- **Camera path:** drone -> bridge -> backend -> dashboard. The built version does not stream directly from the aircraft to the browser. A person views the images to inspect the evidence behind an interpretation.
- **Gemini path:** backend -> Gemini -> backend -> dashboard. A user requests analysis of recent evidence; this is not continuous analysis of every video frame.
- **Spread path:** a separate local scenario function creates shapes for the simulation. Gemini currently does not calculate fire-spread polygons.

If image history is added, store files in a local image directory or object storage and put timestamps/file references in TigerData. This is a proposed addition, not current behavior.

## 4. Current technology and source layout

| Concern | Current choice |
|---|---|
| Drone | Parrot ANAFI; exact physical variant, firmware and controller still need confirmation |
| Hardware receiver | Python + Parrot Olympe on Linux; optional OpenCV for JPEG conversion |
| Backend | Node.js 22+, built-in HTTP server and fetch; optional `pg` package |
| Database | TigerData / Timescale-enabled PostgreSQL |
| AI service | Gemini REST `generateContent`, with structured response validation |
| Frontend | Plain HTML, CSS and JavaScript; no React/Next.js build step |
| Map/overlay | SVG; canvas for the synthetic camera |
| Update transport | Authenticated HTTP polling approximately every two seconds; no WebSocket implementation |
| Tests | Node's built-in test runner |

Portable paths, relative to the project root:

```text
TEAM_AI_CONTEXT.md          This handoff file
README.md                   Startup and delivered scope
.env.example                Configuration names, no real secrets
package.json                Node scripts and pg dependency
pnpm-lock.yaml              Supplied dependency lockfile
dist/index.html             Dashboard structure and fictional SVG map
dist/styles.css             Responsive and print styling
dist/app.js                 Interactions, API client, data modes, review/export
dist/model.js               Spread illustration and briefing templates
dist/guide.html             Printable execution/integration guide
dist/blackboard-flow.svg    Printable numbered system diagram
backend/server.mjs          HTTP API, storage and Gemini adapters
backend/validation.mjs      Input/output validation and freshness checks
backend/schema.sql          Telemetry hypertable and analyses table
bridge/anafi_bridge.py      Read-only Linux observation bridge
tests/backend.test.mjs      Authentication, provenance and service adapter tests
tests/model.test.mjs        Illustration behavior and initial draft-state tests
docs/EXECUTION_PLAN.md      Full team schedule, dependencies, gates and contingencies
docs/INTEGRATION.md         Detailed setup and API contract
docs/SYSTEM_FLOW.md         ASCII blackboard flow and copying instructions
docs/DEMO_SCRIPT.md         Three-minute demonstration
docs/VERIFICATION.md        Verification boundaries
docs/SOURCES.md             Official integration references checked for the baseline
```

Implementation baseline before adding this context: Git revision `98a9161af439e13a4b5c5f72a7547184f4db50d9`. This identifies the supplied baseline, not every teammate's future HEAD.

## 5. API contract: emberwatch.v1

Preserve route names, units, timestamps and provenance across workstreams. Coordinate and document interface changes before integration.

All API requests use `Authorization: Bearer <token>`. Ingest and dashboard tokens must be non-empty and different. Browser access also uses an exact origin allowlist. An authenticated sender can still report incorrect data; a token does not establish sensor truth.

| Method and path | Credential | Behavior |
|---|---|---|
| GET `/api/status` | Dashboard token | Contract, sample availability/freshness, storage readiness, Gemini configuration and camera status |
| POST `/api/ingest/telemetry` | Ingest token | Validate and acknowledge a timestamped live observation; store in TigerData if configured |
| GET `/api/telemetry/latest` | Dashboard token | `{sample: object or null}` |
| POST `/api/ingest/snapshot` | Ingest token | Accept a fresh live JPEG envelope; retain latest image in memory |
| GET `/api/snapshot` | Dashboard token | JPEG bytes plus `X-Captured-At` response header |
| POST `/api/analyze` | Dashboard token | Empty JSON object; backend selects fresh evidence and requests Gemini analysis |

Telemetry shape, **documentation example only**:

```json
{
  "drone_id": "ANAFI-01",
  "provenance": "live",
  "observed_at": "<actual ISO 8601 observation timestamp with timezone>",
  "battery_pct": 78,
  "altitude_m": 62.4,
  "ground_speed_mps": 3.2,
  "latitude": null,
  "longitude": null
}
```

- Use actual source timestamps, not a refreshed browser timestamp on old evidence.
- At least one measurement must be present. Unknown measurements are null; unknown GPS must not become `(0, 0)`.
- Units are percent, metres AGL, metres/second and geographic degrees as named above.
- Ingest rejects observations outside a +/-30-second server clock window. Synchronize clocks for live testing.
- UI marks telemetry/snapshots older than 10 seconds stale. Analysis requires evidence no more than 30 seconds old.
- Gemini is limited to one started request per 30 seconds. Current backend upstream timeout is 20 seconds.
- Errors use `{ "error": "description" }`: 400 invalid data; 401 auth; 403 origin; 404 absent route/image; 409 missing fresh evidence; 413 size; 429 rate limit; 502 invalid/upstream analysis; 503 configuration/storage failure.
- Do not post generated samples as `live` during a demonstration. Synthetic samples belong in Simulation or explicitly isolated automated tests.

Gemini generates the structured content fields:

```json
{
  "summary": "Descriptive observations with uncertainty.",
  "unknowns": ["Information that this evidence cannot establish."],
  "limitations": "Evidence and interpretation limits."
}
```

The backend adds `id`, `created_at`, `model`, `evidence_at`, `evidence_kind` (`rgb-snapshot` or `telemetry-only`) and `provenance: gemini-unverified`. JSON/schema validity does not prove factual correctness. If only telemetry is supplied, analysis must explicitly acknowledge the absence of visual fire evidence. Do not infer temperature, reliable perimeter, geographic location or safe access from uncalibrated RGB imagery.

TigerData currently contains `telemetry(observed_at, drone_id, provenance, payload)` and `analyses(id, created_at, evidence_at, payload)`. Telemetry is time-partitioned using the supplied schema. Images, personnel and reviews currently have no database tables.

## 6. Simulation, mapping and spread-model rules

**Current map:** fictional SVG. No Google Maps API, real map tiles, geographic calibration or API key is used. Real road mapping remains an optional enhancement; no provider has been selected by the user.

**Current spread function:** `footprint()` in `dist/model.js` generates an irregular wind-biased polygon. Time and dryness increase its size; wind stretches and shifts it in the selected direction. Layered translucent polygons create the colored appearance. The timeline runs from 0 to 60 simulated minutes. The area conversion assumes 4 illustrative metres per SVG unit.

This is an artistic scenario illustration, not a trained or validated forecast. Colors mean relative illustrative intensity, not measured temperature, burn probability or calibrated risk. Wind and dryness are manual scenario inputs; there is no weather API, fuel dataset, terrain model, spotting model or suppression model.

**If a real map is added:** Leaflet plus a suitable road-tile provider, or Google Maps JavaScript API, are candidate options. Leaflet itself needs no key; the tile provider determines access requirements. Google's standard deployment setup requires API/project configuration, billing and a restricted browser key; any demo-key eligibility must be checked against current provider documentation. A Google-like visual style does not mean the app already uses Google Maps.

**If a geographic spread scenario is added:** start with a human-verified or manually drawn geographic perimeter and clearly labeled input assumptions. Drone GPS locates the aircraft; it does not automatically locate the fire boundary in a camera image. Reliable image-to-ground mapping and fire-behavior validation are separate work. Image segmentation—marking fire/smoke pixels—is also not currently implemented.

Connected mode currently **hides the fictional fire overlay**. Do not blend the synthetic heatmap into real telemetry without explicit, persistent simulation labels and a deliberate product change. Missing services must produce unavailable/error states rather than silently becoming sample outputs.

## 7. Human review and incident roles

The planner supports situational-awareness, community-information and handoff briefing objectives. Drafts include evidence, user assumptions, unknowns and coordination questions. They begin unreviewed.

Recording a review requires three checked acknowledgments and a non-empty reviewer name. Changing assumptions, objective, scenario or a manually selected timeline invalidates the review and requires regeneration. Exports retain provenance, timestamps, assumptions, review state and limitations. No action is sent to a drone, crew or outside service by recording a review.

Review is local, self-reported and cleared on reload. It is not signed identity, authenticated incident approval or a durable team workflow. The response planner currently uses deterministic templates; it does not execute Gemini output.

Fictional incident roster: Alex Lee (incident lead/reviewer), Jordan Rivera (remote pilot), Morgan Chen (safety/liaison), Sam Patel (GIS/intelligence). These are exercise characters, not the four developers' real names or organizational authority.

## 8. Four-person ownership and timing

| Developer | Ownership | Starting constraint |
|---|---|---|
| A | Dashboard, visual integration, provenance modes, release | Starts H0; prepares D's handoff by H3 |
| B | Backend API, TigerData, tokens/CORS, integration tests | Starts H0; agrees contract with A/C |
| C | Exact ANAFI/controller/Linux check, bridge, snapshots, hardware evidence and QA | Starts H0; hardware failure must not block the demo |
| D | Gemini adapter, briefing workflow, scenario validation, documentation and pitch | Arrives H4; no pre-H4 dependency may require D |

These letters are placeholders for the actual teammates. Shared files need explicit coordination: A and D overlap in `dist/app.js`; B and D overlap in `backend/server.mjs`. Prefer bounded changes, agreed fields and small handoffs over unrelated stack replacements.

Milestones:

- H1: agree API/data contract and confirm offline startup.
- H4: hardware connection decision; onboard D with run commands, contract, open tasks and fallback cutoffs.
- H8: actual snapshot or explicitly labeled camera fallback.
- H12: decide whether real TigerData/Gemini round trips are ready; retain honest memory/fixture modes if not.
- H18: scenario -> draft -> review -> export journey works.
- H24: must-have feature freeze.
- H30: clean-start/offline rehearsal and evidence review.
- H34: source/artifacts frozen; no new features.
- H36: submit and demonstrate verified scope.

Planned rest coverage: A H16-20, B H20-24, C H24-28, D H28-32. Raw availability is 140 person-hours; after four hours of rest each, 124 remain before meals/coordination. Plan approximately 100 task hours plus 24 hours of buffer. Full schedule and acceptance criteria are in `docs/EXECUTION_PLAN.md`.

## 9. Configuration and startup

| Configuration | Location/use |
|---|---|
| `INGEST_TOKEN` | Bridge and backend; authorizes observation writes |
| `DASHBOARD_TOKEN` | Backend and page session; authorizes reads/analysis |
| `DATABASE_URL` | Backend only; TigerData PostgreSQL connection credentials |
| `PG_CA_FILE` | Optional backend trusted CA file; keep TLS verification enabled |
| `GEMINI_API_KEY` | Backend only; never a browser setting |
| `GEMINI_MODEL` | Backend-selected account-enabled model; example value is not proof of access |
| `ALLOWED_ORIGINS` | Exact frontend origins allowed to call the backend |
| Optional future map key | Separate browser-restricted key if required by the chosen provider |

No real secrets are included. Keep `.env` untracked. The browser's integration token field takes the dashboard token, not Gemini/database/ingest credentials.

Offline demo: open `dist/index.html` in a modern browser. Recommended local server from the project root:

```text
node backend/server.mjs
```

Then open `http://127.0.0.1:8787`. Simulation needs no package installation or keys. The server defaults to loopback.

Optional integrations: install dependencies using the team's package manager; copy `.env.example` to `.env`; configure tokens and available services; apply `backend/schema.sql` to the provisioned TigerData service; run:

```text
npm start
```

On a tested Linux Olympe environment, set the ingest token in the process environment and run:

```text
python3 bridge/anafi_bridge.py --ip 192.168.42.1 --controller direct --backend http://127.0.0.1:8787
```

Add `--camera` for optional OpenCV JPEG snapshots. The bridge targets classic ANAFI directly or SkyController 3; verify the exact hardware and SDK before adapting it to other variants. The pilot remains responsible for manual operation in an approved test setting; this project does not authorize flight at an active wildfire.

With no database URL, backend status explicitly says `memory only`; data vanishes on restart. A configured database failure must not silently switch to memory. Check real insert/readback independently. A Gemini `configured` flag is not evidence of a successful call.

An HTTPS hosted frontend may be unable to reach an HTTP/private local backend. For the hardware demo, use the local frontend served by Node, or a correctly configured HTTPS backend and origin allowlist. Drone Wi-Fi and Internet access on the Linux host must be tested together.

## 10. Validation and known integration work

Run relevant checks after code changes:

```text
node --test tests/backend.test.mjs tests/model.test.mjs
node --check dist/app.js
node --check backend/server.mjs
python3 -m py_compile bridge/anafi_bridge.py
```

Browser acceptance: responsive layout; visible simulation/source labels; playback/scenario controls; camera and telemetry ages; backend missing/no-data states; role details; draft generation; checklist/name requirement; review invalidation; exports with provenance; no automatic dispatch/flight action.

External acceptance is separate: confirm exact drone/SDK/controller; receive actual telemetry/frame; demonstrate TigerData insert/readback and hypertable; demonstrate a real Gemini response; record capture times and verification evidence. A passing fixture test is not a real external test.

**Known item to address when connecting real Gemini:** the frontend's shared request timeout is currently 12 seconds, while the backend allows Gemini 20 seconds. Align analysis timeouts/feedback so a legitimate slow response does not finish after the browser has already given up. This was identified from source; no live latency test was performed.

The current Gemini adapter uses documented compatibility fields `responseMimeType` / `responseSchema`. Check the configured model and current provider API before changing or migrating that request format. No production identity, multi-incident authorization, durable reviews, image archive, live weather feed, continuous browser video or validated forecasting system is supplied.

## 11. How each AI should work and hand off

1. Establish your assigned developer role and concrete task. Inspect the relevant files; do not assume every proposal in this context already exists.
2. Keep the offline baseline runnable and preserve agreed contracts/provenance. Make reversible, scoped implementation choices without inventing missing hardware, keys, data or success claims.
3. Coordinate edits to shared files. Report interface changes and dependencies clearly to the human teammate who will integrate them.
4. Maintain clear separation of observed measurements, model interpretations, manual assumptions and synthetic fixtures.
5. Test the changed behavior appropriately. Distinguish source checks, fake-service tests, browser tests and actual external-service/hardware evidence.
6. Hand off a concise record: objective completed; changed files; interfaces touched; checks and results; remaining uncertainties; next dependency/owner; demo fallback.

Suggested opening prompt for a teammate's AI:

```text
Read TEAM_AI_CONTEXT.md and inspect the current project files.
I am developer [A/B/C/D]. My task is: [specific bounded task].
Implement that task while preserving the shared contracts, simulation labels,
human-review requirements and offline baseline. State which behavior you actually
verified and what still needs hardware, credentials, data or another teammate.
Finish with a concise handoff listing changed files and the next dependency.
```

If only this file is available, use it to explain or plan the work and state that current source/hardware cannot yet be inspected. Do not claim implementation from this description alone.

## 12. Official references for integration work

These are baseline references, not proof that a teammate's installation or account is compatible. Check current documentation when wiring or changing external services.

- Parrot Olympe: https://developer.parrot.com/docs/olympe/index.html
- Physical connection: https://developer.parrot.com/docs/olympe/userguide/advanced/physical_drone.html
- Camera streaming: https://developer.parrot.com/docs/olympe/userguide/advanced/streaming.html
- Gemini request API: https://ai.google.dev/api/generate-content
- Gemini image input: https://ai.google.dev/gemini-api/docs/image-understanding
- TigerData hypertables: https://www.tigerdata.com/docs/reference/timescaledb/hypertables/create_hypertable
- Optional Leaflet mapping: https://leafletjs.com/examples/quick-start/
- Optional Google Maps setup: https://developers.google.com/maps/documentation/javascript/get-api-key
