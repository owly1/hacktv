# Codebase tour

Start the dashboard with the [README](README.md). For machine setup, use the
[Windows](docs/RESTART_CURRENT_LAPTOP.md) or [Mac](docs/MAC_SETUP.md) guide.

## Follow one observation

1. `bridge/anafi_observer.py` receives camera/telemetry on the Pi without piloting.
   `bridge/anafi_bridge.py` is the fuller detection/flight adapter.
2. `backend/validation.mjs` checks incoming measurements and the selected fire QR.
3. `backend/server.mjs` authenticates requests, relays JPEGs, stores evidence,
   calls Gemini and serves the dashboard.
4. `dist/app.js` renders the incident, drone, analysis and plan. `dist/model.js`
   supplies the shared illustrative spread calculations.
5. `backend/people.mjs` combines person observations into uncertain leads;
   `dist/people.js` displays evidence, coverage and responder actions.

## Concepts

| Term | Meaning here |
|---|---|
| Backend | The Node server on the laptop, normally port 8787 |
| Bridge / receiver | Linux process that owns the aircraft SDK connection |
| Telemetry | Battery, flying state, height, speed, attitude and available GPS |
| Detection episode | Related fire sightings sharing one identifier |
| Rescue lead | A possible person with evidence and a location-error estimate |
| Replay | Explicitly simulated input; its Gemini results are not stored as live data |
| Flight runtime | Separate opt-in terminal program that can command the aircraft |

The Pi's Wi-Fi talks to the drone. Ethernet/SSH carries observations back to
the laptop; laptop Wi-Fi remains online for cloud services.

## Pick an entry point

- UI work: `dist/app.js`, `dist/people.js`, `dist/styles.css`.
- API/data work: `backend/server.mjs`, `backend/validation.mjs`, `backend/schema.sql`.
- AI work: prompts, schemas and Gemini transport in `backend/server.mjs`.
- Hardware work: the selected [receiver/flight guide](README.md#choose-a-hardware-workflow).
- Debug a flight recording: `scripts/mac.py fetch-flights`, then `scripts/review_flights.py`.

Run the tests before changing interfaces. For all teammates' AIs, use
[TEAM_AI_CONTEXT.md](TEAM_AI_CONTEXT.md). Physical and cloud evidence is listed
in [VERIFIED.md](docs/VERIFIED.md); software tests do not establish flight accuracy.
