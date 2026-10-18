Task / owner: Combined QR-circle and D-triggered measured person search / Codex

Branch / commit: `codex/qr-dive-combined`, integrated with fetched
`origin/main` 22dd9a4, retaining its outdoor contour and wind updates. Earlier dirty
`codex/operator-stop-flight` and `dive-surveilance` worktrees were preserved.

Changed files and behavior: new combined Python receiver queues D onto the
existing QR mission worker. Orbit neutralization/stop-piloting and camera
release precede descent. Search uses measured bounded movement, real person
inference per view, measured height/camera return and fresh QR reacquisition.
The Node backend adds authenticated leased dive APIs and a COCO-SSD worker
separate from HTTP/control. Live dashboard adds D, detector health, sightings
and X; normal standalone observation and GPS contour receivers remain separate.

Contracts or decisions changed: compatible `emberwatch.v1` additions at
`/api/dive`, `/api/commands` and `/api/ingest/dive/status`; `/api/dive` advertises
`workflow: qr-circle-dive-v1`. Original QR flight authorization remains
required alongside the D lease. New flight phases: dive, surveil, hovering.
Until-stop requires normal battery reserve. Height remains above takeoff.
Search observations are camera counts, not unique people or geographic fixes.

Checks run after latest-main integration: 231 passing Node tests (serial), plus
2 launcher compatibility tests; the new launcher/runtime/HTTP subset passed 6/6.
57 Python tests passed: 17 fire tracking, 17 fire monitor, 10 dive/controller/
SDK-adapter fakes, 5 combined orchestration and 8 wind measurement tests.
Existing Olympe SDK suite: 133 skipped because Olympe is unavailable on Windows.
PowerShell parsing, Bash syntax and whitespace checks. Actual Edge rendering:
offline D disabled, input/keyboard guards, zero browser errors. Actual model
worker inference on QR-only JPEG: zero detections, about 5.3 seconds including
loading, 85 independent 50-ms event-loop ticks during it.

Hardware/cloud evidence (or not checked): model weights were downloaded and
real CPU inference executed. No real-person accuracy evaluation, aircraft
connection, Pi deployment, takeoff, descent or landing test. Production port
8787 and existing hardware runtime were not restarted. Work remained files-only.

Open issue / next step: user should follow QR_CIRCLE_DIVE.md when physically
present. Do not claim software tests establish aircraft behavior. The new
receiver needs supervised hardware verification of pause/hover, sensor event
cadence, every measured move, camera ownership, person views, return and LAND.
