# Test the Pi camera in the actual BOSCO dashboard

Verified on the grounded ANAFI Extended, 17 October 2026 at 15:43 UTC.
This tests RGB reception only. The observer does not fly the drone or run
the separate fire-detection bridge.

## Quick test on the configured laptop

1. Keep the drone powered and grounded, the Pi powered, and the Pi's Ethernet
   cable connected to the laptop's USB Ethernet adapter.
2. Open <http://127.0.0.1:8787/>. This is the actual BOSCO backend/dashboard.
3. Leave **Replay** off and find **ANAFI-01**. Use its expand control for
   the camera panel, or open the drone-feed icon in the left navigation.
4. Move a hand or an object in front of the camera. The view should change
   within a few seconds, and the capture timestamp should keep advancing.
5. Expect one 640 × 360 RGB image approximately every two seconds. This is
   low-rate camera reception, not full-motion video or thermal imagery.

Press Escape to leave the enlarged panel. The laptop must stay awake and
its backend and SSH tunnel must remain running.

## Current connection

```text
Aircraft Wi-Fi -> Pi observer
    -> Pi 127.0.0.1:8788
    -> encrypted SSH tunnel over direct Ethernet
    -> laptop 127.0.0.1:8787 /api/ingest/frame + /api/ingest/telemetry
    -> BOSCO /api/video -> ANAFI-01 camera panel
```

The Pi uses the existing team backend's ingest token from a local,
owner-only environment file. No token belongs in the browser, source or chat.
The existing team backend was preserved and did not need a restart.

On the laptop, from the repository root, recreate the current tunnel if it
has closed:

```powershell
.\scripts\Connect-PiBackend.ps1 -PiAddress 'fe80::2ecf:67ff:fe80:173e%38' -PiUser pet -BackendPort 8787 -PiPort 8788 -IdentityFile "$env:USERPROFILE\.ssh\emberwatch_pi_ed25519" -KnownHostsFile "$env:USERPROFILE\.ssh\emberwatch_pi_known_hosts"
```

On the configured Pi, start or stop the existing observation service:

```sh
systemctl --user start emberwatch-bridge.service
systemctl --user stop emberwatch-bridge.service
```

The service wrapper runs the SDK environment and
`/home/pet/emberwatch/bridge/anafi_observer.py --camera --camera-transport frame`
with the Pi loopback backend URL above. Its SSID guard requires the configured
aircraft network. It remains disabled at boot. Owner-only backups preserve
the previous prototype token configuration and wrapper for rollback.

If there is no view, check the Pi/service, Ethernet link, open tunnel and
camera capture age. Starting the observer does not run the separate detector;
a live view alone does not prove fire detection, geolocation or forecasting.

The dashboard currently served by the other checkout may still show older
AGL/location labels. This observer reports altitude **above takeoff** and
leaves missing GPS null; it provides no indoor position estimate. Current
repository source corrects the altitude label. No flight, gimbal movement or
simultaneous controller test was performed.
