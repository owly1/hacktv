# KEYS.md — every credential Emberwatch needs (or doesn't)

Role B (API/Data) reference, verified 2026-10-17 ~11pm ET against official docs.
**Bottom line: the map needs NO key. Only Gemini and TigerData need accounts.**

## The map — no key required

The dashboard's "light road-style map" does not need Google Maps or any key:

| Option | Key? | Cost | Verdict |
|---|---|---|---|
| **Leaflet + CARTO Voyager tiles** | none | free, attribution required | **Recommended** — `https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png` is a light road-style map, exactly the requested look |
| Leaflet + OSM standard tiles | none | free, attribution + light use | Fine fallback; heavier visual style |
| Google Maps JS API | API key + **billing account (credit card)** | pay-as-you-go | Skip — card requirement is not hackathon-friendly |
| Google **Maps Demo Key** | demo key, no billing | no-cost, prototyping-only | Exists as of Oct 2026 docs; limited to "select" features — only if the team specifically wants the Google look |

Verified live: Voyager tile, OSM tile, and the Leaflet 1.9.4 CDN all return 200.
Caveat: tiles need internet at demo time. Keep the fictional SVG as the labeled
offline fallback — do not remove it; it is the guaranteed-demo path.

Minimal integration for whoever owns `dist/` (A):

```html
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
```
```js
const map = L.map('map').setView([43.78, -79.19], 12); // UTSC area
L.tileLayer('https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors © CARTO', maxZoom: 19,
}).addTo(map);
// then re-add the spread polygons as L.polygon overlays in the same layer order
```

## Keys that are needed

| Env var | Who provides | How to get | Cost |
|---|---|---|---|
| `GEMINI_API_KEY` | teammate D (or Sharon) | aistudio.google.com → Get API key. New keys are service-account-bound "auth keys" restricted to the Generative Language API — that default restriction is fine, our backend only calls `generateContent`. Backend env only, never the browser. | Free tier on Flash-class models |
| `GEMINI_MODEL` | backend config | e.g. `gemini-2.0-flash`; a configured value is not proof of access — verify one real `/api/analyze` round trip | — |
| `DATABASE_URL` | whoever provisions TigerData | tigerdata.com → 30-day trial (**no credit card**) → create service → copy the `postgres://…` connection string → `psql "$DATABASE_URL" -f backend/schema.sql` | $0 within trial |
| `PG_CA_FILE` | optional | download the CA cert the service provides; keep TLS verification on | — |
| `INGEST_TOKEN`, `DASHBOARD_TOKEN` | generated locally | `openssl rand -hex 32` — two different values, shared with C's bridge and the browser field respectively | — |
| `ALLOWED_ORIGINS` | deployment config | exact origins the dashboard is served from; defaults cover :8787 and :8000 loopback | — |

## Keys explicitly NOT needed

- `OPENAI_*/ANTHROPIC_*` — nothing in the project uses them
- Any map provider key — see above
- `ELEVENLABS_*`, Solana, Auth0, Vultr, GoDaddy — only if the team chooses those sponsor tracks; none are in the current architecture

## Rules of thumb (from TEAM_AI_CONTEXT)

- `.env` stays untracked; `.env.example` documents names only — no real values.
- Gemini key lives backend-side only; the browser's token field takes `DASHBOARD_TOKEN`.
- A `configured` flag in `/api/status` is not evidence of a successful call — run one real analyze + one real insert/readback before claiming integration in the demo.
