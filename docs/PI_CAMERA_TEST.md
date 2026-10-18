# Check real camera reception

Use the [Windows](RESTART_CURRENT_LAPTOP.md) or [Mac](MAC_SETUP.md) launcher,
with one receiver and the aircraft grounded. Leave Replay off.

1. Open <http://127.0.0.1:8787/> and move an object in the camera's view.
2. Confirm the picture content and capture timestamp both change.
3. Confirm fresh telemetry has a current observation time and plausible landed
   state/height; existing stored telemetry can outlive a connection.
4. Inspect `/api/status` with the dashboard token: camera/video `fresh`, ages,
   FPS, and `connection.state` describe the currently arriving evidence.
5. If testing a grounded off/on cycle, keep the backend/tunnel running and
   record the interruption and recovery. Only the Mac observation supervisor
   automatically retries; flight modes never restart themselves.

Pi loopback 8788 normally forwards to laptop 8787. The receiver's `frame`
transport posts raw JPEG to `/api/ingest/frame`; compatible `snapshot`
transport also feeds the dashboard relay. Use the transport configured for
the running backend.

Recorded Windows/Pi reception was 640 × 360 at about 8–9 FPS with a 10 FPS
target. This is historical evidence, not an expected rate for every resolution.
Native-resolution capture must keep width/zoom consistent with calibration.

On failure, check aircraft/Pi power, Ethernet, saved Wi-Fi, clock alignment,
competing SDK receivers and the [Pi logs](PI_RUNTIME_HANDOFF.md). A 200 response,
running process or retained JPEG alone does not prove a live aircraft stream.
No takeoff, detector accuracy or Gemini call is verified by this camera test.
