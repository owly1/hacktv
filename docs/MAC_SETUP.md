# MacBook + Raspberry Pi drone testing

The Mac runs Node, the dashboard and Python QR/calibration tools. The existing
Linux Pi runs the team's Olympe 8.5.0 SDK. A USB-C Ethernet adapter joins them;
the Mac's Wi-Fi stays online while the Pi's Wi-Fi connects to the aircraft.
The Ethernet cable does not power the Pi: connect its own USB-C supply.

## One-time Mac preparation

Install Node 22+ and `uv` if absent, then run from this repository:

```sh
bash scripts/setup-mac.sh
.venv/bin/python scripts/mac.py doctor
```

Setup installs the Node dependencies and a local Python 3.11 environment with
OpenCV, NumPy, Segno, PyTorch and Ultralytics, plus the existing fire/smoke
model at a pinned revision with a SHA-256 check. It preserves an existing `.env`. A new `.env` receives
random, distinct local tokens; cloud credentials remain optional and must be
configured locally. No Olympe or FFmpeg installation is required on the Mac
for the Pi route. The public key is `~/.ssh/emberwatch_pi_ed25519.pub`; its
private counterpart stays on this Mac.

## Ethernet and first login

```sh
networksetup -listallhardwareports
ifconfig en8
.venv/bin/python scripts/mac.py configure --host 'fe80::2ecf:67ff:fe80:173e%en8'
.venv/bin/python scripts/mac.py authorize-pi
```

`en8` is the adapter detected on Max's Mac on 17 October 2026. Substitute the
current Ethernet interface if macOS assigns another. `status: active` means
the physical cable link is up. The configured Pi account is `pet`; `--user`
on `configure` can select a different provisioned account. The address before
`%` identifies the team's Pi; the suffix is the **Mac's** network interface.
Connection settings are saved in ignored `.pi.local`.

Run `authorize-pi` in your own interactive terminal. Verify the SSH host
fingerprint against a trusted record from the Pi owner, then enter the Pi
login password there. The command appends this Mac's public key without
replacing existing keys. A dedicated known-hosts file is saved as
`~/.ssh/emberwatch_pi_known_hosts`. Subsequent commands require that verified
identity; they do not silently accept a new or changed host key.

If you do not have a password, the Pi owner can authorize the public key using
an existing login. Do not copy their private key or send passwords in chat.

## Deploy the receiver and start the dashboard

```sh
.venv/bin/python scripts/mac.py install-pi
.venv/bin/python scripts/mac.py check-pi
npm start
```

Deployment copies source and only this Mac's ingest token over SSH into
`~/emberwatch/mac-<Mac username>` on the Pi, with owner-only credential access.
It preserves the Windows receiver files and `/home/pet/emberwatch/bridge.env`.
Repeat deployment after changing bridge source or this Mac's ingest token.
`check-pi` tests software imports without connecting to the aircraft. These
commands reuse the existing Pi SDK and maintenance helper; they do not build
Olympe or provision a blank SD card.

Open <http://127.0.0.1:8787/>. Keep that backend terminal running. In a second
interactive terminal, with the grounded aircraft powered, Skycontroller off
and FreeFlight closed on any phone:

```sh
.venv/bin/python scripts/mac.py pi
```

This defaults to observation: telemetry and camera on the Pi, with RGB/QR
fire detection on the Mac. There are no aircraft control commands. The launcher stops
the ordinary Pi observer service, checks for competing receivers, selects the
saved aircraft Wi-Fi profile and runs one foreground receiver. It maps the
Pi's **loopback** port 8788 to the Mac backend port from `.env`. A conflicting
tunnel causes startup to fail rather than reuse another laptop's connection.
Keep the terminal open; Ctrl+C stops reception. An existing flight checkout
must be stopped through its own operator terminal before changing modes.

Observation now stays running when the drone starts off or is power-cycled.
After a failed session it waits five seconds, reselects the aircraft Wi-Fi
profile (the Pi may have fallen back to another saved network), realigns the
clock and starts a fresh SDK process. A camera stream with no decoded frames
for 15 seconds also reconnects. Native SDK stalls are bounded by a 90-second
watchdog and cleanup by 15 seconds. Wi-Fi discovery/boot time adds to recovery
time. Keep the Pi powered, Ethernet connected and the Mac receiver terminal
open; neither localhost nor the QR preview needs restarting for drone cycles.
`npm start` starts only the backend; start `scripts/mac.py pi` once as well.
Flight modes are never automatically restarted or armed.

### Fire detection versus QR flight rehearsal

