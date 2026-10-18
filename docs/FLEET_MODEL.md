# Fleet wind consensus, formation and measured growth model

Design document for the `model/algo` branch. This specifies the algorithms that
fill the open decisions in [spec.md](../spec.md) (fleet size, wind aggregation,
formation geometry, growth-rate model). It redefines nothing in that
specification; where they overlap, spec.md wins. The live demo still flies one
drone — everything here degrades gracefully to a single aircraft, whose
estimates become the consensus.

## 1. Wind consensus: many drones, one vector

All fleet members fly at the **same altitude**, so the wind field is treated as
a single 2-D vector field sampled at N points — no vertical shear term is
modeled. If a future mission stratifies heights, the same machinery runs per
altitude band and the bands produce a shear profile; out of scope here.

### Inputs

Each drone `i` streams the flight controller's NED estimate
`w_i = (north_i, east_i)` m/s (the `flight_data.WindSpeed` event the bridge
already forwards as `extra.fc_wind_*`), plus:

- `t_i` — capture time of the estimate,
- `s_i` — flight state at capture (`hovering`, `flying`, …),
- `p_i` — position (for future spatial weighting and outlier context).

### Consensus algorithm (deterministic, single solution)

1. **Freshness weight.** `λ_i = exp(-(now - t_i) / τ)` with `τ = 30 s`. Stale
   estimates fade rather than flip a binary cutoff.
2. **Confidence weight.** `c_i`: hover/slow flight `1.0`, steady forward flight
   `0.7`, maneuvering (climb, turn, descend) `0.4`, landed `0`. The FC estimator
   is most confident in stable flight; this mirrors that.
3. **Iterative trimmed vector mean.** Start `W₀ = Σ λ_i c_i w_i / Σ λ_i c_i`.
   Then repeat (at most 5 iterations, always convergent because the accepted
   set can only shrink):
   - compute angular deviation `θ_i` between `w_i` and the current mean `W_k`;
   - reject `w_i` if `θ_i > 45°` **or** `‖w_i‖` is more than 3× the median
     magnitude — a drone inside a rotor-wash pocket, structure eddy, or a
     sensor fault should not drag the consensus;
   - recompute `W_{k+1}` over the accepted set only.
4. **Uncertainty, reported not hidden.** Directional spread
   `σ_dir = √(-2 · ln |mean of unit directions|)` (circular standard
   deviation) and magnitude spread `σ_mag = std(‖w_i‖)` accompany the
   consensus. High `σ_dir` means real spatial variation or a fault — the
   dashboard shows "wind field non-uniform" rather than pretending precision.

Output: `wind_consensus = { vector: W, speed_kmh, toward_deg, sigma_dir_deg,
sigma_mag_mps, samples: N, rejected: [drone_ids], computed_at }`.

With one drone the loop is a no-op: `W = w₁`, spreads `0`, `rejected = []`.

### Why this converges

A plain vector mean answers Terry's "summation of vectors" instinct and is the
optimal estimator under uniform noise. The trimming pass is the "reasoning that
converges to one solution" for disagreement: near-consensus vectors dominate
the mean, outliers are dropped by fixed criteria, and shrinking a finite set
terminates. It is deterministic — same inputs, same answer — and never leaves
the system without a single wind vector to feed the model.

## 2. Fire extent from the camera

Each scan produces a measured footprint, not just a confidence:

- The camera's ground footprint is the projective image of the 69° FOV at the
  drone's altitude, gimbal pitch and heading — a ground-truth quadrilateral
  ("the rectangular box"). Detection bounding boxes inside it are
  back-projected to a georeferenced fire region polygon.
- Fusing all drones' regions (union with capture-time weighting) yields
  `fire_extent`: the measured perimeter polygon with per-edge provenance and
  capture times. Stale edges are labeled; unobserved arcs stay unobserved
  rather than interpolated (spec: "retain conflicts and unobserved areas").
- From `fire_extent`: `area_ha`, centroid, and per-45°-sector boundary radius.
  Indoor rectangle or irregular outdoor shapes are all handled — the polygon
  is shape-free; the ellipse is only the fleet's *formation* geometry outdoors.

## 3. Measured growth rate (replaces the generic curve)

The complaint this fixes: the current model applies one weather-derived rate to
every fire — a UTSC fire would "reach STC in ~30 min", which is not physical.
The fleet fixes it with measurement:

