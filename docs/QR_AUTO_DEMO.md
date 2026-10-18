# Automatic QR demo preset

This mode treats the selected QR as a trigger. It does not measure or follow
the QR's position and needs no camera/QR-size/offset calibration.

**With `--execute`, a QR already visible at startup can trigger takeoff.**
There is no later typed-arm or per-scan confirmation. Without execution enabled,
recognition creates only the test fire incident.

## Sequence and limits

1. Five distinct fresh frames spanning at least 0.8 seconds recognize the exact
   `bridge/orbit-marker.txt` payload. Other QR/replay input cannot trigger it.
2. The backend must accept the fire incident; Gemini completion is not required.
3. Grounded aircraft checks, fresh video/telemetry and ≥40% battery gate takeoff.
4. Near a 1 m hover, fly repeated **1 m-radius, 24-segment** fixed circles about
   a point 1 m ahead of the launch heading. Yaw/camera aim at that planned point.
5. X/Esc, `LAND` + Enter, Ctrl+C or terminal closure requests landing. Stale
   data, failed moves, other guards, battery below 40% or five minutes including
   takeoff also end the session. A completed lap alone does not end it.

The nominal footprint extends 2 m forward and 1 m to either side of launch,
plus aircraft size/clearance. QR loss after triggering does not stop this preset;
aircraft/video guards remain active. Relative movement error can cause drift.
Only an aircraft landed event confirms touchdown. A lost link can prevent
delivery of a landing request. Restart deliberately for another takeoff.

## Mac

With the backend running, Pi powered, controller/FreeFlight off:

```sh
.venv/bin/python scripts/mac.py install-pi
.venv/bin/python scripts/mac.py stop-observer
.venv/bin/python scripts/mac.py pi --mode qr-demo
```

The last command rehearses recognition without motors. Stop it before the
flight command, then keep the operator terminal open:

```sh
.venv/bin/python scripts/mac.py pi --mode qr-demo --execute
```

## Windows

From the configured checkout, backend running and other receivers stopped:

```powershell
.\scripts\Install-QrDemo.ps1
.\scripts\Start-HoverCheckout.ps1 -Mode QrAutoPreset
```

After rehearsal exits, `-Mode QrAutoPreset -Execute` enables automatic takeoff.
Mac/Windows select the same Pi preset and request 30 FPS; delivered FPS varies.

## Recordings

Flight-enabled sessions record locally on the Pi in
`anafi_out/flights/<UTC-session-id>/`: `video.mjpeg`, `frames.jsonl`
(capture times/byte offsets), `events.jsonl` (telemetry/control/moves), and
`recording.json` (counts/errors). A bounded writer drops recording frames
instead of blocking control; less than 256 MiB free stops recording.

Mac copies recordings after exit and creates `preview.mp4` / `review.json`.
For a missed copy, run `.venv/bin/python scripts/mac.py fetch-flights`.
On Windows, copy session folders locally, then run:

```sh
python scripts/review_flights.py <local-flights-directory>
```

MP4 timing repeats frames across gaps; the original index distinguishes real
captures. Review failures and measured height alongside footage before adjusting
limits. Keep footage out of Git. Recording is not retroactive.

Mocked SDK tests cover gating, repeated laps, aborts and aiming; they do not
prove flight accuracy. See [verification](VERIFIED.md). For a measured-marker
orbit use [QR_AUTO_CIRCLE.md](QR_AUTO_CIRCLE.md); for typed arming use
[QR_PRESET_DEMO.md](QR_PRESET_DEMO.md).
