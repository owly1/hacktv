# Circle tracking after depth rejection

Task / owner: fine-tune the working circle from the newest downloaded flights.

Branch / commit: `codex/circle`, based on main `554f499`.

## Recording evidence

Reviewed contact sheets and synchronized logs from `20261018T113332Z-0f0c448e`
and `20261018T113051Z-07a93899`. The visible QR moves out of frame even while
estimated radius stays near one metre. Latest flight completed reported laps
in 17.47 seconds (including another radius recovery) and 13.95 seconds.
Operator LAND ended both flights; the latest did not end from a circle timeout.

The latest flight loses metric corrections at +21.71 seconds; the preceding
flight loses them at +6.65 seconds. Respectively 44 and 42 detected frames fail
the existing 35 cm vertical consistency check. All 86 retain a usable calibrated
horizontal viewing direction. Gimbal pitch already uses that independent pixel
bearing, but body steering previously received only accepted metric targets.
It therefore ignored visible sideways error during depth rejection and used
velocity integration alone. The footage does not establish why the depth fit
itself disagrees with altitude, nor prove a particular velocity sensor bias.

The short `112826` recording reports emergency during motor ramp before any
orbit; it provides no evidence about circle tracking. `112344` is shorter and
contains radius recovery. Neither supersedes the two complete orbit recordings.
Raw videos, extracted frames and diagnostics remain untracked locally.

## Changed files and behavior

- `camera_search.py` exposes a calibrated unit NED pixel ray independent of QR
  size. Existing pitch aiming uses the same computation.
- `fire_response.py` retains a separate capture-time QR direction and rotated
  camera origin when depth fitting fails. Metric validity and its existing
  height consistency rejection remain separate and unchanged.
- `qr_orbit_bridge.py` supplies the latest bearing to the continuous controller.
- `continuous_orbit.py` uses each fresh bearing once, after a measured fire
  centre is locked. It corrects only aircraft position perpendicular to the
  viewing ray (25% residual, at most 8 cm per observation). The fixed fire
  centre, depth along the ray, height reference and measured lap travel are
  not rewritten by this correction. Camera direction uses capture-time NED
  directly, avoiding a second rotation through a delayed body heading.
- New regression coverage checks depth rejection, velocity bias, repeated laps,
  a three-second visual gap, stale/future/wrong-episode/invalid bearings,
  duplicate frames, and inability to start an orbit using bearing alone.

## Contracts or decisions changed

No UI or flight authorization changes. No new timeout, landing condition or
continuous-detection requirement. Existing launch-relative altitude, measured
radial recovery, speed limits and 15-second lap profile remain. The new bearing
path does not claim metric position and cannot authorize takeoff or initial
circle acquisition. Direction updates must be at most 0.8 seconds old and
agree within 30 degrees of the locked-location estimate. Camera origin is
included; stale, near-vertical and contradictory rays are ignored. New local
diagnostics distinguish bearing corrections/rejections from metric corrections.

## Checks run

- Full Node suite: 191 passed.
- Full Python discovery: 359 tests, 244 passed and 115 SDK-dependent tests
  skipped because Olympe is unavailable on this Mac. The final stronger
  three-lap assertions also passed in a focused rerun (5 tests).
- Existing continuous orbit suite plus initial bearing regressions: 40 passed.
- Independent delayed-physics regression, with 250 ms camera latency, 5 Hz
  telemetry and 4.5/2.5 cm/s NED velocity bias after metric depth rejection:
  maximum physical radius error after 10 seconds improves from 1.747 m to
  0.220 m. With bearing feedback, physical laps finish in 14.553, 12.312 and
  12.213 seconds; maximum heading error is 10.17 degrees. These are synthetic
  test measurements, not predictions or results from a new aircraft flight.

## Hardware evidence / remaining work

The Pi is unreachable over SSH, so this branch has not been deployed or flown.
The source is isolated in the attached managed checkout, preserving the other
active task's `codex/fire-contour-mode` checkout and existing localhost process.
Run the installed-SDK mock suite and a new flight recording after deployment.
Verify `continuous_bearing_corrected` appears when metric depth is rejected,
and compare the real QR's image position and circle radius. Bearing feedback
constrains sideways drift; it does not independently measure range or resolve
all camera calibration, odometry or long visual-loss errors.
