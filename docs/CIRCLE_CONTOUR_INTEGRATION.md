# Circle and contour integration

Task / owner: Codex — merge both user-approved flight branches into `main`
and update the primary laptop checkout for subsequent recorded demos.

Branch / commit: `main`; merged `codex/circle` at `02a0717` and
`codex/fire-contour-mode` at `c0c1fb5` using merge commits that preserve both
histories. The primary checkout was initially clean; the separate circle
worktree was not modified.

Changed files and behavior:
- Retained circle's calibrated bearing feedback when QR metric depth is
  rejected, including the existing independent range/altitude gates.
- Retained the separate real Tiny contour flight, exact low-wind marker,
  GPS anchor, frontend action, forecast overlay and single-drone scope.
- Resolved the shared `fire_response.py` import conflict by retaining both
  sets of imports. The circle-only controller files and the contour-only
  controller are identical to their respective branch heads. Target updates
  retain circle bearing feedback before depth validation; the contour path
  still ignores QR updates after its initial anchor is claimed.

Contracts or decisions changed: no additional API, flight authorization,
motion limit, marker payload, GPS requirement or flight-mode behavior changes
beyond the two approved branches. Original Alpha and Tiny remain separate.
Source integration and pulling the laptop checkout do not deploy to the Pi.

Checks run (including skips):
- `npm test`: 202 passed, no failures or skips.
- `.venv/bin/python -m unittest discover -s tests -p '*_test.py'`: 382 tests;
  260 passed, 122 SDK-dependent checks skipped because Olympe is unavailable.
- Python compilation for the merged receiver and circle/contour controller
  modules, staged/unstaged whitespace checks and an independent merge audit
  passed. No conflict markers remain.
- Circle's camera helper, continuous controller and SDK movement adapter are
  byte-identical to `02a0717`; the pure contour controller and frontend contour
  helper are byte-identical to `c0c1fb5`.

Hardware/cloud evidence (or not checked): no aircraft connection, movement,
Pi deployment or new flight recording. SDK tests use mocked aircraft and skip
when the SDK is absent. Existing circle footage findings are documented in
[CIRCLE_TRACKING_TUNING.md](CIRCLE_TRACKING_TUNING.md); contour operating
requirements are in [FIRE_CONTOUR_MODE.md](FIRE_CONTOUR_MODE.md).

Open issue / next step: capture new circle and contour demonstrations after
the grounded deployment workflow. Preserve the matching local flight recordings
and diagnostic logs alongside external video so camera error, GPS/velocity,
command timing and model tracking can be compared. Contour still requires
reported GPS accuracy ≤0.5 m; no physical performance claim is made by this merge.
