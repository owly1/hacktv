# Pi observation receiver — shared AI handoff

Recorded 17 October 2026. This adds the grounded hardware work to the team's
existing application. It does not replace the team's dashboard, backend,
cloud-service verification or detection bridge.

## Source and deployment

- `bridge/anafi_observer.py` is the tested observation-only receiver. It polls
  telemetry at approximately 1 Hz and sends at most one 640-pixel-wide JPEG
  every two seconds. It has no flight controls or gimbal commands.
- `bridge/anafi_bridge.py` is the separate, pre-existing team implementation
  with detection and flight features. Do not confuse these two entry points.
- The current Pi service uses
  `/home/pet/emberwatch/bridge/anafi_observer.py`. Its wrapper now refers to
  this distinct filename. An earlier prototype deployment used
  `anafi_bridge.py`; that file is retained separately. Do not substitute the
  team's detection/flight bridge for the observation-only receiver.
- The Pi SDK lives at `/home/pet/emberwatch/sdk/olympe-8.5.0`. Use its setenv
  wrapper and isolated Python 3.11.16; the system Python is 3.13.

## Verified hardware path

```text
ANAFI Extended Wi-Fi
    -> Pi 4B / Olympe 8.5.0 / observation receiver
    -> authenticated ingest over loopback SSH reverse tunnel
    -> laptop backend -> authenticated dashboard camera and telemetry

Laptop Wi-Fi remains connected to the Internet.
```

The actual grounded test passed fresh telemetry, full JPEG decoding at
640 × 360, and visible real camera/telemetry in the local browser. Firmware
reported 1.8.2 / HW_03. SDK imports and I420/NV12 conversion passed separately.
The provided controller path and simultaneous controller connectivity were
not tested. There was no flight or fire-detection test.

Missing GPS sentinels remain null. Altitude is the SDK's height **above
takeoff**, not measured terrain clearance. SDK INFO event logging is
suppressed because settings events can include Wi-Fi credentials. Raw
captures, environment files, SSH keys and passwords are excluded from Git.

## Backend compatibility

The observer sends the existing `emberwatch.v1` telemetry shape and a JSON
JPEG envelope to `/api/ingest/snapshot`, using only `INGEST_TOKEN`. The team's
backend now gives this route the same camera-frame relay treatment as
`/api/ingest/frame`: latest snapshot, camera freshness and multipart viewers.
It accepts both the team's `jpeg_base64` envelope and the observer's
`data`/`mime_type`/`provenance` envelope; the latter requires explicit live
provenance and JPEG MIME type.
Empty detection overlays stay empty; an image is not treated as a fire
detection. No synthetic location, detection or replacement image is sent.

The Pi test used a local prototype backend at laptop port 8788, exposed as
Pi loopback port 8787. Its memory-only storage and missing cloud keys are a
description of that test instance. They do not supersede the separate team
Gemini/TigerData round-trip record in `VERIFIED.md`. The newly added relay
compatibility is tested against this repository's backend using isolated
fixtures; this integrated version has not been redeployed to the aircraft.
All 42 Node tests and both mocked observer tests pass after integration.

**Later actual-team-dashboard test, 15:43 UTC:** the Pi now sends raw JPEGs
with `--camera-transport frame` to the existing team backend's
`/api/ingest/frame`. The encrypted tunnel maps Pi loopback 8788 to laptop
loopback 8787. Fresh camera frames (approximately 0.5 fps) and telemetry were
read back from that backend, and the BOSCO camera panel visibly displayed
the actual image. Storage reported PostgreSQL and Gemini reported configured;
no new Gemini request was made during this camera test. This raw-frame mode
also works with the existing running backend before a snapshot-relay update
is restarted. The default `snapshot` transport remains available for the
earlier prototype. See `PI_CAMERA_TEST.md` for current start/test steps.

## Operating context

See `PI_RUNTIME_HANDOFF.md` for exact current machine paths, the tunnel and
start/stop instructions. The observation service was manually running and
disabled at boot. Keep the Pi/drone powered and the laptop awake with its
backend and SSH tunnel running for reception. Enter secrets locally only.

`PI4_SDK_BUILD_NOTES.md` records native ARM build adjustments and source hashes.
`EXECUTION_PLAN.md` and `SYSTEM_FLOW.md` preserve the original four-person,
36-hour reference plan and human-reviewed planning design; their product
scope differs from the team's later v2 application decisions.

The grounded receiver test establishes no fire forecast accuracy. Spread
illustrations, test markers and inferred outputs must remain distinguishable
from actual measured observations. Incident planning requires human review.
