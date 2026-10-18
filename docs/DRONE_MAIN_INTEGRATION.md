# Working drone and main product integration

Task / owner: integrate the user's working autonomous drone into the shared
main product, preserving current UI, fleet replay and person-search features.

Branch / commit: working drone snapshot `c976cc2` from
`codex/autonomous-fire-response`, integrated with main `b994f4e`.

## Changed files and behavior

- Retained main's BOSCO home/dashboard, themes, fleet replay, spread model,
  person-search views, live overlays, incident APIs and source assets.
- Preserved the working continuous orbit, measured target geometry, QR scale,
  glare handling, inward camera aim, launch-relative height, correction
  progress checks and flight authorization/landing gates. The control modules
  come from the working branch; retained upstream docstrings do not alter them.
- Added the working Live Start BOSCO, LAND, camera-preview controls and owned
  session heartbeat to main's dashboard. Replay cannot enable the aircraft.
  Live people boxes remain visible alongside a tracked fire.
- Combined main's backend with the working autonomy endpoints and incident
  acknowledgement hook. Person/overlay evidence cannot authorize a fire flight.
- Kept main's flight-controller wind telemetry and observer person/geolocation
  support. The fire-response launcher selects `--flight-targets --no-people`,
  retaining the tested fire-only detector and asynchronous incident publishing;
  extra observer inference and overlay HTTP calls stay outside that target loop.
- Retained main's demo and vision commands, plus the working Mac startup and
  receiver ownership guards. Windows deployment now includes all local imports
  required by the new flight and detector modules.

## Contracts or decisions changed

The user explicitly reversed the prior instruction excluding the autonomous
branch from main. New work should start from updated main. Aircraft movement
still requires an explicit authorized session, fresh sensors and preflight
checks; ordinary startup and replay do not authorize flight. Height remains
above takeoff, not terrain clearance. QR gaps after initial lock do not
independently end a timed orbit. Corrections continue while measured progress
continues within the existing mission and no-progress limits.

## Checks run

- Full Node suite: 191 passed, no failures or skips.
- Browser: isolated Live → Replay → Live check, main fleet rendering and
  disabled aircraft Start during Replay; no browser console errors.
- Windows source manifest: all local Python imports resolve within the
  deployment bundle. No PowerShell or physical Windows execution performed.
- Final Python discovery: 352 tests, 238 passed locally and 114 SDK tests
  skipped because Olympe is unavailable on the Mac.
- Installed-SDK run before the final laptop-monitor isolation refinements:
  114 passed using fake aircraft, including the additive wind telemetry cases.
  All SDK test files and flight/control dependencies remained unchanged after
  that run. The final snapshot rerun was interrupted by Pi SSH loss, and one
  retry reported no route to host; it is not recorded as a completed rerun.
  The final monitor refinements are covered by the completed local suite.
- Preservation audit: 11 flight/control/authorization files are byte-identical
  to `c976cc2`; detector executable logic is identical with two main docstrings
  retained. All 768 files introduced by main are unchanged, and none of main's
  tracked files are missing. Merge markers and whitespace checks are clean.

## Hardware/cloud evidence and remaining work

The merge was prepared and tested in an isolated checkout. The original
working drone checkout, localhost receiver and deployed aircraft source were
not replaced or restarted by the merge. Unit tests and SDK tests use fake
aircraft; the merged application's physical flight has not been reverified.
The user's working flight and previous video investigations are documented in
[the reliability review](BOSCO_FLIGHT_RELIABILITY.md).

After updating a hardware checkout, stop its old receiver and confirm landing
before deploying the merged source. The normal installer retains its active
receiver guard. Main's real-camera person inference remains an observation
workflow; live fleet flight coordination is still outside this integration.
