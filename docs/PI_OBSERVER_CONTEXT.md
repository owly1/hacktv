# Observation receiver context

`bridge/anafi_observer.py` is the read-only Pi receiver: telemetry and JPEG
camera frames, no flight or gimbal commands. `bridge/anafi_bridge.py` is the
separate richer adapter; do not substitute it for the observation service.

## Compatibility

- Targets the provisioned Olympe 8.5.0 environment; use its isolated Python
  and `PYOPENGL_PLATFORM=glx` wrapper.
- Classic ANAFI video uses `StreamInfoDefault` and raw callbacks through
  `play_multiple_stream`; the generic `Front camera` stream failed on the
  tested aircraft.
- Posts `emberwatch.v1` telemetry plus raw frames or compatible snapshot
  envelopes. Empty overlays do not count as fire detections.
- Missing GPS sentinels remain null; height is above takeoff. SDK INFO settings
  events are suppressed because they can contain network credentials.
- `--camera-fps 0` is unthrottled; positive values throttle processing.
  `--camera-width 0` preserves native decoded dimensions.

## Recorded hardware evidence

On 17 October 2026, grounded ANAFI Extended firmware 1.8.2/HW_03 delivered
real telemetry and decoded 640 × 360 JPEGs through the Pi tunnel to the laptop
dashboard. Later the configured 10 FPS service delivered about 8–9 FPS.
Mac observation also recovered from a physical off/on cycle.

These runs do not establish flight, controller coexistence or classifier
accuracy. Cloud evidence is separate in [VERIFIED.md](VERIFIED.md).

Use [Pi runtime](PI_RUNTIME_HANDOFF.md), [camera checks](PI_CAMERA_TEST.md)
and [SDK build notes](PI4_SDK_BUILD_NOTES.md). Preserve one SDK owner and the
separation between automatic observation recovery and explicit flight modes.
