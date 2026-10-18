# BOSCO flight reliability review — 18 October 2026

This review repairs the software on `codex/autonomous-fire-response`. It does
not certify a physical flight. No aircraft connection, session enablement,
takeoff or movement was used to validate these changes.

## Glare, launch-box height and blocked retreat — flight 20261018T110714Z

The latest flight landed because initial radial alignment timed out, not
because it exceeded a height limit. Continuous control started at +18.367 s,
with the QR only 0.528 m away. The desired ring is 1 m, so the correct initial
movement was about 0.47 m backward. At +23.861 s the controller aborted with
`Inward radius correction did not settle within 5.36051 seconds`; the radius
had reached about 0.857 m and no tangential orbit had begun. There was no
aircraft emergency event, and the aircraft subsequently confirmed landing.

An unconditional outward-speed brake contradicted that approach. Whenever
outward speed exceeded 0.15 m/s, it replaced the desired -0.2 m/s radial
velocity with zero, even while the aircraft was still too close to the QR.
Pitch therefore alternated between backing away and braking about once per
second. A lagging visual range-rate estimate could also oppose that intended
initial approach. The repair uses the signed radius error for initial
approach and retains the outward-divergence checks during later recovery.

Following the requested removal of arbitrary maneuver deadlines, the timed
hardware path can wait for valid metric acquisition within the active mission
instead of aborting after 15 seconds. Once a physical target is locked, a QR
gap does not independently end the flight; fresh motion continues to update
its relative geometry and camera aim. Initial camera reacquisition likewise
continues while the session and sensor data remain valid. Short image-motion
extrapolation still expires, because an old image is not a fresh measurement.
Operator LAND, battery, flight budget and stale flight-control data still stop
the response. The legacy untimed polygon checkout retains its own behavior.
Radius correction now uses a rolling progress check rather than a five-second
completion deadline: at least 4 cm of both radius-error reduction and measured
radial travel renews the attempt. An actual five-second stall still ends the
correction; visual position jumps alone cannot renew it. Likewise, real angular
progress keeps a slower orbit running without requiring 20 degrees in every
five-second window. The 15-second lap remains the commanded target, not an
automatic landing deadline. Initial stable ring dwell counts toward that lap's
schedule; later recovery does not create a speed burst to catch up.

