# Gemini and planning handoff

The Gemini integration lives in `backend/server.mjs`; no separate AI service
or browser API key is needed. Start with [shared context](../TEAM_AI_CONTEXT.md).

| Part | Purpose |
|---|---|
| `ANALYSIS_INSTRUCTIONS`, response schema | Evidence-based scene analysis and optional derived wind |
| `buildAnalysisParts`, `runAnalysis` | Assemble fresh evidence and bounded read-only tool calls |
| `PLAN_INSTRUCTIONS`, `PLAN_SCHEMA` | Prioritized plan, owners, timing, triggers and rescue leads |
| `makeGeminiTransport` | Timeout, transient-error retry, fallback models and cooldown |
| `validateAnalysisContent`, `validatePlanContent` | Reject malformed structured output |
| `fcWindEstimate` | Prefer an available onboard wind estimate and disclose disagreement with Gemini |
| `findUnsafeWording` | Flag unsupported claims that ground/routes are safe or clear |

Configure `GEMINI_API_KEY`, `GEMINI_MODEL` and optional fallbacks in `.env`.
Analysis is limited to one start per 30 seconds; plans/replay requests to one
per 10 seconds. Analysis defaults to a configurable 60-second upstream cap;
plans use a 45-second per-call cap. A tool loop/fallback can take longer overall.

Live results go to the configured storage adapter. `/api/demo/analyze` and
`/api/demo/plan` use simulated evidence without querying or storing live results.
Preserve source labels, location uncertainty, human review and visible failures.

Run `npm test`. A successful mocked test or configured model name does not
prove account access; record real calls separately in [VERIFIED.md](VERIFIED.md).
