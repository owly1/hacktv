# Bridge → backend ingest contract

What `bridge/anafi_bridge.py` POSTs to the backend (default
`http://127.0.0.1:8787`). Every request carries `Authorization: Bearer
<INGEST_TOKEN>` — the only credential the bridge holds. All timestamps are
ISO 8601 UTC with an explicit `Z` and must be within **±30 s of the server
clock** (bridge and backend on the same laptop share a clock).

## Telemetry — `POST /api/ingest/telemetry` (~1 Hz)

| Field | Type | Rule |
|---|---|---|
| `drone_id` | string | `"ANAFI-01"` |
| `observed_at` | ISO 8601 | **required**, capture time |
| `provenance` | string | **required**, `"live"` (`sim`/`demo`/`test`… are rejected) |
| `battery_pct` | 0–100 | |
| `altitude_m` | number | metres above takeoff (`AltitudeChanged`); not measured terrain clearance |
| `ground_speed_mps`, `vertical_speed_mps` | number | ground speed ≥ 0; vertical negative = descending |
| `latitude`, `longitude` | number | pair rule: both or neither. GPS when the drone has a fix; indoors, the `--home` point plus the offsets of commanded moves |
| `state` | string | Olympe flying state: `landed`, `takingoff`, `hovering`, `flying`, `landing`, … |
| `gps_fix` | boolean | |
| `attitude_deg` | `{roll, pitch, yaw}` | degrees |
| `extra` | object | `heading_deg`, `gimbal_pitch_deg`, `position_source` (`gps` or `home+odometry`), `flight_phase`, `wifi_rssi_dbm`, `video_fps` |

At least one measurement is required. Errors return `{"error": "..."}`.

## Video — `POST /api/ingest/frame` (~15 fps)

Raw JPEG body (`Content-Type: image/jpeg`, ≤ 2 MB, 960 px wide by default),
headers `X-Captured-At: <ISO>` and optional `X-Detections: [{source, label,
confidence, bbox}]` with boxes normalized 0..1 for the dashboard overlay.
Returns 204. The bridge reuses one keep-alive connection per thread.

## Fire detection — `POST /api/ingest/detection`

Sent when a fire has been seen in **3 consecutive** detector passes (~5 Hz)
for a QR test marker, or **5 consecutive** passes at overlapping positions for
a YOLO hit (score ≥ 0.65, plausible box size, flame-coloured pixels; smoke
only with `--detect-smoke`),
then every 5 s while it stays in view. A run of sightings shares one
`episode_id`; it ends after 15 s unseen. The first sighting of an episode
triggers one automatic Gemini analysis.

```json
{
  "detected_at": "2026-10-17T06:24:07.120Z",
  "episode_id": "ep-1792218232-d7f93c",
  "source": "qr-test",                       // or "yolo"
  "label": "fire",                           // yolo: "fire" or "smoke"
  "confidence": 1.0,
  "bbox": [0.51, 0.59, 0.58, 0.71],          // x1, y1, x2, y2, normalized
  "fire": { "latitude": 43.786599, "longitude": -79.190279, "distance_m": 1.7,
            "bearing_deg": 93.8, "position_source": "home+odometry+marker-size" },
  "drone": { "latitude": 43.7866, "longitude": -79.1903, "altitude_m": 1.0,
             "heading_deg": 90, "gimbal_pitch_deg": -45, "state": "hovering" },
  "details": { "name": "Alpha", "area_ha": 120, "intensity": "extreme",
               "spread_m_per_min": 35, "fuel": "dry mixed forest and grass",
               "wind_kmh": 30, "wind_dir_deg": 60, "temp_c": 31, "rh_pct": 18,
               "marker_size_m": 0.18, "test_marker": true },
  "frame_jpeg_base64": "<the frame, ≤ 5 MB>"
}
```

Fire position: the ray through the box centre is cast from the camera
(heading + horizontal offset, gimbal pitch + vertical offset) to flat ground
at the drone's altitude (`camera-ray`). For the test marker, range comes from
its known printed size instead (`marker-size`), which is more accurate
indoors. With the camera near the horizon the range is capped
(`camera-bearing`). YOLO sightings report `details.area_ha` estimated from
the box width at that range.

### QR test marker payload

