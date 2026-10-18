# Bridge → backend contract

Contract: `emberwatch.v1`. Ingest requests use `Authorization: Bearer
<INGEST_TOKEN>`; reads/actions use the distinct dashboard token. The local-only
`GET /api/session` bootstraps browser access. All timestamps include an ISO
8601 timezone; normal ingest accepts ±30 seconds, except delayed person data.
Source of truth: `backend/validation.mjs`, `backend/people.mjs`,
`backend/autonomy.mjs`, `backend/server.mjs`.

## Ingest routes

`GET /api/demo/people` now includes replay-only `camera` geometry: `origin`,
east/north/up `pose` in metres relative to the fire, downward-positive pitch,
fire dimensions and fictional visible objects. Its simulated `drone` includes
identity, capture time, ground speed and battery. These additive replay fields
never enter live ingest or live rescue-lead storage. Live gimbal pitch remains
negative downward; the browser converts it for rendering.

| POST route | Body / result |
|---|---|
| `/api/ingest/telemetry` | JSON below; returns accepted sample |
| `/api/ingest/frame` | Raw JPEG, `image/jpeg`, ≤2 MB; `X-Captured-At`; optional `X-Detections` JSON overlay; returns 204 |
| `/api/ingest/snapshot` | Compatible JSON JPEG envelope (`jpeg_base64`, or live `data`/`mime_type`); also feeds video relay |
| `/api/ingest/detection` | Fire sighting below; updates incident without automatic scene analysis by default |
| `/api/ingest/flight` | `{at, phase, step?, steps?, message?}` |
| `/api/ingest/vision` | `{observed_at, model_status, camera_state, ...}` health; never creates an incident |
| `/api/ingest/person` | Live person observation below; delayed delivery allowed |
| `/api/ingest/person/crop?obs_id=...` | Raw JPEG ≤300 KB, sent after observation; returns 204 |

Telemetry requires `drone_id`, `observed_at`, `provenance: "live"` and at least
one measurement. Unknown fields such as GPS positions remain null.

| Telemetry field | Meaning |
|---|---|
| `battery_pct` | 0–100 |
| `altitude_m` | Height above takeoff, not terrain clearance |
| `ground_speed_mps`, `vertical_speed_mps` | Ground speed ≥0; negative vertical speed means descending |
| `latitude`, `longitude` | Both or neither; `extra.position_source` explains origin |
| `state`, `gps_fix`, `attitude_deg` | SDK state, fix flag, roll/pitch/yaw in degrees |
| `extra` | Heading/gimbal degrees, position source, flight phase, RSSI and video rate |

When supported by the aircraft/SDK, `extra.fc_wind_speed_mps`,
`fc_wind_direction_deg`, `fc_wind_available` and `fc_wind_state` carry the
flight controller's onboard estimate/capability. Missing values remain null.
The backend prefers valid onboard wind over Gemini's tilt-derived estimate
and discloses significant disagreement; both remain estimates, not a wind sensor.

## Fire sighting

```json
{
  "detected_at": "2026-10-17T06:24:07.120Z",
  "episode_id": "ep-example",
  "source": "qr-test",
  "label": "fire",
  "confidence": 1,
  "bbox": [0.51, 0.59, 0.58, 0.71],
  "fire": {"latitude": null, "longitude": null, "distance_m": null, "bearing_deg": null, "position_source": "unknown"},
  "drone": {"latitude": null, "longitude": null, "altitude_m": 1},
  "details": {"name": "Alpha", "area_ha": 120, "intensity": "extreme", "spread_m_per_min": 35, "fuel": "dry mixed forest and grass", "wind_kmh": 30, "wind_dir_deg": 60, "temp_c": 31, "rh_pct": 18, "marker_size_m": 0.18, "test_marker": true}
}
```

Boxes are normalized `[x1,y1,x2,y2]`. `source` is `qr-test` or `yolo`; YOLO
may report fire or explicitly enabled smoke. Optional `frame_jpeg_base64`
archives the evidence (≤5 MB). Receivers normally confirm three QR passes or
five overlapping filtered YOLO hits, update every five seconds, and end an
episode after 15 seconds unseen. Automatic scene analysis defaults off; explicit
`createApp({autoAnalyze: true})` embedding opt-in retains the legacy at-most-once
behavior. Status exposes `gemini.automatic_analysis`; authenticated legacy
analysis routes remain compatible. The shared replay/live dashboard does not
request or poll scene analysis.

The only selected QR payload is:

```text
EW1:Alpha|120|X|35|M|30|60|31|18|18
```

