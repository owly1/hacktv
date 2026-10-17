# From the passed hover to a measured QR orbit

17 October 2026: the operator reports successful takeoff, hover and automatic
landing. Recorded telemetry shows a hover at 0.96 m followed by descent. The
operator did not press X, so the terminal interrupt remains untested. No real
arc or full orbit has been completed. Measured calibration is not present yet.

The new `bridge/qr_takeoff_demo.py` keeps one Pi SDK connection throughout:
typed start → takeoff → one second of stable hover → calibrated QR recognition
→ one short arc or a full circle → confirmed landing. A QR on the ground does
not initiate takeoff. A typed command starts the flight; recognition initiates
horizontal movement. Gemini and the dashboard do not issue flight commands.

## 1. Verify X during the same short hover test

Keep the Skycontroller off, Pi Ethernet attached and backend running. Open
Windows PowerShell from any folder:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\Desktop\drone\scripts\Start-HoverCheckout.ps1" -Execute
```

Wait for READY. Type `TAKEOFF TEST` and Enter. Once hovering, press X without
Enter, before automatic landing begins. Confirm physical touchdown, stopped
motors and the landed report. This tests the operator input during flight;
the earlier automatic landing did not test that input. It remains a software
landing request dependent on the Pi, terminal, process and aircraft link.

## 2. Print and measure the calibration board

Open <http://127.0.0.1:8787/calibration-board.html>. Print at actual size/100%,
landscape, with background graphics enabled. It has 10 × 7 squares and 9 × 6
inner corners. Measure the printed ruler: it must be 100 mm. Squares should be
20 mm; use the actual measured square edge in the fitting command. Keep the
sheet flat on rigid backing. Also measure the printed black QR square,
excluding its white border; the supplied marker is intended to be 18 cm wide.

## 3. Capture native pixels with the drone grounded

After the previous receiver exits, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\Desktop\drone\scripts\Start-HoverCheckout.ps1" -NativeVideo
```

This has no `-Execute`, so it cannot send flight commands. The launcher stops
the normal observer and supplies full-resolution snapshots. The ordinary feed
is capped at 960 pixels wide, which does not match the QR pose solver's native
frames. Native mode must be selected for capture. Do not run another receiver.

In another Windows PowerShell window:

```powershell
cd "$env:USERPROFILE\Desktop\drone"
$calibrationFolder = Join-Path $PWD ('anafi_out\calibration-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
python .\bridge\calibrate_camera.py capture --directory $calibrationFolder
```

Move the board in front of the stationary drone camera. Press Enter for each
capture. Collect 20 accepted views with all squares visible: different image
positions, distances and tilts. The helper saves detected-corner previews and
rejects stale frames or a missing board. It reports decoded dimensions; those
must match the eventual native QR stream. Keep zoom, crop and video mode fixed.

Then, in that same PowerShell window, fit the measured views:

```powershell
python .\bridge\calibrate_camera.py fit --directory $calibrationFolder --square-mm 20 --qr-side-cm 18
```

Replace 20 and 18 with actual measured dimensions if different. The helper
requires varied views and acceptable reprojection error. The result is
`camera.local.json` inside the capture folder. It deliberately contains
unmeasured camera offsets and `measured_and_verified: false`.

## 4. Measure offsets and check pose before marking verification

