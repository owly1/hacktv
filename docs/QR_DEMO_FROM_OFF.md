# Grounded preparation and calibration

Choose the mode before preparing it. The fixed [automatic preset](QR_AUTO_DEMO.md)
does not use camera calibration. The [measured circle](QR_AUTO_CIRCLE.md) and
legacy measured checkout below require real intrinsics and floor-marker geometry.

## Start from power off

1. Connect/power Pi Ethernet and laptop Internet Wi-Fi; power the grounded drone.
2. Use one known [camera workflow](../README.md#choose-a-hardware-workflow).
3. Open the dashboard with Replay off; confirm moving image/timestamps and fresh state.
4. Show the selected printed marker from `/test-marker.html` to the real camera.
   The [browser rehearsal](QR_ORBIT_DEMO.md) verifies recognition without motors.
5. Complete the physical [short-hover/terminal-landing check](TERMINAL_FLIGHT_TEST.md)
   before attempting a circle. Stop each receiver before changing modes.

## Capture native calibration photos

Keep the drone grounded. Use fixed zoom/native video; do not fit resized
frames and then fly at a different resolution. Open `bridge/calibration-board.html`,
print at 100%, measure its actual square size and attach it to a rigid flat board.
Default board: 10 × 7 squares, 9 × 6 inner corners; select the actual dimensions.

Windows native observation: `.\scripts\Start-HoverCheckout.ps1 -NativeVideo`.
Mac native observation: `.venv/bin/python scripts/mac.py pi --native-video`.
In another terminal from the checkout:

```sh
python bridge/calibrate_camera.py capture --web --directory anafi_out/calibration
```

Open <http://127.0.0.1:8791/> and capture varied distances, tilts and positions
across the whole image. The browser saves fresh matching-resolution attempts,
including undetected boards; saved/detected counts are separate. Reusing the
folder restores metadata/counts, `--photos` sets the total target, and **Start
new photo set** preserves the previous set. CLI capture (without `--web`) uses
Enter and writes `last-attempt.jpg` for rejected attempts.

```sh
python bridge/calibrate_camera.py fit --directory anafi_out/calibration --square-mm 20 --qr-side-cm 18
```

Replace 20/18 with measured square/black-QR dimensions (exclude white border).
The fitter checks view variation/coverage and reprojection error; photo count
alone is insufficient. It writes `camera.local.json` with unverified offsets.

## Independently check geometry

Measure `camera_offset_body_m=[forward,right,down]` in metres at the intended
gimbal configuration. Fill real values, not estimated field-of-view offsets.
Keep `measured_and_verified` false while using the non-executing pose checker
to compare several tape-measured distances, heights and headings. Check gimbal
axes, flat floor-marker tilt and exact resolution. Zero focal-length template
values are deliberately unusable. Mark verification only after those checks pass.

## Preflight and deployment

Copy `bridge/orbit-preflight.example.json` to an ignored local file. Record only
physical checks actually completed: cleared area, pilot present, floor marker,
independently checked calibration, and the selected landing/control route.
Direct mode requires `terminal_landing_tested_with_pi` and `controller_powered_off`;
controller mode requires its tested landing control. Set `checked_at_unix` to
current Unix seconds; acknowledgements expire after one hour.

```powershell
Copy-Item .\bridge\orbit-preflight.example.json .\anafi_out\calibration\preflight.local.json
[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
.\scripts\Install-QrDemo.ps1 -CalibrationFile .\anafi_out\calibration\camera.local.json -PreflightFile .\anafi_out\calibration\preflight.local.json
```

Mac deployment uses `scripts/mac.py install-pi --camera-calibration <file>
--preflight-file <file>`. Installation copies source/files; it never launches.
For staged legacy execution follow [QR_FLIGHT_CHECKOUT.md](QR_FLIGHT_CHECKOUT.md).
For automatic measured flight follow its [separate guide](QR_AUTO_CIRCLE.md).
Neither generated JSON nor unit tests completes human physical checks.
