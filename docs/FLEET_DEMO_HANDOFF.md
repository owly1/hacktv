# Fleet hardcoded demo handoff

Task / owner: Codex — replace historical single-drone ingress with a simulated
fleet orbit and perimeter person searches.

Branch / commit: `fleet-demo-hardcode`; see the branch head for the implementation
commit. Base: `647d380` on `main`.

Changed files and behavior:
- `dist/demo-scout.js`: four source-identified drones, seeded 4–8 fictional
  people, continuous exterior orbit/descent/search/ascent, coordinated slots,
  camera-visible observations, shared identities and bounded evidence.
- `dist/app.js`, `index.html`, `styles.css`, `fullscreen.js`: scrolling per-drone
  camera previews, selected full POV/telemetry, automatic search following,
  1×/2×/4× common clock, map focus and bounded colored trails. Forecast controls,
  Gemini tools and scenario caches remain available.
- `dist/sim-camera.js`: bank-aware 3D projection and other aircraft drawn at
  their world positions/heights. Existing fire and person overlays remain.
- `dist/people.js`: source aircraft shown in lead cards and briefs. Local named
  acknowledgement/closure still applies to fictional leads.
- `scripts/demo.mjs`: compare fleet/camera/CSS assets before reusing a backend.
- README/shared context and `docs/FLEET_DEMO.md`: launch and presentation guide.

Contracts or decisions changed: no live API or aircraft command changes. Only
explicit historical Replay generates these aircraft/people. Demo Gemini requests
and briefs now include the whole simulated fleet and source-attributed leads.
The prediction remains the existing illustrative model, shared across views.
The older backend person-search fixtures and pad flight replay stay separate.

Checks run (including skips): `npm test` (105 passed); relevant Windows-compatible Python
fire-marker checks (3 passed). New coverage exercises all nine historical
geometries, 100 seeds/headings, all four detection contributors, exterior paths,
vertical speed/continuity, coordinated coverage, shared identities, bounded
memory, POV/rate/case state and exports. Full Python discovery was not run on
Windows; the unchanged SDK/POSIX paths require their documented environment.

Hardware/cloud evidence (or not checked): browser verified the scrollable feeds,
manual/automatic POV, map positions, descent/ascent, shared counter, named
acknowledgement, case switch, full screen and planning using an isolated fake
Gemini transport. No aircraft or real Gemini service was used for this task's
verification. This is no evidence of real fleet flight/ingest or person tracking.

Follow-up: drones now stay more than 110 m from the rendered fire edge and
fictional people remain at least 70 m beyond the maximum rendered fire. Cards,
HUDs and telemetry show edge clearance. An imminent forecast no longer labels
an exterior fictional person as already at the fire. Regression checks cover
buffer clearance through maximum growth and long presentations.

Open issue / next step: integrate through review into `main`. Real fleet ingest,
freshness isolation, multi-view boundary fusion and physical coordination remain
separate work in `spec.md`. Browser reload starts a new randomized replay session.
