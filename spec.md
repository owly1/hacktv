# Spec: QR-anchored orbit loop with hotkey dive

Status: **proposed, not implemented, not flight-tested.** Written 17 October 2026
against `main` at `336fae7`. This builds on the existing QR preset and the
calibrated-pose code; it does not replace `qr_preset_demo.py`.

## 1. Goal

1. The drone sees the selected QR code (the stand-in "fire", placed at the
   laptop).
2. It takes off, climbs to an orbit height, and flies a **1 m-radius circle
   around the QR code**, nose and camera pointed at the code.
3. It keeps circling, lap after lap, until the operator presses the **stop
   hotkey**.
4. When the operator presses the **dive hotkey**, it drops toward the fire,
   holds low and close for a few seconds while running **person detection**,
   then climbs back and resumes the orbit.
5. `X`/`Esc` lands immediately at any time, exactly as today.

The difference from the current preset is that the circle is centred on the
**measured QR position**, not on a spot the operator lined up by hand, and the
drone corrects its radius during the loop whenever it can see the code.

## 2. What the repo already gives us

| Need | Existing code | Reuse |
|---|---|---|
| QR decode + `EW1:` check | `fire_detection.py` `FireDetector`, `parse_marker` | as is |
| Arm + 5 fresh frames = one trigger | `qr_preset_core.RecognitionTrigger` | as is |
| QR position relative to the drone | `qr_orbit_pose.CalibratedPose.estimate` → `Marker(forward_m, right_m, down_m, …)` | needs the calibration the team is doing now |
| Circle geometry facing the centre | `qr_orbit_core.polygon` (chord forward/left + yaw 360/N) | generalise to start from any angle |
| Bounded relative move | `qr_orbit_bridge.OlympeOrbitDriver.move` (`extended_move_by` + `moveByEnd` check) | add a per-move timeout and vertical-speed argument |
| Landing that waits for `landed` | `OlympeOrbitDriver.land` | as is |
| Takeoff → hover → hand-off hook | `hover_checkout.HoverCheckout._hover` / `_after_hover` | as is |
| Health checks | `qr_orbit_core.vehicle_reason`, `HoverCheckout.checkout_reason` | new height bands |
| Instant landing key | `terminal_controls.CommandInput` (X/Esc wins over everything) | add S and D |
| Phase reporting to dashboard | `Publisher.flight` → `/api/ingest/flight` | add two phases (§9) |

Things the current code deliberately does **not** do and this spec adds:
continuous laps, a flight longer than 90 s, a height above 1.5 m, vision
correction during the circle, a descent below orbit height mid-flight, and
person detection.

## 3. Physical setup

### 3.1 Marker placement (decide before coding)

`CalibratedPose` currently rejects any marker that is not **flat on the floor**
(`tilt <= 12°`). That matters for "circle the laptop":

| Option | How | Visible during orbit | Code change |
|---|---|---|---|
| **A (recommended)** | 18 cm printed QR laid flat on the floor (or on a box) right in front of the laptop | all 360°, with the gimbal pitched down | none to the pose check |
| B | QR shown on the laptop screen, upright | only about ±60° in front of the screen; behind the laptop it is hidden | add a vertical-target mode to `CalibratedPose`, run odometry-only for the hidden ~240° |

Use **A** for the demo. The orbit centre is the QR, so the laptop sits at the
centre too and the drone circles both. B stays out of scope until A has flown.
Use the printed marker from `/test-marker.html` at 100% scale; its black square
must measure what `qr_black_square_side_m` says in the calibration file.

### 3.2 Space

- Circle diameter 2 m plus aircraft size (about 0.3 m) plus 1 m clearance: keep a
  **clear 4.5 × 4.5 m square** around the marker, and the 10 × 10 × 10 m netted
  area the team already uses.
- Nothing taller than 0.5 m within 1.4 m of the marker except the laptop.
  The dive (§6) comes down to 0.7 m beside the marker; the laptop lid must stay
  out of that path.
