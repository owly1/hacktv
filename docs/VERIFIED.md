# Verification record

Historical evidence below was recorded on 17 October 2026. It describes those
specific runs, not every checkout, key, aircraft or future software revision.
Check current freshness and rerun the relevant acceptance step before a demo.

| Area | Recorded evidence | Limit |
|---|---|---|
| Gemini | Developer B: real `/api/analyze` and `/api/plan` round trips, around 11:47 UTC, `cb38a7a` and the then-current backend; analysis used read-only tools | Account/model availability and output accuracy are not guaranteed |
| TigerData | Developer B: schema and telemetry insert/readback, around 07:04 UTC, `380c2b0`; `telemetry` and `analyses` hypertables | Does not verify every later migration or table |
| Pi SDK | Native Olympe 8.5.0 build/import and synthetic color-conversion checks, 15:20–15:23 UTC | Software readiness, not aircraft reception |
| Pi reception | Grounded ANAFI Extended, firmware 1.8.2/HW_03: decoded 640 × 360 frames and real telemetry, 15:25 UTC; team dashboard later displayed them | No flight or controller coexistence established by that test |
| Camera rate | Later Windows/Pi checks measured about 8–9 FPS with a 10 FPS target | Different resolution/runtime can change throughput |
| Mac reception/recovery | Real camera/telemetry and an off/on cycle returned to live without restarting backend/supervisor; interruption about 52 s | Observation recovery only; flight modes do not auto-restart |
| Mac QR incident | Real selected QR created an incident; a manual Gemini retry succeeded after an initial timeout | Later physical automatic analysis was not recorded in that check |
| Controller USB video | Windows relay delivered about 10 FPS; operator confirmed grounded tilt-wheel control and QR rehearsal recognition | No SDK piloting, takeover or landing proof |
| Short hover | Operator reported successful takeoff, about 0.96 m hover, and automatic landing | Terminal X landing and later circle accuracy require separate evidence |

## Automated checks

Use `npm test` and `python3 -m unittest discover -s tests -p '*_test.py'` for
current results. These use fixtures, fake services and guarded/mock aircraft.
Olympe tests skip when its SDK is absent. Avoid copying a stale test count into
setup instructions; record the commit and actual output for each handoff.

## Still requires evidence

Physical terminal landing, measured orbit/preset accuracy, the complete live
detection-to-plan path on the current revision, real-fire classifier accuracy,
and any claimed rescue-location or spread accuracy. Neither model output nor
unit tests establishes these.

New entry template: **commit · operator · time · hardware/model/service · action
performed · observed result · logs/recording location · remaining limits**.
Keep credentials and footage local. See [acceptance](ACCEPTANCE.md),
[Pi notes](PI_OBSERVER_CONTEXT.md) and [SDK build](PI4_SDK_BUILD_NOTES.md).
