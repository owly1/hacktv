# Bridge → backend ingest contract (for developer C)

What the Python bridge (Olympe) must POST. Backend is Node, default
`http://127.0.0.1:8787`. All endpoints require `Authorization: Bearer <token>`.
The **ingest token** (`INGEST_TOKEN` in `.env`) is the only credential the
bridge needs — never send it the dashboard token or the Gemini key.

## Telemetry — `POST /api/ingest/telemetry`

JSON body. Send roughly 1–2 Hz; every accepted sample is stored (hypertable
when TigerData is configured, memory otherwise).

| Field | Type | Rule |
|---|---|---|
| `drone_id` | string | optional, e.g. `"anafi-1"` |
| `observed_at` | ISO 8601 | **required.** UTC capture time with explicit `Z`/offset. Must be within **±30 s of the server clock** — sync the laptop clock or the POST is refused with 400. |
| `provenance` | string | **required.** Must be `"live"` for real drone data. `sim`/`synthetic`/`fixture`/`demo`/`test` are actively rejected — simulation frames never go through this endpoint. |
| `battery_pct` | number 0–100 | optional |
| `altitude_m` | number | optional |
| `ground_speed_mps` | number ≥ 0 | optional |
| `vertical_speed_mps` | number | optional (negative = descending) |
| `latitude`, `longitude` | number | **pair rule:** both or neither. Never (0, 0) for unknown — send `null` on both when GPS has no fix. |
| `state` | string | optional: `"landed"`, `"hovering"`, `"flying"`, … |
| `gps_fix` | string or boolean | optional: `"no fix"`, `"2d"`, `"3d"`, or `false` (normalized to `"no fix"`) |
| `attitude_deg` | object | optional: `{roll, pitch, yaw}` degrees |
| `extra` | object | optional free-form JSON bag for anything else Olympe gives you (gimbal angles, link quality…). Stored verbatim. Unknown **top-level** fields are dropped — put extras here. |

At least one numeric measurement is required or the sample is rejected.
Errors come back as `{"error": "<why>"}` — log them; a 400 means the sample
did not land.

## Snapshot — `POST /api/ingest/snapshot`

```json
{ "captured_at": "<ISO 8601, ±30 s>", "jpeg_base64": "<base64 JPEG, ≤ 5 MB>" }
```

Grab one frame from the video pipeline and post it periodically (every few
seconds is plenty — the latest frame is what Gemini analyzes). Must start
with JPEG magic bytes (FF D8 FF), which any encoder output has.

## No control channel on purpose

There are no takeoff/landing/movement endpoints and there never will be —
the honesty contract bans command paths through this system (§7).

## Stdlib-only Python poster

No dependencies beyond Python 3. Drop into the Olympe telemetry loop:

```python
import base64, json, urllib.request
from datetime import datetime, timezone

BASE = "http://127.0.0.1:8787"
INGEST_TOKEN = "paste INGEST_TOKEN here"   # get the real value from B/Sharon

def post(path, payload):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {INGEST_TOKEN}",
            "Content-Type": "application/json",
        },
    )
    return json.loads(urllib.request.urlopen(req, timeout=5).read())

def utcnow_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

def send_telemetry(t):
    """t: dict of raw olympe readings (whatever keys you have)."""
    lat, lon = t.get("latitude"), t.get("longitude")
    fix = bool(lat is not None and lon is not None and (lat or lon))
    post("/api/ingest/telemetry", {
        "drone_id": "anafi-1",
        "observed_at": utcnow_iso(),          # use the sample's own time if Olympe gives one
        "provenance": "live",
        "battery_pct": t.get("battery_pct"),
        "altitude_m": t.get("altitude_m"),
        "ground_speed_mps": t.get("ground_speed_mps"),
        "vertical_speed_mps": t.get("vertical_speed_mps"),
        "latitude": lat if fix else None,     # pair rule: both or neither, never (0,0)
        "longitude": lon if fix else None,
        "state": t.get("state"),              # "landed" etc.
        "gps_fix": fix,                       # or the fix-quality string Olympe reports
        "attitude_deg": {
            "roll": t.get("roll_deg"),
            "pitch": t.get("pitch_deg"),
            "yaw": t.get("yaw_deg"),
        },
        "extra": {"gimbal_pitch_deg": t.get("gimbal_pitch_deg")},
    })

def send_snapshot(jpeg_path):
    post("/api/ingest/snapshot", {
        "captured_at": utcnow_iso(),
        "jpeg_base64": base64.b64encode(open(jpeg_path, "rb").read()).decode(),
    })
```

## Verify it landed

`GET /api/telemetry/latest` and `GET /api/telemetry/history` (dashboard
token) echo the newest samples back; `GET /api/snapshot` returns the JPEG.
Acceptance item G wants one real telemetry sample + one real JPEG visible in
the dashboard with real capture times — these two POSTs satisfy it.
