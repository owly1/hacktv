# Direct Pi terminal takeoff and landing checkout

Updated 17 October 2026. The selected route is ANAFI Wi-Fi → Pi → Ethernet →
laptop, with the Skycontroller off. The laptop keeps Internet Wi-Fi for Gemini
and TigerData. This checkout needs no controller USB adapter.

The latest read-only hardware check received 45 video frames, landed state,
zero height and speed, 42% battery and fresh sensor events. It constructed no
flight driver. The selected printed QR was recognized in an earlier simulated
rehearsal. A subsequent operator test successfully took off, hovered and landed
automatically; telemetry recorded a 0.96 m hover. X-key landing remains untested.
Follow [the integrated QR flight guide](QR_FLIGHT_CHECKOUT.md) for the next steps.

## Start from everything off

1. Connect Pi Ethernet to the laptop's USB Ethernet adapter and power the Pi
   separately. Connect the laptop to Internet Wi-Fi.
2. Keep the Skycontroller off. Unfold the ANAFI, place it on a flat floor in the
   prepared flight area and power it on. The reported area is 10 × 10 × 10 m.
   Charge the battery if it is below 40%; the earlier reading is not current.
3. In Windows PowerShell, start the backend if it is not already running:

   ```powershell
   cd "$env:USERPROFILE\Desktop\drone"
   npm start
   ```

4. Leave that window open. Open <http://127.0.0.1:8787/> with Replay off.
5. In a second Windows PowerShell window, run reception only:

   ```powershell
   cd "$env:USERPROFILE\Desktop\drone"
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-HoverCheckout.ps1
   ```

   The launcher stops the normal Pi observer, selects the saved aircraft Wi-Fi
   profile and reuses or creates the backend tunnel. Do not run Start BOSCO,
   another SDK receiver or the Windows controller camera alongside this test.
6. Wait for `READY: reception only`. Move an object in view of the grounded
   camera and check the dashboard updates. This mode has no flight driver.
   `TAKEOFF TEST` cannot take off in this mode. Press X to exercise the input
   without a motor command, then Ctrl+C to exit.

## One real takeoff, hover and landing

1. In the second PowerShell window, run:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-HoverCheckout.ps1 -Execute
   ```

2. It starts **DISARMED**. Wait for `READY: type TAKEOFF TEST`. Keep this window
   focused. Resolve any failed check before continuing.
3. When ready, type `TAKEOFF TEST` and press Enter. This sends one TakeOff
   command. Parrot documents a normal ANAFI takeoff hover about 1 m above the
   launch floor; firmware controls the climb. No horizontal move is commanded.
4. To test landing, press **X** once the aircraft is airborne. Enter is not
   required. Esc also requests landing without Enter. `LAND` + Enter and Ctrl+C
   request landing too. This requests controlled landing, not motor cutoff or
   instantaneous touchdown; delivery depends on the terminal, Pi, process and
   aircraft link remaining available.
5. Without input, landing is requested after at most three seconds in a
   reported hover. Stale sensors/video, excessive height/speed/attitude,
   terminal closure, rejected takeoff or a ten-second timeout also request it.
6. Confirm **physical touchdown, stopped motors and `aircraft confirmed landed`**.
   A sent command or closed window is not a pass. Unconfirmed landing is an
   error. Each session permits one takeoff attempt and cannot repeat by itself.

Project guards: battery ≥40%, height ≤1.5 m, horizontal speed ≤0.3 m/s,
altitude/speed/attitude events within one second and video within 1.5 seconds.
Starting requires landed state, near-zero height and no movement. The ground
and motor-start/taking-off attitude guard is 20°; hovering/flying retains 10°. These are
project checks, not a manufacturer flight envelope. A flat surface does not
calibrate or prove an attitude sensor.

## Before actual QR flight

1. Pass the physical short-hover and terminal-landing test above.
2. Calibrate the exact camera stream, measure the QR square and camera offset,
   and verify recovered positions against measurements. Use the new
   [native Pi capture procedure](QR_FLIGHT_CHECKOUT.md#3-capture-native-pixels-with-the-drone-grounded).
3. Use the new integrated `qr_takeoff_demo.py` through `-Mode QrCheckout`.
   It keeps the **same SDK connection** for takeoff, QR waiting, movement and
   landing. The legacy `qr_orbit_bridge.py` still requires a pre-existing hover;
   the standalone hover checkout cannot leave an aircraft airborne for it.
4. Test one QR-triggered segment and landing before the full twelve-segment
   orbit. The intended start is 1 m high and 1 m from the marker. An automatic
   outward move from the requested 0.5 m starting distance is not implemented.

The QR runtime's direct mode requires explicit `--terminal-control` and local
records of the actual terminal landing test and controller-off confirmation.
Calibration and preflight fields are not marked verified automatically.
Gemini, TigerData and the browser have no flight authority. Port 8789 remains
the simulated rehearsal. The hover test sends real video/telemetry to the
dashboard but does not create a fire incident or invoke Gemini.

The source-only installer puts the code in `/home/pet/emberwatch/qr-demo`.
The launcher is installed at `C:\Users\anshi\Desktop\drone\scripts\Start-HoverCheckout.ps1`.
All 51 Python checks passed on the installed Olympe SDK with real aircraft
constructors guarded and fake drivers. These test input, aborts, no automatic
takeoff, landing confirmation and ground/air attitude limits; they are not a
flight test.

Primary reference: [Parrot ANAFI takeoff guidance](https://www.parrot.com/en/support/anafi/how-do-i-take-off-my-anafi-series-drone).

## Startup troubleshooting

The launcher creates the Pi's port 8788 tunnel if none exists, or reuses a
healthy one. An earlier launcher stopped on an expected `curl: (7)` missing-port
error in Windows PowerShell; the installed launcher now handles that case.
First-start creation was verified by an HTTP 200 response from the laptop
backend through the new Pi tunnel, without enabling flight.

If aircraft Wi-Fi cannot connect after tunnel setup, power the grounded ANAFI
with a charged battery, keep the Skycontroller off, wait for `ANAFI-H084882`
and retry. The Pi being reachable by Ethernet does not establish aircraft
Wi-Fi reception. A bound but unhealthy tunnel is reported separately and is
not replaced automatically.

An initial physical attempt was aborted with `unexpected flight state`; the
operator reported that the motors never started. That is not a hover pass.
The former guard omitted the SDK's documented `motor_ramping` transition.
The updated checkout accepts this startup state within the existing ten-second
timeout and logs each observed state, including the exact rejected value on
abort. The old log did not record that value, so it cannot establish whether
this omission caused the actual attempt to abort. Landing, emergency,
emergency-landing, user-launch and unknown states remain rejected. Extra landing
keys during confirmed-landed cleanup do not restart the landing sequence.
