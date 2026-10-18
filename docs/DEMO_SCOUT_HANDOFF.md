Task / owner: Historical demo scouting / Codex
Branch / commit: main (historical demo update)
Changed files and behavior: demo-scout.js owns per-case random fictional
people, camera-visible sightings, a simulated ingress/orbit and local review
state. app.js uses that pose for the map, camera, telemetry, plans and brief.
sim-camera.js draws people and boxes in the same world coordinates.
people.js reuses existing lead cards without posting demo reviews to live APIs.
The launcher checks the people API and served assets before backend reuse.
Contracts or decisions changed: Historical cases default to an illustrative
rescue scout with 3–7 people. This simulated flight may enter the rendered
fire; real flight gates and aircraft control are unchanged. Demo data stays
in the browser and is explicitly labeled simulated.
Checks run (including skips): npm test; relevant QR detector Python checks;
browser verification of historical scouting, camera, telemetry and people.
Hardware/cloud evidence (or not checked): No aircraft commands or hardware
flight. Cloud output is not required for the local scout demonstration.
Open issue / next step: dive-dashboard adds actual laptop person detections
to the live observation path, with no random people in live mode.
