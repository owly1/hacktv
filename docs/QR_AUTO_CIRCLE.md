# Automatic QR fire circle

For a QR that simply selects the autonomous demo preset, use
[QR_AUTO_DEMO.md](QR_AUTO_DEMO.md). That mode needs no QR-size measurement or
camera calibration. This document describes the separate measured-marker orbit.

Included in `main`. This is a separate, opt-in flight runtime;
`npm start`, the historical Replay button and the ordinary observation receiver
continue to receive data without launching the aircraft.

With this mode explicitly started using `--execute`, the selected QR needs no
additional arm phrase or dashboard click. The sequence is:

1. Decode the selected EW1 fire QR on five distinct fresh frames spanning at
   least 0.8 seconds. Only this physical camera stream counts.
2. Submit a `qr-test` / `fire` detection to the normal backend. Wait for its
   accepted incident ID. Automatic Gemini analysis follows the existing fire
   pipeline; a slow or unavailable Gemini service does not control the motors.
3. Recheck the grounded aircraft, current physical preflight and fresh QR,
   then take off once on the existing SDK connection.
4. At the approximately one-metre hover, acquire five consistent calibrated
   poses of the QR on the launch floor. Allow five seconds, then land if the
   pose is unavailable. No horizontal search is performed.
5. Correct at most 35 cm to the one-metre radius, then travel once around the
   measured marker using 24 short chords. Every segment uses a new measured
   pose, followed by a fresh centered hover observation. Body yaw faces the
   marker; gimbal pitch tracks it five times per second. This is a polygonal
   approximation to a circle, not a continuous curved SDK motion command.
6. Land and require an actual landed event. The process exits after confirmed
   landing. Another scan, reconnect or power cycle cannot repeat that mission;
   restart the flight session deliberately to run again.

**Radius is 1 metre; diameter is 2 metres.** Nominal height is 1 metre above the
launch floor; takeoff height is firmware controlled. Position feedback accepts
up to 18 cm forward error and 15 cm lateral error at segment endpoints. These
are software limits, not a claim of measured real-world accuracy.

## Physical setup

Use the selected `bridge/orbit-marker.txt` payload, printed with the black QR
square size recorded in the calibration. Put it flat on the launch floor about
one metre in front of the grounded drone, visible to its camera. A QR on a
vertical laptop screen is sufficient for fire-classification testing, but does
not supply the floor geometry needed for this orbit.

Use measured camera intrinsics at the exact decoded video size, measured QR
size and camera offset, and verified gimbal axes. Follow the calibration and
physical landing checks in [the cold-start guide](QR_DEMO_FROM_OFF.md). The
zero-focal-length calibration template is deliberately unusable for flight.
The current preflight must record the actual physical checks and be less than
one hour old. Do not mark checks complete based on unit tests.

Keep Skycontroller and FreeFlight off, the Pi powered, the flight terminal open,
and the area clear for the circle and landing. Battery must be at least 40%.
X, Esc, `LAND` + Enter, Ctrl+C or terminal closure requests landing. Link loss,
stale telemetry, lost QR, rejected motion, camera-command failure or the
90-second mission deadline also interrupts the orbit and requests landing.
A lost radio link can prevent delivery of a landing command; only a received
landed event is reported as confirmation.

Indoor geographic coordinates remain unknown. The aircraft uses calibrated
marker-relative metres, never the simulated scenario site, replay coordinates,
Gemini output or a historical incident as flight authority.

## Mac

Start the backend as usual with `npm start`. Stop the observation supervisor
before starting this mutually exclusive SDK receiver:

```sh
.venv/bin/python scripts/mac.py stop-observer
.venv/bin/python scripts/mac.py install-pi \
  --camera-calibration anafi_out/calibration/camera.local.json \
  --preflight-file anafi_out/calibration/preflight.local.json
.venv/bin/python scripts/mac.py pi --mode qr-circle --execute
```

The installer copies code and these files into the Mac's separate Pi directory.
It does not start flight. The last command enables automatic takeoff on QR
recognition; there is no per-scan confirmation. Without `--execute`, this mode
only creates the fire incident and never sends motion or gimbal commands.
The launcher uses native video resolution and never automatically restarts a
flight session. `pi --mode observe` remains the reconnecting read-only mode.

## Windows

Use the existing backend and provisioned SSH configuration. Stop any other
laptop's observation terminal first, then run:

```powershell
.\scripts\Install-QrDemo.ps1 -CalibrationFile .\anafi_out\calibration\camera.local.json -PreflightFile .\anafi_out\calibration\preflight.local.json
.\scripts\Start-HoverCheckout.ps1 -Mode QrAutoCircle -Execute
```

These select the same Pi runtime and flight geometry as the Mac launcher. The
previous Hover, QrCheckout, QrOrbit and QrPreset modes retain their own behavior.
Only one laptop/receiver may own the aircraft SDK connection at a time.

## Validation

Pure geometry and gating tests run on the Mac:

```sh
.venv/bin/python tests/qr_circle_test.py
.venv/bin/python tests/mac_launcher_test.py
```

`tests/qr_auto_circle_sdk_test.py` runs in the Pi's Olympe environment with an
explicitly mocked aircraft: backend acknowledgment before takeoff, one-shot
behavior, takeoff -> 24 movements -> confirmed landing on one SDK object,
marker loss, cancellation, rejected movement, gimbal pitch and disabled mode.
No test constructs an actual aircraft connection. These tests do not replace
measured calibration or a supervised physical flight validation.