- Launch point: **1.5 m to 2.0 m** from the marker, anywhere around it, nose
  roughly toward it. The code measures the real offset; it does not need to be
  exact.

### 3.3 Why these heights and angles

The 18 cm marker reads reliably from 0.8–2.0 m (`TEAM_AI_CONTEXT.md` §2). On
the circle the camera-to-marker slant range is `sqrt(R² + h²)` with `R = 1 m`:

| Orbit height h | Slant range | Gimbal pitch to centre the marker `-atan(h/R)` |
|---|---|---|
| 1.0 m | 1.41 m | −45° |
| **1.5 m (default)** | **1.80 m** | **−56°** |
| 1.7 m (maximum) | 1.97 m | −60° |

Above about 1.7 m the marker drops out of reliable range, so 1.7 m is the hard
ceiling for this mode. The gimbal is set once after the climb and recomputed
from the measured height; it is not moved during laps.

## 4. Configuration

A new `LoopLimits` dataclass (same validation style as `qr_orbit_core.Limits`,
which stays unchanged for the preset). Values outside the range raise
`ValueError` at start-up.

| Field | Default | Allowed | Meaning |
|---|---|---|---|
| `radius_m` | 1.0 | 0.75–1.5 | orbit radius about the QR centre |
| `orbit_height_m` | 1.5 | 1.0–1.7 | height above takeoff during laps |
| `segments` | 12 | 12–24 | chords per lap (12 → 0.52 m chords) |
| `speed_mps` | 0.25 | 0.1–0.3 | horizontal speed on chords |
| `climb_mps` | 0.3 | 0.1–0.5 | vertical speed for climbs |
| `dive_height_m` | 0.7 | 0.5–1.0 | lowest height in the dive |
| `dive_standoff_m` | 0.5 | 0.4–0.8 | horizontal distance from the QR at the bottom of the dive |
| `dive_descent_mps` | 0.4 | 0.2–0.5 | vertical speed going down |
| `dive_dwell_s` | 4 | 2–8 | time held at the bottom running person detection |
| `max_flight_s` | 300 | 60–600 | total airborne time cap |
| `min_battery_start_pct` | 50 | 40–100 | needed to arm |
| `min_battery_lap_pct` | 35 | 30–60 | no new lap or dive below this; stop and hover |
| `land_battery_pct` | 25 | 20–40 | land immediately below this |
| `blind_segments` | 4 | 2–6 | chords in a row without a usable marker before the loop stops |
| `max_correction_m` | 0.15 | 0.05–0.2 | largest radial correction folded into one chord |
| `max_correction_deg` | 10 | 3–15 | largest yaw correction per chord |

CLI: `python bridge/qr_orbit_loop.py --calibration <file> [--execute] [--radius 1] [--orbit-height 1.5] [--max-flight 300]`.
Same rules as the preset: direct Pi link only, interactive TTY, `INGEST_TOKEN`
when `--backend` is set, no `--demo-flight`, no `--gimbal-pitch`.

## 5. States

```text
DISARMED --ARM ORBIT LOOP--> ARMED --5 fresh QR frames--> TAKEOFF --hovering--> CLIMB
CLIMB --at orbit height, gimbal set--> ACQUIRE --pose median ok--> ENTRY --on circle--> ORBITING
ORBITING --S--> HOLD          ORBITING --D--> DIVE_DESCEND --> DIVE_DWELL --> DIVE_ASCEND --> ORBITING
HOLD --D--> DIVE_* --> HOLD    HOLD --S again or hold timeout--> LANDING
any airborne state --X/Esc, LAND, Ctrl+C, watchdog--> LANDING --landed event--> LANDED (process exits)
```

