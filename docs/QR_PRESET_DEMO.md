# QR-triggered preset circle and nearby hover

For automatic QR → fire incident → takeoff without a typed arm phrase, use
[QR_AUTO_DEMO.md](QR_AUTO_DEMO.md). This guide covers the older typed-arm preset.

This is a calibration-free demonstration. QR recognition is only a
start signal. The program does not estimate object distance, center the path
on an object in the picture, follow an object, or move directly over it.

After explicit arming, five fresh observations of the selected QR request
takeoff. The drone settles near 1 m height, flies one preset 1 m-radius,
twelve-segment circle, then holds near its starting hover until X/Esc or a
30-second hover timeout. The whole session has a 90-second flight cap.
The intended endpoint is near the launch position, about 1 m from the manually
placed center. Odometry error can change the actual path and endpoint.

## Place the demo

Use the previously reported clear 10 × 10 × 10 m area. Mark the launch point
and the aircraft's forward direction. Put the intended circle center and low
QR prop **1 m straight ahead** of that launch point. The nominal circle reaches
2 m forward of launch and 1 m left/right, plus the aircraft's dimensions and
clearance. The program does not perform obstacle avoidance or search flight.
The earlier 0.5 m starting distance is not this preset's geometry.

Keep the Skycontroller off. The Pi uses aircraft Wi-Fi and laptop Ethernet;
the laptop keeps Internet Wi-Fi. Only one aircraft receiver should run. The
launcher stops the normal Pi observer and manages the backend tunnel.

## First rehearse recognition with no flight commands

Start the backend with `npm start` from `C:\Users\anshi\Desktop\drone` if it
is off. Power the grounded, unfolded ANAFI and Pi, and attach Pi Ethernet.
Open <http://127.0.0.1:8787/> with Replay off. Then run from any PowerShell folder:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\Desktop\drone\scripts\Start-HoverCheckout.ps1" -Mode QrPreset
```

There is no `-Execute`. Type `ARM QR PRESET` + Enter and show the selected
printed marker from <http://127.0.0.1:8787/test-marker.html>. The expected output
is `QR RECOGNIZED ... REHEARSAL ONLY`. No flight driver is constructed, and no
motor command can be sent. Ctrl+C stops reception.

## Live mode

The short hover/automatic landing test passed previously. X-key landing has
not been physically confirmed yet; exercise X during that short hover test
before relying on it for the circle. X is a controlled-landing request, not
a motor cutoff or instantaneous touchdown.

After stopping the rehearsal receiver, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\Desktop\drone\scripts\Start-HoverCheckout.ps1" -Mode QrPreset -Execute
```

1. Wait for READY and review the marked launch alignment.
2. Type `ARM QR PRESET` and press Enter. This arms recognition for 20 seconds.
   If the selected QR is already visible, new camera frames can trigger
   takeoff shortly after arming. An unarmed scan never starts the motors.
3. Five distinct fresh detections spanning at least 0.8 seconds trigger one
   takeoff, circle and nearby hover. Other QR payloads, cached/pre-arm frames
   and stale images do not trigger this session.
4. Once triggered, the program executes the preset relative to launch heading.
   The QR no longer controls motion and may leave the camera view. No synthetic
   marker distance, coordinate or calibration is used.
5. **X or Esc, without Enter, requests landing** during takeoff, the circle or
   hover. `LAND` + Enter, Ctrl+C and terminal closure also request landing.
6. Without an earlier stop, the program requests landing after 30 seconds of
   nearby hover. Low battery, stale video/sensors, unexpected flight state,
   excessive height/speed/tilt, failed movement acknowledgment or the 90-second
   flight cap also requests landing. A broken connection can prevent delivery.
7. Confirm actual touchdown, stopped motors and the confirmed-landed result.
   An unconfirmed landing is reported as an error. Restart for another attempt;
   recognition never repeats the circle automatically.

Preset mode requires no camera calibration or preflight JSON file. It retains
the separate `-Execute` option, typed arm, real grounded readiness checks,
minimum 40% battery, data freshness checks, bounded moves and landing controls.
The older calibrated `QrCheckout`/`QrOrbit` modes remain available separately.
Gemini, TigerData, dashboard buttons and the QR scenario numbers have no flight
authority. This demonstration does not constitute a real fire response plan.

## Validation

All 67 Python checks passed in the installed Olympe SDK with real aircraft
constructors guarded and fake drivers. Tests cover recognition freshness,
single-use arming, one takeoff on the existing connection, a full preset
circle, hover timeout, X during the circle/hover, sensor and SDK faults,
connection changes, reception-only mode and landing confirmation.
The new preset circle and terminal interrupt still need physical flight tests.
The automatic short hover/landing is the only completed flight test so far.
