# Person search: finding people who cannot ask for help

Project KAZE asks how to help people who can no longer call, message or press
SOS. In a wildfire that is someone injured, overcome by smoke, or cut off. The
drone looks for them, and BOSCO turns what it sees into **rescue leads**:
specific places, with an honest uncertainty, that a responder must
acknowledge.

The drone stays airborne. Nothing in this system lands it near a fire or
commands it from the backend. Every flight suggestion is advisory.

## From a detection to a lead

1. **Detect.** The bridge runs a person detector on the camera stream: COCO
   YOLOv8n on visible video by default. A thermal-trained model can be passed
   with `--person-model … --sensor thermal`. A simple box tracker reports each
   track at most every 2 s, with the timestamped drone and gimbal pose.
2. **Geolocate.** The ray through the box centre is cast through the pose onto
   the ground (`backend/people.mjs`, `geolocate`). Ground height is flat at
   take-off level unless the caller sends `terrain_m`.
3. **Propagate uncertainty.** A linearised error model, J Σ Jᵀ, turns the
   sources below into a 2×2 ground covariance. The dashboard shows its 95%
   ellipse. It never shows a "confidence %".

   | Source | 1σ (default) |
   |---|---|
   | GPS horizontal | 2.5 m (indoor odometry 1.0 m) |
   | Height above ground | 1.0 m (indoor 0.3 m) |
   | Heading | 3° |
   | Gimbal pitch | 1.5° |
   | Box centre | 25% of the box size |
   | Terrain, flat assumption | 2.0 m (1.0 m with `terrain_m`) |

4. **Associate.** A new detection joins a lead when it falls inside the 99%
   gate. The gate combines both covariances plus walking allowance: 1.5 m/s,
   capped at 15 m.
5. **Fuse.** The position is the information-weighted mean of the sightings.
   For a moving person, only the last 15 s of sightings count.
6. **Multi-view check.** Sightings are grouped by viewing direction. Two
   directions at least 25° apart that agree on the spot make a **Possible
   person**. A hot rock, a burning branch or a reflection rarely lands in the
   same place from two angles, so it stays a one-angle **Candidate**.
7. **Negative evidence.** When the drone looks at a lead's spot again and sees
   nothing, the lead records it. After 3 such looks it becomes **Not
   re-seen**: the person may have moved or be hidden, or it may not be a
   person. BOSCO never dismisses a lead on its own.
8. **Movement.** The first and last 15 s of sightings are compared with the
   error model. "Moving" means a statistically significant displacement over
   3 m. "Not moving" is claimed only after 60 s, because it suggests someone
   who may be unable to move.

## The search loop

Survey → propose → revisit → resolve → report → continue.

For each lead that needs it, `nextLook` scores viewpoints on a ring around the
lead, about 45° down at the current altitude:

```
score = 0.5 × (shrink of the 95% area, m²)
      + 150 if it adds a new angle to a one-angle candidate
      + 0.5 × angular novelty (≤ 90°)
      − flight time (s at 8 m/s)
      − exposure (up to 120 within 200 m of the fire)
```

Viewpoints within 40 m of the fire, or outside the assigned sector, are never
suggested. A possible person unseen for 90 s gets a **re-check** suggestion.
The weights are tunable and are stated here so nobody mistakes them for
measurements.

## Fire-aware search

The spread model in `dist/model.js` also runs on the backend, so the dashboard
and the planner project the same fire. `arrivalMinutes` returns when the
projected outline first covers a point:

- **0:** the point is inside the fire now.
- **null:** the fire doesn't reach it within 3 h.

These are projections at the stated conditions, not forecasts.

- **Leads show when the fire reaches them.** Each card shows "Fire projected
  here in about N min". The dashboard recomputes it whenever the Conditions
  change. Within a priority tier, the lead the fire reaches first comes first.
  Gemini plans receive the same figures.
- **The drone trail is coloured by purpose.** Each trail point is classed from
  the drone's position, heading and camera tilt:
  - **Ember:** the camera was on the fire.
  - **Amber:** the centre of the view was on ground the fire reaches within
    60 min.
  - **Teal:** elsewhere.
- **The simulated survey follows the fire.** Its legs run across the wind and
  are ordered by projected arrival, soonest first. Ground the fire doesn't reach
  comes last. Nothing is flown within 60 m of the fire's edge or over ground it
  reaches within 10 min. Next-look suggestions obey the same 10-minute limit.
  A test flies the whole simulation and checks that the drone never breaks it.

## Coverage map (observability)

Every telemetry pose projects the camera footprint onto a grid of 5 m cells.
`COVERAGE_CELL_M` changes the size. Grazing looks shallower than 15° don't
count. Each cell remembers the 30° directions it has been seen from:

- **Well observed:** seen from 2 or more directions.
- **Partly observed:** seen from one direction.
- **Not yet observed:** not drawn, shown as the hatched sector.

With `SEARCH_SECTOR=south,west,north,east`, the incident's assigned airspace,
the dashboard shows the observed share of the sector. Next-look suggestions
then stay inside it.

## Alerts, outages and acknowledgement

- **Small alerts first.** The bridge posts the JSON observation, then the
  image crop of 160 px or less, to `/api/ingest/person/crop`.
- **Store and forward.** Undeliverable observations wait in
  `anafi_out/person_outbox.jsonl`, which survives a bridge restart. They are
  sent when telemetry gets through again. Each has a unique `obs_id`, so
  retries are idempotent. The backend accepts observations up to 6 h old and
  marks anything received more than 15 s late as **delayed**.
- **Acknowledgement.** A responder enters a name or call sign and
  acknowledges each lead. Closing a lead requires an outcome: found, not a
  person, duplicate, or handed off.
- **Leads survive a backend restart.** They are stored in
  `data/people/state.json`, which is git-ignored.

## Plans

Gemini plans now put people first, quote lead positions as ±metres, and must
not call any route, road or area "safe" or "clear". `findUnsafeWording` flags
any such phrase in a plan, and the plan record carries it in
`wording_flags`.

## Demo

**Demo → Person search · simulated multi-view** replays a seeded simulation
through the same pipeline (`backend/people-sim.mjs`):

- A 70 m survey of the sector.
- An injured person who doesn't move, partly hidden from the north-east.
- A walker who leaves their first spot and reappears; the dashboard notes
  "may be the same person".
- A sun-heated rock that shows only from the south-west and never confirms.
- A 55 s radio outage whose observations arrive marked delayed.

## Not done yet

- No elevation model: terrain is flat at take-off height unless `terrain_m` is sent.
- Fire arrival uses the simple ellipse spread model: no terrain slope, fuel map or spotting.
- Leads are stored as a JSON file, not in TigerData. Adding tables needs `npm run db:init`.
- No airborne optical sectioning (integrating thermal frames through canopy).
- No breathing radar. It would only ever be an optional research layer.
- Deconfliction with incident aviation is limited to the sector bound.
- No responder app or SMS relay: alerts go to the dashboard only.