The requested height reference is already the active one: the ANAFI SDK's
`AltitudeChanged` reports height above takeoff. `AltitudeAboveGroundChanged`
is a separate event and is not used by this controller. During continuous
control, measured altitude stayed 0.965–1.009 m. A 30 cm launch box therefore
does not call for adding or subtracting 30 cm from this altitude: that would
apply the offset twice. QR height below the aircraft has a separate measured
vertical anchor, so a target or floor below the launch surface is permitted.
Negative altitudes in this recording occurred only after the landing command.
This confirms the reference used by the software, not independent physical
height accuracy. See the [Parrot altitude event documentation](https://developer.parrot.com/docs/olympe/arsdkng_ardrone3_piloting.html#olympe.messages.ardrone3.PilotingState.AltitudeChanged).

The video also shows the QR leaving the frame during ascent and returning
under strong screen glare. Recognition was delayed until about +17.45 s,
and metric scale was not ready until +17.946 s. Candidate-region enlargement
and local contrast can recover exact payload decodes from some earlier
frames. Completely washed-out modules still cannot be reconstructed reliably;
these are rejected rather than treated as a new sighting. Tilting the display
away from the reflected overhead light remains useful for those frames.
On an identical 5 Hz replay of the full recording, exact decodes increased
from 14 to 56; post-climb reacquisition improved from 15.80 to 11.78 seconds.
Mean QR processing fell from 93.7 to 82.8 ms, with p95 131.7 ms. Candidate
crops are bounded, coordinates map back to original camera pixels, and the
full-frame contrast retry is throttled. Fixtures include an unreadable glare
frame and a different QR payload, both of which must remain rejected.
Small successful decodes also fit their exact decoded modules against the
original grayscale image before metric pose estimation. This addresses an
inaccurate inferred fourth corner found by the full pixel-to-flight simulation:
its corner error fell from 4.7 to 0.62 pixels without relaxing pose assertions.

Regression cases cover a 30 cm launch box, floors dropping farther below it,
QR targets at different elevations, a 22-second acquisition wait, a 23-second
visual gap after lock, slow progressing approaches lasting over six seconds,
and motionless/visual-only false progress. Glare comparisons and original
recording evidence are under `anafi_out/glare-audit-110714.local/` and
`anafi_out/flight-110714-audit.local.json`.

Final discovery ran 341 tests: 229 passed locally and 112 SDK tests were
skipped locally, then all 112 passed against the installed Pi SDK with fake
aircraft. Both full pixel-to-flight simulations pass. The transferred source
matched the worktree and remained unchanged during SDK verification.
The seven changed bridge files were deployed through the existing installer
guard after checking response OFF, no mission, disconnected aircraft and the
prior confirmed landing. All 28 deployed bridge Python hashes match the
tested worktree. The receiver supervisor was restarted in the project virtual
environment; localhost is running, autonomy remains OFF and the aircraft is
currently disconnected. Logs, source manifests, the previous-source backup
and runtime status are in `anafi_out/glare-height-*.local.*`.

## Inward tracking and stale camera fallback — flight 20261018T105541Z

The newest flight never entered continuous orbit. Its single alignment command
requested 14.28 degrees of clockwise body yaw and measured 13.28 degrees; the
QR's horizontal bearing improved from 14.28 to 0.41 degrees. The video shows
the QR dropping below the frame, rather than a reversed yaw response.

At +9.132 seconds the last measured QR position was (0.626, 0.004, 0.871) m.
The alignment memory still held (1.098, 0.011, 0.836) m. Its 0.35 m acceptance
gate rejected the 0.473 m disagreement. When recent visual pitch prediction
expired, camera demand jumped upward from -62.35 to -39.36 degrees at +9.826 s,
using the stale memory. It remained there until the existing visual-presence
timeout. This is a concrete camera and handoff failure, not evidence to reverse
the SDK body-axis signs.

The timed hardware path now enters continuous feedback immediately after a
fresh measured target and settled hover are acquired. The controller corrects
radius and altitude while updating inward body yaw every 50 ms; it no longer
uses the blocking relative alignment move or its predicted-position gate.
The fixed 3D target, optional later QR corrections, inward recovery attempt,
and repeated 15-second lap profile remain in place. Body yaw keeps the nose
toward the centre; gimbal pitch keeps the camera aimed down at the target.
Body pitch and roll still control translation and are not inverted.
For initially distant targets, approach has a distance-based allowance at the
0.2 m/s radial speed cap, bounded to 15 seconds. That allowance is consumed
once; any later divergence still has the existing five-second recovery limit.

Camera fallback now retains a newer valid metric sighting when old alignment
memory disagrees. During continuous movement it uses current propagated
coordinates, so an old image cannot override live geometry. Capture time
remains separate from the time the model coordinates were updated; neither
can fabricate a new sighting or renew the presence timeout.

The preceding two recordings also never reached orbit: 105231 lost metric QR
acquisition, and 105039 entered emergency during motor ramp. The current
repair targets the evidenced 105541 failure. Physical flight remains unverified.

Validation includes independent entry simulations for the recorded
1.1965 m / 14.28-degree start, a 0.626 m
start, and both yaw-wrap directions with QR absent during alignment. They
establish inward heading and ring radius before completing three simulated
laps, each within 15 seconds after alignment. No control gains were changed.
Far starts at 2 m and 3 m align in 5.6 s and 10.7 s, then complete three
simulated laps each under 15 seconds. Stationary far starts exhaust their
finite 8 s / 13 s approach allowances; a later divergence retains five seconds.
Final full discovery passed 313 tests (204 local passes and 109 SDK skips).
All 109 skipped tests then passed against the installed Pi SDK with fake
aircraft, using the exact final source snapshot. No tests failed.

`fire_tracking.py`, `fire_response.py` and `continuous_orbit.py` were deployed after confirming
response OFF, no mission, disconnected aircraft, and the prior confirmed
landing. All 27 deployed bridge Python hashes matched the worktree. The
receiver supervisor was restarted with the project virtual environment;
localhost remains available, autonomy remains OFF, and aircraft Wi-Fi is
required before the receiver can connect. Evidence and validation logs are
under `anafi_out/inward-aim-*.local.*`.

## Outward spiral and corrective cone model — flight 20261018T103406Z

The next recording shows an outward spiral while the QR remains visible.
The camera repair and altitude feedback worked: altitude remained near 1 m.
Continuous movement began at +14.301 s; the speed/height guard aborted it at
+18.115 s and the aircraft reported emergency at +19.118 s. The video shows
the QR receding before that abort. This is a failed physical flight, despite
the preceding simulation results.

The orbit handoff was already wrong: propagated radius was 0.901 m with almost
zero bearing, while the fresh visual radius was about 0.718 m with a 15-degree
bearing. Together with vertical error, this consumed almost the entire 0.30 m
allowed centre correction. The correction reached that clamp 2.284 seconds
into the circle. Later valid observations were limited or ignored. At nearly
the same timestamp, vision measured 1.858 m while the controller believed
1.138 m. Neither the internal radius check nor the speed check corrected that
disagreement in time. Evidence is in `anafi_out/collision-audit.local.json`;
video samples are in `anafi_out/collision-contact.local.jpg`.

The replacement locks one measured 3D fire point in the local coordinate
frame. A horizontal ring at the planned height, with aircraft heading and
camera pitch directed toward that point, defines the requested cone motion.
Fresh received velocity and attitude propagate aircraft position between QR
sightings; continuous QR visibility is not required. Later consistent visual
measurements correct the estimated aircraft position rather than moving the
fire point. The cumulative 30 cm correction clamp is removed. Large returning
corrections use a time-based consistency/trend check, including moving drift
and camera rates from 5 to 20 Hz, instead of being silently discarded.

Outward drift starts an active correction: lateral orbit demand drops to zero,
velocity feedback brakes outward motion, and radial motion steers toward the
ring at up to 0.2 m/s. After the radius and motion settle, orbiting resumes.
Initial alignment similarly establishes the radius before timed rotation.
Every short alignment move now waits for a fresh measured pose, so delayed
frames cannot turn displacement error into a false handoff. Timing does not
accelerate to make up time spent correcting. There is no new instantaneous
measured-radius stop; an unsuccessful five-second correction attempt ends the
mission. Existing LAND/session, sensor freshness, speed, altitude, battery,
flight-duration and 15-second visual-presence limits still apply.

The SDK signs and percentage mappings agree with Parrot's documentation and
installed Olympe source; no sign reversal was justified. The failed recording
did not preserve raw NED velocity, and video timestamps represent decoded-frame
receipt rather than independently measured exposure time. Those limitations
prevent identifying one exact sensor/dynamics error from this flight. New
recording events preserve each received motion vector, full attitude, individual
sensor timestamps and every control command for the next comparison.

Regression coverage includes the recorded outward sequence, biased startup,
QR gaps, returned QR data at different rates, and a correction-only input that
cannot fabricate lap completion. All 32 normal dynamics variations complete
three physical simulated laps, each within 15 seconds (slowest 14.964 s).
Three outward-impulse cases return to the ring and complete three laps. Four
severe velocity/exposure-time corruption cases attempt correction, then fail
within its five-second bound; they are not successful-flight simulations.
The corrected model remains unverified on the aircraft. Results are saved in
`anafi_out/collision-simulation.local.json` and
`anafi_out/collision-recovery-simulation.local.json`.

Validation: full local discovery ran 303 tests successfully, with 106 SDK tests
skipped on macOS; all 106 then passed against the installed Pi SDK with fake
aircraft. The tested source manifest matched all transferred files. Deployment
replaced only `continuous_orbit.py`, `fire_tracking.py` and `qr_orbit_bridge.py`
after confirming response OFF, no mission and a disconnected aircraft. All
27 bridge Python hashes matched afterward. The supervisor restarted disabled;
aircraft receiver startup is waiting because the drone Wi-Fi network is
unavailable. Localhost remained running. No physical test flight was launched. Logs,
rollback source archive and deployment/runtime records are under
`anafi_out/collision-*.local.*`.

## Continuous repeated circles — flight 20261018T102028Z

The next flight confirms the downward camera repair: it reacquired the QR,
measured its scale at +7.254 s, and began circling at +15.803 s. The QR stayed
visible. It aborted at +25.157 s because altitude exceeded the existing
1.0 ± 0.2 m band. Nine acknowledged movements accumulated 19.6 cm of upward
displacement while every request specified zero vertical change.

Only five circle chords completed: 54.58 degrees of actual travel over
8.59 seconds, roughly a 57-second lap at that rate. Each 26 cm command took
1.37–2.24 seconds because `extended_move_by` stops at its endpoint. Raising
its maximum speed cannot make 24 such starts/stops fit in 15 seconds. The
former ideal timing test omitted this firmware behavior.

Timed BOSCO orbits now hand off from bounded alignment moves to a continuous
20 Hz velocity controller. It follows the one-metre circle, corrects measured
altitude throughout, and turns the aircraft toward the QR. Desired translation
remains bounded by 0.6 m/s. The controller schedules repeated laps against the
15-second target, with a small acceleration margin; it counts lap completion
from measured translational sweep, never from yaw alone or elapsed time.
`orbit_lap_completed` diagnostics record each measured duration.

The SDK adapter acknowledges explicit tilt/yaw/vertical-speed settings before
mapping control percentages to them. Each piloting command has a 0.20-second
lease in the installed Olympe SDK. A stalled worker therefore expires to
neutral. Every exit neutralizes commands; LAND latches out further commands
and sends neutral before landing. Original settings are restored only after
the existing fresh, upright, stationary landed confirmation.

The flight also exposed a latency bug: requiring a frame newer than each
completed move, then waiting only 50 ms, discarded ordinary 200–350 ms delayed
camera observations. The continuous controller keeps received-motion history,
projects each distinct QR measurement at its capture time, and applies bounded
centre corrections. Camera prediction does not renew visual presence. Existing
LAND/session, battery, tilt, speed, altitude and absence guards remain active.

The independent dynamics regression models finite acceleration, drag, delayed
motion/video, and upward drift. Its lap assertions use the simulated aircraft's
actual world position around a fixed QR. Simulation timing does not establish
that a hardware lap meets 15 seconds; the new per-lap recording is the physical
verification point. Latest-flight evidence is preserved in
`anafi_out/continuous-orbit-flight-audit.local.json`.

All 32 combinations of initial radius/heading, video delay, drag and tilt
response completed three physical simulated laps, each within 15 seconds;
the slowest was 14.950 seconds. Baseline laps were 14.785, 14.678 and 14.676
seconds. These runs include 5 Hz motion samples, video delays up to 350 ms,
finite acceleration and upward drift. Separate cases exercise target outliers,
temporary visual loss, stale telemetry, LAND, an initially incorrect radius,
and yaw without translation. The controller predicts velocity only from the
speed sample's own timestamp, independent of altitude/attitude updates.
Results are saved in `anafi_out/continuous-orbit-simulation.local.json`.

Validation: 187 local Python tests and 103 mocked tests against the installed
Pi SDK passed. Full discovery ran 289 tests, including 103 SDK skips on macOS;
after the final callback-timing fix, all 10 continuous-control tests passed,
including its new regression. The SDK suite was rerun against the final source
in an isolated directory, with aircraft creation blocked. Logs and tested source
hashes are saved under `anafi_out/continuous-orbit-*.local.*`.

Deployment: autonomous response was OFF, no mission was active, and the
aircraft was disconnected before the old supervisor was stopped. Replaced
only `continuous_orbit.py`, `fire_tracking.py` and `qr_orbit_bridge.py`; all
27 bridge Python files matched the worktree by SHA-256. The new supervisor
and receiver started successfully with response OFF. The dashboard remains
at `http://127.0.0.1:8787/`; the receiver is waiting for the aircraft connection.
No physical test flight was launched.

SDK percentage directions and the positive-gaz/landing interaction were checked
against [Parrot's piloting reference](https://developer.parrot.com/docs/olympe/arsdkng_ardrone3_piloting.html).
The finite command lease was checked against the installed Olympe 8.5 source.

## Takeoff camera deadlock — prior flight 20261018T100712Z

Reviewing all 13 downloaded recordings (8,498 indexed frames, 311.7 seconds)
found no flight that reached the circle phase. The five newest flights issued
no movement commands. Their lack of a circle therefore cannot be diagnosed
by changing the circle's direction or radius.

In the latest recording the last QR observation occurs at +2.860 s, with a
capture-time altitude of 0.165 m. At +3.015 s localization loses the QR; at
+3.276 s the final camera command requests −27.284°. The camera remains there
through hover until the +17.679 s visual-loss abort. The aircraft climbs at
approximately 0.92 m/s in the recorded telemetry, despite the 0.3 m/s setting.
The auto-takeoff command cannot be assumed to obey that setting.

The adaptive camera branch expired its bearing prediction after 0.8 s, then
returned no aim command. Scale acquisition required the QR to be visible
across at least 0.5 m of measured climb; losing the QR before that point left
both camera recovery and horizontal movement blocked. The camera hardware
does reach roughly −75° in the earlier 09:43 recording. That recording's
scale rejection is already resolved by the existing bounded rough fit;
replay acquires it at +5.042 s. No further scale threshold relaxation was
needed for this repair.

`AcquisitionAim` now searches downward at 15 degrees/s after the visual
prediction expires, within the supported pitch bounds and the existing
initial 15-second acquisition period. It requires an active mission, fresh
altitude/camera telemetry, measured climb, and no horizontal movement. The
climb reference persists from the first observation so a loss just before
hover cannot disable recovery. Fresh image bearings immediately resume
tracking. Search never creates a metric target or renews fire presence.
Pixel aiming and grounded camera alignment also remain available when
metric PnP fails. `camera_acquisition` events record tracking/search/hold
transitions for the next flight review.

The new rendered integration regression includes a tilted QR screen,
250 ms image delay, 1 m/s takeoff, finite gimbal speed, and loss during ascent.
It compares the former stalled camera behavior against reacquisition, actual
PnP, adaptive size measurement, and the real orbit controller with measured
movement undershoot. These are software checks, not a successful physical lap.

Validation for this repair: 175 local Python tests, 96 mocked Pi SDK tests,
and 120 Node tests passed. The Python discovery includes those 96 SDK tests
as skips on macOS; they were separately run in an isolated Pi directory with
aircraft factories blocked. The rendered recovery regression passes for two
target geometries and reproduces the old failure without the new search.

Deployment: with autonomous response OFF and the receiver reporting the
aircraft disconnected, its supervisor was gracefully stopped. Only
`camera_search.py` and `fire_response.py` were replaced on the Pi; all 26
bridge Python files then matched the local worktree by SHA-256. The receiver
supervisor was restarted in its normal disabled mode. No takeoff was launched.
Logs and source hashes are in `anafi_out/camera-recovery-*.local.*` and
`anafi_out/orbit-audit-sdk.local.log`.

The per-flight audit and visual contact sheets are saved locally under
`anafi_out/flight-diagnosis-20261018.local.json` and
`anafi_out/flight-diagnosis-20261018/`. Exact latest-flight evidence is in its
`events.jsonl` lines 38–42 and 51–65. Earlier sections below describe previous
revisions; their passing tests did not establish that this takeoff-to-orbit
transition worked on the aircraft.

## What the recordings establish

Flight `20261018T083913Z-14d36e50` reached approximately 1.05–1.13 m above launch,
lost usable QR localization, and requested landing at 9.51 s. There was **no
horizontal movement request**. It was therefore not a failed circle command.
Later telemetry records roughly 78° roll, then emergency and an inverted
aircraft. The old final “landed” message was incorrect. The recording alone
does not establish the exact contact or physical damage.

The preceding flight exposed a separate problem: a successful short SDK move
stopped approximately 9.8 cm short, exceeding the old 8 cm endpoint rule.
The measured-fire controller now accepts bounded undershoot and corrects
from the newly observed target after each move.

## Repairs and runtime contract

| Area | Behavior |
| --- | --- |
| Authorization | Starts OFF. The owning dashboard must acknowledge its session with a heartbeat before a mission can be claimed. A restart cannot resume an old flight authorization. |
| Network interruptions | A transient HTTP timeout retries the existing authorization. Receiver control has a bounded 3 s grace period; the dashboard heartbeat expires after 5 s. A failed LAND request stops heartbeat renewal immediately. |
| Detector throughput | RGB predictor warm-up finishes before detector readiness; its CPU thread budget is restored after initialization. Incident/database work runs separately from fresh target delivery. Video timestamps come from the decoded-frame callback, before queueing and conversion. |
| QR continuity | Fresh image evidence can continue a previously decoded, already claimed QR when decoding fails. Whole-pattern, data-cell and module-identity checks reject unrelated QR codes. This continuation cannot authorize a new incident or flight. |
| Pose timing | QR projection uses nearby received altitude, aircraft attitude and gimbal samples, interpolating bounded timestamps. A recent SDK cache read cannot manufacture fresh telemetry. |
| Calibration | Intrinsics and camera offset remain fixed. QR scale is estimated from independently measured vertical travel, then frozen for that flight. Camera profile changes invalidate geometry. No arbitrary 20 cm correction is applied. |
| Grounded acquisition | Five stable fresh bearings/positions over 0.8 s are required before launch. A single good decode cannot freeze the mission reference. QR bearings authorize vertical acquisition; horizontal movement requires trusted metric scale. |
| Ascent | Before scale is known, the camera follows fresh visual bearings. After scale is established, synchronized metric target and altitude measurements support bounded feed-forward aiming. Neither can substitute for a fresh orbit position. |
| Recovery | Missing or inconsistent targets cause bounded stationary reacquisition: 10 s for initial acquisition, 8 s after a move. Five coherent fresh observations over 0.8 s establish the initial target; three over 0.3 s confirm recovery after movement. |
| Movement | The controller uses actual SDK displacement and a new observed position for its next step. Along-path undershoot may be up to 15 cm; lateral error and overshoot remain limited to 8 cm. Three consecutive moves with less than 20% progress stop the mission. |
| Circles | The radius remains 1 m. Lap progress comes from measured swept angle rather than counting commands; repeated circles remain subject to LAND, battery, connection and flight-time limits. |
| Landing | Sending Landing or completing an SDK expectation is not proof of landing. Confirmation requires a fresh landed state and advancing, upright, stationary telemetry for 0.5 s. Emergency remains a latched failure. |
| Recording | Flight records include requested/actual moves, recovery phases, target corners, synchronized pose samples, calibration hash, camera profile and scale disagreement. Emergency overrides an incorrect landed claim in derived reviews. |
| Deployment | Installing receiver source is refused while a flight receiver is running. Normal startup preserves native camera resolution for calibrated localization. |

The height setting remains **1 m above launch**, not above every surface below
the aircraft. The firmware owns initial takeoff height/rate. The requested
vertical-speed setting does not prove a specific physical takeoff rate.
Normal limits remain 40% battery and 300 s. The explicitly selected short-test
profile requires 30% to start, lands below 25%, and has a 60 s cap.

Real RGB classification and rectangles exist, but autonomous RGB movement
requires verified geometry and a fresh measurable target before takeoff.
A classification result alone does not supply distance. The current local
ground-plane configuration is unverified; QR success must not be described
as proof of generic fire localization.

## Calibration and recorded-video evidence

Refitting the 39 saved checkerboard observations reproduced the active
1280 × 720 calibration, with RMS reprojection error **0.344 px**. Leave-one-out
validation had median **0.286 px**, maximum **0.731 px**; focal length varied
approximately 3.2%. These results support internal image consistency, not an
unmeasured physical marker size or a changed zoom/crop.

At the 5 Hz detector cadence, the revised detector recovered 8 of 27 usable
hover observations from the latest flight, versus zero with the baseline.
That included five consecutive observations over 0.87 s. The preceding
undershoot flight improved from 16/20 to 18/20. An independent 180-case
identity experiment accepted zero of 170 wrong-code cases and 8/10 approved
code cases. Another 40 alternate-payload/scale cases also had zero matches.

The normal RGB fallback had a 751 ms cold-start spike on the first missed QR
during ascent. Predictor warm-up now runs before monitor readiness. Replaying
46 frames through the actual warmed QR + RGB detector on this Mac took median
121 ms, 95th percentile 151 ms, maximum 159 ms. All frames fit within the 200 ms
detector interval in that run; network transport is not included. Torch stayed
at two CPU threads throughout, without per-frame thread resets.

**The former fixed-width assumption was inconsistent with the recording.** Approximate
reconstruction puts the recovered marker 44–50 cm farther below the aircraft
than its grounded position plus climb predicts. The template polygon follows
the visible outer QR boundary. The video appears to show a phone, whereas
the configured 12 cm width came from the earlier iPad measurement. Its real
size cannot be determined from the photograph.

Normal BOSCO now estimates QR size automatically during vertical acquisition.
It fits the observed camera-relative QR translation against independently
measured altitude, accounting for the rotated camera offset. At least 0.5 m
of vertical travel, six distinct frames, three consistent observations at each
height extreme, 80% inliers, residuals below 5 cm and bounded slope uncertainty
are required. Horizontal movement remains blocked until the fit is trusted.
The QR must remain stationary during acquisition. The accepted scale is frozen
for that flight; another explicit session estimates the new display size.

The camera calibration stays unchanged. The old QR width is only a numerical
reference in PnP and cancels during normalization; it is not treated as the
current display's physical size in adaptive mode. Ideal synthetic tests recover
6, 12 and 25 cm QR widths at different target heights through real PnP projection.

The old flight lacks full synchronized gimbal/aircraft history, so this
reconstruction is diagnostic rather than exact. The original camera profile
was also not recorded. The new code logs and checks the session profile,
but cannot retroactively prove it matches the old calibration. Adaptive scale
does not repair incorrect intrinsics, moving targets or unsynchronized sensors.
Its physical flight performance remains unverified. Saved intrinsics and the
measured 8 cm forward camera offset have not been altered.

## Verification and local evidence

### Fifteen-second fire memory and lap target — subsequent revision

The reviewed latest recording is `20261018T094339Z-32b88b0b`. It contains 74
target-tracking events and no horizontal movement command. The QR returned
after a brief loss, but its perspective-derived scale disagreed with the
recorded climb throughout hover. This was a localization failure, not fifteen
seconds without a fire sighting. Recorded altitude peaked at 1.02 m; physical
height remains unverified because of the operator's earlier conflicting report.

For an already claimed mission, the new backend reports fire presence until
15 consecutive seconds after the last matching exact decode or independently
verified template sighting. Missing frames do not renew that timestamp;
optical flow alone cannot keep presence alive indefinitely. Once one valid
metric centre is available in hover, the response controller propagates it
through actual SDK displacement and yaw, continuing the circle between
sightings. Fresh coherent positions correct it; conflicting locations stop
movement. The camera can aim at the propagated position during visual gaps.

Normal response startup selects a 15-second lap target with bounded speed
adjustment (maximum 0.6 m/s translation and 45 degrees/s yaw). The mission
time, altitude, tilt, landing and connection checks remain active. Command
latency, acceleration and corrections can make a physical lap slower; the
simulation is not proof of a hardware timing guarantee. Legacy modes retain
their former speed limits.

Independent motion tests complete multiple 1 m-radius circles with one
sighting every 14 seconds, preserve the centre under 10% movement undershoot,
expire presence during movement without renewing it from odometry, and
complete an ideal measured revolution within 15 seconds. The operator rejected
an assumed one-metre target distance, so no guessed centre or fixed QR size was
introduced to bypass the latest localization failure.

These changes are saved locally and tested in a separate SDK test directory.
They have **not** replaced the running receiver or backend. No receiver stop,
restart, live-source deployment or flight command was performed for this
revision, as requested. The initial localization issue remains unresolved.

### Follow-up camera correction — flight 20261018T093128Z-7f6a8c66

The camera followed the marker from 0° to approximately −16°, then stopped
receiving aim commands after the marker was lost during ascent. Grounded
search had also frozen the gimbal on detection without centering the marker.
The revised controller centers the QR before claiming takeoff, derives camera
aim directly from calibrated image coordinates and actual camera attitude,
and briefly predicts observed angular motion through processing latency.
Prediction expires after 0.8 s and extrapolates at most 0.25 s; it never supplies
an orbit position. There is no fixed downward reacquisition sweep. The focused
follow-up suites passed 38 mocked SDK tests and six camera tests.

The operator reports an approximately 3 m rise from a pillow on the floor,
while the recorded altitude peaks at approximately 1.09 m above launch. These
disagree; the telemetry does not independently prove physical height. The
requested height remains 1 m above takeoff. Physical height control remains
unverified, and the receiver was stopped with autonomous response OFF.
This follow-up does not claim to have repaired the altitude discrepancy.

Final automated results: **119 backend/dashboard tests, 158 local Python tests,
and 91 SDK tests passed**. The local Python discovery reports 249 total with
91 SDK skips; those 91 were run separately in the Pi SDK. No tests failed.
Updated receiver source was copied to this Mac's Pi directory. Localhost was
restarted with `EMBERWATCH_RECEIVER=off`; no receiver or authorized session
was started during the audit.

Run the local suites with:

```sh
npm test
.venv/bin/python -m unittest discover -s tests -p '*_test.py'
```

SDK tests use the provisioned Pi's Olympe environment in an isolated test
directory, with aircraft factories mocked to reject radio access. Relevant
regressions cover two measured laps with repeated undershoot, target loss and
recovery, outliers, stale/replayed frames, calibration changes, camera profile
changes, landing/emergency, session races and deployment ownership.

Rendered-image integration tests complete a circle with targets at launch level
and 0.8 m below launch, including 10 cm movement undershoot and temporary
occlusion. Those simulations start airborne; separate adaptive-acquisition
tests verify scale estimation during ascent. All 29 deployed bridge source
files match the local worktree by hash.

Local audit artifacts are preserved under `anafi_out/` (not committed):

- `calibration-audit.local.json`
- `incident-detector-final.local.json` and `undershoot-detector-final.local.json`
- `qr-template-independent-identity.local.json`
- `incident-detector-yolo-warmed-timing.local.json`
- `incident-approximate-vertical-audit.local.json`
- `incident-template-polygon-detail.local.png`
- `flight-audit-node.local.log`, `flight-audit-python.local.log`, `flight-audit-sdk.local.log`
- Original recordings and `review.json` under `flights/`.

Detector replays verify image processing, not radio latency, real-world range,
mechanical condition, collision clearance or successful physical flight.

SDK semantics checked against the official Parrot documentation:
[relative movement](https://developer.parrot.com/docs/olympe/arsdkng_move.html),
[landing and altitude](https://developer.parrot.com/docs/olympe/arsdkng_ardrone3_piloting.html),
and [camera profile/zoom](https://developer.parrot.com/docs/olympe/arsdkng_camera.html).


## Bounded rough-centre response — 2026-10-18

The response now enables `AdaptiveQRScale(rough=True)`: the full observation
history must support the fit, but the permitted observed residual is 20 cm
and the scale uncertainty limit is 25%. Three sustained observations at both
measured heights and at least 0.5 m of reported climb are still required.
This uses camera geometry and measured travel; it does not assume that the
marker is one metre away or require another ruler measurement. Fit uncertainty
includes empirical disagreement rather than only statistical fit precision.

During the remembered-target orbit, moderate measurement changes are blended
at 20%, limited to 5 cm per update and 30 cm total displacement from the initial
measured centre propagated through actual SDK movement. Isolated inconsistent
poses no longer terminate the orbit. Matching visual evidence alone renews the
15-second presence window; odometry does not. Radius remains 1 m, target height
remains 1 m above takeoff, and the lap duration target remains 15 seconds, with
bounded speeds rather than a guaranteed physical completion time.

Replaying flight `20261018T094339Z-32b88b0b` acquires the approximate scale at
5.04 seconds (16.95% uncertainty, 16.85 cm maximum fit residual). All 50 recorded
positions from acquisition until the landing transition pass the frozen-scale
position checks; the five subsequent rejected samples occur during landing.
The old strict estimator never acquires a fit. This replay establishes a fix
for the observed localization blocker, not ground-truth position accuracy or
proof that the actual aircraft completes a circle. The reported physical
height discrepancy remains unresolved and is not disproved by its telemetry.
Local replay details: `anafi_out/rough-orbit-replay.local.json`.

Validation: 120 Node tests, 169 local Python tests and 93 mocked SDK tests pass.
The SDK tests run in the isolated Pi audit directory with aircraft factories
blocked. Simulations include repeated circles with 28 cm measurement jitter,
large outliers, persistent bias, movement undershoot and 15-second absence.

Deployment: the new source was installed only after the deployment guard
confirmed no active Pi flight receiver process. The independently running Mac
receiver supervisor (PID 68660) was not stopped or restarted. It will use the
updated source on its next natural drone connection. The local backend and
local vision worker were refreshed separately; the backend reports the new
presence contract with autonomous response OFF. No flight was launched.