| State | What happens | Exits |
|---|---|---|
| `DISARMED` | Receiving video and telemetry only. Without `--execute` the whole run stays here or in a rehearsal of the next steps, with no flight driver built. | `ARM ORBIT LOOP`+Enter |
| `ARMED` | `RecognitionTrigger` with a 20 s window. Grounded checks from `checkout_reason(starting=True)` must pass. Battery ≥ `min_battery_start_pct`. | trigger → `TAKEOFF`; expiry/cancel → `DISARMED` (consumed, restart needed, as today) |
| `TAKEOFF` | `TakeOff`, wait for `hovering` (10 s timeout), the same as `HoverCheckout._hover`. | `hovering` → `CLIMB` |
| `CLIMB` | `move(0, 0, -(orbit_height - measured_height), 0)` at `climb_mps`. Then `gimbal.set_target` pitch `-atan(h/R)` from the **measured** height. | height within ±0.15 m → `ACQUIRE` |
| `ACQUIRE` | Up to 5 s: collect ≥ 5 fresh poses from `CalibratedPose.estimate`. Use the **median** of `forward_m`, `right_m`. Reject if poses spread > 0.08 m. If the QR is not in view, yaw in 30° steps up to ±90°, then give up. | good pose → `ENTRY`; none → `LANDING` |
| `ENTRY` | See §5.1. | on circle → `ORBITING` |
| `ORBITING` | Laps of `segments` chords (§5.2), forever, until a hotkey or a watchdog. Each completed lap reports `lap n`. | S → `HOLD`; D → `DIVE_DESCEND`; blind/battery/time → `HOLD` or `LANDING` |
| `HOLD` | Firmware hover where it is, facing the QR. Times out after 30 s. | D → dive; S or timeout → `LANDING`; `R`+Enter → back to `ORBITING` |
| `DIVE_*` | §6. | back to the state the dive came from |
| `LANDING` | `driver.land()`: repeat `Landing` every 2 s until a `landed` event, 20 s max. | `LANDED` or `LANDING UNCONFIRMED` error |

One armed session per process, as with the preset. After `LANDED` the program
exits; restart it for another flight.

### 5.1 Getting onto the circle

From the acquired pose (level body frame, x forward, y right):

```text
d   = hypot(forward_m, right_m)         # horizontal distance to the QR
b   = atan2(right_m, forward_m)         # bearing to the QR, radians
yaw b                                    # face the QR
move forward (d - R)                     # negative = back away
```

- Reject `d < 0.6 m` or `d > 2.5 m` (too close to start, or beyond reliable read range): land.
- Split the forward move into chords of ≤ 0.5 m with a pose re-check after each.
- After entry, re-measure. Radius error must be ≤ 0.15 m and bearing error ≤ 10°, else one more correction, else land.

### 5.2 One chord, with correction

The current `polygon()` already gives the right shape: with the QR straight
ahead at distance R, a chord of `(R(1−cos θ), −R sin θ, 0)` followed by a yaw
of `θ = 2π/N` keeps the drone on the circle and facing the centre (it circles
counter-clockwise seen from above). The loop adds a correction from the last
fresh pose before each chord:

```text
d, b   = measured distance and bearing to QR (from the newest pose < 0.5 s old)
e_r    = clamp(d - R, ±max_correction_m)          # + means too far out
e_yaw  = clamp(b, ±max_correction_deg)
chord  = (R(1-cos θ) + e_r, -R sin θ, h_target - h_measured, θ + e_yaw)
```

- The vertical term holds the orbit height (clamped to ±0.1 m per chord).
- If no fresh pose exists, fly the plain chord and count a **blind segment**.
  `blind_segments` in a row → `HOLD` and report "marker lost". Five more
  seconds without it → `LANDING`. Never search for it.
- A pose must come from a frame captured **after** the previous move finished
  (same rule as `fly_once`), so a stale frame never steers.
- After each chord wait for hover (`vehicle_reason(starting=True)` with the
  orbit height band), 2 s max, as `fly_preset` does.
- One lap at defaults: 12 × (2.1 s move + ~1 s settle) ≈ 35–40 s.

## 6. Dive (person-detection pass)

"Dive" means a **fast, controlled descent toward the fire**, not cutting
motors. It is always flown with `extended_move_by` and ends in a hover.

Accepted in `ORBITING` (taken at the end of the current chord) and `HOLD`.
Ignored with a message in every other state.

