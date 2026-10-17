# Emberwatch — formal 36-hour execution plan

**Team:** four developers, A/B/C present at H0, D arrives H4. **Clock:** elapsed hackathon hours; H0 is event kickoff. **Outcome:** a reliable, explainable monitoring demo, an animated spread illustration, and a human-reviewed incident briefing workflow. Prepared 16 October 2026.

## 1. Delivery agreement

The baseline is the supplied working simulation and source. A pilot may manually fly an ANAFI in an approved test setting and return observations to the computer. Flight permission, airspace coordination, operating limits and go/no-go decisions remain with the responsible pilot and event organizers. A live wildfire flight is outside this hackathon plan.

**Must have by H24:** largest dashboard section is a light road-style map with animated illustrative spread; playback and scenario input; clearly labeled simulated camera and telemetry fallback; source/age labels; sample Gemini analysis or authenticated live API response; TigerData integration interface; incident personnel; briefing questions, unknowns, review checklist and export. All must work from a clean checkout without keys in Simulation.

**Live stretch targets, gated early:** actual ANAFI telemetry, actual low-rate RGB JPEG snapshots, one structured Gemini response, one TigerData persisted observation + readback. These are separately reported; a configured service is not called verified until a real round trip succeeds.

**Cut from the 36-hour scope:** autonomous flight, automated suppression or evacuation advice, multi-drone control, trained fire detection, thermal claims from RGB, geolocated perimeter extraction, a validated fire forecast, production identity, dispatch, continuous WebRTC streaming, real Google Maps credentials/tiles, and operational routing. The fictional schematic provides the requested light map aesthetic without a map service dependency.

## 2. Ownership and capacity

| Developer | Accountable workstream | First four hours | Handoff / backup |
|---|---|---|---|
| A — integration & dashboard lead | UI shell, map, interactions, provenance modes, integration review, final build | Start offline dashboard immediately; publish contracts with B; prepare D's handoff | D can modify simulation; B owns release while A rests |
| B — backend & TigerData | API, tokens/CORS, schema, persistence, status, integration tests | Freeze JSON v1 with A/C; start memory API and schema independently | A can run backend and replay tests |
| C — ANAFI & media / QA | Linux bridge, hardware capability check, manual test capture, snapshots, hardware limitations, demo evidence | Identify exact ANAFI variant, firmware, controller, Linux host; read-only connection spike | B can run ingest; C switches to QA if hardware gate fails |
| D — AI & briefing / simulation (arrives H4) | Gemini adapter, evidence limits, planning workflow, guide + pitch, scenario validation | Absent; no early task depends on D | A prepares a one-page H4 handoff; B backs up API integration |

Raw availability is **140 person-hours** (3×36 + 32). Reserve four hours of rest per person, leaving **124 person-hours before meals and coordination**. Target 100 hours of planned work, with the remaining 24 for meals, handoffs, integration failures and release buffer. No milestone depends on four people being active simultaneously.

Rest windows: A H16–20, B H20–24, C H24–28, D H28–32. No physical flight during fatigue-sensitive periods; C and the responsible pilot stop hardware work when conditions or alertness are unsuitable. These are planning allocations, not a requirement to work continuously.

## 3. Parallel execution schedule