Measure the camera lens offset `[forward, right, down]` in metres from the
chosen aircraft body reference, at the intended camera tilt. Replace the
three null offsets in the generated file with measured values. Do not infer
them from an assumed field of view. See the detailed measurement procedure in
[the existing calibration guide](QR_DEMO_FROM_OFF.md#5-measure-the-camera-offset-and-independently-check-marker-positions).

Copy the measured file using the source checkout's installer:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\anshi\Documents\Codex\2026-10-16\referenced-chatgpt-conversation-this-is-an-3\hacktv\scripts\Install-QrDemo.ps1" -CalibrationFile (Join-Path $calibrationFolder 'camera.local.json')
```

Stop the native hover receiver with Ctrl+C. With motors stopped, run the
read-only QR pose checker:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\Desktop\drone\scripts\Start-HoverCheckout.ps1" -Mode QrCheckout
```

It prints `[POSE]` values using measured intrinsics and gimbal orientation;
there is no flight driver. Check several known distances, heights, headings
and positions with a tape measure. Aim the camera at the floor marker before
the SDK session using the known controller camera controls, then turn the
controller off before starting Pi reception. Do not run both together.

Only after independent pose checks agree should the calibration be marked
verified and copied again. A recent local preflight record must reflect the
actual site, terminal landing test, controller-off state, marker placement and
verified geometry. The example remains false; software tests do not complete
these physical records. Do not substitute a guessed calibration.

After completing those checks, prepare the local record from the example:

```powershell
$preflightPath = Join-Path $calibrationFolder 'current-preflight.local.json'
Copy-Item -LiteralPath "C:\Users\anshi\Documents\Codex\2026-10-16\referenced-chatgpt-conversation-this-is-an-3\hacktv\bridge\orbit-preflight.example.json" -Destination $preflightPath
notepad $preflightPath
[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
```

Record only checks actually performed. For the direct route, fill the terminal
landing test, controller-off state, cleared area, operator presence, floor
marker and independently checked geometry. Use the displayed current timestamp
for `checked_at_unix`; records expire after an hour. The optional physical
controller landing field is not required in terminal mode. Then copy both files:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\anshi\Documents\Codex\2026-10-16\referenced-chatgpt-conversation-this-is-an-3\hacktv\scripts\Install-QrDemo.ps1" -CalibrationFile (Join-Path $calibrationFolder 'camera.local.json') -PreflightFile $preflightPath
```

## 5. One short arc, then the full circle

After those physical checks and file installation, stop the read-only
receiver and select the single-arc mode:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\Desktop\drone\scripts\Start-HoverCheckout.ps1" -Mode QrCheckout -Execute
```

Wait for READY and type `START QR CHECKOUT` + Enter. This requests takeoff,
settles in hover and waits up to 20 seconds for five fresh, stable, calibrated
QR observations. The intended start is 1 m above the launch floor, with the
flat marker 1 m ahead and visible to the camera. Starting 0.5 m away is rejected;
the program does not move outward or search. Firmware controls takeoff height;
the QR phase checks the measured height and does not command a separate climb.

Recognition triggers one roughly 0.52 m chord with a 30° turn, followed by
landing. Check real movement and landing before selecting a full circle:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\Desktop\drone\scripts\Start-HoverCheckout.ps1" -Mode QrOrbit -Execute
```

Its distinct start phrase is `START QR ORBIT`. It requests one twelve-segment,
1 m-radius polygonal orbit, then landing. Neither mode repeats automatically.
X/Esc requests landing; stale data, lost or inconsistent QR pose, an expired
QR wait, an aborted segment or a failed movement acknowledgment also requests
landing. Bounds and camera checks do not provide obstacle avoidance.

## Source and validation

The ordinary hover mode and its `TAKEOFF TEST` phrase are unchanged. Only the
explicit QR modes select the new program. Live QR startup checks calibration
and physical preflight before constructing the flight runtime, and checks the
record again before takeoff and before QR arming. Unverified geometry cannot
enable flight. The installer copies source only; it never starts the aircraft.

All 51 Python checks passed inside the Pi's Olympe SDK with real aircraft
constructors guarded. The tests exercise the complete fake takeoff/QR/arc/land
sequence on one object, full-orbit selection, interruption, wrong marker
distance, absent physical records and native image dimensions. These are
software results, not a demonstrated real orbit.

The calibration board is served locally and returned HTTP 200. A later native
camera startup could not reach the aircraft SSID; the Pi had returned to its
Internet Wi-Fi. No aircraft runtime was running afterward. Full native-frame
delivery still needs to be checked with the powered, grounded aircraft; do not
use a stale 960 × 540 snapshot as a native calibration capture.
