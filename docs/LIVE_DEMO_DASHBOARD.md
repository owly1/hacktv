# Live detection dashboard

On `dive-dashboard`, the laptop monitor also recognizes **actual people** in
the incoming video. Random people exist only in historical Replay cases.

Install the existing laptop inference dependencies and provide a YOLO model
containing a `person` class. The default path is
`~/emberwatch-models/yolov8n.pt` (the same COCO person model used by the full
ANAFI bridge). Use `npm run vision -- --person-model /path/to/yolov8n.pt`
to choose an installed file. Missing weights are reported as unavailable;
the monitor never substitutes fictional detections. `--no-people` disables
person recognition while retaining the fire/QR monitor.

With the observer streaming, run `npm run live-demo` and `npm run vision`.
The existing Mac observation launcher also starts this monitor automatically;
run only one monitor/receiver for that stream. Full ANAFI bridge users already
have a separate person detector and need not run a second laptop detector.

Three distinct fresh frames confirm a person camera track. Every two seconds
the monitor posts its evidence, with a crop and synchronized pose when
available (within two seconds of the frame; an explicitly absent GPS fix
cannot supply GPS coordinates). Located leads go through the existing uncertainty/multi-view
pipeline, map markers, acknowledgement and closure. Without usable pose, or
when the camera ray cannot meet the ground, the dashboard records a
**location unavailable** camera sighting with no map pin. It can be reviewed,
acknowledged, closed and exported. If that same camera track later acquires
usable pose, its unlocated note is replaced by the located lead.

Camera tracks are candidate observations, not a verified count of distinct
people. Person detection does not require an active fire; people surrounding
the drone can be recorded before the fire/QR incident arrives. The monitor
does not command takeoff, navigation or entry into fire. Existing fire
location demo anchoring never supplies a geographic pose for real people.
Located and unlocated observations persist in `data/people/state.json`.

The live demo runs the existing workspace with real camera frames, telemetry
and confirmed QR/fire/smoke incidents. It never starts a flight or selects a
historical case. Replay remains available through the Replay button.

## Start

1. Run `npm install`, copy `.env.example` to `.env` if needed, and configure
   distinct `INGEST_TOKEN` and `DASHBOARD_TOKEN` values. Keep the laptop and
   Pi clocks aligned. Set `DATABASE_URL` for optional durable TigerData storage.
   The monitoring dashboard does not require Gemini.
2. Run `npm run live-demo`. It starts or reuses the backend and opens
   `http://127.0.0.1:8787/?live-demo`. The Live demo button also enables this
   view from the existing dashboard. `--port 9000` is supported; the receiver
   and detector must use the same backend port.
3. Start your existing Pi observer or ANAFI bridge. Live demo does not change
   that connection or any aircraft controls.
4. For the observation-only receiver, run `npm run vision` in a second
   terminal. This starts laptop inference with smoke enabled, loads tokens
   from `.env` and uses the project's `.venv` when available. `PYTHON` can
   select another interpreter. Model weights default to
   `~/emberwatch-models/fire-smoke-yolov8n.pt`; override with
   `npm run vision -- --model /path/to/weights.pt`.

For QR-only testing, create a `.venv` and install
`opencv-python==4.11.0.86 numpy segno`. For RGB inference also install the
dependencies in `bridge/requirements-laptop.txt` and provision the existing
fire model using `scripts/setup-fire-model.py`. Missing weights leave QR
recognition available and are reported in detector health.

The Mac observation launcher already runs a monitor. Do not start another
against the same checkout. To include smoke there, set
`EMBERWATCH_DETECT_SMOKE=1` before launching observation. The full ANAFI
bridge has its existing `--detect-smoke` option. QR/fire detection defaults
are unchanged outside the explicit vision demo command.

## What happens on detection

- Each fresh inference publishes boxes through authenticated
  `POST /api/ingest/overlays`; the backend adds them to the MJPEG stream.
  Empty results clear the box, old results cannot replace newer results,
  and a box expires within two seconds if inference stops. These previews
  do not create incidents or refresh camera freshness/FPS.
- Three distinct QR frames or five overlapping fire/smoke frames confirm
  an incident. The existing detection endpoint stores it without starting
  Gemini scene analysis. Scene analysis has been removed from replay/live
  dashboards; incident questions and response planning are removed as well.
  Repeat sightings keep the
  incident current without resetting operator changes to the timeline.
- The fire summary shows the source, area, fuel, spread rate and conditions.
  The QR payload drives the initial 120 ha Alpha scenario: 35 m/min,
  30 km/h toward 60°, 31 °C and 18% RH. Other QR codes remain ignored.
  A Gemini stabilization wind estimate does not replace encoded QR weather.
- For laptop RGB detections, a usable telemetry position, heading, gimbal
  angle and altitude produce a flat-ground camera-ray estimate and initial
  fire area. Unknown pose, a horizon-facing camera or excessive range leave
  the detection unlocated. Altitude is above takeoff, so terrain can make
  this estimate inaccurate.
- In Live demo, an unlocated incident is projected at `SITE_LAT`/`SITE_LON`.
  The banner, location summary, map popup, spread projection and exported brief
  label it as a scenario location. Captured incident coordinates stay null.
  Disable Live demo to wait for a measured/estimated location instead.
- Timeline playback, presets, condition edits/reset, map layers, full-screen
  panels, rescue leads and brief export remain available. Analysis, Q&A and
  response-planning controls are removed in both live and replay; no dashboard
  requests are sent to Gemini.

## Check the demo

Show `dist/test-marker.html` to the camera. Confirm the rectangular QR box,
advancing capture clock, live altitude/speed/power/state, Alpha conditions,
and an expanding map outline at +30/+60 minutes. Adjust wind in Conditions,
then reset to the detected conditions. Remove the marker: the box clears
while the confirmed incident remains available for monitoring. Dismiss it
with Mark false alarm when finished.

Switch into Replay and back to Live demo to verify the original cases,
person search and flight-pattern animation. Live results from another
incident or a request finishing in the background cannot overwrite the
selected replay's camera, telemetry or rescue leads.

Automated checks: `npm test` and
`python -m unittest discover -s tests -p 'fire_monitor_test.py'`.
