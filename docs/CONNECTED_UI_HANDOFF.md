# Connected BOSCO interface

Task / owner: Codex — connect the uxui design to the working dashboard and demos.

Branch / commit: `feat/connect-bosco-dashboard`, based on `b44d55d`.

Changed files and behavior:
- `dist/index.html` is the canonical BOSCO dark/light workspace. It loads the
  existing app, people, fleet, simulation, Leaflet and fullscreen controllers.
- `dist/bosco/dashboard.css` applies the new design to the runtime DOM;
  `dashboard.js` handles theme, home transitions and replay-picker visibility.
  The separate fixture incident controller and data are removed.
- The new home and teardown open the real replay or live workspace. Old
  dashboard/home URLs forward to the shared entry points.
- Replay cases have shareable URLs; leaving Replay removes stale mode/case
  parameters. Selecting a case preserves unrelated URL options and anchors.
- The launcher compares the new presentation assets before reusing a server.
- README, shared context and spec distinguish implemented replay capabilities
  from future live fleet coordination and document the launch paths.

Contracts or decisions changed: all backend API routes, authentication,
provenance, units, storage and aircraft gates remain unchanged. The new UI uses
the existing real data controllers. Default `/` is live observation; `/?demo`
explicitly starts replay. No dashboard Gemini or aircraft commands are added.

Checks run (including skips): `npm test` — 147 passed; `git diff --check` passed.
New checks cover static dependencies, legacy bookmark forwarding and mode/case
URL persistence. Browser checks covered dark/light themes, phone-width layout,
home/teardown navigation, historical fleet POV switching, forest detection and
approach, forecast presets, map fullscreen, person-search camera, flight replay,
and named live acknowledgement/closure. Live video/telemetry were delivered
through the actual HTTP APIs using isolated test fixtures and memory storage.
No Python code or bridge behavior changed; Python/SDK tests were not rerun.

Hardware/cloud evidence (or not checked): no aircraft, physical flight,
production database or real model service was used. Test camera input was a
repository image, not flight footage. Existing live integrations still depend
on the user's configured backend and running receiver.

Open issue / next step: teammates branch from updated `main`. Real multi-drone
ingest, freshness isolation, real boundary fusion and physical coordination
remain the separate work described in `spec.md`. If localhost still shows the
older interface, restart from the updated checkout or use another port.