`EW1:name|area_ha|intensity|spread_m_per_min|fuel|wind_kmh|toward_deg|temp_c|rh_pct|side_cm`
— intensity `L/M/H/X`, fuel `F` conifer forest, `G` grass, `M` mixed, `S`
brush. Kept short so the code has few, large modules (QR version 3).

**Scope: exactly one QR code is a fire.** The drone reacts only to the
FireSimulationDemo printout, whose payload is

`EW1:Alpha|120|X|35|M|30|60|31|18|18`

(Alpha, 120 ha, extreme, 35 m/min, dry mixed forest and grass, wind 30 km/h
toward 60°, 31 °C, 18 % RH, 18 cm side). The bridge compares the decoded text
byte for byte with `FIRE_MARKER_PAYLOAD` (`bridge/fire_detection.py`); any other QR code, including other
`EW1:` payloads, is ignored and never posted. The backend rejects (400) a
`qr-test` detection whose fire fields in `details` are not exactly that fire.
The `position_simulated` / `location_note` scenario notes may be added. Automatic
flight can also attach all three fields `flight_protocol`, `orbit_radius_m`, and
`path_reference`: radius must be exactly `1`, and the protocol/reference pair
must be `qr-auto-preset` / `launch-heading` or `qr-auto-circle` / `measured-marker`.
Partial or mismatched flight annotations and all other extra fields are rejected.
These fields describe the flight context; backend acceptance does not itself
command the aircraft. The runtime still checks fresh scans and aircraft state. The QR
orbit, preset and hover flows refuse to arm for any other selected marker. The
payload is pinned in `bridge/fire_detection.py` (the bridge, observer, monitor
and orbit/preset cores all use it), `bridge/make_test_marker.py`,
`bridge/orbit-marker.txt` and `backend/validation.mjs`, and a test keeps them in
step; changing the fire means changing all of them and reprinting. Regenerate
the printout with `python3 bridge/make_test_marker.py` (no options).

## Flight events — `POST /api/ingest/flight`

`{ "at": ISO, "phase": "preflight|takeoff|climb|circle|return|landing|landed|aborted|error", "step": 3, "steps": 8, "message": "…" }`

## Person observation — `POST /api/ingest/person`

One observation per person track at most every 2 s (see
[PERSON_SEARCH.md](PERSON_SEARCH.md)). Unlike other ingest, `observed_at` may
be up to **6 h old**, so stored observations can be delivered after a link
outage. Anything received more than 15 s after capture is marked delayed.
Retries with the same `obs_id` are ignored.

```json
{
  "obs_id": "ANAFI-01-1792218232120-a1b2c3",   // unique; makes retries idempotent
  "observed_at": "2026-10-17T06:24:07.120Z",
  "provenance": "live",
  "sensor": "visible",                          // or "thermal"
  "label": "person",
  "detector": "yolov8n.pt", "detector_score": 0.71,   // raw model output, never shown as a confidence
  "track_id": "pt-1792218230-9f1e",
  "bbox": [0.48, 0.45, 0.52, 0.55],
  "drone": { "latitude": 43.7866, "longitude": -79.1903, "altitude_m": 40,
             "heading_deg": 90, "gimbal_pitch_deg": -45, "position_source": "gps" },  // all required except position_source
  "camera": { "hfov_deg": 69, "aspect": 1.778 },
  "terrain_m": null                             // optional ground height at the target vs take-off
}
```

Returns `{accepted, duplicate, obs_id, lead_id, lead_number, new_lead, status, delayed}`.
Returns 422 when the ray cannot meet the ground, for example when the camera
is near the horizon.

Crop: `POST /api/ingest/person/crop?obs_id=…`, raw JPEG body of 300 KB or
less, returns 204. Sent after the observation, so the small alert arrives
first.

## Session-controlled autonomous fire response

The `fire_response.py` receiver uses an explicit, volatile dashboard session.
It starts OFF. Other terminal flight modes retain their existing controls.

Dashboard-token endpoints: `GET /api/autonomy` reads state;
`POST /api/autonomy` accepts `{action: "enable"|"land"|"disable"}` or
`{action: "heartbeat", session_id}`. Only the page that enabled the session
renews its five-second lease. LAND is available from any authenticated page.

