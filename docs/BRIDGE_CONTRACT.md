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

## QR markers decoded on the backend (no bridge code needed)

`backend/qrscan.mjs` decodes every incoming frame (and Pi-observer snapshot)
with pure-JS `jpeg-js` + `jsQR` — the deployed observer streams untouched.
A payload must decode identically on **2 consecutive scans** before it
counts; while the marker stays in view a sighting row is logged at most
every 5 s.

- `EW1:` fire marker → `qrfire-<name>` detection episode (`source:
  'qr-test'`, `kind: 'fire'`). Scenario fields land in `details`; the marker
  `bbox` and the frame itself are stored. Fire position is the site anchor
  labelled `position_source: 'site-anchor estimate'` — real position needs
  camera-pose calibration (still open). A new episode triggers the normal
  auto-analysis.
- `EWP:name|note` person marker → `qrperson-<name>` sighting
  (`source: 'qr-person'`, `kind: 'person'`). Persons never start or hijack
  the fire incident; recent ones (≤5 min) are returned as `persons` on
  `GET /api/incident` and injected into the Gemini analysis/plan context.
- Confirmed markers are merged into the video overlay (`X-Detections`) for
  ~3 s so viewers see the box around the code.

Real CV person detection is the stretch path: a bridge may also
`POST /api/ingest/detection` with `source: 'cv-person'` (or `'yolo'`),
`kind: 'person'`, same fields as a fire sighting — it lands as a person
sighting, not a fire episode.

## Flight events — `POST /api/ingest/flight`

`{ "at": ISO, "phase": "preflight|takeoff|climb|circle|return|landing|landed|aborted|error", "step": 3, "steps": 8, "message": "…" }`

## No control channel through the backend

The backend and dashboard cannot command the drone. Flight is only started
from the bridge's terminal with `--demo-flight` and a typed `FLY`.

## Verify it landed

Dashboard token: `GET /api/status`, `/api/telemetry/latest`, `/api/incident`,
`/api/flight`, `/api/analysis/latest`; `GET /api/video` streams the frames.

## Flight commands (dashboard → bridge, queue model)

The dashboard never moves the drone directly. A viewer action queues a
command; the bridge polls and executes it — the bridge stays the only
process that can fly the aircraft.

- `POST /api/commands` (dashboard token) — `{type: 'dive-surveillance', floor_agl_m?: 0.4, sweep_deg?: 360}` → `{id, status}`.
- `GET /api/commands/next` (ingest token) — returns the oldest `pending`
  command as `{command: {id, type, params}}` and marks it `delivered`
  (`{command: null}` when empty). Poll ~1 Hz.
- `POST /api/commands/<id>/ack` (ingest token) — `{status: 'in_progress'|'done'|'aborted'|'failed', note?}`.
- `GET /api/commands` (dashboard token) — recent commands with status.

`dive-surveillance`: descend to ~0.4 m AGL, yaw a 360° sweep for the
backend person detector, climb back. Implementation lives in
`bridge/dive_surveillance.py` (`DiveSurveillance`); wire `poll` in as a
worker thread. Abort rules from the abort listener apply throughout.
NOT hardware-tested yet — verify on the ANAFI before demoing.

## Backend-side person CV

The backend runs a pretrained person detector (coco-ssd, pure-JS tf.js,
Apache-2.0) on relayed frames (~0.7 Hz). Detections appear as `cv: N
persons` boxes in the video overlay and `cv-person`/`kind: 'person'`
sightings feeding `/api/incident.persons` and Gemini context — same feed
as EWP markers. It activates only when frames arrive; no bridge changes
needed. Operator note: cv sightings are uncalibrated detections — verify
on real frames before claiming the track in the pitch.
