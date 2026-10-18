# Restart the provisioned Windows setup

These launchers reuse the existing Pi account, SSH identity, SDK and Wi-Fi
profile. They are not installers for a new computer. The configured backend
directory is normally `$env:USERPROFILE/Desktop/drone`.

## Normal startup

1. Connect laptop Internet Wi-Fi and Ethernet to the Pi. Power the Pi separately.
2. Power the grounded aircraft; keep the direct receiver's Skycontroller off.
3. Run **Start BOSCO.cmd** on the desktop, or from the checkout:

   ```powershell
   .\scripts\Start-BOSCO.ps1 -BackendDirectory $PWD.Path
   ```

4. Keep backend and Pi/tunnel windows open. Open <http://127.0.0.1:8787/>
   with Replay off and confirm advancing camera time and fresh telemetry.

The launcher checks the backend, opens the loopback tunnel, aligns the Pi clock,
selects saved aircraft Wi-Fi and starts the observation service. It sends no
flight/gimbal commands; this service does not run the laptop fire monitor.
Cloud settings come from the backend's existing `.env`.

## Manual fallback

Start `npm start` from the configured checkout. In a second terminal, use the
generic tunnel helper with the provisioned identity:

```powershell
.\scripts\Connect-PiBackend.ps1 -PiAddress 'fe80::2ecf:67ff:fe80:173e%38' -PiUser pet -BackendPort 8787 -PiPort 8788 -IdentityFile "$env:USERPROFILE\.ssh\emberwatch_pi_ed25519" -KnownHostsFile "$env:USERPROFILE\.ssh\emberwatch_pi_known_hosts"
```

`%38` is the recorded Windows adapter index; use the actual current index.
The normal launcher detects its supported adapter automatically. On the Pi:

```sh
sudo -n /usr/local/sbin/emberwatch-maintenance wifi-profile 64e43de0-e0ff-4ee0-a9cb-5d5cd824d732
systemctl --user reset-failed emberwatch-bridge.service
systemctl --user start emberwatch-bridge.service
```

Keep SSH open. A Pi clock more than 30 seconds wrong causes ingest rejection.
The launcher sets it; for manual repair, get the current Unix seconds on the
laptop and pass them promptly to the Pi maintenance helper's `set-clock` action.

## If reception fails

- Pi unreachable: check power, Ethernet link, adapter scope and trusted SSH identity.
- Aircraft unreachable: check its power/charge, wait for boot, and close competing receivers.
- Old picture: inspect capture timestamps and logs; an image retained by the UI is not fresh.
- Tunnel bound but unresponsive: resolve the existing session; do not reuse another laptop's tunnel.
- Cloud failure: check Internet and local configuration; reception and cloud status are separate.

Keep the laptop awake during reception. Use [camera checks](PI_CAMERA_TEST.md)
and [Pi paths](PI_RUNTIME_HANDOFF.md). Use a separate [flight guide](../README.md#choose-a-hardware-workflow)
for opt-in flight; do not run its receiver alongside Start BOSCO.
