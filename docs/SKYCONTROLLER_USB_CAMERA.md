# Windows Skycontroller USB camera

Camera-only path: ANAFI Wi-Fi → Skycontroller 3 → USB-C data cable → Windows
RNDIS → FFmpeg RTSP/UDP → authenticated JPEG ingest → dashboard. It supplies
no telemetry or aircraft commands; the Pi direct observer must stay stopped.

## Start

1. Keep aircraft grounded; connect the paired controller's USB-C to Windows.
   Leave its USB-A empty. The recorded controller address is `192.168.53.1`.
2. Start the configured backend with `npm start`.
3. With Node 22+ and FFmpeg on PATH, run from the checkout:

   ```powershell
   .\scripts\Start-ControllerCamera.ps1 -BackendDirectory $PWD.Path
   ```

4. Open <http://127.0.0.1:8787/>. Verify moving images and advancing timestamps.
   Old stored telemetry is not refreshed by this relay.

Defaults: `-Fps 10 -Width 960`; `-Width 0` keeps native calibration dimensions.
RTSP used UDP on the tested hardware; TCP failed. The relay reuses a healthy
receiver, drops excess pending frames and stops on lost video instead of
repeating a stale frame. Its timestamp is laptop reception, not aircraft capture.

## Recognition preview and boundaries

With the camera active, `python bridge/qr_orbit_rehearsal.py` exposes port 8789.
Check **LIVE DRONE CAMERA**, reset/arm the rehearsal, and show the selected
printed marker. The resulting orbit is an animation, not a fire incident or flight.

Recorded grounded checks: approximately 10 FPS delivery, physical tilt-wheel
operation while receiving, and selected-QR rehearsal recognition. No manual
landing, takeover or SDK piloting was established. A separate Pi controller-SDK
route needs its own working USB data link and paired-aircraft/piloting-source
checks; this Windows relay does not transport it.

Ctrl+C stops video and sends no landing command. Stop this receiver before
the direct [terminal hover](TERMINAL_FLIGHT_TEST.md) or other SDK modes.
Never run the full Start BOSCO observation path beside it.