| Window | A — dashboard / integration | B — API / data | C — hardware / QA | D — AI / briefing |
|---|---|---|---|---|
| H0–1 | Set acceptance checklist; run prototype; agree design | Freeze `emberwatch.v1`; create token setup | Inventory hardware and Linux host; verify exact variant | Arrives H4; no dependency |
| H1–4 | Road map, timeline, scenario controls; draft handoff | Memory ingest/read/status; TigerData schema; API tests | Read-only SDK spike, battery/GPS sample, camera feasibility; hardware gate | Absent |
| H4–8 | Wire telemetry modes; no synthetic/live blending | Integrate C's ingest; create TigerData service or mark memory-only | Capture test telemetry; attempt JPEG snapshots; camera gate | 20-minute handoff; Gemini structured adapter + fixtures; briefing draft structure |
| H8–12 | Complete responsive layout, map controls, empty/error states | Persist real observation + readback; TLS and auth checks; database gate | Validate snapshot display and timestamp; prepare recording fallback | One live Gemini round trip if keys; evidence limits, refusal on missing data; AI gate |
| H12–16 | Connect complete user journey and export | End-to-end integration, stale data behavior, recovery | Device/network drop test; provenance review | Human checklist, named review, stale-draft behavior, incident roles |
| H16–20 | Rest; handoff release runbook to B | Integrate branches; tests, packaging; cover release | Browser QA, telemetry/sample-age checks | Scenarios, briefing copy, guide; fill UI bugs with B |
| H20–24 | Final visual pass; scope freeze; own release | Rest; A covers server runbook | Mobile/desktop acceptance; record backup demo | Finish plan, diagram and pitch; review content boundaries |
| H24–28 | Fix release blockers only; assemble source/artifacts | Test from clean checkout; secrets and schema review | Rest; hardware remains off unless separate qualified coverage | Rehearsal 1, identify failed claims, edit evidence labels |
| H28–32 | Stabilize release; check final dashboard | Reproducible startup, persistence evidence; offline test | Rehearsal 2, video backup, hardware demo only if ready | Rest; A follows pitch notes |
| H32–34 | Full team: one timed demo; triage only blockers | Verify final package and API configuration | Confirm charged equipment or use recorded/synthetic fallback | Final pitch, judge questions, attribution and limitations |
| H34–36 | Freeze source, zip and checksums; launch final dashboard | Keep reproducible offline copy | Stage laptop, recording and equipment | Submit artifact links; present; no feature additions |

## 4. Work packages and dependencies

| ID | Owner | Deliverable and acceptance | Prerequisite | Budget |
|---|---|---|---|---|
| W1 | A + B | v1 fields, provenance, units, routes, errors; all agree on same sample | None | 4 person-hours |
| W2 | A | Offline map, animation, timeline, scenario inputs, responsive camera/panels | W1 field names; mock source independent | 18 |
| W3 | B | Token-separated API, validation, status, read/ingest, tests | W1 | 12 |
| W4 | C | Linux observation bridge and connection evidence or documented fallback | Exact hardware + Linux available | 10 |
| W5 | B | TigerData schema, verified TLS, real insert/readback or truthful memory mode | W3; service credentials | 7 |
| W6 | D | Gemini structured adapter, validated response, fixture and timeout/error UI | W1; live test needs fresh W4 data and API key | 10 |
| W7 | D + A | Briefing objectives, evidence gaps, checklist, named review, stale inputs + export | W2; independent of live Gemini | 10 |
| W8 | C + A | Integration, desktop/mobile, auth, stale feed, mode-switch, offline checks | W2/W3/W7; W4–6 as available | 15 |
| W9 | D + all | Plan, blackboard flow, source package, evidence table, 3-minute pitch, backup recording | Stable baseline | 14 |
| Buffer | All | Rest/food handoffs and unexpected fixes use unallocated capacity | — | 24 available after above 100 |

**Critical path:** W1 → W2 + W3 in parallel → W7 → W8 → W9 release. W4/W5/W6 connect through explicit interfaces and timeouts; they cannot block the offline baseline. No work is assigned to D before H4. A writes D's handoff by H3: repository commands, API sample, chosen Gemini fields, current mode rules, assigned issues and fallback cutoffs.

## 5. Milestones and decision gates

