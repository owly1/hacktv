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
  1×/2×/4× common clock, map focus and bounded colored trails. Forecast controls
  and scenario camera/review state remain available; all AI panels are removed.
- `dist/sim-camera.js`: bank-aware 3D projection and other aircraft drawn at
  their world positions/heights. Existing fire and person overlays remain.
- `dist/people.js`: source aircraft shown in lead cards and briefs. Local named
  acknowledgement/closure still applies to fictional leads.
- `scripts/demo.mjs`: compare fleet/camera/CSS assets before reusing a backend.
- README/shared context and `docs/FLEET_DEMO.md`: launch and presentation guide.

Contracts or decisions changed: no live API or aircraft command changes. Only
explicit Replay generates these aircraft/people. Briefs include the whole
simulated fleet and source-attributed leads; the dashboard sends no Gemini requests.
The prediction remains the existing illustrative model, shared across views.
The older backend person-search fixtures and pad flight replay stay separate.

Checks run (including skips): `npm test` (107 passed); Windows-compatible Python
fire-monitor (10 passed) and fire-marker checks (3 passed). New coverage exercises all nine historical
geometries, 100 seeds/headings, all four detection contributors, exterior paths,
vertical speed/continuity, coordinated coverage, shared identities, bounded
memory, POV/rate/case state and exports. Full Python discovery was not run on
Windows; the unchanged SDK/POSIX paths require their documented environment.

Hardware/cloud evidence (or not checked): browser verified the scrollable feeds,
manual/automatic POV, map positions, descent/ascent, shared counter, named
acknowledgement, case switch, full screen and planning using an isolated fake
Gemini transport. No aircraft or real Gemini service was used for this task's
verification. This is no evidence of real fleet flight/ingest or person tracking.

Current patrol follow-up: the former fixed maximum-fire buffer is replaced by
the exact evolving +20-minute map contour. Fleet observation/search offsets are
about 105/65 m outside that contour; people are placed 26–31 m outside it at
their first search. The map opens at +20 minutes, with a persistent teal dashed
patrol outline and a separate solid current-fire outline. Camera, map, telemetry
and evidence use the same aircraft pose. Both hardcoded replay types suppress
inside-current-fire targets before camera rendering or observation generation.
Live person ingest is unchanged. Fire-first paths now search the exterior
+20-minute border, retain the false-positive/revisit/outage demonstration and
share one 9 m movement budget per simulation step across route waypoints.

Open issue / next step: integrate through review into `main`. Real fleet ingest,
freshness isolation, multi-view boundary fusion and physical coordination remain
separate work in `spec.md`. Browser reload starts a new randomized replay session.

Latest dashboard follow-up: scene analysis, incident Q&A and response planning
are all removed from the shared replay/live UI, navigation, controls, brief
sections and Gemini status chips. No dashboard AI requests or plan polling remain.
Backend automatic scene analysis defaults off; authenticated legacy API routes
remain compatible for explicit callers.

Fire-first search had a deliberate waiting-camera placeholder despite its
existing simulated drone. `backend/people-sim.mjs` now adds replay-only camera
geometry/objects and measured simulation-step speed, power and identity.
`dist/people.js` renders its camera and interpolates one capture interval using
the same position/heading for the map and telemetry. First load, case switching
and loop restart clear incompatible camera state. The fake radio outage keeps
the local onboard illustration while detections still follow delayed delivery.
Thermal and false-positive examples remain explicitly fictional.

Validation: 109 Node tests and 13 relevant Python checks passed. Added geometry
checks for UTSC and every historical search case, telemetry/camera agreement,
heading wrap, clearing a camera on case switch, and no UI AI requests. Browser
verified both modes without Q&A/planning and the fire-first rendered camera,
source labels, overlays, speed and battery. No aircraft or cloud inference used.
The latest regression checks compare fleet paths against independently measured
+20-minute polygon distances across all nine cases, check continuous motion and
all four search contributors, and inject inside-fire targets into both replay
engines to prove they cannot produce sightings. Browser checks confirm the
+20-minute default/preset, visible patrol border and exterior leads.
