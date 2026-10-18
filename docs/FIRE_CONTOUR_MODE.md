# Outdoor fire forecast contour

The Live dashboard has separate actions. **Start BOSCO** retains the existing
circular response. **Take off & search · 1 m** selects the explicit
`outdoor-50m-live-wind` profile. LAND stops either flight. Startup and Replay
never authorize flight; one dashboard lease and one SDK owner control one drone.

## Marker and scenario

Print [Marker 2 PDF](../dist/tiny-marker.pdf), served at `/tiny-marker.pdf`, at
actual size: its black QR square is 18 cm across and must match the verified
camera calibration. Its exact payload remains:

```text
EW1:Tiny|0.0001|L|0.01|G|0.2|60|22|45|18
```

The outdoor profile uses that identity to select a **50 m nominal initial fire
diameter** (`area_ha = pi × 25² / 10000`). It does not enlarge the physical QR.
The printed Tiny scenario and no-flight preview still describe a 1 m² fire,
0.2 km/h wind and 0.01 m/min head spread. Alpha and circular flight are unchanged.
Only the two exact allowlisted markers are accepted.

## Actual flight and model

1. The receiver requires fresh actual GPS and the inherited aircraft protections.
   Wind capability/availability is reported separately and never blocks takeoff.
   SDK imports or a generic wind warning are not evidence of numerical wind.
2. After enable is acknowledged by the owning dashboard, one drone takes off and
   establishes 1 m measured height **above launch**, not terrain clearance. It
   searches GPS waypoints at ±10 m, inside a 20 m launch envelope, at 0.5 m/s.
3. Seeing Marker 2 pauses movement for five stable, fresh measured QR positions.
   Capture-time heading, actual GPS and calibrated QR geometry locate the fire
   area. It claims the contour using the best available wind input. The original
   launch point remains the envelope origin.
4. The fire claim fixes the marker identity, simulated area, model epoch and
   GPS anchor. Fresh received FC vector events are preferred; the last usable
   measured value is retained across wind dropouts. If none has ever arrived, the
   original 0.2 km/h toward 60° QR wind is explicitly an unmeasured assumption.
   Temperature (22°C), RH (45%), fuel and baseline spread (0.01 m/min at encoded
   conditions) remain explicitly simulated assumptions.
5. Each movement watchdog updates the immutable plan from the best available
   wind. Missing, stale or invalid new wind retains the prior plan input and marks
   degraded quality; fresh valid estimates automatically restore measured mode.
   Python and browser use the same 72-vertex uniform-fuel model, at five minutes
   plus real elapsed mission time. Wind changes scale spread relative to the
   original baseline and change outline orientation/shape. No timeline control
   or replay animation can alter the flight. QR visibility is no longer needed.

The existing spread formula is illustrative, not a calibrated wildfire forecast.
The onboard wind value is an aircraft estimate, not an anemometer measurement;
no altitude correction or uncalibrated tilt formula is substituted. Directions
point **toward**, clockwise from north. Exact calm has no measured direction;
zero is used only as the mathematical orientation of a calm model.

Tangential patrol speed is 300× modeled head-growth speed, bounded to 0.5–1 m/s
for this outdoor demonstration. That multiplier affects traversal only, not fire
expansion or the forecast clock. Moves are capped at 2 m, use received GPS/heading
and acknowledged aircraft motion, and replan with an accuracy-scaled lookahead.
This is GPS-feedback aircraft movement, not frontend animation.

## Position, wind and protection gates

- GPS events must be ≤1.5 s old, fixed and valid. ARSDK reports integer metre
  accuracy per axis; conservative uncertainty is `hypot(lat_accuracy+1,
  lon_accuracy+1)`, and must be ≤5 m. Unknown/-1 accuracy is rejected. Zero
  components do not imply perfect accuracy. The old ≤0.5 m rule could never be
  satisfied by these integer fields and is no longer the outdoor requirement.
- The fire anchor must be within 20 m of launch. The modeled contour stays within
  100 m of that anchor and actual aircraft position within 125 m of launch.
  These bounds require a correspondingly clear outdoor test area; the model
  supplies no obstacle avoidance. Altitude remains 1 m above launch.
- Numerical wind is accepted only with a device availability report and an
  actual vector event received within five seconds. Polling a cached value never
  refreshes its age. Missing/stale wind, unsupported capability, or model inputs
  outside 0–60 km/h leave the last valid model wind unchanged. Before any valid
  measured wind, use the clearly labeled QR assumption, never a made-up reading.
  Actual wind telemetry remains null when unavailable; no default 18 km/h is used.
- Wind loss alone never blocks the flight attempt or lands the drone. GPS loss,
  lease expiry, unhealthy
  sensors, motion failures, battery protection or LAND interrupts movement and
  requests landing. Normal contour has no duration timer. The explicit short
  test remains 60 seconds including search, with its original battery gates.
  Normal start/in-flight battery minimum remains 40%; circle retains 300 seconds.

## Screenshare and provenance

The Live map draws the current aircraft marker from fresh actual GPS only. A
stale fix hides the current marker and leaves a clear stale status. The blue
trail contains received GPS records and breaks at missing/unverified positions,
source changes or time gaps; it is never drawn from commanded or predicted motion.
The fire marker and cyan five-minute outline use the receiver's frozen GPS
anchor and exact current model inputs. The outline redraws when measured wind
changes and keeps growing from the retained input during dropouts. Live wind
displays the fresh numerical FC estimate or unavailable; the plan separately
shows last measured wind with age/degraded status, or the explicit QR assumption.
Replay retains its separate scenario display.

The frontend describes the Raspberry Pi as a possible fleet hub but reports
**one real aircraft**. No second aircraft, fleet ingest or fleet controller is
implemented by this change.

## Deployment and verification

Follow the existing [Mac](MAC_SETUP.md) or Pi/Windows workflow. Do not replace
files under a running flight receiver. The Mac bundle picks up Python modules;
the Windows manifest includes `wind_measurement.py`. Keep one connection owner.
Run `npm test` and `.venv/bin/python -m unittest discover -s tests -p '*_test.py'`.
SDK checks mock aircraft; local SDK skips must be reported separately. See the
[outdoor handoff](OUTDOOR_CONTOUR_HANDOFF.md) for evidence and remaining hardware
checks. Software tests do not establish actual GPS lock, wind support or flight.
