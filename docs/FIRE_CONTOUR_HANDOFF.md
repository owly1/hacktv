# Contour mode handoff

Task / owner: Codex — add a separate real single-aircraft forecast-contour
flight mode, a nearly stationary Tiny fire QR, and frontend Pi/fleet framing.

Branch / commit: `codex/fire-contour-mode`; feature commit recorded in Git.

Changed files and behavior:
- `bridge/fire_contour.py`, `fire_response.py`: real takeoff → GPS-guided
  `OlympeOrbitDriver.move` → SDK `extended_move_by` → confirmed landing. Uses
  a frozen initial measured marker-area anchor, then no ongoing QR tracking.
  Default/omitted mode retains the existing circular controller.
- `backend/autonomy.mjs`, `validation.mjs`: explicit per-session mode,
  compatible capability gates, exact Tiny claims and matching incident identity,
  bounded contour status, and reporting phase. No fleet backend was added.
- Detector/monitor/contrast helpers: both exact QR identities, separate tracking
  caches and episodes, no cached-template authorization of another marker.
- Marker generator/source/print pages: Tiny is 1 m², wind 0.2 km/h, spread
  0.01 m/min; original Alpha payload and PNG are unchanged.
- Dashboard/model/CSS: separate physical contour action, actual mission overlay,
  optional aircraft-free preview, and Pi hub/future fleet architecture copy with
  one live demo drone. Existing replay fleet remains independent.
- Windows installer includes the new controller module; Mac automatically
  bundles it. README, shared context and contract link the new operating guide.

Contracts or decisions changed:
- `emberwatch.v1` remains compatible. `mode` defaults to `circle`; `contour`
  must be selected explicitly and cannot change within a session.
- Only the exact Tiny scenario is eligible for the bounded contour flight.
  The original Alpha remains available for circular response. Tiny's earlier
  higher-wind development payload is rejected.
- Model uses real elapsed time and the existing 72-point geometry with uniform
  fuel; preview/timeline/replay controls cannot steer flight. Tiny patrols at
  0.05 m/s while modeled head growth is only 1 cm/min.
- GPS location must be received within 1.5 s, with reported horizontal accuracy
  ≤0.5 m. No home/scenario/commanded-position substitute is accepted. Initial
  metric QR geometry must be physically verified; this path does not infer a
  metre-scale anchor from an unscaled bearing.
- The same sole aircraft owner retains battery, sensor, control watchdog,
  launch-relative altitude, movement acknowledgement and landing gates.

Checks run (including skips):
- `npm test`: 202 passed, no failures or skips.
- `.venv/bin/python -m unittest discover -s tests -p '*_test.py'`:
  375 tests, 254 passed, 121 skipped because Olympe is unavailable locally.
- Final contour-specific suite: 9 passed, 6 SDK tests skipped. Fake measured
  movement completes more than two laps within 0.08 m of the evolving forecast;
  all 72 Python/browser vertices agree within 0.01 mm. Tests include GPS loss,
  GPS jump, expired session during command, poor preflight data and time limit.
- Isolated browser server: distinct disabled flight actions without receiver,
  Tiny preview rendering and correct marker link, existing fleet Replay,
  Replay flight isolation, and no browser warning/error logs observed.
- `git diff --check`, Python compilation and unchanged original Alpha PNG /
  `dist/vendor` checks passed. The initial geometry test harness had a Node
  module-export mistake; it was fixed and the complete suite rerun successfully.

Hardware/cloud evidence (or not checked): no aircraft connection, takeoff,
Pi deployment, real GPS measurement or physical flight performed. SDK tests
are supplied but skipped in this Mac environment. No storage/cloud integration
changed or exercised. Browser verification used a separate local memory server
with no receiver and no real credentials.

Open issue / next step: physical validation remains necessary after deploying
to the existing receiver while grounded. Ordinary ANAFI GPS, especially indoors,
may fail the 0.5 m gate; this work does not add precision-GPS hardware or claim
the metre-scale course is physically demonstrated. See
[FIRE_CONTOUR_MODE.md](FIRE_CONTOUR_MODE.md) for operating bounds and print setup.
