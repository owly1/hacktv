# Verification record

What has been checked against the real services, by whom, and when.
Rules (§5): a `configured` flag is not evidence — only a real round trip counts.
Anything not listed here is **not verified** and must not be demoed as live.

## Gemini (aistudio key, model `gemini-3.8-flash`)

Verified by developer B, 2026-10-17 ~11:47 UTC, against `main` @ cb38a7a +
the current backend (`runAnalysis`/`/api/plan` pipeline).

- `POST /api/analyze` (manual trigger) — real round trip, ~20 s.
  - Gemini used its declared tools on its own initiative: `tool_trace` shows
    `get_detection_history` then `get_latest_telemetry`, then produced the
    structured `{summary, severity, observations, spread_outlook, unknowns,
    falsifiers, limitations}` record with `provenance: gemini-unverified`.
  - It correctly described the test frame as a featureless brown field and
    listed falsifiers (e.g. "a subsequent clear optical or thermal image
    showing visible fire … near (43.7866, -79.1903)").
- `POST /api/plan` (`objective: initial-attack`, wind 18 km/h @ 60°, dryness 0.8)
  — real round trip; returned a complete structured incident-action draft
  (title/situation/objectives/prioritized actions/resources/triggers/risks/
  advantage) that reasoned from the blinded camera + landed drone + dry fuel.

Rate limits observed live: analyze 1 req/30 s (429), plan 1 req/10 s.

## TigerData

Verified by developer B, 2026-10-17 ~07:04 UTC (commit `380c2b0`):
schema applied to the provisioned service, `telemetry` + `analyses`
hypertables exist, telemetry insert/readback succeeded.
TLS stays on — set `DATABASE_URL` + `PG_CA_FILE=backend/tigerdata-ca.crt`.

## Backend contract suite

`npm test` → 41/41 passing (26 contract + 15 live-pipeline, all externals faked).
`node --check` clean on `backend/server.mjs`, `backend/validation.mjs`.

## Not verified (honest boundary)

- A real ANAFI flight end-to-end (bridge → ingest → detection → auto-analysis →
  dashboard) — needs the drone + C's laptop on venue Wi-Fi.
- Thermal/visual fire detection on a real fire — the pipeline is verified on
  code and dry-run frames only; no live flame has been seen by the system.
- Any claim beyond what the checks above cover.
