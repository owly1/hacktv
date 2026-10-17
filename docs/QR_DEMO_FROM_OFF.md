# QR demo preparation from everything powered off

Updated 17 October 2026. The selected flight-checkout route is direct Pi Wi-Fi
with the Skycontroller **off** and a terminal landing command. Start with
[the terminal takeoff/landing checkout](TERMINAL_FLIGHT_TEST.md). Grounded
direct reception supplies real video and fresh sensors; no real flight has
been tested in an orbit. The short hover/automatic landing has now passed;
X-key landing and measured geometry remain. The integrated takeoff/QR program
is described in [the new QR flight guide](QR_FLIGHT_CHECKOUT.md).

The controller USB camera route below remains an alternative for grounded
recognition and calibration. Its 10 FPS feed, concurrent camera-tilt control
and printed-QR simulated orbit were confirmed. Run only one route at a time:
Pi direct reception conflicts with controller commands.

## 1. Start the known camera path

1. Connect the laptop to Internet Wi-Fi. Keep the ANAFI grounded. Power the
   controller and connect its USB-C port to the laptop with the tested data
   cable; leave the controller's USB-A port empty. Wait for aircraft pairing.
2. Keep the Pi's direct observer stopped. Do not use the full `Start BOSCO.cmd`
   startup: that shortcut restarts the conflicting direct observer.
3. In a Windows PowerShell window, start the existing backend if it is off:

   ```powershell
   cd "C:\Users\anshi\Desktop\drone"
   npm start
   ```

4. In another Windows PowerShell window, start camera reception:

   ```powershell
   cd "C:\Users\anshi\Desktop\drone"
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-ControllerCamera.ps1
   ```

5. Keep both windows open. Open <http://127.0.0.1:8787/> with Replay off. Move
   a hand/object in view and confirm fresh footage. Check the camera-tilt wheel
   with motors stopped. This route supplies video only: old telemetry is stale.

The Pi is bypassed for this camera route. It may remain powered and connected
by Ethernet for source preparation. Full details and the Windows driver setup
are recorded in [the controller camera guide](SKYCONTROLLER_USB_CAMERA.md).

## 2. Test the printed QR on the actual camera

Open a **new Windows PowerShell** window and run:

```powershell
cd "C:\Users\anshi\Documents\Codex\2026-10-16\referenced-chatgpt-conversation-this-is-an-3\hacktv"
python bridge/qr_orbit_rehearsal.py
```

1. Open <http://127.0.0.1:8787/test-marker.html>. Print at 100%/actual size.
2. Measure the black QR square, excluding the white margin: the default is
   18 cm. This size matters later for positioning.
3. Open <http://127.0.0.1:8789/>. It must say **live drone camera**, not test image.
4. Show the printed marker to the grounded camera. Use good lighting and
   avoid glare; the whole code must fit in the picture.
5. Click **Arm rehearsal** and hold it steady until **selected QR recognized**
   and the simulated orbit appear. If arming expires, Reset and try again.
6. Close only this rehearsal's Python process with Ctrl+C in its Windows
   terminal when finished. Leave the backend and controller camera receiver open.

This proves physical printed-code recognition. It sends no motor commands.

## 3. Establish the pilot's control path

The grounded USB camera + camera-tilt check passed. This is not evidence of
manual landing authority or an ability to interrupt SDK-controlled flight.

For the selected controller-off arrangement, perform the separate
[terminal hover/landing checkout](TERMINAL_FLIGHT_TEST.md). Esc or X requests
landing without Enter. The direct QR runtime requires explicit
`--terminal-control` and its own actual landing-test record. Its takeoff/hover
handoff is now implemented in the separate `qr_takeoff_demo.py`. The standalone
checkout still lands and exits; it is not an airborne handoff to another process.

The optional controller-mediated route uses `--controller skycontroller3`;
the Pi USB link and manual override have not been physically tested. The
working C-to-C cable serves Windows and needs an adapter to connect to Pi
USB-A. This adapter is not needed for the selected direct Pi route. The
controller-specific flight commands later in this document describe the
optional route, not the current terminal checkout.

### Reported flight area and requested geometry

The operator now reports a 10 × 10 × 10 m clear indoor area and an experienced
operator. This accommodates the requested 2 m centreline
diameter geometrically; an on-site clearance and landing-area check is still
required. The requested path is 1 m above the floor with a 1 m orbit radius.
The reported initial distance of 0.5 m is not supported by the present trigger:
the pilot must first establish the measured 1 m-radius starting hover. The
program rejects a marker only 0.5 m ahead; it has no automatic outward
repositioning or takeoff. The first planned flight is one chord followed by
landing, after the physical acceptance checks. The former 2 m-wide area was
rejected because the orbit left no aircraft/propeller clearance.

## 4. Collect native-resolution calibration images

These are camera calibration steps, separate from flight. Use a fixed,
stationary aircraft and keep its motors stopped throughout image collection.
Avoid the propeller area; follow the manufacturer's handling instructions.

