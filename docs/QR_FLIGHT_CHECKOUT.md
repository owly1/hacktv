# Staged measured QR checkout

This older integrated flow keeps takeoff, QR waiting, motion and landing on
one SDK connection. For newer automatic QR-started flight use the
[measured circle guide](QR_AUTO_CIRCLE.md).

## 1. Check terminal landing

Pass the physical [short hover](TERMINAL_FLIGHT_TEST.md), including X input,
before the measured arc. The standalone hover always lands; it cannot hand
an airborne aircraft to a second receiver.

## 2. Calibrate and deploy

Follow [native capture, measurement and preflight](QR_DEMO_FROM_OFF.md).
Place the selected QR flat on the launch floor about 1 m ahead at the intended
1 m hover height. Prepare calibrated intrinsics at native resolution, measured
black-square size/offset, verified pose checks and current local preflight.

```powershell
.\scripts\Install-QrDemo.ps1 -CalibrationFile .\anafi_out\calibration\camera.local.json -PreflightFile .\anafi_out\calibration\preflight.local.json
.\scripts\Start-HoverCheckout.ps1 -Mode QrCheckout
```

With no `-Execute`, `[POSE]` output is read-only. Verify several measured
positions/headings before marking the file verified and redeploying it.

## 3. One arc, then full orbit

Stop the read-only receiver. After actual physical checks:

```powershell
.\scripts\Start-HoverCheckout.ps1 -Mode QrCheckout -Execute
```

Type `START QR CHECKOUT` for the first mode: takeoff, automatic QR-waiting,
one short arc and landing. Verify the motion and X/Esc landing before the
full twelve-segment mode:

```powershell
.\scripts\Start-HoverCheckout.ps1 -Mode QrOrbit -Execute
```

Type `START QR ORBIT` for the full-orbit mode. The QR waiting gate arms after
the takeoff hover; these integrated modes do not need a second typed arm phrase.

Keep the direct controller off, terminal open and one receiver only. Do not
substitute guessed geometry or reuse expired physical preflight. The marker
must remain fresh and correctly measured; failures request landing. A command
sent is not touchdown confirmation.

Source: `qr_takeoff_demo.py`, `qr_orbit_bridge.py`, `qr_orbit_core.py`,
`qr_orbit_pose.py`. The [legacy orbit guide](QR_ORBIT_DEMO.md) explains its
pre-existing-hover entry point and limits. These tests/guides do not establish
real-world orbit accuracy; record physical results separately.
