# Person search

Person observations become **rescue leads**, not confirmed identities or a
medical assessment. The UI shows viewing directions, location uncertainty,
movement evidence, delayed sightings and a named responder's review.

## Code path

1. `PersonDetector` in `bridge/anafi_bridge.py` runs a YOLO person model and
   tracks overlapping boxes. It reports at most once per track every two seconds.
2. An observation carries capture time, bounding box and full camera/drone pose.
   Failed deliveries queue on disk in `anafi_out/person_outbox.jsonl` (up to 500).
3. `backend/people.mjs` casts the image ray onto flat ground and propagates
   GPS/odometry, altitude, attitude, pixel and terrain errors into a 95% ellipse.
4. Agreeing sightings associate into a lead; distinct angles tighten the estimate.
   Missing a later sighting changes status but never silently dismisses a lead.
5. `dist/people.js` renders cards, map uncertainty, coverage and suggested next looks.

Standard ANAFI Extended is visible RGB. `--sensor thermal` and `--person-model`
describe a supplied stream/model; they do not create a thermal camera.
`--no-person` disables this detector. The observation-only Pi receiver does
not run the full person detector.

## Interfaces and state

| Route / path | Purpose |
|---|---|
| `POST /api/ingest/person` | Validated live observation; `obs_id` makes retries idempotent |
| `POST /api/ingest/person/crop?obs_id=...` | JPEG crop up to 300 KB, sent after the small alert |
| `GET /api/people`, `/api/people/crop/:id` | Dashboard state/evidence |
| `POST /api/people/ack`, `/api/people/close` | Named responder action; closing needs an outcome |
| `GET /api/demo/people?t=...&scenario=...` | Deterministic search replay |
| `data/people/state.json`, `data/people/crops/` | Local persisted leads and crops, ignored by Git |

Observations can arrive up to six hours late; over 15 seconds is marked delayed.
These leads are stored as JSON, not TigerData. See [ingest contract](BRIDGE_CONTRACT.md).

## Coverage and ranking

`SEARCH_SECTOR=south,west,north,east` adds assigned-area percentages; without it
the UI reports observed hectares. `CAMERA_HFOV_DEG` defaults to 69 and
`COVERAGE_CELL_M` to 5. Coverage distinguishes unseen, one-angle and multi-angle
ground, not guaranteed visibility through terrain or canopy.

The shared spread model estimates arrival at each lead. A lead at the fire
ranks first; otherwise evidence and projected arrival guide priority. Suggested
views respect the modeled fire standoff, but the pilot decides actual flight.
Plans include open leads and flag wording claiming that a route is safe/clear.

## Demonstration and limits

Replay → **Person search · fire first** offers UTSC and the historical example
sites: circle the fire, survey its path, revisit people, reject a one-angle hot
rock, and deliver queued observations after a radio outage. It never pilots.

Run `npm test`. No terrain/canopy reconstruction, breathing radar, responder
SMS/app or validated arrival forecast is implemented. Field-test detector and
location errors before interpreting them as operational accuracy.
