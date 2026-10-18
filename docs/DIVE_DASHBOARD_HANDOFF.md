Task / owner: Live person observation extension / Codex
Branch / commit: dive-dashboard (extends main and live-demo-dashboard)
Changed files and behavior: person_detection.py provides laptop-only YOLO
person inference and fresh-frame tracking. fire_monitor.py sends person
boxes and confirmed observations alongside fire/QR evidence. Existing located
leads use the original person API/crops/error model. person-sightings.mjs
validates bounded unlocated notes; server.mjs persists and exposes their
review state. people.js shows and exports them without fabricated map pins.
Contracts or decisions changed: Added /api/ingest/person/sighting and named
camera-sighting review routes; extended vision health and /api/people with
optional fields. All live observations retain provenance=live. Random people
are confined to historical Replay. No flight-control contract changed.
Checks run (including skips): npm test; fire_monitor_test.py,
person_detection_test.py and fire_marker_test.py. Python integration uses real
JPEG/HTTP with fake inference on an isolated backend; no aircraft/cloud.
Hardware/cloud evidence (or not checked): Real camera person model accuracy,
actual aircraft GPS/gimbal synchronization and live flight remain unverified.
Open issue / next step: Install compatible person weights, start the existing
receiver and laptop vision monitor, then perform a grounded person observation
check before any separately authorized flight.
