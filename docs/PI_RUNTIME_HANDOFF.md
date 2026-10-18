# Provisioned Pi runtime

The Pi receives aircraft Wi-Fi and forwards authenticated observations over
Ethernet/SSH to the laptop. Laptop Wi-Fi stays online.

| Item | Recorded value |
|---|---|
| Pi account | `pet` |
| Ethernet IPv6 | `fe80::2ecf:67ff:fe80:173e%<laptop-interface>` |
| Aircraft | ANAFI Extended `ANAFI-H084882`, direct IP `192.168.42.1` |
| SDK root | `/home/pet/emberwatch/sdk/olympe-8.5.0` |
| SDK entry wrapper | `products/olympe/linux/env/setenv` under that root |
| Python | SDK's isolated 3.11.16; system Python stays separate |
| Observation source | `/home/pet/emberwatch/bridge/anafi_observer.py` |
| Observation credentials | `/home/pet/emberwatch/bridge.env` (local only) |
| Service | `emberwatch-bridge.service`, a user service disabled at boot |
| Flight deployment | `/home/pet/emberwatch/qr-demo` on Windows; separate `mac-<user>` on Mac |
| Current tunnel | Pi `127.0.0.1:8788` → laptop `127.0.0.1:8787` |

Earlier prototype notes used the opposite port mapping. Check actual launcher
arguments rather than mixing the two. Current [Windows](RESTART_CURRENT_LAPTOP.md)
and [Mac](MAC_SETUP.md) guides use the mapping above.

## Start and inspect

Start the laptop backend, establish the verified SSH reverse tunnel, then on
the Pi select the saved aircraft Wi-Fi profile and start observation:

```sh
sudo -n /usr/local/sbin/emberwatch-maintenance wifi-profile 64e43de0-e0ff-4ee0-a9cb-5d5cd824d732
systemctl --user start emberwatch-bridge.service
tail -n 20 /home/pet/emberwatch/logs/bridge.log
```

For a direct foreground receiver, from the repository with its ingest token loaded:

```sh
PYOPENGL_PLATFORM=glx bash /home/pet/emberwatch/sdk/olympe-8.5.0/products/olympe/linux/env/setenv python bridge/anafi_observer.py --camera --controller direct --ip 192.168.42.1 --drone-id ANAFI-H084882 --backend http://127.0.0.1:8788 --camera-transport frame --camera-fps 10
```

Do not run service and foreground receivers together. `--camera-fps 0` keeps
all processable frames; `--camera-width 0` preserves native dimensions for
calibration. Existing service settings can differ from CLI defaults.

## Maintenance and evidence

The provisioned maintenance helper has bounded actions for Wi-Fi selection and
clock setting; it is not a general sudo interface. Keep passwords and Wi-Fi
settings out of logs. Inspect software/build results locally:

```sh
tail -n 20 /home/pet/emberwatch/logs/sdk-build.log
cat /home/pet/emberwatch/logs/software-readiness.json
cat /home/pet/emberwatch/logs/camera-software-test.json
```

[SDK build notes](PI4_SDK_BUILD_NOTES.md) retain source hashes and ARM fixes.
[Observer context](PI_OBSERVER_CONTEXT.md) and [verification](VERIFIED.md)
separate grounded reception from physical flight and cloud-service checks.
