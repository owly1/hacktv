# First Pi Ethernet connection

1. Power the Pi with its own USB-C supply. Ethernet does not supply power here.
2. Connect laptop USB Ethernet → cable → Pi Ethernet. Keep laptop Wi-Fi online.
3. Find the actual interface and Pi address. On Windows use `Get-NetAdapter`
   and the adapter's `ifIndex`; on Mac use `networksetup -listallhardwareports`.
   A link-local IPv6 address needs the laptop interface suffix (`%38`, `%en8`, etc.).
4. Obtain the provisioned Pi username and trusted host fingerprint from its
   owner; use an authorized password/key. This repository is not a Pi image
   installer and does not contain login credentials.

```powershell
ssh -l YOUR_PI_USERNAME 'YOUR_PI_ADDRESS'
.\scripts\Connect-PiBackend.ps1 -PiAddress 'YOUR_PI_ADDRESS' -PiUser YOUR_PI_USERNAME
```

The recorded Pi is `pet@fe80::2ecf:67ff:fe80:173e%<interface>`. Scope values
are machine-specific. Enter passwords locally; private keys stay on their
own laptop. Verify the first host fingerprint rather than accepting it blindly.

Once access works, use [runtime paths](PI_RUNTIME_HANDOFF.md) and the appropriate
[Windows](RESTART_CURRENT_LAPTOP.md) or [Mac](MAC_SETUP.md) guide to establish
the backend tunnel and observation. Ethernet reachability alone proves neither
Olympe readiness nor aircraft Wi-Fi reception. Do not reimage a teammate's Pi
to repair a missing login or incompatible local environment.