1. **Sector-wise rate of spread.** Consecutive `fire_extent` snapshots give
   `ROS_s = Δ(radius_s)/Δt` per 45° sector `s` — this fire's actual head,
   flank and back rates, fit to `fire_extent` changes ≥ GPS noise (~2 m).
2. **Extrapolation.** `ROS_s` is advanced by the environment factor ratio:
   `ROS_s(new) = ROS_s(measured) · envFactor(current)/envFactor(at-measurement)`
   — weather still modulates the measured rate, so changing wind/humidity
   reshapes the projection without discarding the measurement.
3. **Fuel/infrastructure brakes.** Where a non-burnable surface (pavement,
   water, maintained lawn — from site data/OSM) crosses sector `s`,
   `ROS_s → ~0` with the blockage shown on the map. This is the "surrounding
   infrastructure/nature/materials" factor: the zone stops at the parking lot
   instead of washing over it.
4. **Cold start.** Before any second snapshot exists, the model uses the
   current illustrative curve (wind-convex head rate, 12% heel, L:W `1+w/35`)
   seeded by `wind_consensus` — labeled illustrative until ≥2 scans fit a
   measured rate, then the zone is labeled "measured perimeter fit".
5. **Validation.** The fitting path is scored against the nine documented
   fires in `examples/historical-fires.mjs` (projected vs. recorded final
   area, head distance, arrival times) so "evidence-based" has numbers behind
   it, not adjectives.

## 4. Formation: evenly spaced on the fire's contour

- **Indoors (wind ≈ 0):** drones space uniformly by arc length along the
  measured `fire_extent` polygon plus a standoff margin `d_safe` — circle,
  rectangle, whatever the real shape is.
- **Outdoors (wind > 0):** the formation is the footprint's **ellipse** (the
  wind-stretched projected perimeter), same center, drones evenly spaced by
  arc length along the contour. Even spacing on an ellipse: perimeter
  `C ≈ π(3(a+b) − √((3a+b)(a+3b)))` (Ramanujan II); station `k` sits at arc
  `s_k = k·C/N`, and its position is found by inverting the elliptic arc
  integral (Newton iteration on the eccentric anomaly — a few iterations,
  exact to cm at fire scales).
- **Same altitude for all** — the 2-D field assumption from §1.
- **Dynamic re-spacing:** as `fire_extent` updates, target stations shift.
  New assignments are matched to drones by Hungarian assignment (minimize
  total repositioning distance), so the fleet slides along the contour
  instead of churning.
- **Fleet size scales with severity** (Terry's rule): severity — from
  measured area, ROS, and proximity to people/infrastructure — maps to N:
  e.g. small/slow → 2 observing, growing → +1 per severity tier up to the
  fleet cap, plus drones dedicated to perimeter-search dives. Exact tiers
  are configuration, per spec.md.

## 5. Feeding the shared model and dashboard

- `wind_consensus` replaces the single-drone wind input to the spread model
  unchanged in shape — speed + direction + now an honest uncertainty.
- Sector ROS field drives per-sector growth: the projected zone is no longer
  one ellipse rate but a vector of rates per 45° arc; the UI still renders
  nested time-horizon bands from `model.js` math, now sector-varying.
- `fire_extent` renders as the measured perimeter (solid) distinct from the
  projected zone (dashed bands) — the spec's observed-vs-predicted separation.
- Severity tier drives the dispatch suggestion ("recommend +2 drones") —
  display-only in the single-drone demo.

## 6. Honesty and bounds

- One drone ⇒ consensus = its own estimate, fleet UI shows a single card;
  nothing claims fleet capability a solo demo doesn't have.
- Measured-vs-estimated-vs-scenario provenance stays on every number, per
  spec.md's evidence rules.
- `ROS` fitting never manufactures precision: fits require ≥2 snapshots and
  movement above GPS noise, otherwise the model stays labeled illustrative.
- Simulated drones (acceptance criterion 1) are labeled simulated in streams,
  map and model provenance.

## 7. Implementation order on this branch

1. `wind_consensus` aggregation (pure math + unit tests on synthetic fleets:
   unanimity, one-outlier, stale-sample weighting, opposite-vector failure).
2. `fire_extent` structure + camera-footprint projection (reusing the
   existing 69°-FOV/pitch geometry in `people.js`/`fire_location.py`).
3. Sector ROS fitting + env-factor extrapolation + fuel-brake table.
4. Formation math (ellipse arc spacing, Hungarian re-assignment) as pure
   functions; drone-count tiers as config.
5. Dashboard: consensus readout, sector zone rendering, measured-vs-illustrative
   label, fleet-size suggestion.
