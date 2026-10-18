# QR circle and person-search descent

**Opt-in experimental runtime. The combined physical maneuver has not been
flight-validated. Merging this code does not establish production flight readiness.**

The combined runtime is `bridge/qr_dive_response.py`. It owns one SDK connection
and starts disarmed. Do not run the standalone dive receiver alongside it.
GPS contour flight is a separate mode and is unavailable on this receiver.

## This provisioned Windows laptop and Pi

Keep the ANAFI landed during receiver setup. Power on the ANAFI, leave the
Skycontroller off, and connect/power the Pi's USB Ethernet link. End the old
flight session and confirm touchdown before stopping its receiver. If the old
managed receiver is still running, stop `bosco-response.service` from its Pi
owner session with `systemctl --user stop bosco-response.service`.
Stop the previous laptop backend and QR detector in their owner terminals.
Port 8787 must serve this checkout; a browser refresh cannot update an older
backend's in-memory routes. Normal `npm start` does not enable this new
backend person worker: use the combined launcher below.

In terminal 1, from this repository:

```powershell
npm ci
node scripts/qr-dive-demo.mjs
```

The existing private `.env` must contain distinct ingest/dashboard tokens
matching the provisioned Pi. The local prepared checkout already has a copy
of this laptop's private configuration. Keep `.env` out of Git.

In terminal 2, use the laptop Python with OpenCV and NumPy installed:

```powershell
node --env-file=.env scripts/vision.mjs --flight-targets --no-people
```

`PYTHON` selects the Python executable; `PYTHONPATH` can supply its installed
OpenCV dependencies. The separate backend worker runs real COCO-SSD person
inference on relayed RGB images. Thus `--no-people` here prevents duplicate
person inference on the latency-sensitive QR process; it does not disable
the backend person worker. The person model needs internet to load its
pretrained weights initially. Wait for **Person detection active** after
video starts. A failed, loading or stale detector blocks D.

In terminal 3:

```powershell
.\scripts\Start-QrDive.ps1
```

This provisioned-Pi launcher checks dashboard compatibility, rejects active
flight ownership, copies source into `/home/pet/emberwatch/qr-dive`, verifies
the existing tunnel points to this backend (or creates a missing reverse
tunnel), checks landed state and verified calibration, stops the known
observer, and starts the combined receiver OFF. It reuses this laptop's
existing trusted Pi SSH identity. `-PiAddress` can override adapter detection.
Keep all three terminals and the controlling dashboard open.

## Operate

1. Open `http://127.0.0.1:8787/?live-demo`. Select Live, not Replay.
2. When the flight receiver is ready, click **Start BOSCO** for the circular
   response. This explicitly enables flight. Present the repository's Alpha
   fire QR (`dist/test-marker.html`) in the drone camera. A confirmed accepted
   QR and all existing calibration/sensor gates trigger one takeoff and circle.
3. In **Person-search descent**, choose a height (default **0.4 m above
   takeoff**). This is not measured terrain clearance. Wait for D to become
   enabled and **Person detection active**.
4. Press **D** with the dashboard focused outside a text field, or click
   **D · Dive & search**. The orbit releases piloting and the QR camera worker
   releases its gimbal commands. The aircraft must settle into measured hover
   before descent begins.
5. The receiver descends in measured steps of at most 0.2 m at a requested
   vertical limit of 0.2 m/s, aims the camera to -10°, and sweeps 360° in
   measured turns of at most 45°. Each stationary view needs a newly captured
   frame with completed person inference. It then returns to the measured
   starting height and restores camera pitch and the previous vertical limit.
6. It reacquires a fresh measured QR position before resuming circling. If QR
   geometry is unavailable, it holds while reacquiring; it does not resume
   from pre-search position memory.
7. Press **X** or click **LAND** at any point to request landing. Confirm
   actual touchdown; sending LAND or closing a terminal is not confirmation.

Normal battery reserve remains 40%. Until-stop removes the old 5-minute circle
timer, not battery, sensor/video, connection or operator guards. Each search
has its own 120-second maximum and requires both the original flight lease
and its browser-owned D lease. Loss of permission, inference or measured
movement confirmation ends the search and requests landing. There is no
automatic person pursuit, impact dive, rescue dispatch or thermal sensing.

The panel reports actual phases, completed/failed outcomes and camera
observations. Repeated sightings may represent the same person. The isolated
backend search observations do not fabricate geographic person coordinates.

## Verification and limits

Automated checks use fake aircraft/SDK drivers and isolated HTTP servers.
They cover circle cleanup before search, all eight search views, measured
return, fresh-QR reacquisition, lost leases, failed motion/inference, X and
dashboard input/Replay guards. The real model was also executed on a QR-only
fixture with zero person detections while the HTTP event loop remained free.
That verifies execution, not person-detection accuracy or physical maneuver
performance. This combined runtime has not been deployed or flight-tested.

## Windows duplicate detector recovery

An older monitor used a truncating lock-file open. Starting another copy on
Windows could fail with `PermissionError` before reporting that the detector
was already running. The updated monitor opens without truncation, locks
first, and reports the existing owner. The laptop deliverable wrapper also
reuses the same checkout's already-running flight-target detector.

If old detectors remain running and `/api/dive` returns 404, port 8787 is
still serving an older backend. Keep the aircraft landed and BOSCO OFF.
From the task's `outputs` folder, manually run `./Reset-QR-Laptop.ps1`, then
restart Dashboard, Detector and Receiver in separate terminals with
`./Run-QR-Circle-Dive.ps1 -Part <part>`. Reset checks the local flight session
is disabled and stops only the identified laptop backend/detectors. It does
not connect to the Pi. No administrator launch or lock-file deletion is needed.
