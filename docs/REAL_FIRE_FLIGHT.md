# Physical 100 m real-fire buffer controller

This separate terminal runtime commands the aircraft to retreat and then
monitors the fire continuously, issuing more outward movement when the observed
extent grows. The target is **100 m between the aircraft and the estimated
fire edge**, not 100 m from the centre. The dashboard advice is no longer the
only implementation of real-fire standoff.

The indoor demo remains `QrFireSize` / `qr-fire-size`: recognize the selected
QR, take off when explicitly enabled, back away to its scaled radius, orbit
once and land. The 120 ha QR still selects 1.25 m from its centre. **No real-fire
100 m rule is applied to QR scans.** See [QR_FIRE_SIZE.md](QR_FIRE_SIZE.md).

## Physical control sequence

1. Start `bridge/real_fire_bridge.py` with an explicit mission configuration.
   Without `--execute`, no aircraft movement or landing command is permitted.
2. Execution requires a paired SkyController 3, an interactive terminal, a
   recent physical preflight for the exact mission configuration, and the real
   fire model. Ordinary observation/dashboard startup never selects this mode.
3. The pilot establishes a stationary hover within the verified altitude and
   flight area. There is **no automatic takeoff**. Type `ARM FIRE BUFFER` to
   authorize one session. Five distinct post-arm real-fire frames over at least
   0.8 seconds must confirm the selected extent before movement begins.
4. Project all four detection-box corners onto the mission's surveyed ground
   plane. The control boundary is a circle enclosing all projected corners.
   This is more conservative than the dashboard's equivalent-area circle.
5. Target centre distance is enclosing radius + **100 m** + configured combined
   uncertainty allowance + **2 m** control margin. The allowance must bound the
   mission's camera, terrain, GPS, alignment and capture/response error; the
   supplied example values are not measured calibration.
6. Move radially away in horizontal steps no longer than 1 m, at no more than
   0.5 m/s. Heading/altitude are not intentionally changed. Each move requires
   SDK acknowledgement and measured displacement within 20 cm horizontally,
   10 cm vertically and 0.1 rad yaw. The controller then requires newer fire
   and GPS/pose feedback and a settled hover before another step.
7. At the target, remain in observation and continue checking the boundary.
   Growth can initiate another retreat; shrinkage never causes an approach.
   The session ends on cancellation or its configured travel/time budget.

The controller checks the **full required target**, not just the next short
step, against the configured circular flight area. The complete area/corridor
must have been checked clear. There is no autonomous obstacle avoidance.

## Abort and operator control

- `HOLD` or `ABORT` latches the retreat session stopped. Restart deliberately
  to re-arm; new observations or reconnection never resume a failed mission.
- X/Esc or `LAND` explicitly requests landing. The operator chooses when a
  landing is appropriate. Only a landed event is reported as confirmation.
- Ctrl+C, terminal closure, loss of fire/pose, GPS, video, sensor events, wind
  availability, battery margin or control authority stops autonomous retreat.
  It does **not** automatically land into an unverified location near a fire.
- A stop sends a zero-distance `moveBy` to interrupt the relative move and
  requires a fresh hover event. Cancelling a Python expectation is not counted
  as stopping the aircraft. Failure is reported as `STOP UNCONFIRMED`; pilot
  intervention is required. A lost link can prevent command delivery.
- Source handoff does not switch piloting authority or send motion against
  a changed source. One SDK owner is retained; used sessions never reconnect.

The interruption behavior follows Parrot's documented rule that a second
relative move interrupts the preceding move ([Piloting API](https://developer.parrot.com/docs/olympe/arsdkng_ardrone3_piloting.html)).
The zero-move stop and controller override must be physically checked on the
specific aircraft/firmware before the execution preflight can be completed.

## Required evidence and limits

Real `yolo` / `fire` detections with confidence at least 0.8 are required. QR,
smoke, replay, unlocated sightings, clipped boxes, wrong camera resolution,
near-horizon rays and simulated GPS cannot drive this controller. The fire
must remain visible; no blind search or continued retreat on expired geometry
is allowed. A large centre jump or confirmation gap stops the session.

Camera and pose must align within 0.5 seconds. At processing, frames must be
at most 0.75 seconds old. During motion, required pose/GPS/wind events and fire
geometry expire after 1.5 seconds; battery events expire after 10 seconds.
The runtime timestamps actual sensor events, not repeated SDK cache reads.
It requires an available fresh FC wind estimate, GPS fix, at least 40% battery,
level attitude, and the configured altitude/wind/speed envelope. Missing
measurements block motion rather than being filled with defaults.

Camera yaw/roll alignment is checked at each detection. Ground height, camera
field of view, native resolution, distortion/offset effects and combined error
must be verified for the mission. The pinhole flat-ground model cannot establish
a complete real wildfire perimeter from a partially occluded RGB image.

If the aircraft overlaps the uncertain fire extent or the buffer target lies
outside the verified area, the controller stops and requests operator
intervention. It does not invent an escape route. It cannot guarantee a 100 m
physical clearance when the fire is obscured, grows faster than the drone can
retreat, exceeds its flight envelope, or violates the configured error bound.
This is an experimental control implementation, not validated wildfire autonomy.

## Configuration and entry point

Use a complete repository checkout in the configured Linux Olympe environment;
this mode is intentionally not added to the indoor demo launcher menu.
Stop other receivers first. Local process guards reject another receiver;
physical preflight must also verify no other computer owns the aircraft.

Create ignored local configuration files from
`bridge/real-fire-config.example.json` and
`bridge/real-fire-preflight.example.json`. Replace example geometry with measured
values. Record actual checks, their Unix time and the **exact** configured
`limits` object in preflight `mission_limits`. The shipped false/empty examples
cannot authorize movement. Preflight expires after one hour and is rechecked
at arming; changing configuration requires restart.

Read-only configuration/recognition session:

```sh
python bridge/real_fire_bridge.py --controller skycontroller3 \
  --mission-config bridge/real-fire-config.local.json \
  --model /path/to/fire-smoke-yolov8n.pt
```

After actual configuration and physical checks, an explicitly enabled session:

```sh
python bridge/real_fire_bridge.py --controller skycontroller3 \
  --mission-config bridge/real-fire-config.local.json \
  --preflight-file bridge/real-fire-preflight.local.json \
  --model /path/to/fire-smoke-yolov8n.pt --execute
```

Optional `--backend` uses the existing `INGEST_TOKEN` and incident/telemetry/
flight-status APIs. HTTP work is off the movement thread. This script owns
both detection and aircraft control; do not run another aircraft receiver or
duplicate detector against its stream.

## Verification

Run `python -m unittest discover -s tests -p 'real_fire*_test.py'`.
The tests numerically integrate a simulated aircraft's movement to the buffer,
enlarge the fire and verify a second retreat, check no approach on shrinkage,
and cover confirmation, time/travel limits, geofence, loss, cancellation,
movement acknowledgement, physical-stop commands and explicit-only landing.
Adapter tests inject a fake SDK surface and never connect to an aircraft.
SDK compatibility, actual stop behavior and camera/range accuracy still require
the staged hardware checks. The branch has not been deployed or flown.