`POST /api/autonomy` also accepts `{action:"camera", pitch_deg:0|-45|-70}`
while response is OFF and the receiver reports `camera_ready:true`. The
receiver-bound request expires after five seconds. The receiver independently
checks grounded state, fresh telemetry and stationary preflight conditions;
it sends only a gimbal pitch command and consumes each request once. Missing
flight geometry does not block these camera-only previews.

Ingest-token endpoints:

- `POST /api/ingest/autonomy/status`: receiver ID, ready boolean, reason,
  phase, optional `short_test` boolean, and measured heading-relative position
  (forward/right/down/width in metres, episode ID, position source). Status expires after two seconds. A different receiver
  ID disables the old session.
- `POST /api/ingest/autonomy/target`: captured_at, image width/height, episode_id,
  and hit `{source, label, confidence, bbox, qr_text?, qr_corners?}` or null to clear it.
  QR corners are four finite pixel pairs in decoder TL/TR/BR/BL order within
  the supplied frame; metric QR flight requires these corners.
  Boxes are normalized `[left, top, right, bottom]`. Frames must be fresh and
  strictly increasing. Only RGB fire or the exact approved QR qualifies.
- `POST /api/ingest/autonomy/claim`: receiver_id, session_id, episode_id.
  Atomically consumes one confirmed fire after a matching accepted incident.
- `GET /api/ingest/autonomy`: reads the current session and target.

Five consistent observations spanning at least 800 ms after Enable are
required. A receiver must be ready before enabling, and a consumed episode
cannot authorize another takeoff. Restarts, lease expiry, LAND and completed
flights disable the session. Receivers request landing on control loss.

Approved QR targets use square pose estimation with measured physical size,
calibrated intrinsics and actual camera attitude. Forward/right/down are measured
independently of launch altitude, allowing a target below a table launch. Fresh
QR position is required before takeoff and stable 3D tracking before movement.
The orbit uses a 1 m horizontal radius at approximately 1 m above takeoff;
camera pitch follows the target's measured vertical position. `qr_pose_verified`
and measured camera offsets are required. There is no QR ground-plane fallback.

RGB fire still projects its visible ground contact onto a physically verified
launch ground plane (`fire_ground_plane_verified`). Neither method uses the
simulated map coordinates for flight. Missing, stale, ambiguous or inconsistent
geometry prevents movement and requests landing during flight. Geographic fire
coordinates remain unavailable indoors.

Status reports the explicitly selected short-test profile. Snapshot limits are
normally 40% battery to start/continue and 300 seconds; short-test limits are
30% to start, landing below 25%, and 60 seconds. The receiver independently
enforces them. Backend restarts do not enable either profile's flight session.

## Verify it landed

Dashboard token: `GET /api/status`, `/api/telemetry/latest`, `/api/incident`,
`/api/flight`, `/api/analysis/latest`, `/api/people`; `GET /api/video` streams the frames.

## Connection status and recovery

The Mac fire monitor posts health to authenticated `POST /api/ingest/vision`:
`observed_at`, `model_status` (`ready|missing|error|disabled`), `camera_state`
(`live|waiting|stale`), and optional `last_frame_at`, `last_detection_at`,
`last_source` (`qr-test|yolo`), `error`. `/api/status.vision.fresh` expires
after ten seconds. Health alone never creates an incident.

QR and RGB classifications use the same detection endpoint and automatic
analysis path. QR scenario positions use
`fire.position_source=qr-scenario-site-not-measured` and
`details.position_simulated=true`; these are configured test anchors, not GPS.
Missing RGB fire coordinates remain null and do not suppress the incident UI.

`GET /api/status` distinguishes stored evidence from a current connection.
`available` still means a sample exists, including an old one. Each of
`telemetry`, `camera` and `video` now includes `fresh`: telemetry expires at
10 seconds, camera/video at 3 seconds. Timestamps more than 1 second ahead
of the server are not fresh. Stale video reports zero FPS.

`connection.connected` is true when fresh telemetry or video is arriving.
`connection.state` is `live` (both), `telemetry-only`, `video-only`,
`disconnected` (old evidence only), or `waiting` (no evidence yet). This
reports received evidence, not an SDK handshake or permission to fly.
An HTTP 200 or an old `available: true` alone never proves a live drone.

The Mac observation supervisor retries Wi-Fi selection and starts a new SDK
receiver after connection loss. The backend and existing video subscriptions
remain running and accept the returning stream. Flight sessions do not
automatically restart or re-arm.
