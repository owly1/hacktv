# Automatic circle around a measured QR

This opt-in mode flies once around the **measured floor marker**. For a
calibration-free fixed preset, use [QR_AUTO_DEMO.md](QR_AUTO_DEMO.md).
For an indoor retreat and orbit scaled from the QR's fire area, select the
separate [fire-size mode](QR_FIRE_SIZE.md). Ordinary `qr-circle` stays at 1 m.

With `--execute`, five distinct fresh selected-QR frames spanning ≥0.8 seconds
and backend incident acceptance can start takeoff without a typed arm phrase.
Without it, only the test incident is created. Ordinary observation/dashboard
startup never enables this runtime.

## Required setup

- One receiver owns the aircraft; direct Pi Wi-Fi, controller/FreeFlight off.
- Selected printed QR lies flat on the launch floor about 1 m ahead.
- Camera intrinsics match native decoded resolution/zoom; QR black-square size,
  camera offset and gimbal axes are measured and independently checked.
- Verified calibration and an actual physical preflight less than one hour old.
  The zero-focal-length/false example files intentionally cannot authorize flight.
- Cleared flight/landing area, ≥40% battery, terminal open and landing control
  physically tested. See [cold start](QR_DEMO_FROM_OFF.md).

## Flight sequence

1. Stable recognition → accepted fire incident → grounded checks → one takeoff.
   Gemini completion is not a motor gate.
2. At about 1 m height, acquire five coherent calibrated poses within five seconds.
   Missing pose requests landing; there is no horizontal QR search.
3. Correct at most 35 cm to a **1 m radius (2 m diameter)**, then make one
   24-chord lap. Re-measure after every move and require a fresh settled hover.
   Endpoint bounds are 18 cm forward error and 15 cm lateral error; these are
   software thresholds, not established physical accuracy.
4. Body yaw faces the marker; the gimbal tracks it at five updates/second.
   Mission deadline is 90 seconds. Then request and confirm landing.

X/Esc, `LAND` + Enter, Ctrl+C, terminal closure, stale sensors, lost QR,
failed movement or camera commands also request landing. Only a landed event
confirms it; a broken link can prevent delivery. Reconnection never repeats
the one-shot mission. Indoor scenario GPS is never used as flight geometry.

## Launch

Mac: stop observation, copy measured files, then opt into flight:

```sh
.venv/bin/python scripts/mac.py stop-observer
.venv/bin/python scripts/mac.py install-pi --camera-calibration anafi_out/calibration/camera.local.json --preflight-file anafi_out/calibration/preflight.local.json
.venv/bin/python scripts/mac.py pi --mode qr-circle --execute
```

Windows, from the checkout with the backend running:

```powershell
.\scripts\Install-QrDemo.ps1 -CalibrationFile .\anafi_out\calibration\camera.local.json -PreflightFile .\anafi_out\calibration\preflight.local.json
.\scripts\Start-HoverCheckout.ps1 -Mode QrAutoCircle -Execute
```

Omit the execution flag for recognition/incident rehearsal. Stop that receiver
before starting another. Run `tests/qr_circle_test.py` for pure geometry and
`tests/qr_auto_circle_sdk_test.py` in the mocked SDK environment. Physical
calibration/flight acceptance is separate from those checks.
