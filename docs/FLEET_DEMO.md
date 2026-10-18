# Historical fleet demo

Branch: `fleet-demo-hardcode`, based on updated `main`. No build step.
This is an explicit browser replay with fictional flight and people. The live
receiver and physical flight workflows remain separate.

## Launch on Windows

From your existing repository, with Node 22+:

```powershell
git fetch origin
git switch fleet-demo-hardcode
git pull --ff-only origin fleet-demo-hardcode
npm ci
.\demo.ps1 -Port 9001
```

Keep your configured `.env`. On a fresh checkout, first run
`Copy-Item .env.example .env` and configure distinct `INGEST_TOKEN` and
`DASHBOARD_TOKEN`. Gemini is not required by either dashboard. Enter `DASHBOARD_TOKEN` in the
dashboard's Integrations dialog when prompted. Credentials stay local.

Open <http://127.0.0.1:9001/?demo>. On Mac/Linux use
`npm run demo -- --port 9001`. Stop the launcher with Ctrl+C.

If a port is occupied by another checkout, the launcher refuses to reuse its
dashboard. Stop that process or choose another port. After pulling changes,
restart the backend and use Ctrl+Shift+R to refresh browser assets.

## Presentation walkthrough

1. Start with the default **Horse River** historical case. The selector's
   **Historical fleet perimeter search (simulated)** group contains all nine
   fleet cases. The older “Person search · fire first” fixtures and flight-pattern
   replay are separate demonstrations.
2. Confirm four colored ANAFI markers patrolling outside the fire. The replay
   opens at **Now**; solid red marks the current fire. The dedicated +20-minute
   patrol marker and preset have been removed. Routes still use that forecast
   as an internal exterior buffer, with lateral weaving and changing bank angles
   instead of a rigid path. Map and camera movement use the same world pose.
   Their positions, heading cones and trails rotate with the same clock as
   the cameras. The forecast timeline changes the predicted fire horizon;
   it does not fast-forward the aircraft.
3. In the drone panel, scroll horizontally through ANAFI-01 through ANAFI-04.
   Each card has its own camera preview, phase, altitude, speed, battery and
   cumulative count of people it spotted. The large feed and detailed
   telemetry belong to the selected drone. Card counts overlap when drones
   see the same person; the shared counter counts each fictional person once.
4. Leave **Follow searches** enabled. At the default 8×, ANAFI-01 starts
   descending after about one second. Terrain perspective, camera pitch/bank and altitude
   change together. It searches the perimeter, ascends, then resumes observing.
   Other drones take turns while all four keep orbiting the roughly predicted
   +20-minute boundary. The first searches finish within about 25 seconds.
   Choose 1×/2×/4× to slow down. Speed changes preserve the current clock;
   colored trails show only where drones have flown, with no prewritten route.
5. Watch cyan person boxes appear during low searches and **People found**
   increase. Each case randomly chooses 4–8 fixed fictional people, placed
   about 26–31 m outside the +20-minute border at their first scheduled search.
   Drones pace about 105 m outside that contour, approaching about 65 m outside
   it during descents. Camera observations reject targets inside the current
   fire in either the map or rendered camera geometry. Drones keep over 110 m
   of ground clearance from the current fire across the supplied cases;
   camera HUDs and cards display distance from the current fire edge. Leads include coordinates, illustrative uncertainty,
   capture times and source drone evidence. A named responder can acknowledge
   and close leads; closing removes a lead from the open counter.
6. Click a card or map marker. Its color highlights on the map and its
   camera/telemetry take focus. Manual selection disables Follow searches;
   enable it to resume automatic POV changes. Use full screen for the camera
   panel or map, and “Centre on the drone and fire” to frame the whole fleet.
7. Exercise the forecast slider, Conditions, lead review and Export brief.
   Briefs include fleet telemetry and source drones. Scene analysis, incident
   Q&A and response planning are removed from both replay and live dashboards.
   No Gemini key or cloud inference is needed for these dashboard features.
8. Exit replay. Fleet controls disappear and live inputs resume. Fictional
   evidence never posts to live ingest, rescue-lead storage or aircraft control.

## Fire-first person-search replay

The **Person search · fire first** selector group remains a distinct single-drone
mission, with fictional people outside its +20-minute border, uncertainty, revisits and
simulated store-and-forward during a link outage. It previously drew a waiting
placeholder instead of camera input. It now shows the same moving ANAFI-01 pose
in the 3D camera, map and telemetry, including speed and battery.

Select **UTSC · Highland Creek ravine** in that group. Within a second, confirm
the **ANAFI-01 · Search POV** header, **3D search replay** source, altitude/speed/
power, heading and moving map marker. Expand the drone panel to inspect person
overlays and the fire box. Switch to a historical search and then back to a
fleet case; the previous search camera must stop. Camera scene objects and
thermal cues are fictional; standard ANAFI RGB is not thermal hardware. During
the staged link outage the rendered onboard replay continues, labeled as such,
while observations follow the existing delayed-delivery behavior.

## Forest patrol with a presenter trigger

In the same replay dropdown, choose **Forest patrol · press Detected** under
**Interactive fleet exercise (simulated)**. Four aircraft hold stationary above
the forest at 150, 170, 190 and 210 m, at least 1.5 km apart. There is no fire,
smoke, fire box, predicted spread or
person lead until you press **Detected**, next to the dropdown.

Press the button to reveal a fictional fire near ANAFI-01. All four drones move
continuously from their current positions toward the incident, with a bounded
12 m/s approach and 2 m/s maximum descent; there is no teleport or camera swap. Select different aircraft
to compare their terrain, tree perspective, heading and distance. The default
8× patrol replay uses a clearly labeled 16× approach, taking about 17 seconds
to converge before returning to 8× orbital patrol and exterior searches.
Telemetry remains in simulation metres/seconds. Detection immediately opens
the +30-minute spread prediction; arrival reframes the map around the fleet.
The existing people counter/review controls remain available. The forest geometry, fire,
people and flight are simulated. The background satellite imagery is geographic
context, not recorded drone footage. Reselect this case to reset and rearm the
button; switching to another case or live mode hides the trigger.

## Implementation limits

The fleet is rendered locally with a common clock and existing WebGL terrain,
smoke, fire boxes and 3D camera projection. One aircraft at a time descends
from 78–84 m to 36–39 m, searches outside the +20-minute border and ascends; the
other three maintain observation. The repeatable schedule has small seeded
gaps. Patrol positions use the exact same evolving contour as the map's
+20-minute prediction, with smooth outward offsets. People stay fixed after
placement; detections are suppressed if a target is inside the current fire.
These dimensions and timings illustrate a presentation, not a validated
flight plan. WebGL is needed for the rendered terrain; satellite imagery needs
network access or previously cached tiles.

Targets have explicit fictional identities so repeated/cross-drone sightings
can share one lead. That association is not a real person tracking algorithm.
Evidence/trails are bounded for long presentations; replay state is held in
the browser and resets on reload. The existing illustrative fire forecast
is shared by the fleet; no new sensor fusion, multi-aircraft ingest, thermal
capability or autonomous aircraft coordination is claimed.
