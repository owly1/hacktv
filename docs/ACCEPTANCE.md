# Acceptance checklist

The demo is "done" when every **Must** item passes. Run the full list at the H30 clean-start rehearsal
and record who checked it and when. A failing item gets fixed or removed from the demo script.
Never demo around a failing item.

Checked by: __________  Date/time: __________  Commit: __________

## A. Offline simulation (Must; no internet, no keys, no backend)

- [ ] Opening `dist/index.html` shows the map, animated fire spread, synthetic camera and all panels.
- [ ] Play/pause animates the spread; the timeline slider and T+0 / +30 / +60 presets move it.
- [ ] Changing wind direction changes the spread direction; dryness and wind speed change its size.
- [ ] Map zoom in/out/reset and layer toggles work.
- [ ] Every synthetic panel is labelled (SIM, Simulated feed, DEMO FIXTURE, Illustrative, Exercise).
- [ ] The simulation banner says spread is illustrative, not a validated prediction.

## B. Layout and navigation (Must)

- [ ] Desktop width (≥1240 px): no overlapping or clipped panels.
- [ ] Phone width (~390 px): single column, no horizontal scrolling, all controls usable.
- [ ] Each sidebar button opens its panel full screen; clicking it again or pressing Esc closes it.
- [ ] The full-screen button on map, drone, Gemini, planning and personnel panels works both ways.
- [ ] Scenario and Integrations dialogs open and close, including while a panel is full screen.

## C. Honest data states (Must)

- [ ] Connected mode with the backend **not running** shows an unreachable/error state, not sample data.
- [ ] Connected mode with a wrong token shows an auth error.
- [ ] Connected mode with no telemetry yet shows "awaiting samples", not zeros.
- [ ] Unknown values (e.g. GPS) show as unknown, never as 0 or (0, 0).
- [ ] Telemetry or snapshots older than 10 s are marked stale.
- [ ] Connected mode hides the synthetic fire overlay.
- [ ] Switching back to simulation clears live data and the token.

## D. Backend integration (Must for connected demo)

Start with `node --env-file=.env backend/server.mjs` and open http://127.0.0.1:8787.

- [ ] `npm test` passes.
- [ ] A live telemetry POST (ingest token) appears in the dashboard within ~2 s with its real timestamp.
- [ ] A sample with `provenance` other than `live` is refused in connected mode.
- [ ] Status panel shows storage mode (`memory only` or `postgres`) and Gemini configuration honestly.
- [ ] Analyze without fresh evidence shows the 409 message; a second click within 30 s shows the 429 message.

## E. Gemini analysis

- [ ] **Must:** In simulation, the analysis panel is labelled DEMO FIXTURE and says no Gemini request was made.
- [ ] **Should:** One real Gemini response captured (date/time + screenshot) with summary, unknowns, limitations, provenance `gemini-unverified`.
- [ ] **Should:** A slow but valid Gemini response (>12 s) still appears in the browser (timeout fix).
- [ ] **Should:** Telemetry-only analysis explicitly says there is no visual fire evidence.

## F. Response planning and review (Must)

- [ ] A draft can be created for each objective; it starts **unreviewed**.
- [ ] Recording a review requires all three checkboxes **and** a non-empty name.
- [ ] Changing assumptions, objective, scenario or the timeline (manually) invalidates the review.
- [ ] JSON and Markdown exports include timestamps, provenance, assumptions, review state and limitations.
- [ ] No draft text gives tactical commands, crew dispatches, evacuation orders or "safe route" claims.
- [ ] Nothing in the app sends commands to a drone, crew or outside service.

## G. Hardware (Should; demo must not depend on it)

- [ ] Exact ANAFI model, firmware and controller recorded.
- [ ] Bridge sends at least one real telemetry sample, visible in the dashboard with its capture time.
- [ ] Bridge sends at least one real JPEG snapshot, visible in the drone panel.
- [ ] Bridge contains no takeoff, landing or movement commands.

## H. Persistence (Should)

- [ ] `backend/schema.sql` applied to TigerData; a telemetry insert is read back.
- [ ] Hypertable confirmed (screenshot or query output saved).

## I. Release (Must, H34)

- [ ] `.env` is not committed; `.env.example` has no real values.
- [ ] README run commands work from a fresh clone.
- [ ] Source zip and checksum created from the frozen commit.
