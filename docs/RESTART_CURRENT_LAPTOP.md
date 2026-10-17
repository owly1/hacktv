# Restart the current laptop + Pi + ANAFI setup

For the provisioned Windows laptop and Pi 4B, recorded 17 October 2026.
No reinstallation or repeated API-key entry is needed after a normal shutdown.
The desktop launcher is named **Start BOSCO.cmd**.

## Normal startup

1. Connect the laptop to Internet Wi-Fi. Plug its USB Ethernet adapter into
   the same laptop and connect Ethernet to the Pi. Power the Pi separately.
2. Power the drone and keep it grounded. Wait approximately one minute for
   the Pi to boot. The Pi, laptop and aircraft each need power.
3. Double-click **Start BOSCO.cmd** on the Windows desktop. It starts the
   backend if needed, opens a Pi SSH/tunnel window, sets the Pi UTC clock
   from the laptop, reconnects the saved aircraft Wi-Fi profile and starts
   the observation service. Keep the
   backend and Pi connection windows open.
4. Open <http://127.0.0.1:8787/> and leave Replay off. Look for the ANAFI-01
   image, an advancing capture time and fresh telemetry. Expect about one
   camera image every two seconds.
5. Gemini's key/model and TigerData configuration load from the existing
   `C:\Users\anshi\Desktop\drone\.env`. Keep laptop Internet Wi-Fi connected.
   **Analyze current view** sends the current camera evidence to Gemini.
   A new response with the current evidence time proves the round trip;
   a configured indicator alone does not. Review the result as unverified
   descriptive analysis.

This receiver provides camera and telemetry. QR detection is not running
in it. The launcher never starts an autonomous flight or moves the gimbal.
The observation service is deliberately disabled at boot; the launcher
starts it when the aircraft is available. Closing the browser does not
replace the backend or SSH connection windows.

The launcher uses the current Realtek USB Ethernet adapter's interface
number and the already trusted Pi host key. It does not accept an unfamiliar
host key, edit credentials or change the laptop's permanent power settings.
If the laptop sleeps, reception and cloud access stop until connections
are restored. Keep it awake during the demonstration.

## Manual fallback

In the first Windows PowerShell window:

```powershell
cd "$env:USERPROFILE\Desktop\drone"
npm start
```

Leave it open. In a second PowerShell window, open SSH **with the tunnel**:

```powershell
ssh -6 -t -i "$env:USERPROFILE\.ssh\emberwatch_pi_ed25519" -o "UserKnownHostsFile=$env:USERPROFILE\.ssh\emberwatch_pi_known_hosts" -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -R 127.0.0.1:8788:127.0.0.1:8787 -l pet 'fe80::2ecf:67ff:fe80:173e%38'
```

At the Pi's Linux prompt, paste:

```sh
sudo -n /usr/local/sbin/emberwatch-maintenance wifi-profile 64e43de0-e0ff-4ee0-a9cb-5d5cd824d732
systemctl --user reset-failed emberwatch-bridge.service
systemctl --user start emberwatch-bridge.service
```

For a manual restart after a long power-off, check that the Pi's `date -u`
matches the laptop. A Pi clock more than 30 seconds out causes ingest
rejections. The launcher handles this automatically. To correct it manually,
get the current epoch in Windows PowerShell with
`[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()`, then promptly run
`sudo -n /usr/local/sbin/emberwatch-maintenance set-clock NUMBER` on the Pi,
replacing NUMBER with that value, before starting the observation service.

Keep that SSH window open: it carries the camera connection. Open the
browser URL above. No password should be needed with the saved SSH key and
saved drone Wi-Fi profile.

The manual `%38` suffix is this laptop's current Ethernet interface index.
If Windows changes it, the launcher detects the new index automatically.
If the adapter is replaced or renamed, inspect `Get-NetAdapter`, verify the
correct interface and pass `-PiAddress` to the launcher script. Do not
discard a host-key warning or overwrite the existing card.

## If startup fails

- **Pi unreachable:** check separate power, Ethernet and the boot wait.
- **Tunnel/port already in use:** reuse the existing working windows. Do
  not launch multiple copies. No unrelated process is killed by the launcher.
- **Aircraft Wi-Fi connection fails:** check aircraft power and that its
  SSID is visible. The saved profile is for this team's ANAFI only.
- **Camera timestamp stops:** check the Pi connection window and receiver
  log at `/home/pet/emberwatch/logs/bridge.log`.
- **Gemini unavailable:** check laptop Internet and the backend's local
  Gemini configuration/quota. Do not paste keys into the dashboard or chat.
- **Ingest authentication fails after token changes:** the Pi's owner-only
  `bridge.env` must use the same ingest token as the laptop backend. The
  launcher preserves the already configured values.

## Clean shutdown

In the Pi SSH window:

```sh
systemctl --user stop emberwatch-bridge.service
sudo -n /usr/local/sbin/emberwatch-maintenance poweroff
```

The Pi shuts down and SSH disconnects. Stop the laptop backend with Ctrl+C.
Allow the Pi to finish shutting down before disconnecting its power, then
power off the drone. Startup will still use the saved software, Wi-Fi
profile, SSH key and backend configuration next time.

The launcher was checked without mutations against the running setup.
A complete all-power-off/cold-start rehearsal has not been performed.
