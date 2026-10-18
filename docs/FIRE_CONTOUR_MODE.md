# Tiny fire forecast contour

The Live dashboard has two distinct actions. **Start BOSCO** retains the
existing measured one-metre circular response. **Start contour response**
selects the Tiny fire's five-minute forecast course. LAND stops either mode.
Switching modes requires ending the current session and deliberately starting
a new one. Observation startup and Replay never authorize flight.

## Marker and preview

Open `/tiny-marker.html` to print the second marker at 100% scale. Its black
square is 18 cm across; its printed size must match the independently verified
camera calibration. The original `/test-marker.html` and Alpha PNG are retained.

```text
EW1:Tiny|0.0001|L|0.01|G|0.2|60|22|45|18
```

Tiny starts at 0.0001 ha (1 m²). Wind is only **0.2 km/h**, with **0.01 m/min
head spread** (1 cm per minute). Lowering both keeps the outline almost fixed
during the demo: its modeled head advances approximately 5 cm over five minutes.
It retains the existing model's irregular boundary, with little wind elongation.
Only the exact Alpha and Tiny payloads are accepted; arbitrary EW1 codes are not.

**Preview tiny contour · no flight** opens a local animation of one aircraft,
the current fire, the +5-minute route, the initial marker area and a metre scale.
The elapsed-time slider affects only the preview. It sends no aircraft requests
and works without GPS, a Pi or a connected drone. This is the appropriate way
to demonstrate the contour when the real GPS does not meet the small course's
precision requirement.

## Flight behavior

1. A fresh compatible receiver must report contour readiness before the separate
   action enables the session. The usual owning dashboard heartbeat is required.
2. Five fresh decoded Tiny observations over at least 0.8 seconds must match an
   accepted Tiny incident and a stable, physically verified metric location.
3. The receiver combines that initial camera location with synchronized aircraft
   GPS and heading to freeze the general fire-area anchor. It uses no configured
   site point, home fallback or assumed GPS.
4. After claim, the marker is no longer tracked for navigation. The aircraft
   takes off to the existing approximately 1 m launch-relative height, then
   follows GPS waypoints on the evolving forecast. It uses the same sole SDK
   owner, command acknowledgements and landing path as the existing runtime.

`bridge/fire_contour.py` matches the 72-vertex wind/ellipse/wobble geometry in
`dist/model.js` with uniform fuel. The horizon is five minutes plus real elapsed
time since claim. The live map renders the receiver's frozen anchor and scenario
on a separate overlay; weather edits, timeline sliders and replay speed cannot
change the physical course.

Boundary growth follows the model's spread in metres per minute. Tangential
patrol speed is a distinct quantity: 30 times head growth speed, bounded to
0.05–0.20 m/s. Tiny therefore patrols at **0.05 m/s** while its boundary expands
very slowly. The drone can visibly traverse the line without accelerating the
fire model. Short movement commands are capped at 0.2 m and checked against
received GPS, heading, movement results and the launch envelope.

## Physical gates and current limits

- Actual SDK location events must be no more than 1.5 seconds old. Reported
  horizontal accuracy, computed from latitude/longitude accuracy components,
  must be positive and at most **0.5 m**. Unknown accuracy is not sufficient.
- The initial fire anchor must be within 3 m of the launch position. The entire
  modeled course must stay within 4 m of that anchor, and received position
  must stay within 6 m of launch. GPS jumps and failed movement progress abort.
- The full mission uses the existing battery and duration limits: normally
  40% start/in-flight minimum and 300 seconds; the explicit short test uses
  30% to start, 25% in flight and 60 seconds. Height is above launch, not ground.
- LAND, expired dashboard/receiver contact, stale sensors, poor GPS, aircraft
  disconnection and command failures request landing. QR disappearance after
  anchoring does not independently stop the GPS course.

Ordinary onboard GPS, especially indoors, may not meet the 0.5 m requirement.
This implementation does not add RTK hardware or claim that the existing ANAFI
can physically trace a metre-scale line. The mode remains unavailable until
the receiver reports suitable measured data. Software tests are not flight proof.
Alpha's large forecast is rejected for this bounded contour mode; Alpha's
existing circular flight remains available through its original action.

## Launch and architecture

Follow [Mac setup](MAC_SETUP.md) or the existing Pi/Windows procedures. The same
disarmed `fire_response.py` receiver advertises both modes; do not start another
receiver for contour. Mac source bundles include the new Python module, and
the Windows installer manifest includes it explicitly. Do not deploy new code
over a running flight receiver.

The frontend presents the Raspberry Pi as the aircraft/data hub and shows how
the workspace could expand to a fleet. This demo still operates **one real
drone**. No fleet backend, second live aircraft, distributed flight control or
new fleet ingestion contract is implemented. Existing four-drone Replay is
independent of physical flight.

## Validation and handoff

Run `npm test` and `.venv/bin/python -m unittest discover -s tests -p '*_test.py'`.
The new pure geometry tests compare every Python vertex against the browser
model, exercise growth/pacing and verify GPS/motion aborts with fake drivers.
SDK tests mock aircraft and skip when Olympe is absent. See the branch handoff
in [FIRE_CONTOUR_HANDOFF.md](FIRE_CONTOUR_HANDOFF.md) for completed checks.
