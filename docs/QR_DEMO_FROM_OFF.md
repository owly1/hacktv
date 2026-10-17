# QR demo preparation from everything powered off

Recorded 17 October 2026. The normal camera path is hardware-tested. QR flight
is experimental and has not flown. Complete the grounded stages first; live
execution requires a verified pilot control path and measured camera geometry.

## 1. Start the known camera path

1. Connect the laptop to Internet Wi-Fi. Connect its USB Ethernet adapter to
   the Pi with Ethernet. Power the Pi separately.
2. Power the ANAFI, keep it grounded, and allow about one minute for Pi boot.
3. Double-click `C:\Users\anshi\Desktop\Start BOSCO.cmd`.
4. Keep the backend and Pi connection windows open. This already starts the
   backend; a separate `npm start` is unnecessary.
5. Open <http://127.0.0.1:8787/>. Leave Replay off. Move a hand/object in view
   and confirm the image changes and telemetry remains fresh.

The Pi window ends at a `pet@...` Linux prompt and also owns the tunnel.
Keep it open throughout the following process.

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
   terminal when finished. Leave the backend and Pi tunnel open.

This proves physical printed-code recognition. It sends no motor commands.

## 3. Establish the pilot's control path

First test connections with the aircraft grounded and motors stopped:

1. Use the supplied controller's normal supported connection to the aircraft,
   with its normal FreeFlight setup if available. Do not re-pair/reset devices
   or change the drone password as part of this check.
2. Leave Pi camera reception running. Check whether the controller remains
   connected and whether the laptop still receives fresh footage.
3. Use a non-flight control such as the camera-tilt wheel and verify the
   camera responds. This is only a preliminary connection check.
4. If either connection drops, or either device reports another controller
   has taken over, stop this flight preparation. A controller-mediated Pi
   connection must be implemented and tested first. Changing an IP address
   alone does not establish that connection.
5. After the grounded connection check, an experienced pilot must perform a
   short **manual** hover and normal landing in the prepared flight area,
   while a second teammate checks that the Pi feed stays live. The pilot uses
   the controller's documented controls; the QR program remains off.
6. Confirm the pilot can command the landing with the Pi connected. A working
   camera-tilt command alone does not verify landing authority.

The current project has not established that direct Pi and supplied-controller
connections coexist. No automatic orbit should be attempted if this checkpoint
fails. The calibration stage below can still be done with motors stopped.

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
4. In the **Pi Linux window**, stop only the normal receiver, then start its
   separate native-resolution copy:

```bash
systemctl --user stop emberwatch-bridge.service
set -a
. /home/pet/emberwatch/bridge.env
set +a
PYOPENGL_PLATFORM=glx /bin/bash /home/pet/emberwatch/sdk/olympe-8.5.0/products/olympe/linux/env/setenv python /home/pet/emberwatch/qr-demo/anafi_observer.py --controller direct --ip 192.168.42.1 --drone-id ANAFI-H084882 --backend http://127.0.0.1:8788 --camera --camera-transport frame --camera-fps 2 --camera-width 0
```

5. Keep this Pi command running. `--camera-width 0` preserves the decoded size;
   calibrating the normal downscaled 640-pixel feed and then using unscaled
   orbit frames would not match this runtime's strict resolution checks.
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

1. In the Pi window, Ctrl+C stops the temporary native-resolution receiver.
   Leave the SSH window itself open so the backend tunnel stays available.
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
PYOPENGL_PLATFORM=glx /bin/bash /home/pet/emberwatch/sdk/olympe-8.5.0/products/olympe/linux/env/setenv python /home/pet/emberwatch/qr-demo/qr_orbit_bridge.py --no-window --backend http://127.0.0.1:8788 --drone-id ANAFI-H084882 --camera-calibration /home/pet/emberwatch/qr-demo/camera.local.json
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
PYOPENGL_PLATFORM=glx /bin/bash /home/pet/emberwatch/sdk/olympe-8.5.0/products/olympe/linux/env/setenv python /home/pet/emberwatch/qr-demo/qr_orbit_bridge.py --no-window --backend http://127.0.0.1:8788 --drone-id ANAFI-H084882 --execute --checkout-one-segment --radius 1 --height 1 --camera-calibration /home/pet/emberwatch/qr-demo/camera.local.json --preflight-file /home/pet/emberwatch/qr-demo/current-preflight.local.json
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
9. `LAND` or `X` + Enter requests landing; the pilot's verified control path
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

```bash
systemctl --user reset-failed emberwatch-bridge.service
systemctl --user start emberwatch-bridge.service
```

For shutdown, stop it and use the existing bounded Pi poweroff helper. Stop
the backend separately. Do not remove Pi power before shutdown completes.

## Verification boundary

The calibration helper is tested with generated checkerboard data and known
synthetic camera parameters. Actual photos, measured camera offsets, controller
routing, native-image transfer and flight still need the physical stages above.
The installer syntax has been checked; a cold deployment while the user's hardware
is off cannot be verified by these software checks.

Primary references: [Parrot physical connection options](https://developer.parrot.com/docs/olympe/userguide/advanced/physical_drone.html)
and [OpenCV camera calibration](https://docs.opencv.org/4.x/dc/dbb/tutorial_py_calibration.html).
Parrot's current generic guide includes newer controllers; it does not establish
the supplied controller's compatibility with this Pi topology.
