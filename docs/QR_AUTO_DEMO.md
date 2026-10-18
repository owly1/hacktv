# Automatic QR demo preset

Use this mode when the selected QR is a demo trigger. Its printed size and
position do not determine the flight path. Camera calibration, QR-size and
camera-offset measurements are not inputs to this mode.

Starting this mode with `--execute` enables one automatic sequence:

1. Recognize the exact selected payload from `bridge/orbit-marker.txt` in five
   fresh camera frames spanning at least 0.8 seconds. The existing test marker
   at <http://127.0.0.1:8787/test-marker.html> contains that payload.
2. Create the normal QR fire incident and wait for backend acceptance.
3. Check the actual grounded aircraft, fresh telemetry/video, and battery
   of at least 40%, then take off on the existing connection.
4. From a stationary hover near 1 m height, fly one preset 1 m-radius circle
   about a point 1 m ahead of the launch heading, using 24 short segments.
5. Pause for one second at the endpoint, then request and confirm landing.

There is no typed arming phrase or per-scan confirmation after enabling this
mode. A QR already visible when the receiver starts can trigger takeoff once
the fresh-frame and incident checks succeed. Other QR payloads and replay
data cannot trigger the preset. A session runs at most once; reconnecting does
not repeat it. Backend acceptance creates the incident; Gemini completion is
not required to start the demo.

The camera pitches toward the planned circle centre and the aircraft turns
inward after each segment. This aims at the predefined centre; it does not
visually follow a QR or correct the path using the QR's position. Relative
movement error can change the actual path and endpoint. QR loss after takeoff
does not stop this preset; stale telemetry/video, failed movement, cancellation
and the mission timeout still request landing.

## Mac

Keep the Pi powered, Skycontroller/FreeFlight off, and the operator terminal
open. With the backend running, install the source:

```sh
.venv/bin/python scripts/mac.py install-pi
```

For recognition and fire-incident testing with no flight commands:

```sh
.venv/bin/python scripts/mac.py stop-observer
.venv/bin/python scripts/mac.py pi --mode qr-demo
```

For the actual automatic demo, stop the rehearsal receiver and run:

```sh
.venv/bin/python scripts/mac.py pi --mode qr-demo --execute
```

The launch position and heading define the path. Its nominal footprint reaches
2 m forward and 1 m either side of launch, plus aircraft dimensions and clearance.
Align any centre prop 1 m ahead if the demonstration should appear to circle it.
X or Esc without Enter, `LAND` + Enter, Ctrl+C or terminal closure requests
landing. This is a landing request, not an instantaneous motor stop. Only an
actual landed event confirms touchdown. The mission has a 90-second cap.

## Windows

Use the same backend, QR payload and Pi runtime:

```powershell
.\scripts\Install-QrDemo.ps1
.\scripts\Start-HoverCheckout.ps1 -Mode QrAutoPreset
```

After stopping rehearsal, `-Mode QrAutoPreset -Execute` enables automatic
flight on the selected QR. Only one laptop receiver may own the Pi connection.
Neither launcher requires calibration or a marker-pose preflight JSON for this
preset. Both select the same code and request a 30 FPS dashboard feed.

The older typed-arm preset remains `qr-preset` / `QrPreset`. The separate
measured-marker orbit remains `qr-circle` / `QrAutoCircle`, documented in
[QR_AUTO_CIRCLE.md](QR_AUTO_CIRCLE.md).

## Verification

`tests/qr_auto_preset_sdk_test.py` runs against mocked aircraft in the installed
Pi SDK. It checks exact QR selection at different image sizes, incident-before-
takeoff ordering, one-shot execution, a complete 24-segment preset and landing
without a visible QR, cancellation, stale data, rejected moves and camera aiming.
These tests do not launch an aircraft or establish real flight-path accuracy.