```text
from the circle (facing the QR, distance d, height h):
DIVE_DESCEND  move forward (d - dive_standoff_m), down (h - dive_height_m),
              at speed_mps horizontal and dive_descent_mps vertical, one move
              ⇒ 0.5 m from the QR, 0.7 m up, camera still on it
              gimbal pitch → -atan(dive_height_m / dive_standoff_m)  (about −54°)
DIVE_DWELL    hover dive_dwell_s; run the person detector on every new frame;
              keep running QR pose to check the standoff stays ≥ 0.4 m
DIVE_ASCEND   exact reverse move back to (d, h); gimbal back to the orbit pitch;
              re-measure the pose; resume ORBITING at the same angle
```

Guards specific to the dive:

- Before descending: fresh pose, battery ≥ `min_battery_lap_pct`, at least
  20 s left before `max_flight_s`. Otherwise refuse and stay where it is.
- Measured height below `dive_height_m − 0.15 m` at any point: stop the
  descent, climb to `dive_height_m`.
- Measured standoff below 0.4 m during the dwell: back away 0.2 m.
- `S` during a dive cancels it: go straight to `DIVE_ASCEND`, then `HOLD`.
- `D` during a dive is ignored. Only one dive at a time.
- The person detector is **report-only**. A detection never changes the flight.

### 6.1 Person detection

- The `person-search` branch exists on the remote; reuse its detector if it
  fits. Otherwise use YOLOv8n COCO class 0 (`person`) on CPU, the same
  Ultralytics package the fire model uses, confidence ≥ 0.5.
- Run it only during `DIVE_DWELL` so it does not slow the QR loop on the Pi.
  If the Pi is too slow, run it on the laptop from the relayed frames instead.
- A person is "found" with ≥ 3 frames out of the dwell above the threshold.
- Report: one `/api/ingest/flight` event, phase `dive`, message
  `person detected: n frames, max conf 0.xx` (or `no person detected`), and
  the best frame's boxes in the `X-Detections` overlay so the dashboard shows
  them. Writing person sightings into the detection tables is a separate
  backend change (§9) and not needed for the demo.

## 7. Hotkeys

All keys work in the Pi SSH terminal via the existing `immediate_keys` (no
Enter needed). The Enter commands are fallbacks for laggy SSH.

| Key | Enter fallback | Active | Effect |
|---|---|---|---|
| `X` / `Esc` | `LAND` | always | land now; wins over every other key in the same read (unchanged) |
| `S` | `STOP` | airborne | orbit → hold; hold → land; dive → abort dive, then hold |
| `D` | `DIVE` | `ORBITING`, `HOLD` | one dive pass (§6) |
| — | `R` / `RESUME` | `HOLD` | back to `ORBITING` |
| Ctrl+C | — | always | land, as today |

Implementation notes for `terminal_controls.CommandInput`:

- `S` and `D` become immediate keys **only after takeoff**. Before takeoff the
  operator is typing `ARM ORBIT LOOP`, which deliberately contains no S, D or X.
- Priority inside one read: X/Esc > S > D. Repeated presses within 0.5 s are
  one press.
- Every key press is echoed as a `report()` line with the state it applied to,
  so the log shows what the drone did with it.

## 8. Safety watchdog

Checked at every 50 ms poll inside every move (the existing `check()`
callback pattern), in every airborne state:

- Link, altitude, speed and attitude samples older than 1 s, or camera frames
  older than 1.5 s → land.
- Height above 2.0 m, or (once `CLIMB` has finished) below 0.4 m → land.
- Ground speed above 0.6 m/s, or tilt above 15° → land.
- Battery below `land_battery_pct` → land. Below `min_battery_lap_pct` →
  finish the current chord, then `HOLD`.
- `max_flight_s` reached → land.
- Any exception in the mission thread → land (existing `finally` blocks).
- Move timeout scales with distance: `max(3 s, 2 × distance / speed + 2 s)`
  instead of the fixed 8 s in `OlympeOrbitDriver.move`.
- Every failure message goes to the terminal and the dashboard.

