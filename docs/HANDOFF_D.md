# Handoff for Developer D (arriving H4)

From Developer A. Read this first, then `TEAM_AI_CONTEXT.md` (sections 5, 7 and 10 matter most for you).
If you use an AI assistant, point it at both files.

## 1. Get running (5 minutes)

```bash
git clone https://github.com/owly1/hacktv.git && cd hacktv
open dist/index.html                       # simulation mode: no install, no keys
```

Backend (connected mode). Node 22+ required. **Use `--env-file`**: the server does not load `.env` by itself.

```bash
cp .env.example .env
# edit .env: INGEST_TOKEN and DASHBOARD_TOKEN, two different values, e.g. `openssl rand -hex 32`
node --env-file=.env backend/server.mjs   # dashboard + API on http://127.0.0.1:8787
node --test tests/                         # backend contract suite
```

In the browser at http://127.0.0.1:8787, open **Integrations** and paste the **dashboard** token.
Do not paste the ingest token or the Gemini key into the browser.

## 2. What exists right now

| Area | State | Owner |
|---|---|---|
| Dashboard (`dist/`) | Simulation works offline: SVG map, animated spread, synthetic camera, panels, full-screen mode | A |
| Backend (`backend/`) | emberwatch.v1 API, token/CORS auth, memory storage, TigerData adapter, Gemini adapter **with tool calling** (`get_telemetry_history`) and `falsifiers` output | B |
| Bridge (`bridge/`) | Not in the repo yet | C |
| Docs (`docs/`) | `KEYS.md` (B), this file, `ACCEPTANCE.md` | all |

A verified on this handoff: the backend starts with `--env-file`, a test telemetry POST is accepted, `/api/status` reports
`telemetry.available: true`, and `/api/analyze` returns `503 Gemini is not configured` without a key.
**No real Gemini call, TigerData insert or drone connection has happened yet.**

## 3. Your workstream

Per `TEAM_AI_CONTEXT.md` §8: Gemini, the briefing workflow, scenario validation, documentation and the pitch.

1. **Gemini key + first real round trip.** B has already written the adapter, so don't rewrite it. Get a key at
   aistudio.google.com, set `GEMINI_API_KEY` in `.env` (backend only), post a fresh telemetry sample, then click
   *Analyze*. Save the response and its timestamp as evidence. `GEMINI_MODEL` in `.env.example` is a suggestion,
   not proof of access. Coordinate prompt or schema changes with B (`backend/server.mjs`).
2. **Briefing workflow review.** The planner lives in `dist/model.js` (`reviewDraft`, line 25) and `dist/app.js`:
   `markDirty` (line 9, invalidates reviews), draft render/review/export (lines 66–69), generation (line 73).
   It is deterministic templates only. Check that the wording never gives tactical commands, dispatches, evacuation
   orders or "safe route" claims (§1, §7).
3. **Scenario validation.** Check that the spread illustration stays labelled as illustrative everywhere, including
   exports, and that connected mode never shows the synthetic fire.
4. **Docs + pitch.** `docs/DEMO_SCRIPT.md` (3-minute demo) doesn't exist yet. Build it from `docs/ACCEPTANCE.md`.

## 4. Known issues touching your area

- **Analyze timeout (A is fixing).** The browser gives up after 12 s (`dist/app.js` line 78, `AbortSignal.timeout(12000)`).
  The backend allows each Gemini call 20 s and up to 2 tool rounds, so a real analysis can legitimately take longer.
  Until A pushes the fix, a slow real response will show as "Analysis unavailable" in the browser even though the
  backend succeeded.
- **`falsifiers` not displayed.** B's analysis output now includes `falsifiers` (what evidence would contradict the
  summary). The dashboard ignores it for now. A and D: agree on who adds it to the Gemini panel.
- **README backend command.** README says `node backend/server.mjs` after copying `.env`; that fails with
  "INGEST_TOKEN and DASHBOARD_TOKEN must be non-empty". Use the `--env-file` command above until B updates the README.

## 5. Shared files: coordinate before editing

| File | Shared by | Rule |
|---|---|---|
| `dist/app.js` | A + D | Tell A which section you're editing; keep commits small |
| `backend/server.mjs` | B + D | B owns the API contract; don't rename routes or fields |

Always **pull before you start and before you commit**. Four people push to `main`.

## 6. Cutoffs and fallbacks

| Milestone | Decision | If it isn't ready |
|---|---|---|
| H12 | Is the real Gemini round trip working? | Demo uses the labelled DEMO FIXTURE in simulation; say so honestly |
| H18 | Scenario → draft → review → export works end to end | Cut polish, not the review checks |
| H24 | Feature freeze | Only fixes after this |
| H30 | Clean-start rehearsal against `docs/ACCEPTANCE.md` | Failing items get fixed or removed from the demo |

## 7. Open questions for D

- Who holds the Gemini key? `KEYS.md` says D (or Sharon).
- Real Leaflet road map or keep the fictional SVG? A is deciding with the team. If Leaflet is added, the SVG stays
  as the offline fallback.
