# Typed-arm preset circle

The older `QrPreset` / `qr-preset` mode needs no camera calibration: recognition
is a start signal, not position tracking. For the newer automatic repeated
preset see [QR_AUTO_DEMO.md](QR_AUTO_DEMO.md).

## Prepare and rehearse

Use one direct Pi receiver, controller off, backend running and a clear area.
Mark launch/heading and put the intended centre 1 m ahead. The nominal circle
extends 2 m forward and 1 m either side, plus aircraft clearance.

```powershell
.\scripts\Start-HoverCheckout.ps1 -Mode QrPreset
```

Type `ARM QR PRESET`, then show the selected printed marker. Without `-Execute`,
expect `QR RECOGNIZED ... REHEARSAL ONLY`; no flight driver is built.
Mac equivalent: `.venv/bin/python scripts/mac.py pi --mode qr-preset`.

## Opt-in flight

After the separate [terminal landing check](TERMINAL_FLIGHT_TEST.md), stop
rehearsal and run `-Mode QrPreset -Execute` (Mac: append `--execute`).

1. Wait for READY; type `ARM QR PRESET`. Arming expires after 20 seconds.
2. Five new selected-QR frames spanning ≥0.8 seconds trigger one takeoff.
   A marker already visible can trigger after arming; stale/pre-arm frames cannot.
3. Near 1 m hover, fly one 1 m-radius, 12-segment fixed circle at about 0.25 m/s.
   QR position/size no longer controls the path and may leave view.
4. Hold near the starting hover for at most 30 seconds, then request landing.
   Whole-session cap: 90 seconds. X/Esc, `LAND` + Enter and Ctrl+C request
   landing earlier; require physical touchdown and a confirmed-landed result.

Minimum battery is 40%. Freshness, state, height, speed/tilt and move results
are guarded. Failures request landing, but delivery depends on the link.
One armed attempt per process; restart for another. Relative odometry may drift;
the preset does not avoid obstacles or follow an object.

Mocked SDK checks do not establish physical circle accuracy or terminal landing.
Keep those outcomes in [VERIFIED.md](VERIFIED.md).