The Mac observation launcher also starts `bridge/fire_monitor.py`. It reads
fresh camera JPEGs and uses the shared `bridge/fire_detection.py` detector:
the existing YOLOv8 fire/smoke model plus the EW1 QR test marker. Three
distinct fresh matching frames post to `/api/ingest/detection`, activating
the incident and automatic Gemini analysis. Ongoing sightings update the
same episode every five seconds; cached/stale frames cannot trigger it.
Response-plan generation remains the dashboard's explicit action.

For a **fire response test**, show the full [fire marker page](http://127.0.0.1:8787/test-marker.html)
to the camera, with its white margin and without glare. The bare PNG has no
quiet zone; the decoder now adds a border as a fallback. No rehearsal arming
is needed to create the fire incident. The QR's fire properties feed the same
response workflow as an RGB detection; `source=qr-test` remains visible.
The QR spread map is anchored to the configured site and explicitly labeled
as a scenario position, not measured GPS. RGB detections without geolocation
still activate the incident and analysis, with no invented map coordinates.

The separate port-8789 rehearsal is a flight animation only. It does not
create fire incidents or control motors. The terminal hover/preset flight
modes remain separate and do not start the Mac fire monitor.

`GET /api/status` includes `vision`: model readiness, fresh camera status,
last detection source/time and an error indicator. The dashboard shows when
RGB classification is unavailable instead of claiming that video alone means
fire detection is active. The Mac monitor automatically resumes when the
camera returns after a drone power cycle.

Model: [rabahdev/fire-smoke-yolov8n](https://huggingface.co/rabahdev/fire-smoke-yolov8n),
revision `13017fe8af477c25f5298d168e2dfede4b000753`, SHA-256
`b91633799ceb052c814b4f8b77a37efc9a40f002d528df97d74463585fa4f28f`.
The model card reports fire/smoke training on D-Fire and AGPL-3.0 licensing.
Real RGB inference is running locally; this integration is not a field
accuracy validation of the classifier.

The first physical QR scan on this Mac created an active `qr-test`/`fire`
incident with Alpha's scenario values and two real camera sightings. It
exposed a Gemini 20-second timeout. The backend now permits 45 seconds per
attempt and retries timeouts, network failures and transient upstream errors;
the deadline also covers response-body decoding. QR detection and incident
storage were verified on hardware. A manual retry of that same incident then
completed successfully in Gemini, producing Alpha's 120-ha extreme-intensity
scenario assessment and east-northeast spread outlook. Automatic triggering
is covered by the isolated integration test; a second physical automatic
analysis after the timeout fix has not yet been verified. The full local suite currently has 46 passing
Node tests; Python has 54 passes, 31 SDK skips and the pre-existing macOS
`PENDIN` terminal restoration failure.

If the observer was started by Codex or another terminal, stop this Mac's
observation session before starting your own:

```sh
.venv/bin/python scripts/mac.py stop-observer
```

This only interrupts `anafi_observer.py` in this Mac's Pi deployment directory.
It also cancels this checkout's automatic retries, even while the drone is off.
Flight sessions must be controlled from their own terminal. Startup synchronizes
the Pi clock after joining aircraft Wi-Fi so Internet time synchronization does
not make camera captures appear to come from the future.

Check advancing camera timestamps in the dashboard. A running process alone
does not establish fresh video, telemetry or successful flight.

If the Pi can ping the aircraft but SDK discovery or reconnection fails, check
that the Skycontroller is still off and FreeFlight is closed before retrying.
On this setup, a failed connection recovered after both were turned off.

## QR recognition and independent flight testing

For the browser preview while observation is running:

```sh
.venv/bin/python scripts/mac.py rehearsal
```

Open <http://127.0.0.1:8789/> and show the [printed marker](http://127.0.0.1:8787/test-marker.html)
to the grounded aircraft camera. **Arm rehearsal** starts only the animated
preview. `rehearsal --test-image` tests the supplied PNG without any aircraft.

To test the Pi's current preset recognition, first stop the observation
receiver, then run:

```sh
.venv/bin/python scripts/mac.py pi --mode qr-preset
```

Type `ARM QR PRESET`. Without `--execute`, this reports rehearsal recognition
without sending motor commands. For operator-controlled physical testing,
follow [the short hover procedure](TERMINAL_FLIGHT_TEST.md) and
[the preset guide](QR_PRESET_DEMO.md), using these Mac equivalents:

```sh
.venv/bin/python scripts/mac.py pi --mode hover --execute
# Type TAKEOFF TEST for the short hover; X/Esc requests landing.

.venv/bin/python scripts/mac.py pi --mode qr-preset --execute
# Type ARM QR PRESET; recognition can then initiate takeoff.
```

Run only one mode at a time. The existing typed arming, flight limits and
landing controls remain in the Pi programs. The real preset circle and X-key
landing still need physical acceptance; laptop software checks do not verify
them. `--native-video` preserves native camera dimensions for calibration.

## Checks

Verified on Max's Mac on 17 October 2026: key-authenticated SSH over `en8`,
Pi Olympe/OpenCV imports, and the actual ANAFI camera and telemetry through
the Mac's authenticated backend. Video decoded at 640 × 360 and about 8.5 FPS;
successive capture timestamps and image contents advanced. The aircraft
reported 87% battery, zero height and zero ground speed during this check.
No takeoff or movement commands were sent.

Later that evening, a physical drone off/on cycle recovered automatically:
the status changed from `live` to `disconnected` and back to `live`, video
returned at 8–9 FPS and the QR preview resumed without errors. The same Node
backend process and Mac observation supervisor remained running throughout.
The recorded camera interruption was about 52 seconds including power-off,
boot and Wi-Fi discovery; recovery is not instantaneous. Regression checks:
43 backend tests and 15 targeted observer/launcher tests pass.

```sh
npm test
.venv/bin/python -m unittest discover -s tests -p '*_test.py'
```

SDK tests are skipped on macOS and need the Pi's SDK environment. The existing
terminal-restoration test can differ on macOS's OS-managed `PENDIN` flag;
investigate that separately from the Linux flight runtime. No flight test is
performed by the setup or unit tests.

## Autonomous one-metre QR circle

For the QR-as-demo-trigger workflow, use `pi --mode qr-demo --execute`, described
in [Automatic QR demo preset](QR_AUTO_DEMO.md). The selected QR creates a fire
incident, then starts a fixed one-metre-radius circle relative to launch heading
and lands. This preset needs no camera calibration, QR-size or camera-offset
measurement. Without `--execute`, it only creates the incident. Stop the
observation receiver before starting either flight runtime.

The separate `qr-circle` flight mode is described in
[Automatic QR fire circle](QR_AUTO_CIRCLE.md). It uses the measured marker
position and the normal fire-incident pipeline. `--execute` enables automatic
takeoff on recognition; stop the observation supervisor first. It requires
measured calibration and a current physical preflight. The observer remains
read-only and is the only mode that restarts automatically.

### Calibration capture with visible feedback

Use the native-resolution observer. The browser capture page avoids a second
interactive terminal and shows both the live image and the exact rejected or
accepted photo:

```sh
.venv/bin/python bridge/calibrate_camera.py capture --web --directory anafi_out/calibration-browser
```

Open <http://127.0.0.1:8791/> and click **Capture photo** for each view. Count the
squares on your actual sheet: the default is 10 across and 7 down (54 inner
corners); a 12 × 7 sheet needs 11 × 6 inner corners. Board dimensions
can be selected before the first accepted photo. Dimensions are saved with the
session and automatically used by `fit --directory anafi_out/calibration-browser`.
Browser capture saves every fresh, matching-resolution photo, even when the
checkerboard is not detected. Saved count and detected count are shown separately;
the fitter searches the saved images again and uses views with detected corners.
The terminal capture mode saves `last-attempt.jpg` and prints its path on rejection.
The detector uses CPU processing, lighting normalization and a classic-corner
fallback. Calibration quality and physical verification requirements remain.

Attach the paper flat to a rigid board before capture. Bending paper changes the
geometry even when every corner is detected. Vary tilt, distance and position;
include the left, right, upper and lower portions of the image. Twenty detected
photos do not guarantee a valid fit: coverage and reprojection error are checked
separately. Preserve a failed set for diagnosis and choose a new `--directory`
for replacement photos. Restarting the browser command with the same directory
restores its saved board dimensions and photo count without overwriting views.
The browser defaults to 50 photos. To append 50 to an existing 20-photo set, run
the same command with `--photos 70` (the target is the total, including existing
photos). The larger target is saved and restored on future restarts.
The page shows horizontal and vertical board-position coverage after each photo.
Use **Start new photo set** to create a separate retake folder without deleting
previous photos or needing another terminal. Its path is shown on the page; use
that path with `fit --directory` or to resume the new set after a server restart.

The calibration preview streams the backend's original MJPEG frames continuously,
without polling or JPEG re-encoding. Its FPS label measures incoming backend
frames. The Mac observation receiver defaults to `--camera-fps 0` (all frames it
can process); native resolution is preserved with `--native-video`. Actual FPS
depends on the aircraft stream, Pi decoding/encoding and connection. Direct
observer launches can explicitly throttle with `--camera-fps 0.5` through `60`.
