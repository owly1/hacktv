# Shared AI context

Read this first, then inspect the relevant source. Keep this file short;
put procedures in the linked guides and explain local behavior at its function.

## Project

- Name: BOSCO / Emberwatch, a Parrot ANAFI wildfire-monitoring prototype.
- Stack: Node 22+ HTTP backend, plain browser JavaScript, Python/Olympe on Linux.
- Normal path: aircraft → receiver → authenticated API → dashboard/Gemini/storage.
- The current `main` includes person search, historical replay, QR flight
  experiments, calibration capture and local flight recording.

## Where to work

| Concern | Source / reference |
|---|---|
| Routes, Gemini, database, video | `backend/server.mjs`, [contract](docs/BRIDGE_CONTRACT.md) |
| Validation and marker identity | `backend/validation.mjs`, `bridge/fire_detection.py` |
| Person search / simulation | `backend/people.mjs`, `backend/people-sim.mjs`, `dist/people.js` |
| Dashboard / spread / camera replay | `dist/app.js`, `dist/model.js`, `dist/sim-camera.js` |
| Observation-only receiver | `bridge/anafi_observer.py`, [Pi runtime](docs/PI_RUNTIME_HANDOFF.md) |
| Detection and common aircraft link | `bridge/anafi_bridge.py`, `bridge/fire_monitor.py` |
| Flight gates, geometry, SDK adapter | `bridge/qr_*`, `bridge/hover_checkout.py` |
| Laptop startup | `scripts/`, [Windows](docs/RESTART_CURRENT_LAPTOP.md), [Mac](docs/MAC_SETUP.md) |
| Evidence already recorded | [VERIFIED.md](docs/VERIFIED.md) |

## Contracts to preserve

- Live is the default; replay is explicit and never silently replaces live input.
- Ingest and dashboard tokens differ; cloud/database credentials stay server-side.
- Contract: `emberwatch.v1`. Missing measurements remain null; simulated site
  coordinates are not measured GPS. Altitude is height above takeoff.
- Angles are clockwise from north; wind/spread directions point **toward**.
- Prefer an available flight-controller wind estimate over Gemini's tilt-derived
  estimate; retain source labels and disclose disagreement. Neither is an anemometer.
- The only fire QR is `EW1:Alpha|120|X|35|M|30|60|31|18|18`.
  Change all pinned copies and tests together if its identity changes.
- The dashboard/Gemini cannot pilot. Aircraft commands belong to an explicitly
  enabled terminal flight runtime; observation is separate. One SDK owner only.
- Automatic `qr-demo` and `qr-circle` can take off after recognition when
  `--execute` is enabled. Preserve their one-shot, freshness and landing gates.
- Person leads carry uncertainty and require human review. Their state is JSON
  under `data/people/`, not TigerData; standard ANAFI RGB is not thermal hardware.
- Unit tests, configured services and sent landing commands are not physical proof.

## Working routine

1. Check `git status`, fetch, and preserve teammates' edits. Use the requested
   branch; coordinate overlapping files before publishing.
2. Read the source and linked workflow before changing a shared contract.
3. Keep function comments focused on purpose, units, side effects and failure cases.
   Preserve third-party assets and useful existing comments.
4. Run `npm test` and relevant Python checks. Report SDK skips and any environment
   limitation separately from failures. Never connect to hardware just to run tests.
5. Keep secrets, recordings, model weights and generated runtime files out of Git.

## Handoff template

```text
Task / owner:
Branch / commit:
Changed files and behavior:
Contracts or decisions changed:
Checks run (including skips):
Hardware/cloud evidence (or not checked):
Open issue / next step:
```

Current assignment and temporary notes belong in the chat or a handoff; avoid
copying dated test counts, active branch lists or machine logs into this file.
