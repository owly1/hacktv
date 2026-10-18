# Real-fire distance advisory

This guide describes the dashboard display. A separate [physical real-fire
controller](REAL_FIRE_FLIGHT.md) now commands outward retreat to maintain the
100 m estimated edge buffer when explicitly enabled and armed. The dashboard
itself remains unable to pilot.

The live dashboard displays a size-based distance recommendation for confirmed
RGB fire detections. The requested **100 m** is interpreted as a buffer from
the **estimated fire edge**, not a fixed distance from the centre.

```text
equivalent_radius_m = sqrt(observed_area_ha * 10000 / pi)
target_distance_from_centre_m = equivalent_radius_m + 100
edge_clearance_at_capture_m = camera_range_m - equivalent_radius_m
buffer_shortfall_at_capture_m = max(0, target_distance_from_centre_m - camera_range_m)
```

For example, an estimated 3.1416 ha circular fire has a radius of about 100 m.
Its centre-distance target is about 200 m. If the camera estimated a 150 m
range, the edge clearance at capture was about 50 m and the buffer shortfall
was about 50 m. A four-times-larger observed area produces about a 300 m
centre-distance target. Displayed target/shortfall values round upward to
whole metres; they do not imply metre-level measurement accuracy.

## Inputs and visibility

Use normal live monitoring and the installed RGB detector. No flight mode is
needed. The recommendation appears in the detected-fire conditions panel and
is included in exported incident briefs with its capture timestamp.

- Only real `yolo` / `fire` sightings qualify. QR tests, smoke-only sightings,
  historical Replay and configured demo-site anchors do not qualify.
- Both the laptop detector and direct aircraft bridge use the same flat-ground
  camera estimator for RGB location/area. They retain the captured pose and
  `area_source: camera-box-estimate`. Unknown camera orientation stays unknown;
  the RGB path does not substitute a guessed heading or camera pitch.
- Size estimation requires a timestamped pose within two seconds of the frame.
  Missing/invalid pose, no GPS fix, near-horizon geometry, range beyond the
  estimator's 500 m envelope and boxes touching the frame's 1% border do not
  produce physical area. A clipped box may represent only part of a larger fire.
- The advisory additionally requires live provenance, an explicit GPS fix,
  GPS-based camera location, and positive finite observed area. Observations
  expire after ten seconds. The panel refreshes freshness every second even
  if backend polling fails.
- Range, edge clearance and shortfall refer to the drone **at frame capture**.
  Missing range leaves those fields unknown rather than inventing a position.
  Shortfall never becomes negative or recommends moving toward a fire.
- Forecast horizon, manual weather controls and illustrative fire growth do
  not change this recommendation. A new usable observed area does.

## Meaning and limits

This is **display-only advice**. It sends no piloting commands and does not
change QR flight behavior. The area is a circular approximation derived from
the visible camera box, with altitude measured above takeoff and an assumed
flat ground plane. It is not a verified fire perimeter, a surveyed terrain
model or a calibrated thermal/heat-distance model. The 100 m buffer is the
operator-selected policy, not an established safe-flight clearance.

This display performs no automatic retreat, path planning or obstacle checking,
and offers no guarantee
that the chosen distance is reachable. The existing indoor QR flight mode
remains separately enabled and uses its bounded indoor scaling rule.

Implementation: `dist/fire-standoff.js` contains pure advice calculations;
`dist/app.js` renders and exports them. `bridge/fire_location.py` supplies the
shared camera estimate. No backend API fields or flight permissions changed.