In the Windows PowerShell window, from the same `hacktv` directory:

```powershell
Start-Process .\bridge\calibration-board.html
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-QrDemo.ps1
```

1. Print the checkerboard at actual size, landscape, with a white margin.
   It has 10 x 7 squares, 9 x 6 inner corners, and 20 mm square edges.
2. Measure its 100 mm ruler after printing. Mount it flat on a rigid surface.
3. The installer copies preparation source to the separate Pi directory
   `/home/pet/emberwatch/qr-demo`. It does not launch or arm anything.
4. In the **Windows camera receiver window**, Ctrl+C stops reception. Restart
   that receiver at native resolution for calibration; keep the Pi observer off.
   This command can run from either checkout containing the camera launcher:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-ControllerCamera.ps1 -Fps 2 -Width 0
```

5. Keep this Windows command running. `-Width 0` preserves the decoded size;
   calibrating a downscaled feed and then using unscaled orbit frames would
   not match the experimental runtime's strict resolution checks.
6. Keep camera zoom/video mode unchanged from here through pose validation
   and the eventual flight experiment.
7. In **Windows PowerShell**, run:

```powershell
python bridge/calibrate_camera.py capture
```

8. Show the complete board to the aircraft camera. Press Enter in Windows
   PowerShell for each capture. Hold the board steady for the capture.
9. Collect 20 accepted views: centered, left, right, above and below center,
   some closer/farther away, and with varied tilts. Keep all corners visible.
   Do not collect twenty identical pictures. Move the board, not the aircraft.
10. The helper reports a missing board or stale image rather than accepting it.
    Captures and corner previews remain in the ignored local directory
    `anafi_out/calibration`.
11. Fit the measured views:

```powershell
python bridge/calibrate_camera.py fit --square-mm 20 --qr-side-cm 18
```

Use actual measured dimensions if printing changed them. The helper requires
at least 15 usable, distributed views and rejects excessive reprojection error.
A successful fit writes `anafi_out/calibration/camera.local.json` with
`measured_and_verified: false`. This is an intrinsics estimate, not flight approval.
If repeating a capture session, select a fresh folder with `--directory` for
both capture and fit; the helper avoids overwriting or mixing an existing set.

## 5. Measure the camera offset and independently check marker positions

1. In the Windows camera receiver window, Ctrl+C stops the temporary
   native-resolution receiver. Leave the backend running. The Pi's direct
   observer remains stopped.
2. In Windows, open the generated calibration:

```powershell
notepad .\anafi_out\calibration\camera.local.json
```

3. Measure the lens center's offset from the aircraft body reference used for
   your setup, with the camera at its intended operating tilt. Record metres
   in `camera_offset_body_m`: `[forward, right, down]`. Front/right/down are
   positive; an offset above the reference has a negative down value. The
   generated `null` values deliberately require real measurements. Record
   any uncertainty; independent position checks below must catch a bad offset
   or reference assumption.
   The teammate responsible for flight integration must identify this reference;
   if it is uncertain or cannot be independently checked, keep the geometry
   unverified rather than substituting zero offsets.
4. Keep `measured_and_verified` false during checking. Save, then copy it:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-QrDemo.ps1 -CalibrationFile .\anafi_out\calibration\camera.local.json
```

5. In the **Pi window**, load the environment if needed and start pose checking:

```bash
set -a
. /home/pet/emberwatch/bridge.env
set +a
PYOPENGL_PLATFORM=glx /bin/bash /home/pet/emberwatch/sdk/olympe-8.5.0/products/olympe/linux/env/setenv python /home/pet/emberwatch/qr-demo/qr_orbit_bridge.py --controller skycontroller3 --ip 192.168.53.1 --no-window --backend http://127.0.0.1:8788 --drone-id ANAFI-H084882 --camera-calibration /home/pet/emberwatch/qr-demo/camera.local.json
```

There is no `--execute`: no flight driver is constructed. Do not type any arming
phrase during these measurements.

6. With motors stopped, put the aircraft on a stable support, the flat QR on
   the floor, and aim the camera at it through the supported camera controls.
   Measure the body-reference height and horizontal marker position with a tape.
7. Read the `[POSE]` lines. For example, a marker measured 1 m ahead, centered,
   and 0.8 m below the aircraft reference should be approximately:
   `forward=1.00 right=0.00 down=0.80 m`.
8. Check at several measured distances and left/right offsets, and after
   changing the aircraft heading while stationary. Do not validate only the
   same checkerboard views used to fit the camera.
9. Investigate incorrect sign, heading dependence, large position error,
   resolution mismatch, ambiguous pose, or poor reprojection results. The live
   gate allows only a narrow target-position band; aim for errors below 0.1 m
   throughout the intended demonstration positions. This is a project acceptance
   target, not a certified positioning specification.
10. Only after measured offsets, gimbal axes and independent poses check out,
    record `measured_and_verified: true` in the Windows calibration file.
    Ctrl+C the Pi pose checker before copying its updated calibration again.