Other QR text, including other `EW1:` payloads, is rejected/ignored. Keep
`bridge/fire_detection.py`, `make_test_marker.py`, `orbit-marker.txt`, backend
validation and tests synchronized. Regenerate with `python3 bridge/make_test_marker.py`.
The backend checks the exact Alpha fields above. Allowed scenario additions
are `position_simulated` and `location_note`. Flight annotations must include
all of `flight_protocol`, `orbit_radius_m: 1`, `path_reference`, using only
`qr-auto-preset`/`launch-heading` or `qr-auto-circle`/`measured-marker` pairs.

Legacy bridge geolocation uses camera rays/printed size. The laptop monitor
can instead label a configured QR scenario site as
`qr-scenario-site-not-measured`; RGB positions can remain unknown. Directions
are degrees clockwise from north, pointing **toward** wind/spread travel.

## Session-controlled autonomous fire response

`fire_response.py` is a separately enabled flight runtime. Its backend session
starts OFF and is never restored from disk. The browser grants/revokes permission;
localization, aircraft commands, motion guards and landing remain in the receiver.
Ordinary camera/person ingest and Replay do not enable this runtime.

| Endpoint | Authentication / behavior |
|---|---|
| `GET /api/autonomy` | Dashboard token; current session, receiver and target state |
| `POST /api/autonomy` | Dashboard token; `action: enable`, `land`, `disable`, `heartbeat`, or `camera` |
| `GET /api/ingest/autonomy` | Ingest token; the receiver reads the same control snapshot |
| `POST /api/ingest/autonomy/status` | Ingest token; receiver readiness, phase and optional measured position/calibration |
| `POST /api/ingest/autonomy/target` | Ingest token; a timestamped confirmed fire rectangle, or null hit |
| `POST /api/ingest/autonomy/claim` | Ingest token; atomically claim a confirmed incident for the current receiver/session |

Enable requires a fresh ready receiver and returns `session_id`. An owning
`{action: "heartbeat", session_id}` must acknowledge that exact session before
any target can authorize takeoff. The dashboard lease expires after five seconds;
receiver contact expires after three seconds. Reconnection never restores an
expired session. LAND/disable can be requested by any dashboard-authenticated
page. Receiver replacement, disconnection, errors and completed landing revoke
permission. Claims retried by the same receiver for the same fresh matching
mission return the existing mission rather than authorizing a second flight.
A deliberate new session can authorize another response to the same marker.

Status requires `receiver_id` (8–80 letters/digits/underscore/hyphen), `ready`
and `reason`; it may report `aircraft_connected`, `phase`, `camera_ready`,
`camera_search_supported`, `search_state`, `short_test`, `lap_seconds: 15`,
`localization_sources`, `blocked_source`, and `qr_scale_mode: measured|adaptive`.
`position` uses heading-relative `forward_m`, `right_m`, `down_m`, `width_m` in
metres. Optional `calibration` contains `qr_side_m`, `offset_body_m`, `image_size`,
`rms_px`, `qr_verified`, `profile_verified`; adaptive mode permits unknown
`qr_side_m: null`. Unknown scale is not a verified metric position.

Target bodies contain `captured_at`, integer `width`/`height`, `episode_id`, and
`hit: {source, label, confidence, bbox, qr_text?, qr_corners?, ...}` or `hit: null`.
Capture times must strictly increase and be less than 1.5 seconds old; a candidate
must be less than one second old. The source is `yolo` or `qr-test`, the label is
`fire`, confidence is at least 0.65, and boxes are ordered normalized coordinates.
QR identity must exactly match the approved payload. Corners are four finite
TL/TR/BR/BL pixel pairs inside that frame. Before the first claim, five consistent
decoded observations spanning at least 800 ms after Enable must match an accepted
`/api/ingest/detection` incident from the last seven seconds. Overlay boxes,
vision health and person sightings cannot substitute for that accepted incident.
The claim body is `{receiver_id, session_id, episode_id}`.

`qr_tracking` can be `decoded`, `optical-flow`, or `visual-template`. Flow requires
current corners and a decode within about 2.5 seconds. Template tracking is
limited to an already claimed matching QR mission and requires its recent decode
seed plus the checked template/data/module/coverage evidence. Neither tracking
method can supply the initial decoded confirmations. `fire_presence` exposes
`last_seen_at`, `expires_at` and a 15-second `present` indicator; this is observation
metadata, not a timeout that revokes an existing mission by itself. Fresh exact
decodes can restore sightings after a longer gap. Permission still depends on
control connectivity and the receiver's independent flight guards.

`{action: "enable", camera_search: true}` requests the receiver's supported camera
search before takeoff. `{action: "camera", pitch_deg: 0|-30|-45|-55|-70}` is a
receiver-bound preview request, valid for five seconds only while autonomy is OFF
and `camera_ready` is true. The receiver rechecks stationary grounded conditions
and sends only a gimbal command; camera preview does not authorize flight.

