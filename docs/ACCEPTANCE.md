# Acceptance checklist

Commit: __________  Operator/reviewer: __________  Date/time: __________
Record failures and skipped checks; do not turn unchecked items into claims.

## Software and startup

- [ ] `npm test` and relevant Python checks pass; SDK skips are listed.
- [ ] A clean checkout starts using the README without committed secrets.
- [ ] Live opens waiting for the aircraft; unavailable/stale input is visible.
- [ ] Replay is explicit; switching cases or back to live clears incompatible state.

## Observation and detection

- [ ] One receiver owns the link; video timestamps advance and telemetry is fresh.
- [ ] Selected QR creates a labeled test incident; unrelated QR payloads do not.
- [ ] Missing RGB fire coordinates remain unknown; scenario locations stay labeled.
- [ ] Incident dismissal works; automatic Gemini analysis succeeds or shows a reason.

## Leads and planning

- [ ] Person-search replay shows candidates, multiple views, delayed alerts and coverage.
- [ ] Lead acknowledgement/closure records a named responder and outcome.
- [ ] Plans include evidence, uncertainty, actions and re-planning triggers.
- [ ] Changed conditions mark plans stale; approval/export retain source and reviewer.
- [ ] Replay plans/analyses never appear in live storage.

## External services and hardware (separate checks)

- [ ] Real Gemini analysis/plan and TigerData insert/readback are recorded, if claimed.
- [ ] Use the chosen mode's [flight guide](../README.md#choose-a-hardware-workflow).
  Confirm physical terminal landing before a circle; verify touchdown rather than
  only a sent command. Software tests alone do not satisfy this item.
- [ ] Keep recordings and update [VERIFIED.md](VERIFIED.md) with exact scope.
