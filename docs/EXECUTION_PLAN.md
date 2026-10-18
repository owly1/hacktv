# Development work areas

This replaces the original 36-hour schedule, whose simulation-only scope is
superseded by the integrated application. Use [shared context](../TEAM_AI_CONTEXT.md)
for current decisions and the [README](../README.md) for startup.

| Area | Deliverable | Depends on |
|---|---|---|
| Dashboard | Clear live/replay, incident and lead views | API shapes and spread model |
| API/data | Validated ingest, evidence storage and freshness | Receiver payloads and local configuration |
| Aircraft | Camera/telemetry; separate gated flight experiments | Provisioned Pi, one connection owner, hardware checks |
| Gemini/planning | Structured analysis and reviewed plans | Fresh evidence and an enabled model |
| Release | Clean startup, tests and accurate claims | Integrated source and recorded verification |

For a change: agree the interface, implement one complete path, run isolated
tests, exercise the relevant UI or hardware path, then record evidence and
remaining work. Missing cloud configuration should report unavailability;
it must not substitute a sample response into live mode.

Before a demo, run [acceptance](ACCEPTANCE.md). Record actual hardware/cloud
results in [VERIFIED.md](VERIFIED.md), separately from automated test results.
