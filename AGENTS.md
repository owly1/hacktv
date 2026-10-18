# Repository guide for coding assistants

Start with [TEAM_AI_CONTEXT.md](TEAM_AI_CONTEXT.md) and [README.md](README.md).
Use current source as the authority when a historical note disagrees.

- Check the working tree and preserve other contributors' changes.
- Keep API field names, provenance, units and flight gates compatible.
- Document each first-party function's purpose; explain unusual units,
  asynchronous ownership and side effects where they matter.
- Leave `dist/vendor/` and generated assets in their upstream form.
- Do not commit `.env`, private keys, footage, weights or runtime state.
- Run `npm test` and the relevant Python tests before publishing. Python SDK
  tests mock aircraft and may skip without Olympe; do not turn tests into flight.
- Record what changed, validation and remaining work using the shared handoff template.

Launch procedures live in `docs/`. Normal observation and explicit flight
modes have different entry points; preserve that distinction.
