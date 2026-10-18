# System flow

```text
ANAFI camera + state
  → Pi/Linux receiver (Olympe)
  → authenticated HTTP through an SSH reverse tunnel
  → Node backend: validate → storage + video relay + Gemini
  → browser dashboard: incident, spread, leads, analysis, plan
  → named human review → export

Historical/person-search simulation → separate replay API/UI
Operator terminal → explicitly enabled flight runtime → aircraft commands
```

| Component | Responsibility |
|---|---|
| `anafi_observer.py` | Reception only; no motors or gimbal commands |
| `anafi_bridge.py`, `fire_monitor.py` | Shared detection pipeline and evidence publishing |
| `backend/server.mjs` | Auth, HTTP, Gemini, PostgreSQL/memory adapters, tiles and JPEG relay |
| `backend/people.mjs` | Location uncertainty, lead association, coverage, review state |
| `dist/` | Display and human planning controls; no aircraft command channel |
| `qr_*`, `hover_checkout.py` | Separate terminal flight experiments and their gates |

The laptop keeps Internet access; Pi Wi-Fi joins the aircraft. The current
tunnel normally maps **Pi loopback 8788 → laptop loopback 8787**.

Replay Gemini calls are real requests when configured, but replay results stay
out of live storage. Model output and spread are estimates; human approval is
a local review record. The old `dist/blackboard-flow.svg` is an early design
illustration; use the flow above for the integrated codebase.

See [API contract](BRIDGE_CONTRACT.md), [source map](../README.md#source-map)
and [verification](VERIFIED.md).
