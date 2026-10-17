# QR recognition and one observation orbit

Status, 17 October 2026: software experiment, **no autonomous flight tested**.
The team's current Pi service remains the observation-only receiver. The user
confirmed an indoor cleared/netted demonstration area; the pilot landing/stop
control has **not** been tested with the Pi connected. Do not switch to flight
execution until that test and camera geometry checks have been completed.

For the full cold-start, printed-board capture, measured calibration and staged
checkout procedure, see [QR demo from everything off](QR_DEMO_FROM_OFF.md).
`bridge/calibrate_camera.py` prepares intrinsics with flight verification false;
`--checkout-one-segment` selects one chord and landing before the full orbit.
That mode is armed with `ARM QR CHECKOUT`, using the same live execution gates.

## Try recognition now, with motors disabled

On the laptop, from the repository, run:

```powershell
python bridge/qr_orbit_rehearsal.py
```

Open <http://127.0.0.1:8789/>. Keep BOSCO and its existing Pi camera receiver
running. This companion page reads `/api/session` and `/api/snapshot` from
the local backend. The token remains in memory. It makes no ingest requests,
imports no drone SDK, and cannot send flight commands. It leaves the actual
dashboard at <http://127.0.0.1:8787/> and the receiver unchanged.

1. Use the existing `dist/test-marker.html`, printed at its actual size.
2. With the aircraft grounded, show the QR code to its camera.
3. Click **Arm rehearsal**. Five distinct recognized frames spanning at least
   0.8 seconds start the animated **simulated** orbit on the companion page.
4. Reset permits another software rehearsal. No motor movement occurs.

The selected code must match `bridge/orbit-marker.txt` exactly. A different
QR code cannot trigger this session. Expiry consumes the current arming.
Stale video does not count. Rehearsal permits up to two seconds of camera age;
the flight experiment uses stricter freshness limits.

If the aircraft is off, test the same decoder against the supplied image:

```powershell
python bridge/qr_orbit_rehearsal.py --image dist/test-marker.png --port 8790
```

That page explicitly says **test image**. It proves decoding and previews the
path, not a live drone connection or a flight.

## Intended live demonstration

The pilot first establishes a stationary hover: default height 1 m above the
launch floor, with the flat QR marker 1 m ahead. The camera must face the marker.
The pilot then types `ARM QR ORBIT` in an interactive Pi terminal. Five stable,
fresh, geometrically consistent observations trigger one orbit. The aircraft
flies twelve short straight segments, turning to face the marker after each
segment, then requests landing at its current position. This is a polygonal
approximation of a circle; movement and turning are not a smooth continuous arc.

There is **no automatic takeoff**, boot-time arming, repeated circling, or QR
search flight. Losing the marker, sensor updates, link health, expected height,
or a successful movement acknowledgment requests landing. `LAND`, `X` + Enter,
the local video window's `l` key, terminal closure, or Ctrl+C requests landing.
Keyboard input requires the terminal to remain connected and responsive.
A broken radio link can prevent delivery: a software request cannot guarantee
landing. Catchable termination signals request cleanup; a hard process kill or
power loss cannot run that cleanup. A fresh aircraft `landed` event is required
before reporting success.

One arming lasts 20 seconds. The mission watchdog is 75 seconds. Defaults are
1 m radius, 1 m hover height, horizontal speed capped at 0.25 m/s and yaw speed
capped at 25 degrees/s. Accepted radius is 0.75–1.5 m and hover height 0.8–1.5 m.
Battery must be at least 40%; the flight starts only from a stable hover.
The pilot must arrange clearance beyond the planned circle and a clear landing
surface throughout it. These limits do not provide obstacle avoidance.

## What must be verified before opting into flight

1. Verify the pilot's independent landing/control path while the Pi is connected.
   The supplied controller working by itself is insufficient. Do not assume
   simultaneous controller/direct-Pi connections work. First verify command
   routing with the aircraft grounded, then conduct a supervised short hover
   and landing exercise in the prepared flight area. This repository does not
   automate that physical acceptance test.
