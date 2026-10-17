# Skycontroller 3 USB camera reception on Windows

This is a camera-only alternative to the Pi's direct Olympe connection. It does
not implement telemetry, QR detection, camera movement, pilot takeover, takeoff,
landing, or an autonomous orbit. No SDK piloting-source or joystick mapping is
changed. Grounded camera-tilt operation alongside the live feed was confirmed
by the operator on 17 October 2026; landing and takeover remain unverified.

Route: ANAFI Wi-Fi → Skycontroller 3 → USB-C data cable → Windows RNDIS network
→ FFmpeg (RTSP over UDP) → authenticated localhost frame ingest → browser.
The Pi is bypassed by this video route; its direct observer must remain stopped.
Laptop Wi-Fi remains available for Gemini/TigerData internet access.

On 17 October 2026 Windows detected the controller as Parrot Skycontroller 3
v1.8.1 after a USB-C-to-USB-C connection. Microsoft Remote NDIS Compatible Device
was assigned specifically to its RNDIS interface. The controller was reachable
at 192.168.53.1, and its drone REST proxy on port 180 returned ANAFI firmware
1.8.2. A UDP RTSP probe decoded 1280×720 H.264 with an advertised 30000/1001 FPS;
TCP transport failed. This does not establish any flight-safety capability.

The camera-only relay subsequently delivered fresh frames to the running
dashboard at 10 FPS. The operator confirmed that the physical controller's
camera-tilt wheel moved the camera while that live feed continued updating.
That grounded camera-control check passed; no flight was performed.

## Start

1. Keep the aircraft grounded and the Pi direct observer stopped. The existing
   `Start BOSCO.cmd` starts that direct observer; do not use its full startup mode
   alongside this receiver.
2. Power the controller and connect its USB-C port to the laptop with the tested
   cable. Leave the controller's USB-A port empty. Wait for aircraft pairing.
3. Start the existing backend on localhost:8787 from its own directory:
   `npm start`. It must use the matching local `.env`.
4. The camera launcher and receiver are also installed in the team's working
   directory, `C:\Users\anshi\Desktop\drone`. In another PowerShell window, run:

   ```powershell
   cd "$env:USERPROFILE\Desktop\drone"
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-ControllerCamera.ps1
   ```

   The backend directory defaults to `$env:USERPROFILE\Desktop\drone`. Override
   it with `-BackendDirectory` if needed. Node 22+ and FFmpeg on PATH are required.
   `-Fps 10 -Width 960` is the default; `-Width 0` preserves native resolution for
   measured camera calibration. Browser JPEG delivery FPS differs from the
   aircraft's encoded stream FPS. If a single receiver is already running with
   fresh frames, the launcher reports its PID and reuses it instead of starting
   a second stream.
5. Open http://127.0.0.1:8787/. Confirm fresh camera timestamps and increasing
   delivered-frame counts. Existing telemetry may be old: this relay supplies no
   battery, altitude, GPS, or flight-state updates. Gemini configuration alone
   does not verify a successful Gemini request.
6. While reception runs, test only the controller's camera-tilt wheel with the
   drone grounded. Manual landing/takeover requires a separate verified test
   before any flight experiment.

## Grounded QR recognition

With this camera feed running, the existing laptop rehearsal can read its fresh
snapshots. From the source checkout root, run `python bridge/qr_orbit_rehearsal.py`
only if it is not already running. Open http://127.0.0.1:8789/ and confirm the
source says **LIVE DRONE CAMERA**. Click **Reset**, then **Arm rehearsal**, and
present the selected printed marker from http://127.0.0.1:8787/test-marker.html.
The expected result is a QR recognition label and a simulated orbit. The page
has no flight driver and cannot move the aircraft. Port 8790 may host an older
test-image preview; it is not evidence of recognition through the real camera.

On 17 October 2026 the operator confirmed that presenting the printed marker to
the real camera produced **SELECTED QR RECOGNIZED** and started the simulated
orbit. The live rehearsal's status subsequently reported `mode: live drone
camera`, `state: triggered`, `progress: 1`, fresh frames, and
`flight_commands_possible: false`. This verifies the grounded recognition and
simulated-orbit demonstration. It does not verify aircraft motion or submit a
fire detection/Gemini analysis to the main dashboard.

The Pi orbit runtime now has an explicit `--controller skycontroller3` mode,
which selects the SDK's `SkyController3` class and defaults to 192.168.53.1.
In controller mode, execution requires a paired aircraft and a
reported `SkyController` piloting source; it never changes the source to
`Controller`, which disables RC joysticks. A source change fails the flight
state gate. These checks do not prove a working manual override.

All 67 Python checks passed on the installed Pi Olympe 8.5.0 SDK using fake
aircraft and guarded constructors. No live controller SDK connection or QR flight
has been tested. The optional controller SDK route is controller USB-C → a working
USB-A data cable/adapter → Pi USB-A, then the existing Ethernet backend tunnel.
The operator currently has only the working C-to-C cable, so this Pi USB link
has not been connected. The current Windows camera route is still valid for
grounded recognition; it does not transport SDK piloting to the Pi. Do not
restart the direct observer as a way to add telemetry to it.

The operator subsequently selected a separate direct Pi route with the
controller **off**, which does not need that adapter. See
[the terminal hover/landing checkout](TERMINAL_FLIGHT_TEST.md). It receives
real video/telemetry and provides operator-requested takeoff and terminal
landing commands. The direct short hover and automatic landing passed; X-key
landing remains untested. Stop this Windows camera route before using it. The
new [integrated QR program](QR_FLIGHT_CHECKOUT.md) keeps takeoff and QR movement
in one connection; its real orbit still needs measured geometry and testing.

Ctrl+C stops camera reception; it sends no landing or other aircraft command.
On lost video the relay stops rather than repeating the last frame. The dashboard
may retain that last image: use its timestamp to distinguish fresh from stale.
The relay keeps at most one pending frame; it drops excess frames during slow
uploads. The frame timestamp is laptop reception time, not a measured aircraft
capture time. Tokens come from the local environment file and are never placed
in command arguments or printed. No files in the teammate's backend checkout
are changed by this receiver. These additions are separate from the Pi orbit
experiment and do not make that experiment ready to fly.
