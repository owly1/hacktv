# Team handoff: QR flight branch versus main

Prepared 17 October 2026. Code reviewed: `feat/qr-orbit-rehearsal` at
`9200d24`, compared with remote `main` at `cd5689e`. These are the code
snapshots before this documentation update. Start with [explain_max.md](explain_max.md)
for the beginner introduction.

## What this branch adds

This branch adds a separate, terminal-controlled QR flight experiment to the
existing BOSCO/Emberwatch dashboard and Pi receiver. It has four code commits
beyond main, changing 36 files: 4,376 insertions and 27 deletions before these
handoff documents. It does not replace the backend, database schema, map or
Gemini implementation on main.

| Commit | Main addition |
|---|---|
| `1e7b6d0` | Grounded QR recognition and simulated orbit rehearsal; separate opt-in measured orbit code |
| `6e909e1` | Camera calibration preparation and staged checkout documentation |
| `270da08` | Direct Pi hover checkout, terminal landing input, controller camera relay and integrated QR checkout |
| `9200d24` | Calibration-free QR-triggered preset circle and nearby hover |

## Current demo behavior

The chosen route is **QrPreset**, documented in
[docs/QR_PRESET_DEMO.md](docs/QR_PRESET_DEMO.md). Default operation is rehearsal:
recognition has no flight driver. Real flight requires both `-Execute` and
typing `ARM QR PRESET` in the interactive terminal. Five fresh observations
of the selected QR, spanning at least 0.8 seconds after arming, trigger one
takeoff. The arming window expires after 20 seconds.

The requested path is a 1 m-radius circle made of 12 straight segments, at
about 1 m altitude and 0.25 m/s, followed by a nearby hover. The operator places
the intended circle center 1 m ahead of the launch point and aligns the nose.
The nominal path reaches 2 m forward and 1 m either side of launch. It ends
near the starting hover. Aircraft dimensions, drift and clearance are additional.

**QR recognition is a trigger, not object tracking.** The code does not measure
the object's distance, center the circle on a visible object, avoid obstacles,
or move over it. Calibration is unnecessary for this preset precisely because
the operator establishes the geometry. The earlier proposed 0.5 m start offset
does not match this preset.

X/Esc without Enter, `LAND` + Enter and Ctrl+C request a controlled landing.
The nearby hover times out after 30 seconds; the entire flight has a
90-second cap. Minimum battery is 40%; freshness, flight state, height, speed,
tilt and movement acknowledgments are checked. Landing is not an instantaneous
motor cutoff, and a broken radio link can prevent delivery of the request.
The terminal reports an error if touchdown is not confirmed. Each process
allows one armed attempt; restarting is required for another.

## Integration and file ownership

```text
ANAFI camera + state
    -> Pi Wi-Fi / one Olympe SDK connection
    -> QR recognition + explicitly armed preset controller
    -> authenticated HTTP through Pi Ethernet / laptop SSH tunnel
    -> Node backend on laptop :8787
    -> browser video, telemetry and flight phase display

Laptop Internet -> Gemini analysis and TigerData
Terminal landing input -> same Pi SDK connection -> Landing request
```

| Files | Responsibility |
|---|---|
| `bridge/qr_preset_demo.py`, `qr_preset_core.py` | Current recognition trigger, takeoff orchestration, relative circle and bounded hover |
| `bridge/hover_checkout.py`, `terminal_controls.py` | Short hover checkout and immediate terminal landing input |
| `bridge/qr_orbit_core.py`, `qr_orbit_bridge.py`, `qr_orbit_pose.py`, `qr_takeoff_demo.py` | Shared checks and the older, separate measured-pose flight modes |
| `bridge/qr_orbit_rehearsal.py`, `qr-orbit-rehearsal.html` | Laptop recognition/path preview on port 8789; simulated flight only |
| `bridge/calibrate_camera.py`, `calibration-board.html`, example JSON files | Optional measured-mode preparation; examples are not real calibration or acceptance records |
| `bridge/rtsp_camera_relay.mjs`, `scripts/Start-ControllerCamera.ps1` | Camera-only Skycontroller USB route using FFmpeg; does not control flight |
| `scripts/Start-HoverCheckout.ps1` | Selects a Pi mode, checks the local backend and manages the reverse tunnel |
| `scripts/Install-QrDemo.ps1` | Copies source to the Pi's separate QR directory; starts no receiver or flight |
| `bridge/anafi_bridge.py`, `anafi_observer.py` | SDK/controller selection, compatible publication and configurable video sizing |
| `tests/*qr*.py`, `terminal_controls_test.py`, `calibration_test.py` | Recognition, control, fault, calibration and terminal checks with fake aircraft drivers |