2. Calibrate the exact decoded camera resolution at fixed zoom. Use OpenCV's
   normal camera calibration workflow with multiple checkerboard views, save
   intrinsics and distortion coefficients, and check reprojection accuracy.
   Measure the printed **black QR square**, excluding the white border, and
   camera offset from the aircraft reference. Copy
   `bridge/orbit-calibration.example.json` to a local calibration file.
   Its zero focal lengths and `measured_and_verified: false` deliberately
   prevent live execution. Do not substitute an assumed field of view.
3. With motors off, check recovered marker distances, floor orientation, gimbal
   axes and camera offset at several known positions and headings. The solver
   uses all four QR corners, calibrated PnP, gimbal absolute orientation and
   aircraft heading. It rejects ambiguous poses, inconsistent floor targets,
   wrong resolution, and excessive reprojection error. Indoor map coordinates
   and commanded odometry are never used to position this orbit.
   In a separately connected, grounded SDK session, omit `--execute` and supply
   `--camera-calibration /absolute/path/to/camera.json` to print `[POSE]` metrics
   without constructing a flight driver. This permits checking the geometry
   before marking it verified. The file must already contain measured, valid
   intrinsics; the zero-focal-length template cannot estimate a pose.
4. Complete a local copy of `bridge/orbit-preflight.example.json` after these
   physical checks. Set `checked_at_unix` to the current Unix time. These
   acknowledgments expire after one hour; they are human records, not measured
   proof or a replacement for a pilot. Recheck the actual site each session.

The separate `bridge/qr_orbit_bridge.py` is the opt-in Olympe runtime. It uses
the rich team's bridge for video/telemetry and QR overlays, and the existing
flight-event endpoint to display phases. It forces YOLO and automatic gimbal
tracking off so they cannot change the selected target/camera during the orbit.
It does not create an incident or pass synthetic coordinates into Gemini.
The usual dashboard analysis remains a separate human-reviewed operation.

For an integration engineer, after the above checks, the explicit runtime is:

```bash
# Run inside the installed Olympe SDK environment, in an interactive pilot terminal.
# The existing observation service must be stopped before this connection;
# do not run two aircraft receivers/controllers together.
python bridge/qr_orbit_bridge.py --no-window \
  --backend http://127.0.0.1:8788 --drone-id ANAFI-H084882 \
  --execute --radius 1 --height 1 \
  --camera-calibration /absolute/path/to/measured-camera.json \
  --preflight-file /absolute/path/to/current-preflight.json
```

The ingest token is read from the existing environment; never paste keys into
arguments or QR codes. The normal `Start BOSCO.cmd` never selects this runtime.
Pilot takeoff/hover and camera aiming must be arranged through the **verified**
control path before arming. If that path cannot coexist with the Pi, execution
remains blocked until a controller-mediated connection is implemented and tested.

## Integration and verification

`camera -> exact QR + corners -> calibrated marker pose -> one-shot trigger ->
bounded local flight driver -> aircraft movement acknowledgment -> new QR pose`

Gemini, TigerData, the dashboard and QR scenario metadata have no flight authority.
The QR encodes a pretend fire's data; **radius, height and speed never come from it**.
During a segment the marker may move within the image. Before another segment,
the system requires a fresh frame captured after the preceding move ended,
the marker back at the planned relative center, and an aircraft hover.
No correction/search command is sent if that check fails.

Run local checks with:

```powershell
python -m unittest discover -s tests -p '*_test.py'
npm test
```

The SDK adapter tests use a fake aircraft and additionally run inside the Pi's
actual Olympe 8.5.0 environment. They test SDK message construction, interruptible
movement expectations, landing confirmation, and motor-disabled rehearsal.
Synthetic projected-camera tests check geometry; decoding the supplied PNG
checks the actual QR algorithm. None of these constitute a flight test.

Parrot primary references: [relative moves and landing](https://developer.parrot.com/docs/olympe/arsdkng_ardrone3_piloting.html),
[extended relative moves](https://developer.parrot.com/docs/olympe/arsdkng_move.html),
[OpenCV pose estimation](https://docs.opencv.org/4.x/d5/d1f/calib3d_solvePnP.html).
Movement semantics were also checked against the installed Olympe 8.5.0
`packages/arsdk-xml/xml/move.xml` and `ardrone3.xml`; the web reference is older.