| Deadline | Responsible | Exit evidence | Fallback decision |
|---|---|---|---|
| H1 | A/B | Contract agreed, source starts on laptop | Keep browser-local baseline |
| H4 | C/A | Exact model + Linux host known; real state received or clear failure | Cap further hardware setup at one additional bounded attempt; C then switches to replay/QA |
| H8 | C/B | At least one real frame with captured-at time or explicit camera unavailability | Use low-rate JPEG instead of continuous stream; otherwise synthetic camera labeled in every view |
| H12 | B/D | Real DB insert/readback; real Gemini response logged separately | Memory only / sample fixture labels; no pretend connections |
| H18 | B | Complete click path through scenario → draft → review → export | Trim decorative controls before required behavior |
| H24 | A | Must-have acceptance passes; feature freeze | Cut unverified integrations from live presentation |
| H30 | A/C | Cold start and offline demo succeed; no leaked keys | Use local static copy and recorded proof of earlier hardware test |
| H34 | All | One timed rehearsal; source and artifacts frozen | No dependency updates or new features |
| H36 | D/A | Submit dashboard, guide, source zip and verification matrix | Present exact verified scope |

## 6. Contingency playbook

| Trigger | Action / owner | What judges see |
|---|---|---|
| Wrong controller, incompatible host or failed Olympe connection at H4 | C documents exact failure and switches to test evidence + QA; A preserves simulation | Synthetic feed with persistent label; physical integration remains source-only |
| Network cannot reach drone and Internet simultaneously | C keeps drone bridge on Linux; use a second authorized interface or relay only after testing; otherwise run locally and replay | No claim that cloud analysis is live |
| RTSP cannot render in browser | C uses supplied JPEG bridge at ~0.5 fps; do not spend sprint building WebRTC | Snapshot timestamp and explicit low-rate label |
| TigerData quota/network/schema issue by H12 | B keeps explicit ephemeral memory mode; SQL + adapter remain supplied | “Memory only,” no false persistence badge |
| Gemini missing key, timeout, 429 or malformed output | D shows failure; demo mode uses labeled deterministic fixture | No fabricated API response; human briefing workflow still works |
| Telemetry older than 10 seconds | A marks telemetry stale; at 30 seconds backend refuses analysis on that evidence | Age and source remain visible |
| Snapshot older than 10 seconds | A marks image stale; at 30 seconds do not send it as fresh Gemini evidence | Last-capture time; no fake stream status |
| Bad payload or wrong token | B rejects ingest; no database write or UI substitution | Last known sample age increases |
| Model output includes unsupported inference | D treats as unverified; keep response planner deterministic; reviewer checks evidence | Evidence gaps and scope limit alongside analysis |
| Unexpected teammate absence after H4 | A prioritizes W2/W3/W7/W9; B covers release; C/D share QA | Coherent baseline and accurate feature matrix |
| Deployment unavailable | A opens `dist/index.html` or local server; D uses recorded 3-minute demo | Full offline interactions and downloadable source |

## 7. Acceptance and release checklist

- Open from a clean checkout with no credentials. Simulation map, timeline, scenario change, synthetic camera, fixture analysis, personnel details and briefing export work.
- Road map is the dominant panel; no satellite imagery. Desktop and narrow screens remain usable. Keyboard focus and accessible labels are present.
- Color legend says relative intensity; map says fictional; spread says illustrative; no temperature or probability claim.
- Connecting a backend hides the schematic heatmap. No fire location is inferred from drone position. Missing, stale and disconnected states are visible.
- Ingest/read tokens are distinct, API keys stay on server, CORS is allowlisted, and DB TLS verification stays enabled.
- Gemini requires fresh evidence, structured output and a bounded rate; errors do not become sample responses in connected mode.
- Briefing contains observations, unknowns and coordination questions. A reviewer must complete three checks and enter a name; changed inputs require regeneration. Review is explicitly local and self-reported.
- Exports preserve source mode, timestamp, assumptions, review state and limitations. Nothing is dispatched or flown from the dashboard.
- Run automated tests; record actual external round trips separately. Source zip contains no `.env`, credentials, `node_modules` or hardware footage.

## 8. Demonstration and handover

Use the supplied three-minute script. Lead with the problem and main map, show one wind-shift comparison, play the animation, inspect telemetry provenance, then create and review a briefing. Explain the live integration boundary and show verified hardware evidence only if achieved. Finish with source, plan, diagram, limitations and a realistic next step: validate georeferencing and fire science with domain experts before any operational use.
