# Airborne contour search handoff

Task / owner: Codex — start the real contour flight with a one-drone airborne
QR search at 1 m, transition to the Tiny forecast, and provide Marker 2 as PDF.

Branch / commit: `main`, directly updated at the user's explicit request;
the implementation commit is recorded in Git.

Changed files and behavior:
- `bridge/contour_search.py`, `fire_response.py`, `fire_contour.py`: one SDK
  owner takes off before QR recognition, corrects measured height to 1 m,
  searches bounded GPS waypoints, holds to acquire stable Tiny poses, then
  follows the real-time +5-minute contour through actual movement commands.
  The original launch GPS remains the flight envelope's origin.
- `backend/autonomy.mjs`, `validation.mjs`: explicit search capability and
  idempotent search ownership, separate from the existing incident/fire claim.
  New search/hold reporting remains within `emberwatch.v1`. Circle remains
  the default, with its existing fire-triggered takeoff and flight limits.
- `dist/app.js`, `index.html`: explicit takeoff/search action, receiver-driven
  one-aircraft status, and QR-encoded conditions labelled separately from
  measured wind. Pi/fleet copy remains frontend architecture only.
- `dist/tiny-marker.pdf`, Tiny print page/generator, PDF generator and static
  MIME: labelled Marker 2 with an exact 180 mm QR square, 0.2 km/h wind and
  1 cm/min spread. Original Alpha assets and Tiny PNG are unchanged.
- Windows receiver installer includes the new search module; the existing
  Mac Python source bundle includes it automatically. Operating docs updated.

Contracts or decisions changed:
- Contour enable requires `airborne_search_supported: true`; old receivers
  cannot silently interpret this action as the earlier QR-first workflow.
- A dashboard acknowledgment precedes `stage: "search"` claim. Its stable
  search ID binds one takeoff to the current receiver/session. The later
  exact-Tiny fire claim requires that same owner and accepted incident.
- Normal contour duration is `null`, meaning operator-ended. Battery, link,
  camera/flight sensors, GPS, motion failures and geofence faults still request
  landing. Short tests retain 60 seconds; circle retains 300 seconds.
- Search uses 0.1 m/s, 0.2 m maximum commands and a 2 m launch envelope. It
  requires fresh measured GPS with positive horizontal accuracy ≤0.5 m.
  Acquisition uses post-stop metric samples; no QR means continued search.
- Encoded weather drives the reproducible Tiny scenario. This does not add
  an anemometer, a second aircraft, fleet commands or fabricated GPS.

Checks run (including skips):
- `npm test`: 209 passed, no failures or skips.
- `.venv/bin/python -m unittest discover -s tests -p '*_test.py'`: 396 tests,
  269 passed and 127 SDK-dependent checks skipped because Olympe is absent.
- Final contour-specific discovery after the added concurrency regression:
  30 tests, 18 passed and 12 SDK checks skipped. Synthetic feedback exercises
  measured climb/descent, actual search moves, acquisition, contour handoff,
  continued flight beyond five minutes, explicit LAND, short-test expiry,
  failed progress, GPS faults, battery/link faults and bounded marker holds.
- Marker PDF: one A4 page, embedded square measured 179.9999928 mm per side,
  rendered QR decodes to the exact Tiny payload, original image pixels intact,
  deterministic regeneration verified, and 13 marker tests passed.
- Browser: reviewed the separate disabled takeoff/circle controls, one-aircraft
  Pi architecture and PDF link without a receiver; no console warnings/errors.
  PDF GET returns 200 and `application/pdf`.
- Python compilation, `git diff --check`, unchanged Alpha/Tiny PNG and vendor
  assets verified. No SDK-dependent result is represented as hardware proof.

Hardware/cloud evidence (or not checked): no aircraft, Pi deployment, motors,
real GPS or cloud storage was exercised. Browser review used a separate local
memory server with no receiver. Flight simulation tests use synthetic sensor
feedback and command doubles; they are not physical flight evidence.

Open issue / next step: restart/deploy the updated receiver while grounded,
then physically validate the bounded search, measured height and contour.
Ordinary indoor ANAFI GPS may fail the retained 0.5 m accuracy gate. Print
Marker 2 at actual size and verify its square measures 18 cm.
