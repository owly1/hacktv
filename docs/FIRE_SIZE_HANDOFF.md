# Fire size handoff

## Physical real-fire controller correction

Task / owner: Implement actual outward aircraft movement to maintain the
100 m real-fire edge buffer, retaining the scaled QR demo / Codex.

Branch / commit: `fire-size`; controller implementation commit containing
this section. Updated shared `origin/main` was merged before this extension.

Changed files and behavior:
- `real_fire_core.py`: conservative projected fire envelope, fixed 100 m edge
  buffer plus uncertainty/control margin, bounded outward steps, continuous
  growth response, fresh post-move feedback and one-use execution gates.
- `real_fire_driver.py`: acknowledged bounded movement and explicit physical
  stop/landing callbacks, independently testable without Olympe.
- `real_fire_bridge.py`: actual SDK motion/stop/landing bindings on one owned
  controller connection, real-event age checks, real camera projection,
  verified configuration/preflight, terminal arming and nonblocking reporting.
- False configuration/preflight examples and [flight guide](REAL_FIRE_FLIGHT.md).
  Existing launchers refuse a competing real-fire receiver. The mode is not
  included in the indoor demo menu and does not automatically take off.

Contracts or decisions changed: The user clarified that real-fire standoff
must physically move the aircraft, not only display advice. The dashboard
still cannot pilot. The selected QR still commands its separate 1.25 m scaled
radius sequence, never a 100 m retreat. Real-fire faults interrupt relative
movement and latch stopped; no automatic landing location is chosen near fire.
LAND remains an explicit operator action. Fire extent remains a camera/ground
model estimate, not a physically verified wildfire perimeter.

Checks run (including skips): 150 Node tests passed. New pure/controller and
fake-SDK adapter tests: 28 passed. Existing Python fire tests: 22 passed; QR
tests: 38 passed and 60 real-SDK-dependent checks skipped because Olympe is
unavailable. WSL Mac launcher tests: 14 passed. Python compilation, PowerShell
syntax and diff checks passed. New adapter tests exercise production wiring
with a fake SDK surface; they do not establish actual SDK/firmware compatibility.

Hardware/cloud evidence (or not checked): No aircraft connection, deployment,
motor command, real fire or physical flight validation. Existing services were
not changed. All command tests use a fake aircraft.

Open issue / next step: Stage SDK/firmware binding checks, zero-move stop and
controller override tests, surveyed camera/ground/error-bound checks and a
cleared flight-area trial before real execution. The controller cannot claim
100 m physical clearance outside its verified measurement/environment bounds.

## Real-fire advisory follow-up

Task / owner: Display real-fire distance advice with the user-selected 100 m
edge buffer / Codex.

Branch / commit: `fire-size`; follow-up commit containing this section.
Merged updated `origin/main` (including the team's fleet model work) into the
existing branch before extending it.

Changed files and behavior: `dist/fire-standoff.js` computes estimated fire
radius plus 100 m, and the dashboard displays/exports the target and buffer
shortfall at capture. Advice expires independently of backend polling. The
shared Python camera estimator now checks pose synchronization and clipped
boxes; the direct bridge uses that estimator and retains full pose/provenance.
The Pi copy list includes its shared estimator dependency.

Contracts or decisions changed: User chose display-only recommendations and
100 m, interpreted as distance from the estimated edge. No real-fire motion
commands or new API fields were added. QR flight behavior remains separate.
Missing size/pose, stale evidence, simulations and smoke cannot yield a numeric
real-fire advisory. Details and limitations: [REAL_FIRE_STANDOFF.md](REAL_FIRE_STANDOFF.md).

Checks run (including skips): 149 Node tests passed, including dashboard,
advisory and existing contract checks. Python fire tests: 22 passed. Python
QR checks: 98 collected, 38 passed and 60 Olympe-dependent tests skipped.
The new direct-bridge SDK adapter check is among the skips. Python compilation
and diff checks passed.

Hardware/cloud evidence (or not checked): No aircraft connection, deployment,
real flight or physical size/range validation. Tests use fixtures/mocked services.

Open issue / next step: Validate camera size/range estimates against measured
scenes. The circular/flat-ground assumption and operator-selected 100 m buffer
do not establish safe real-fire clearance. Automatic real-fire movement was
explicitly excluded from this follow-up.

## Original indoor QR implementation

Task / owner: Indoor QR fire-area-scaled retreat and orbit / Codex.

Branch / commit: `fire-size`; implementation commit containing this handoff.
Based on current `origin/main`; no excluded autonomous-response commits used.

Changed files and behavior:
- `bridge/qr_circle_core.py`: bounded area-to-radius policy and measured radial
  retreat before the existing single orbit. Pure fake-driver tests cover sizes,
  off-centre geometry, loss/staleness, cancellation and failed movement.
- `bridge/qr_auto_circle.py`: opt-in `--fire-size`, current QR area decoding,
  protocol/radius reporting, existing incident/execute/calibration/landing gates.
- Windows and Mac launchers: `QrFireSize` / `qr-fire-size` modes.
- Backend validation and contract tests: accept the precise new protocol/path/
  radius combination; reject altered area, incompatible radius or arbitrary QR.
- README and QR guides: setup, indoor distance rule, footprint and boundaries.

Contracts or decisions changed:
- New optional flight annotation `qr-fire-size` / `measured-marker`, radius
  1.25 m for the selected 120 ha QR. Backend/Pi must be updated together.
- Indoor formula: `min(1.5, 1 + 0.25 * sqrt(area_ha / 120))` metres from QR centre.
  No real-fire clearance claim. Other area values are unit-test fixtures only.
- Exact QR payload, `emberwatch.v1`, existing modes, flight gates, observation
  behavior, and the fleet mission specification are preserved.

Checks run (including skips):
- `npm ci` and `npm test`: 116 passed, none skipped.
- Python fire-size tests: 7 passed.
- Python `qr_*test.py`: 97 collected; 38 passed, 59 SDK-dependent tests skipped
  because Olympe is unavailable in the Windows Python environment.
- Python fire-marker tests: 3 passed, including the actual generated QR image.
- Mac launcher tests under WSL Ubuntu: 14 passed, no SSH or aircraft access.
- Python compilation, PowerShell launcher syntax and `git diff --check`: passed.

Hardware/cloud evidence (or not checked): No real aircraft connection, Pi
deployment, motor command or physical flight test was performed. Backend tests
use isolated fixtures. Expanded SDK adapter tests require the Olympe test
environment; they mock aircraft construction and must not open a radio.

Open issue / next step: Run the SDK adapter tests on a compatible SDK runtime,
then perform the measured calibration and physical preflight for the enlarged
footprint before an explicitly enabled live test. Multiple live QR sizes would
require a separate coordinated marker-contract change.
