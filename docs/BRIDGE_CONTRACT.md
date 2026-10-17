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

Sent when a fire has been seen in **3 consecutive** detector passes (~5 Hz),
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
Generate with `python3 bridge/make_test_marker.py [--name … --area … --wind … --dir …]`.

## Flight events — `POST /api/ingest/flight`

`{ "at": ISO, "phase": "preflight|takeoff|climb|circle|return|landing|landed|aborted|error", "step": 3, "steps": 8, "message": "…" }`

## No control channel through the backend

The backend and dashboard cannot command the drone. Flight is only started
from the bridge's terminal with `--demo-flight` and a typed `FLY`.

## Verify it landed

Dashboard token: `GET /api/status`, `/api/telemetry/latest`, `/api/incident`,
`/api/flight`, `/api/analysis/latest`; `GET /api/video` streams the frames.