## 6. Supervised flight checkout and final one-orbit attempt

This stage remains unavailable if the independent controller/landing test in
stage 3 failed, or if the camera checks in stage 5 failed. Passing camera
calibration does not fix control routing.

1. Confirm the prepared flight area's clearance and landing surfaces, a pilot
   at the controls, and an observer. The software has no obstacle avoidance.
2. Have the pilot complete the normal aircraft checks and demonstrate manual
   hover/landing with the intended Pi connection. Keep the QR experiment
   unarmed. The software does not take off for the pilot.
3. In Windows, copy the human preflight template:

```powershell
Copy-Item .\bridge\orbit-preflight.example.json .\anafi_out\calibration\preflight.local.json
notepad .\anafi_out\calibration\preflight.local.json
[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
```

Record only completed physical checks as true and put the current numeric Unix
time in `checked_at_unix`. This record expires after one hour and is checked again
at arming. Editing flags does not perform the physical checks.

4. Copy the actual measured calibration and current preflight to the Pi:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-QrDemo.ps1 -CalibrationFile .\anafi_out\calibration\camera.local.json -PreflightFile .\anafi_out\calibration\preflight.local.json
```

5. Make sure the pose checker/native receiver has stopped and the normal
   observation service is also stopped. Keep backend and SSH tunnel running.
6. In the Pi window, first run the explicit **one-segment checkout**:

```bash
set -a
. /home/pet/emberwatch/bridge.env
set +a
PYOPENGL_PLATFORM=glx /bin/bash /home/pet/emberwatch/sdk/olympe-8.5.0/products/olympe/linux/env/setenv python /home/pet/emberwatch/qr-demo/qr_orbit_bridge.py --controller skycontroller3 --ip 192.168.53.1 --no-window --backend http://127.0.0.1:8788 --drone-id ANAFI-H084882 --execute --checkout-one-segment --radius 1 --height 1 --camera-calibration /home/pet/emberwatch/qr-demo/camera.local.json --preflight-file /home/pet/emberwatch/qr-demo/current-preflight.local.json
```

7. It starts disarmed. The pilot establishes the verified hover at the planned
   1 m height, with the flat floor marker 1 m ahead in the aircraft's direction.
   Keep the camera facing the marker. If connecting this runtime disrupts pilot
   control, land via the verified fallback and stop; do not arm.
8. The laptop operator types `ARM QR CHECKOUT` once in the Pi program. Five
   stable fresh recognitions can trigger one chord, approximately 0.52 m long,
   and a 30-degree heading change, followed by a landing request. The chord is
   mostly leftward relative to the starting aircraft heading, with a small
   forward component; the landing position is displaced from takeoff. Keep
   the entire path and landing area clear.
9. Esc or `X` requests landing without Enter; `LAND` + Enter also works. The verified control path
   remains necessary. A broken link or process failure can prevent software
   delivery. Confirm actual touchdown and the aircraft's reported landed state.

10. Have the pilot/integration engineer review the movement, marker tracking,
    abort behavior and confirmed landing. Investigate any failure before another
    attempt. Stop the completed program with Ctrl+C after landing.
11. Only after checkout is accepted, start a new session with the same command
    **without `--checkout-one-segment`**. It will print the full twelve-segment
    mode. Refresh an expired preflight record only after repeating its checks.
12. Establish the planned hover again, then type `ARM QR ORBIT`. One polygonal
    orbit and a landing request are the intended behavior. Review actual results.

Neither the checkout nor the orbit is hardware-tested by the software author.
Their bounded segments and watchdogs are software features, not a demonstrated
flight envelope. Do not use the legacy `--demo-flight` as a substitute: its path
and controls differ.

## Restore the normal camera receiver

Once the experiment/pose/native receiver is stopped and the aircraft is landed:

Reconnect the controller USB-C cable to the laptop and leave its USB-A port
empty. Keep the Pi direct observation service stopped. In Windows, run:

```powershell
cd "$env:USERPROFILE\Desktop\drone"
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-ControllerCamera.ps1
```

For shutdown, stop the Windows camera receiver and use the existing bounded Pi
poweroff helper. Stop the backend separately. Do not remove Pi power before
shutdown completes.

## Verification boundary

All 51 Python checks passed on the Pi's installed SDK with fake aircraft and
real controller constructors guarded against use. The calibration helper is
tested with generated checkerboards and known synthetic camera parameters.
Actual photos, measured camera offsets, Pi controller routing, pilot override
and flight still need the physical stages above. Native-resolution camera
calibration transfer has not been physically verified. A source-only Pi
deployment does not establish a live controller connection.

Primary references: [Parrot physical connection options](https://developer.parrot.com/docs/olympe/userguide/advanced/physical_drone.html)
and [OpenCV camera calibration](https://docs.opencv.org/4.x/dc/dbb/tutorial_py_calibration.html).
Parrot's current generic guide includes newer controllers; it does not establish
the supplied controller's compatibility with this Pi topology.
