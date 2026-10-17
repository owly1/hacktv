# Blackboard system flow

Draw a horizontal data pipeline first, then the analysis/UI lane, then the human review gate. Use solid arrows for observed data and dashed arrows for synthetic scenario data. **Do not draw an arrow from the dashboard back to flight controls or field crews.**

```text
   PILOT: manual flight remains outside the software
                      |
                      v
[1 ANAFI] ---> [2 Linux bridge] ---> [3 API: auth + validate] ---> [4 TigerData]
 RGB + state     Olympe read only      time + source + units        time series
                       |                        |                        |
                       | JPEG snapshots         | fresh evidence         |
                       +------------------------+----> [5 Gemini]        |
                                                |      descriptive       |
                                                |          |             |
                                                v          v             v
[S Synthetic scenario] - - - - - - - - -> [6 Dashboard + provenance] <--- API read
 map + camera + spread illustration             |
                                                v
                                     [7 Briefing draft]
                                     evidence / gaps / questions
                                                |
                                                v
                                     <8 Human review complete?>
                                      no |                 | yes
                                         v                 v
                                 Verify / revise     [9 Export review record]
                                      |               local, self-reported
                                      +------> 7

No automatic flight, crew dispatch, suppression tactic or evacuation order.
```

## Copying instructions

1. Put boxes 1–4 across the top third. Write “pilot manual” above box 1, with a downward arrow.
2. Put box 5 beneath box 3. Label its incoming arrow “fresh image/telemetry.” Gemini is an inference, not a sensor.
3. Put box 6 across the center, underneath boxes 3–5. Draw arrows from the API read side and Gemini. Label the TigerData return “via API”; the browser never receives database credentials.
4. Put S on the left and use a dashed arrow into box 6. Write “SIMULATION” beside it. In Simulation the sample Gemini output is a fixture; connected mode does not blend in the fictional heatmap.
5. Under box 6 stack box 7, diamond 8, then box 9. The “no” branch loops to verification and back to 7. The “yes” branch only records a local review and enables export.
6. Underline “human decisions” at the bottom. Keep any operational decision outside the software boundary.

Use the included `dist/blackboard-flow.svg` for a clean printable version. The dashed simulation branch feeds UI data independently of the authenticated real-data pipeline. API failure is reported as unavailable; it does not silently switch the meaning of the data.
