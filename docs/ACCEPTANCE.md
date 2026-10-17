# Acceptance checklist (v2.0 — live by default)

The demo is "done" when every **Must** item passes at the clean-start rehearsal.
A failing item gets fixed or removed from the demo script.

Checked by: __________  Date/time: __________  Commit: __________

## A. Startup (Must)

- [ ] `npm test` passes.
- [ ] `npm start`, then http://127.0.0.1:8787 opens straight into live mode (no token prompt) showing "Waiting for the drone".
- [ ] With the backend stopped, the page says the backend is unreachable — no example data appears.

## B. Drone link (Must)

- [ ] `bridge/anafi_bridge.py --backend …` connects; the ANAFI-01 panel shows smooth live video (fps shown) within a few seconds.
- [ ] Altitude AGL, ground speed, drone power and flight state update about once a second; stale telemetry (>10 s) is marked STALE.
- [ ] The drone's position appears on the map (GPS outdoors; home + moves indoors).

## C. Detection → everything (Must)

- [ ] Showing the printed test marker (18 cm, within ~2 m) triggers "Fire detected" within a second or two; the video shows the detection box.
- [ ] The fire pin appears on the map with the marker's name/area, and the spread projection grows when Play is pressed.
- [ ] Gemini analysis appears automatically (AUTO tag) with severity and spread outlook — or, with no internet, "Cannot connect to Gemini" with the reason.
- [ ] "Mark false alarm" clears the incident.

## D. Planning (Must)

- [ ] "Generate operational plan" returns prioritized actions with owners and timing, triggers and the stated advantage.
- [ ] Changing conditions marks the plan stale; approval needs a name.
- [ ] Export brief contains the fire, projection, telemetry, analysis and plan.

## E. Demo flight (Should — needs the venue's OK and a person on the controller)

- [ ] `--demo-flight` refuses to start below 30% battery or when not landed, and waits for `FLY`.
- [ ] Take-off, +1 m climb, 8-segment circle, return, landing; progress shows in the ANAFI-01 panel.
- [ ] `x` + Enter, `l` in the video window and Ctrl+C each land the drone immediately.

## F. TigerData (Must for the track)

- [ ] `npm run db:init` reports insert + read-back via `telemetry_1m` and lists the hypertables.
- [ ] Status shows TigerData "Connected"; the Integrations chart shows altitude per minute from the continuous aggregate.
- [ ] Detections, analyses and plans rows exist after a test run.

## G. Demo mode (Should)

- [ ] The Demo button loads the historical fires from `examples/`; each replays from ignition to its recorded size.
- [ ] "ANAFI demo flight pattern" replays the circle at the Sam Ibrahim Building; Exit demo returns to live.

## H. Release (Must)

- [ ] `.env` is not committed; `.env.example` has no real values.
- [ ] README commands work from a fresh clone.