QR flight uses calibrated image/camera geometry and either verified measured QR
size or adaptive scale acquired from measured vertical motion. The receiver
requires a fresh metric location and settled aircraft before horizontal control.
It locks the physical 3D target, aims the body/camera toward it, corrects radius,
and follows the one-metre ring. Missing visual frames do not require abandoning
that locked location while measured motion and flight guards remain valid.
Recovery continues while independent measured radial motion and geometric error
show progress; pose corrections alone cannot renew the stall check. A 15-second
lap is the commanded profile, not a claim that every real lap meets that time.
RGB flight requires the separately verified launch ground plane. Simulated map
coordinates are never flight geometry; indoor geographic location can remain null.

Snapshot limits are normally a one-metre radius/height, 40% minimum start/flight
battery and a 300-second session flight limit. Explicit short-test mode uses 30%
to start, 25% in flight and 60 seconds. Altitude is relative to takeoff, not terrain
clearance. The receiver enforces its own battery, sensor, motion and control guards;
backend acceptance does not itself execute an aircraft command.

## Person observation

Required: `observed_at`, `provenance: "live"`, `sensor: "visible"|"thermal"`,
`label: "person"`, normalized `bbox`, and `drone` with latitude, longitude,
positive altitude, heading and gimbal pitch. Optional `obs_id`/`track_id` use
1–64 characters `[A-Za-z0-9._:-]`; `detector`/`detector_score` identify raw output.
Optional `camera` supplies HFOV/aspect/VFOV; `terrain_m` is ground height
relative to takeoff. See [person search](PERSON_SEARCH.md).

The capture can be up to six hours old, at most 30 seconds ahead; over 15
seconds late is flagged delayed. Reusing `obs_id` is idempotent. A ray that
cannot locate ground returns 422. Success includes `accepted`, `duplicate`,
`obs_id`, `lead_id`, `lead_number`, `new_lead`, `status`, `delayed`.

## Reads, freshness and control boundary

Dashboard routes include `/api/status`, `/api/telemetry/{latest,history,summary}`,
`/api/incident`, `/api/flight`, `/api/video`, `/api/snapshot`, `/api/detections`,
`/api/analysis/latest`, `/api/plan/latest`, and `/api/people`. Plan/analyze,
incident dismissal and lead review are explicit dashboard actions.

`available` means stored evidence exists. `fresh` expires after 10 seconds
for telemetry/vision and three for camera/video; more than one second in the
future is not fresh. `connection.state` is live, telemetry-only, video-only,
disconnected or waiting. A 200 response or retained picture is not a live link.
Vision health uses `model_status=ready|missing|error|disabled` and
`camera_state=live|waiting|stale`, with optional frame/detection times, source and error.

Flight phases are `preflight`, `takeoff`, `climb`, `recover`, `circle`, `return`, `landing`,
`landed`, `aborted`, `error`. They report events, not commands. The backend,
dashboard and Gemini cannot pilot. Explicit terminal runtimes own execution;
automatic observation recovery never restarts a flight session.

### Laptop detection overlays — `POST /api/ingest/overlays`

Authenticated with the ingest token. Body:
`{ "captured_at": "<ISO UTC>", "detections": [{ "source": "yolo", "label": "smoke", "confidence": 0.85, "bbox": [0.2, 0.3, 0.6, 0.7] }] }`.
Send an empty array for a negative inference. At most ten ordered normalized
boxes are accepted; source is `qr-test|yolo`, label is `fire|smoke|person`
(QR must be fire), confidence is 0–1. Returns `{accepted}`. Results more than
two seconds old or older than the latest overlay are ignored. An overlay
can annotate matching/newer frames for up to 1.5 seconds of camera motion;
embedded frame detections take precedence. A redraw retains the image's
original timestamp and does not count as a new frame or incident.

### Camera-only person evidence — `POST /api/ingest/person/sighting`

Ingest authentication; `obs_id`, `track_id`, `observed_at` (up to six hours
old, at most 30 seconds ahead), `provenance: live`, `sensor: visible`,
`label: person`, `detector`, `detector_score` (0–1), ordered normalized `bbox`,
and `location_reason: pose-unavailable|ground-intersection-unavailable`.
No geographic position is accepted or inferred by this endpoint. At most
200 camera tracks are retained. Repeated observation ids/older captures are
idempotent. `/api/people` includes `unlocated_sightings`; these are saved
alongside located leads. An accepted `/api/ingest/person` observation for the
same `track_id` removes the unlocated note.

Dashboard-authenticated `POST /api/people/sighting/ack` and `/close` accept
`track_id` and a named responder `by`; closure also requires `outcome`
(`found|not-a-person|duplicate|handed-off`). Reviews survive repeat sightings
and backend restart. Vision health adds `people_model_status` and
`last_person_at`. None of these routes commands the aircraft.

