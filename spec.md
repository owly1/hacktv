# Proposed orbit loop and person-search descent

**Proposal, not the implemented flight mode.** Current measured flight makes
one lap; the automatic preset repeats fixed launch-relative laps. Neither
implements the hotkey-driven descent described here. Use the current
[mode guides](README.md#choose-a-hardware-workflow) to operate existing code.

## Intended behavior

Recognize the selected floor QR, take off, acquire its calibrated position,
enter a 1 m-radius orbit and repeatedly face the marker. Proposed controls:
S stops to a hold (a second S lands); D makes a controlled person-detection
descent and return; R resumes from hold; X/Esc always requests landing first.
These are proposed extensions, not keys currently accepted by every runtime.

## Proposed states

```text
DISARMED → ARMED → TAKEOFF → CLIMB → ACQUIRE → ENTRY → ORBIT
ORBIT ↔ HOLD
ORBIT/HOLD → DESCEND → DWELL → ASCEND → prior state
any airborne state → LANDING → confirmed LANDED (or unconfirmed error)
```

Typed `ARM ORBIT LOOP` would expire after 20 seconds. It would be one session
per process with explicit execution and a physical operator terminal. S/D
would only become immediate keys airborne, with priority X/Esc > S > D.

## Proposed limits

| Parameter | Default / permitted range |
|---|---|
| Radius | 1 m / 0.75–1.5 m |
| Orbit height | 1.5 m / 1–1.7 m |
| Segments | 12 / 12–24 |
| Horizontal speed | 0.25 m/s / 0.1–0.3 |
| Climb speed | 0.3 m/s / 0.1–0.5 |
| Descent height / standoff | 0.7 m / 0.5–1; 0.5 m / 0.4–0.8 |
| Descent speed / dwell | 0.4 m/s / 0.2–0.5; 4 s / 2–8 |
| Flight deadline | 300 s / 60–600 |
| Start / next-lap / land battery | 50% / 35% / 25% (ranges 40–100 / 30–60 / 20–40) |
| Consecutive blind chords | 4 / 2–6; then hold, land after another 5 s without pose |
| Correction caps | 0.15 m / 0.05–0.2; 10° / 3–15 |

Use a flat floor marker and measured camera/offset. Proposed entry accepts
0.6–2.5 m target distance, splits corrections into ≤0.5 m moves, and requires
radius error ≤0.15 m and bearing error ≤10°. No horizontal target search.
Each new pose must follow the previous move; cap vertical correction at 0.1 m.

The descent would require fresh geometry, sufficient battery and ≥20 seconds
remaining; dwell runs a report-only person detector. Person sightings must not
steer the aircraft. S aborts descent through ascent; D during a descent is ignored.

## Work before implementation

- Extend pure geometry/state logic separately from SDK commands. Reuse existing
  QR gate, calibrated pose, movement results and landing confirmation.
- Add explicit S/D/R input states without weakening landing priority.
- Bound every move/hold and check sensors ≤1 s, video ≤1.5 s, height/speed/tilt,
  marker loss, battery, mission time and camera-command failures.
- Test entry/chord math, correction clamps, blind-marker transitions, key priority,
  inverse descent/ascent, aborts and no-execute behavior with fake drivers/clocks.
- Only then run physical calibration, terminal landing, one arc/lap, drift,
  hold and descent checks in stages; retain recordings and measured results.

The earlier proposed new filenames and branch ownership were never an API
contract. Coordinate changes against current source and [shared context](TEAM_AI_CONTEXT.md).
