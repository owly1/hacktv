# Official integration references

Checked 16 October 2026. These sources support interface choices; they do not validate this prototype or the spread illustration.

- [Parrot Olympe overview](https://developer.parrot.com/docs/olympe/index.html): Linux Python interface; supported ANAFI variants; state and video access. The exact variant/controller combination must be checked on the team's hardware.
- [Parrot Olympe API reference](https://developer.parrot.com/docs/olympe/olympeapi.html): drone and controller classes, state access and streaming. The bridge targets direct ANAFI or SkyController 3, not every ANAFI family topology.
- [Connect to a physical drone](https://developer.parrot.com/docs/olympe/userguide/advanced/physical_drone.html): direct network connection and controller network options. A laptop on drone Wi-Fi may need separate tested Internet access for cloud services.
- [Parrot streaming guide](https://developer.parrot.com/docs/olympe/userguide/advanced/streaming.html): decoded-frame callbacks and streaming lifecycle. The included conversion code needs a physical hardware test with the installed SDK.
- [Gemini generateContent API](https://ai.google.dev/api/generate-content): authenticated server REST endpoint, image inputs, structured response configuration. The implementation uses the documented `responseMimeType` / `responseSchema` compatibility fields; newer API documentation prefers `responseFormat`. Validate the configured model against the account before the live demo.
- [Gemini structured output guide](https://ai.google.dev/gemini-api/docs/generate-content/structured-output): schema-constrained output does not make factual claims correct. The server also checks response shape and preserves human-verification limits.
- [TigerData create_hypertable reference](https://www.tigerdata.com/docs/reference/timescaledb/hypertables/create_hypertable): create a PostgreSQL table, then time-partition it. The SQL targets a Timescale version supporting `by_range`; choose the appropriate documented variant for the provisioned service.

The supplied original conversation reference contained the user's requirements but no readable previous assistant plan. The deliverable therefore implements the supplied current brief and preserves the named ANAFI, TigerData, Gemini, large animated map and four-person constraints.