The X-key landing has still not been checked in real flight
(`handoff.md`). **Do that first**, using `TERMINAL_FLIGHT_TEST.md`, before
flying this mode.

## 9. Files and interfaces

| File | Change |
|---|---|
| `bridge/qr_loop_core.py` (new) | `LoopLimits`, state machine, `entry_moves`, `corrected_chord`, `dive_moves`, watchdog reasons. No SDK, no I/O, fully unit-testable like `qr_preset_core.py` |
| `bridge/qr_orbit_loop.py` (new) | `QROrbitLoop(HoverCheckout)`: wires the trigger, `CalibratedPose`, gimbal, driver and person detector; `_after_hover` runs the loop |
| `bridge/qr_orbit_bridge.py` | `OlympeOrbitDriver.move`: add `vertical_speed` and distance-based timeout arguments, defaults keep today's behaviour |
| `bridge/terminal_controls.py` | optional immediate keys (`S`, `D`) enabled by the caller; X/Esc behaviour unchanged |
| `bridge/person_detection.py` (new, or from `person-search`) | `detect(image) -> [{label, confidence, bbox}]` |
| `backend/validation.mjs` | add `'orbit'` and `'dive'` to `FLIGHT_PHASES`; until then report laps as `circle` and the dive as `climb`/`return` |
| `scripts/Start-HoverCheckout.ps1`, `scripts/mac.py` | add `-Mode QrLoop` |
| `docs/QR_LOOP_DEMO.md` (new) | operator guide, written after the first grounded rehearsal |

Not touched: `qr_preset_demo.py` (stays the fallback demo), the observer
service, `Start BOSCO`, Gemini, TigerData. Dashboard buttons and QR payloads
still cannot command flight.

## 10. Tests

Software (fake driver and clock, like `tests/qr_preset_test.py`):

1. Entry math: pose at (1.8, 0.4) → yaw 12.5°, forward 0.84 m.
2. A perfect lap of 12 chords returns to the start within 1 mm and turns 360°.
3. Correction clamps: e_r = 0.5 m is applied as 0.15 m.
4. `blind_segments` in a row → `HOLD`; 5 s more → `LANDING`.
5. `S` in each state does what §7 says; `X` in the same read as `S`/`D` lands.
6. `D` in `TAKEOFF`, `CLIMB`, `ENTRY`, `DIVE_*` is ignored.
7. Dive moves are exact reverses; dive refused with low battery or < 20 s left.
8. Height below the dive floor stops the descent.
9. Every watchdog reason in §8 ends in `driver.land()`.
10. `max_flight_s` ends the loop even with no keys pressed.
11. Without `--execute`, no driver is constructed (same check as the preset tests).

Physical, in order, stop at the first failure and record each result:

1. Calibration done and `measured_and_verified: true`; the pose of a marker at a
   tape-measured 1.50 m reads within ±0.05 m from the ground and from 1.5 m up
   (hand-held drone, motors off).
2. X-key landing in the short hover checkout.
3. Rehearsal (no `--execute`): log shows trigger, planned entry and chord moves.
4. Live: takeoff, climb, acquire, entry, then `S` immediately → hold → `S` → land.
5. Live: one full lap, then `S`. Tape-measure the radius at four points
   (target 1.0 ± 0.15 m).
6. Live: three laps. Check drift stays within ±0.15 m.
7. Live: one dive from `HOLD`, a person standing 2 m behind the marker.
8. Live: dive from `ORBITING`, then let it run until `max_flight_s`.

## 11. Open questions

1. Marker on the floor (option A) is assumed. Confirm the laptop can sit just
   behind it without the lid going above 0.5 m inside the dive path.
2. Orbit direction: counter-clockwise from above by default. Add `--clockwise`
   if the room layout needs it.
3. Should `S` from `HOLD` land, or should it wait for `X`? This spec lands.
4. Does the Pi keep up with QR pose (every frame) plus YOLO person detection
   during the dwell? If not, move person detection to the laptop.
5. Should a found person trigger anything (Gemini analysis, a dashboard alert)?
   Out of scope here; detection is report-only.
