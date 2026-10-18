# Fleet fire monitoring and perimeter person search

## Direction and implementation status

BOSCO / Emberwatch is moving to a fleet of drones that surrounds a fire,
collects camera and telemetry evidence, and displays a shared predictive fire
model. Individual drones intermittently descend to search for people along
the fire's **perimeter**, then return to their observation sectors.

This is the current product specification. It supersedes this file's earlier
single-drone, floor-QR orbit-loop proposal. Existing QR workflows remain
separate development tools; their one-metre orbit and proposed hotkeys do not
define the fleet mission.

Current `main` provides the connected BOSCO dark/light dashboard with live
single-drone camera/telemetry ingest, fire/QR/person detection, illustrative
spread and named rescue-lead review. Explicit Replay provides four animated
drone cameras with synchronized telemetry, a scrollable fleet area, coordinated
exterior search descents, historical cases, forest detection and person-search
exercises. Home opens this same workspace; the fixture-only UI is removed.
Legacy AI APIs remain available, but the dashboard makes no Gemini requests.
Isolated live fleet streams, fusion of real perimeter observations and physical
fleet coordination remain planned work. This specification describes the target
beyond the verified replay capabilities, not implemented aircraft autonomy.
Use the [existing workflow guides](README.md#choose-a-hardware-workflow) for
current operation and [shared context](TEAM_AI_CONTEXT.md) for team work.

## Observe the fire as a fleet

- Distribute drones across sectors around the evolving fire perimeter to collect
  views from multiple directions. Encircling means observation coverage; it
  does not claim that drones physically contain or extinguish the fire.
- Show each drone's position, sector, role, camera viewing direction and recent
  coverage on one shared incident map.
- Refresh assignments as the observed boundary changes. Show gaps, stale sectors
  and uncertain boundary segments rather than assuming complete coverage.
- Maintain fire observation while individual drones search for people. Coordinate
  sector handoffs and simultaneous descents so search activity does not remove
  all perimeter coverage.

Fleet size, spacing, observation heights and permitted standoff remain
configuration and validation decisions. Earlier indoor QR dimensions do not
set the fleet's field mission limits.

## Build a shared predictive fire model

Combine the fleet's camera observations and telemetry with available wind,
temperature, humidity and fuel information to update a common incident picture.
Camera evidence needs capture time, source drone, viewing geometry and confidence;
image boxes alone are not a geographic fire boundary. Missing measurements
remain unknown, and measured, estimated and scenario inputs retain source labels.

Display the observed or estimated perimeter separately from predicted future
extent, spread direction and spread rate at the chosen forecast horizon.
Expose the update time, uncertainty and environmental assumptions. New usable
observations refresh the shared model without resetting the chosen time horizon
or silently replacing manual scenario edits.

Associate observations by incident, drone and capture time before combining
views. Avoid counting repeated reports as independent evidence; retain conflicts
and unobserved areas. Keep the current spread model labeled illustrative until
a replacement has supporting validation. Gemini analysis and incident Q&A use
the same shared evidence and its limitations; they do not pilot aircraft.

## Scroll through drones in the existing drone area

Extend the existing main ANAFI camera/telemetry area into a scrollable fleet
view. Scrolling moves between drone cards/feeds; the fire forecast timeline
remains a separate control.

Each drone card shows its stable identity, assigned sector/role and flight phase,
its own camera input with capture clock and detection overlays, and matching
telemetry: position, altitude, speed, heading, camera orientation and battery
where available. Show connection/freshness state and whether it is observing,
descending, searching, ascending or holding.

Focusing a card highlights the same drone and camera footprint on the map.
Camera, telemetry, overlays and status must stay attached to the correct drone
while scrolling, reconnecting or receiving delayed results. A missing feed keeps
its identity and stale/unknown state; it must not silently show another drone's
picture or telemetry. Off-screen drones still contribute to the shared model.
Support one connected drone as well as multiple drones. Scroll orientation and
visible card count are layout decisions within the existing drone area.

## Intermittent perimeter person-search dives

"Dive" or "dive bomb" means a **controlled descent for observation**, followed
by a brief search and ascent, not an impact maneuver. Search along the perimeter
and adjacent exterior; the fire interior is not the search destination.

The intended mission phases are:

```text
PERIMETER_OBSERVATION -> SEARCH_ASSIGNED -> DESCENDING
-> PERIMETER_SEARCH -> ASCENDING -> PERIMETER_OBSERVATION
```

Searches occur at intermittent moments and may appear sporadic across the fleet.
Record a reason such as a sector revisit, coverage gap, candidate sighting or
operator request. Exact cadence and trigger policy remain configurable design
decisions; this specification does not prescribe a fixed interval or random
real-aircraft commands.

- Assign a particular drone and perimeter sector to each search. Record its
  reason, start/end times, phases and resulting observations.
- Coordinate with other drones to preserve fire coverage and avoid conflicting
  sector assignments or flight paths.
- Continue that drone's camera and telemetry stream during the descent/search.
  Attribute person observations to their source drone and capture time.
- Ascend and resume or hand back its perimeter sector after the search. Keep
  interruptions visible instead of marking an aborted search completed.
- Keep hold, abort and landing handling in the separately enabled flight runtime,
  with validated geometry, freshness, energy and movement limits.

All drones contribute to shared rescue leads. Agreeing views may strengthen a
lead, but camera track IDs are not identities or a count of distinct people.
Preserve location uncertainty, source views, delayed delivery and named human
acknowledgement/closure. Without usable synchronized pose, retain an unlocated
sighting without a map pin. A sighting does not itself dispatch responders or
command a maneuver.

## Data and implementation boundaries

- Carry stable `drone_id` and capture time through frames, telemetry, overlays,
  detector health, fire/person observations and flight events. Scope track and
  observation identifiers by drone/session to prevent collisions.
- Isolate latest state, freshness, stream buffers and asynchronous responses per
  drone. One connection loss must not clear another drone's state. Bound storage
  and connections as the fleet grows.
- Coordinate compatible API changes with [the bridge contract](docs/BRIDGE_CONTRACT.md)
  and all producers/consumers. Existing global camera/latest-state routes are
  not sufficient fleet isolation simply because telemetry has a drone identifier.
  Preserve the single-drone workflow during migration.
- Keep distinct ingest/dashboard authentication and server-side credentials.
  Maintain one SDK owner per aircraft; dashboard/Gemini remain observation and
  planning clients, with explicit flight enablement elsewhere.
- Keep live, simulated and historical evidence visibly separate. Fleet replay
  must use the same simulation clock for map positions, cameras, telemetry and
  dive phases, including when switching between drones.
- The older historical scout can enter the rendered fire footprint. Revise that
  legacy simulation for the fleet demo; it does not define perimeter search or
  establish real flight capability.
- Every teammate branches from updated `main`. `codex/autonomous-fire-response`
  remains excluded; this specification does not authorize merging its commits.

## Acceptance criteria and next work

1. Ingest at least two distinguishable mocked/simulated drones. Interleave and
   delay their frames, telemetry, overlays, health and observations without
   crossing identities or corrupting another drone's state.
2. Show those drones around one incident with sectors, coverage gaps and a shared
   observed perimeter. Refresh predictions with source labels and uncertainty
   while retaining the selected forecast horizon.
3. Scroll through the existing drone area and focus each drone on the map. Drop
   and reconnect one feed without changing another card's identity or content.
4. Demonstrate intermittent perimeter-only search descents with visible reasons
   and phases while other drones observe the fire. Test return/handback,
   coordination and hold/abort behavior with fake drivers and clocks.
5. Combine agreeing cross-drone person evidence into shared leads with uncertainty;
   retain unlocated sightings and named review actions without counting tracks
   as distinct people.
6. Preserve single-drone live operation and clearly labeled historical replay.
   Validate real multi-aircraft coordination and measured behavior in stages
   before claiming hardware support; a rendered demo is not flight evidence.

Implement per-drone ingest/state isolation first, then the scrollable fleet
view, combined perimeter/model inputs and simulated search coordination. Test
those paths with fixtures before extending the real flight runtime. Fleet size,
dive cadence, flight limits and prediction accuracy remain open engineering
decisions, not features delivered by this documentation.
