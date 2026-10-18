# Bridge → backend contract

Contract: `emberwatch.v1`. Ingest requests use `Authorization: Bearer
<INGEST_TOKEN>`; reads/actions use the distinct dashboard token. The local-only
`GET /api/session` bootstraps browser access. All timestamps include an ISO
8601 timezone; normal ingest accepts ±30 seconds, except delayed person data.
Source of truth: `backend/validation.mjs`, `backend/people.mjs`, `backend/server.mjs`.

## Ingest routes

| POST route | Body / result |
|---|---|
| `/api/ingest/telemetry` | JSON below; returns accepted sample |
| `/api/ingest/frame` | Raw JPEG, `image/jpeg`, ≤2 MB; `X-Captured-At`; optional `X-Detections` JSON overlay; returns 204 |
| `/api/ingest/snapshot` | Compatible JSON JPEG envelope (`jpeg_base64`, or live `data`/`mime_type`); also feeds video relay |
| `/api/ingest/detection` | Fire sighting below; first accepted episode can trigger automatic Gemini analysis |
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
episode after 15 seconds unseen. Each episode triggers analysis at most once.

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

Flight phases are `preflight`, `takeoff`, `climb`, `circle`, `return`, `landing`,
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

