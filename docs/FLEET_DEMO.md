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
`DASHBOARD_TOKEN`. Gemini is optional for flight/camera/people replay; set
`GEMINI_API_KEY` to test analysis and planning. Enter `DASHBOARD_TOKEN` in the
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
2. Confirm four colored ANAFI markers around the current fire boundary.
   Their positions, heading cones and trails rotate with the same clock as
   the cameras. The forecast timeline changes the predicted fire horizon;
   it does not fast-forward the aircraft.
3. In the drone panel, scroll horizontally through ANAFI-01 through ANAFI-04.
   Each card has its own camera preview, phase, altitude, speed, battery and
   cumulative count of people it spotted. The large feed and detailed
   telemetry belong to the selected drone. Card counts overlap when drones
   see the same person; the shared counter counts each fictional person once.
4. Leave **Follow searches** enabled. At 2×, ANAFI-01 starts descending after
   about four seconds. Terrain perspective, camera pitch/bank and altitude
   change together. It searches the perimeter, ascends, then resumes observing.
   Other drones take turns. Choose 4× to see the first searches from all four
   drones within about 50 seconds. Speed changes preserve the current clock.
5. Watch cyan person boxes appear during low searches and **People found**
   increase. Each case randomly chooses 4–8 fixed fictional people, placed
   beside the perimeter at their first assigned search. The fire can later
   approach their positions. Leads include coordinates, illustrative uncertainty,
   capture times and source drone evidence. A named responder can acknowledge
   and close leads; closing removes a lead from the open counter.
6. Click a card or map marker. Its color highlights on the map and its
   camera/telemetry take focus. Manual selection disables Follow searches;
   enable it to resume automatic POV changes. Use full screen for the camera
   panel or map, and “Centre on the drone and fire” to frame the whole fleet.
7. Exercise the forecast slider, Conditions, Analyze current view, incident
   Q&A, Generate operational plan and Export brief. Analysis/planning require
   Gemini configuration and retain visible service errors when unavailable.
   Plans receive fleet poses and shared leads; briefs include fleet telemetry
   and source drones. Case switching preserves each case's evidence and results.
8. Exit replay. Fleet controls disappear and live inputs resume. Fictional
   evidence never posts to live ingest, rescue-lead storage or aircraft control.

## Implementation limits

The fleet is rendered locally with a common clock and existing WebGL terrain,
smoke, fire boxes and 3D camera projection. One aircraft at a time descends
from 64–73 m to 24–27 m, searches outside the growing fire and ascends; the
other three maintain observation. The repeatable schedule has small seeded
gaps. These dimensions and timings illustrate a presentation, not a validated
flight plan. WebGL is needed for the rendered terrain; satellite imagery needs
network access or previously cached tiles.

Targets have explicit fictional identities so repeated/cross-drone sightings
can share one lead. That association is not a real person tracking algorithm.
Evidence/trails are bounded for long presentations; replay state is held in
the browser and resets on reload. The existing illustrative fire forecast
is shared by the fleet; no new sensor fusion, multi-aircraft ingest, thermal
capability or autonomous aircraft coordination is claimed.
