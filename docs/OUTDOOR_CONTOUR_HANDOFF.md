# Outdoor contour and resilient wind handoff

Task / owner: Outdoor 50 m fire contour, measured GPS map/trail and best-available
wind continuity / Codex, following the user's direct-main request.

Branch / commit: `main`; this handoff accompanies the implementation commit.

Changed files and behavior:

- `bridge/fire_contour.py`, `contour_search.py`, `fire_response.py`: Marker 2
  selects a 50 m nominal initial fire, scans at 1 m above launch, then physically
  follows the rolling five-minute GPS forecast. Separate outdoor movement limits
  leave circle defaults intact. The GPS accuracy gate now handles integer metre
  SDK fields honestly. A separate watchdog compares GPS with acknowledged aircraft
  displacement to catch a fresh but frozen position stream.
- `bridge/anafi_bridge.py`, `wind_measurement.py`: subscribe before probing FC
  capabilities; timestamp actual numerical wind events, distinguish capability
  from availability and preserve exact calm. SDK cache polling never refreshes
  a measurement. Classic warning enums remain independent of numerical wind.
- Wind loss is **not a takeoff or landing gate**. Keep the last usable measured
  wind, its original time and increasing age. If no usable measurement has been
  incorporated yet, use the exact QR baseline as a clearly labeled scenario
  assumption. Invalid/missing wind-provider data cannot cancel patrol; fresh
  valid wind automatically updates the plan again. Aircraft/GPS/lease/battery
  protections and physical envelope bounds remain.
- `backend/autonomy.mjs`, `contour-profile.mjs`: explicit profile plus immutable
  marker/scenario identity, matching raw wind and model inputs, separate
  `measured`/`stale`/`assumed` provenance. `server.mjs` keeps actual GPS provenance
  and missing-position gaps in the trail API, including database storage.
- `dist/app.js`, `contour.js`, `index.html`, dashboard CSS: actual GPS aircraft
  marker and recorded segmented trail; shared five-minute forecast with measured,
  stale or assumed wind labels. Stale wind keeps the forecast running. No fake
  18 km/h live reading, no simulated aircraft following the live route. One real
  drone is shown; fleet architecture remains frontend-only.
- README, shared context, bridge/mode guides and Windows deployment manifest
  describe the current workflow; the new wind helper ships in both installers.
- Preserved the concurrent `1fec62b` dashboard change: wind values display to one
  decimal place in Live, Replay, scenario controls and tooltips, with provenance
  retained and missing measurements still shown as unavailable.

Contracts or decisions changed:

- Profile `outdoor-50m-live-wind`; initial area `pi * 25² / 10000` hectares.
  Exact Tiny printed payload and original low-wind preview are unchanged.
- GPS events ≤1.5 s; conservative axis-quantization uncertainty ≤5 m. Search
  envelope 20 m; modeled contour radius 100 m; launch envelope 125 m. Search
  speed 0.5 m/s, patrol 0.5–1 m/s, commands ≤2 m. Patrol is 300× head growth
  speed within those limits; forecast time remains real time.
- Numerical wind is fresh for five seconds. Plan provenance is separate from
  the Live measurement metric. Missing measurements remain null; QR assumptions
  have no fabricated observation time. Temperature/RH/fuel/spread remain model
  assumptions. The existing fire model is illustrative, not field-calibrated.
- The original circular entry point, marker selection, speed limits and duration
  remain unchanged. Normal contour duration is operator-ended with protections;
  explicit short tests remain 60 seconds.

Checks run (including skips):

- Final `npm test`: **217 passed**, zero failures/skips.
- Final full local Python discovery: **424 tests, 291 passed, 133 SDK skips**.
- Before the temporary Pi disconnect: **109 tests passed on the installed Pi
  SDK**, no skips, using isolated temporary source and mocked aircraft. These
  verified protocol constructors/serialization, adapters, circle isolation and
  response integration. Later wind-continuity/GPS-watchdog changes were checked
  locally; a final complete SDK rerun remains pending reconnection.
- Browser refreshed and visually inspected: outdoor copy, unavailable live wind
  and actual-GPS waiting state render correctly. No flight control was clicked.
- Whitespace and Python syntax checks passed.

Hardware/cloud evidence (or not checked):

- No aircraft flight performed. Before unplugging, the disarmed receiver reported
  landed, no GPS fix and no numerical FC wind. The old probe read an uninitialized
  cached State; this did not establish that the hardware supports numerical wind.
- Classic documented wind warnings and video metadata are not numerical wind
  vectors. The corrected probe must be observed on the reconnected aircraft.
- The user confirmed the Pi was temporarily disconnected for handoff to a friend
  and will be connected to the computer for the outdoor test. No final receiver
  deployment or outdoor GPS/wind verification occurred while it was disconnected.

Open issue / next step:

- Reconnect the Pi, deploy/restart the current checkout while grounded using the
  existing launcher, and verify the receiver advertises this outdoor profile.
  Preserve the single SDK owner and default disarmed state.
- Check actual outdoor GPS lock/precision, numerical wind capability/events and
  full battery before the operator enables a clear, level outdoor course.
- Observe/record the real GPS trail against the model. Numerical wind support
  remains unverified; absent support is labeled and does not prevent the flight
  from using its explicit model assumption. A real external sensor would be
  needed to obtain measured wind if the aircraft does not expose it.