The existing `emberwatch.v1` interface remains in use: ingest uses
`INGEST_TOKEN`; browser reads use `DASHBOARD_TOKEN`. Frame publication feeds
`/api/video` and `/api/snapshot`, and telemetry/flight events populate their
existing endpoints. The preset hover uses the existing `return` phase, so
there is no new backend phase/schema to deploy. Indoor GPS can remain unknown.
Gemini, TigerData, browser buttons and QR scenario values cannot command flight.

## What has actually been verified

- Real grounded ANAFI -> Pi -> laptop video and telemetry reception.
- Skycontroller 3 -> Windows USB network -> live camera relay; the user
  confirmed camera tilt still worked while viewing this camera route.
- Grounded printed-QR recognition and a simulated orbit preview.
- One direct Pi takeoff, short hover near 0.96 m, and automatic landing,
  confirmed by the user. This did not test horizontal movement.
- All 67 Python checks passed in the installed Olympe environment with real
  aircraft constructors guarded and fake drivers, as recorded in the flight
  guides. Those are software checks, not 67 physical flight tests.

**Still unverified:** a real preset circle, the X-key landing during real
flight, accurate object-relative orbiting, and calibrated pose flight. The
user reported automatic landing in the successful hover test; do not record
that as an X-key pass. Native-size publication has code coverage but still
needs a fresh hardware video check. Existing cloud-service proof is recorded
in [docs/VERIFIED.md](docs/VERIFIED.md); configuration alone does not prove
today's Gemini or TigerData connection.

## Run and test from the correct checkout

For a new laptop, first provision Node 22+, local `.env`, the Pi SDK, SSH trust
and aircraft Wi-Fi; see [docs/PI_RUNTIME_HANDOFF.md](docs/PI_RUNTIME_HANDOFF.md).
The scripts contain the current team's Pi username/address and expect its
provisioned SSH files. Merely cloning the repository does not provision a Pi.

From **this repository's root**, start the backend in one terminal:

```powershell
npm install
# Only for a new checkout without .env: Copy-Item .env.example .env
# Fill in local tokens and cloud settings before starting.
npm start
```

Open <http://127.0.0.1:8787/> with Replay off. On the already provisioned
laptop, connect Pi Ethernet and power the grounded aircraft. Keep the
Skycontroller off for the direct Pi flight route. In a second terminal:

```powershell
# Optional deployment after source changes; copies only, starts no flight:
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-QrDemo.ps1

# Reception and QR rehearsal only:
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-HoverCheckout.ps1 -Mode QrPreset
```

Print the selected marker from <http://127.0.0.1:8787/test-marker.html>, type
`ARM QR PRESET`, and confirm `REHEARSAL ONLY`. Stop this receiver before
starting another. For the physical acceptance sequence, use
[docs/TERMINAL_FLIGHT_TEST.md](docs/TERMINAL_FLIGHT_TEST.md) to verify X during
the short hover first, then follow the live steps in the preset guide. The
live preset command adds `-Execute`; do not add it to an automatic startup.
The normal Start BOSCO observer, controller camera route and flight program
are different modes; do not start competing aircraft receivers.

## Immediate next work and merge notes

1. **Drone teammate:** physically verify X landing in the short hover checkout;
   then verify one preset circle in the reported clear 10 x 10 x 10 m area.
   Record measured path, height, endpoint, response and landing result. Stop
   treating the demo as tested if these checks fail.
2. **Maxim / integration teammate:** run recognition rehearsal and trace one
   fresh image through the backend into the browser. Check advancing evidence
   timestamps, not just a last cached picture. `npm test` covers backend
   contracts with fake cloud/drone services; SDK tests need the documented
   Python/Olympe environment.
3. **Backend / AI teammate:** verify one current Gemini response and one
   TigerData insert/readback with local credentials. Review generated plans
   as human-reviewed drafts. Keep simulation and live evidence distinct.
4. **Release teammate:** integrate `democases` and `person-search` separately
   after review. Neither branch's new features are included in this QR branch.
   They also touch bridge/dashboard/backend files, so retest contracts when
   combining them. Keep the older `--demo-flight` path separate from QrPreset.

The running copy at `C:\Users\anshi\Desktop\drone` is a separate checkout
with local history and local configuration. Its modified/untracked files are
not silently included here. The Git source for this handoff is the clone at
`C:\Users\anshi\Documents\Codex\2026-10-16\referenced-chatgpt-conversation-this-is-an-3\hacktv`.
Do not reset the running copy or overwrite its `.env` to synchronize branches.
Older README/context status paragraphs describe earlier stages; this dated
handoff and the current preset guide describe the selected QR mode.

No credentials, SSH private keys, captures or real calibration/preflight
records belong in Git. This update documents branch contents; it does not
merge feature code into main or alter the Pi's running services.
