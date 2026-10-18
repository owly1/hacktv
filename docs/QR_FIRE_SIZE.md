# Fire-size-scaled indoor QR flight

`qr-fire-size` reads the selected QR's **fire area in hectares**, backs away
from its measured floor position, flies one 24-chord orbit at the selected
radius, then requests landing. It is an explicit alternative to `qr-circle`.
Ordinary observation, fixed presets and the original 1 m circle keep their
existing behavior.

## Distance rule

The indoor target distance from the QR centre is:

```text
radius_m = min(1.5, 1 + 0.25 * sqrt(area_ha / 120))
```

| Scenario fire area | Target radius | Retreat from a centred 1 m start |
|---|---|---|
| 30 ha (unit-test fixture) | 1.125 m | 0.125 m |
| 120 ha (selected live QR) | 1.25 m | 0.25 m |
| 480 ha or larger (unit-test fixture) | 1.5 m | 0.5 m |

This is a bounded indoor demonstration policy, not a clearance model for a
real fire or a distance from a real fire boundary. The 18 cm printed QR size
is used for calibrated pose estimation; it is not fire area.

Only the existing exact marker is accepted:
`EW1:Alpha|120|X|35|M|30|60|31|18|18`. Other sizes above demonstrate the rule
in tests; arbitrary edited QR codes remain rejected. Adding live markers
requires a coordinated change to detector identity, backend validation,
printed assets and tests, as described in the shared context.

## Sequence and bounds

1. Five distinct fresh QR frames spanning at least 0.8 seconds plus a backend
   incident acknowledgement authorize one takeoff only when execution is enabled.
2. Use the same measured calibration, current physical preflight, battery,
   link, telemetry, video and terminal gates as the measured-circle mode.
3. Place the floor QR about 1 m ahead of launch. At the 1 m hover, acquire five
   coherent calibrated poses within five seconds. No horizontal search occurs.
4. Retreat radially in steps of at most 20 cm at 0.15 m/s, yawing toward the QR.
   Each step requires a newer centred QR pose, settled hover and radius error
   at most 5 cm within two seconds. At most four retreat commands and 65 cm
   total commanded retreat are permitted. Failure requests landing.
5. A start more than 5 cm beyond the selected radius aborts instead of moving
   closer. Within the target band, the orbit still requires a centred fresh pose.
6. Fly one measured lap at the selected radius. Existing limits remain:
   chord at most 50 cm, yaw at most 30 degrees, endpoint forward error at most
   18 cm and lateral error at most 15 cm. Camera tracking remains active.
7. Request and confirm landing. The 90-second mission deadline includes takeoff,
   acquisition, retreat and orbit. X/Esc, LAND, Ctrl+C, terminal closure,
   stale/lost observations and failed commands retain their landing behavior.

For the current QR, the nominal footprint is a 2.5 m diameter circle around
the marker, including 25 cm behind the launch position. Allow aircraft size,
clearance and possible drift in the checked flight space. Software limits and
mocked tests do not establish physical accuracy or confirmed touchdown.

## Launch

Update the backend and Pi source from this branch together; an older backend
rejects the new flight annotation and therefore cannot authorize takeoff.
Complete the calibration and physical setup in [QR_AUTO_CIRCLE.md](QR_AUTO_CIRCLE.md).
Only one receiver may own the aircraft.

Windows, with the configured backend already running:

```powershell
.\scripts\Install-QrDemo.ps1 -CalibrationFile .\anafi_out\calibration\camera.local.json -PreflightFile .\anafi_out\calibration\preflight.local.json
.\scripts\Start-HoverCheckout.ps1 -Mode QrFireSize
```

This rehearses recognition and incident submission without motors. End that
session before explicitly enabling flight:

```powershell
.\scripts\Start-HoverCheckout.ps1 -Mode QrFireSize -Execute
```

Mac, after installing measured files with the existing `install-pi` command
and stopping observation:

```sh
.venv/bin/python scripts/mac.py pi --mode qr-fire-size
# End rehearsal before starting this explicitly enabled flight session:
.venv/bin/python scripts/mac.py pi --mode qr-fire-size --execute
```

The underlying Pi entry point is `bridge/qr_auto_circle.py --fire-size`, with
the same backend/direct-control arguments and, for execution, calibration,
preflight and `--execute` flags as the measured circle. It cannot be combined
with `--preset`; leave the generic `--radius` argument at its default.
With execution enabled, a QR already visible at startup can trigger takeoff.

## Verification

`python -m unittest discover -s tests -p 'fire_size_test.py'` checks the scaling,
actual body-frame retreat/orbit geometry and failure paths with fake feedback.
Existing QR tests preserve original behavior; SDK adapter tests also run the
scaled mode through one-shot, read-only, incident and landing gates when Olympe
is installed. No test opens a real aircraft connection. Run `npm test` to check
that only the matching protocol, measured path and computed radius are accepted.
