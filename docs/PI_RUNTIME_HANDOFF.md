# Pi runtime handoff — 17 October 2026

**Repository integration note:** this is the dated hardware setup snapshot,
tested with the local prototype backend. In this repository its receiver
source is `bridge/anafi_observer.py`; on the configured Pi that source was
deployed under `/home/pet/emberwatch/bridge/anafi_bridge.py`. Use the observer
source when updating that deployment. The team's separate bridge shares the
older filename but has different detection/flight behavior. This document's
memory-only/cloud-unconfigured status applies to the tested prototype
instance; consult `VERIFIED.md` for the team's separate cloud tests.

This records the actual setup on the team's Pi. The grounded direct-Wi-Fi reception test passed on 17 October 2026. No aircraft movement commands are included in this project; flight and controller operation remain untested.

## Connection and responsibilities

```text
ANAFI Extended (ANAFI-H084882)
  | Wi-Fi: telemetry + RGB camera reception
  v
Pi 4B: Olympe + read-only Python bridge
  | direct Ethernet, encrypted SSH reverse tunnel
  v
Laptop: Node backend at 127.0.0.1:8788
  |-- serves local dashboard
  |-- authenticates/validates incoming observations
  |-- keeps latest telemetry and JPEG in memory
  |-- writes telemetry/analyses to TigerData when configured
  `-- calls Gemini when configured and requested by a user

Laptop Wi-Fi stays on the Internet connection.
Pi Wi-Fi is connected to the aircraft for the tested observation path.
```

The hosted dashboard is a static demonstration. For this local hardware connection, open `http://127.0.0.1:8788` on the laptop and use its connected mode. A hosted HTTPS page does not automatically gain access to this loopback backend.

## Verified access

The Pi is a 4 Model B Rev 1.5 running aarch64 Debian 13 with approximately 4 GB RAM. Its existing account is `pet`. The direct adapter is Windows `Ethernet 2`, currently interface index 38. The Pi's observed scoped link-local address is `fe80::2ecf:67ff:fe80:173e%38`; recheck the scope if the adapter is moved.

The local private key is `%USERPROFILE%\.ssh\emberwatch_pi_ed25519`; the verified host-key file is `%USERPROFILE%\.ssh\emberwatch_pi_known_hosts`. Neither file belongs in the source bundle or a teammate's chat. All three card setup steps restored the original boot command, and the existing OS/password were preserved. The third update's hardware report returned exit 0 and verified maintenance helper v2.

PowerShell access from this laptop:

```powershell
ssh -6 -i "$env:USERPROFILE\.ssh\emberwatch_pi_ed25519" -o "UserKnownHostsFile=$env:USERPROFILE\.ssh\emberwatch_pi_known_hosts" -l pet 'fe80::2ecf:67ff:fe80:173e%38'
```

## Laptop processes

From the project folder, the configured local backend starts with:

```powershell
node --env-file=.env backend/server.mjs
```

This laptop's `.env` selects port 8788; the default project port remains 8787. Another existing service on 8787 was preserved. Start only one instance of this backend. Tokens are distinct and remain in the ignored `.env`; external Gemini/TigerData credentials have not been supplied.

Keep a second terminal open for the tunnel:

```powershell
.\scripts\Connect-PiBackend.ps1 -PiAddress 'fe80::2ecf:67ff:fe80:173e%38' -PiUser pet -BackendPort 8788 -PiPort 8787 -IdentityFile "$env:USERPROFILE\.ssh\emberwatch_pi_ed25519" -KnownHostsFile "$env:USERPROFILE\.ssh\emberwatch_pi_known_hosts"
```

The listener was checked on the Pi: only `127.0.0.1:8787`, forwarded through SSH to the laptop. A correctly authenticated invalid payload received HTTP 400. No synthetic payload was inserted as live evidence.

## Pi paths and build

| Path on Pi | Purpose |
|---|---|
| `/home/pet/emberwatch/sdk/olympe-8.5.0` | Official SDK source and native build |
| `/home/pet/emberwatch/logs/sdk-build.log` | Build progress and errors |
| `/home/pet/emberwatch/logs/sdk-source-adjustments.json` | Recorded local source adjustments |
| `/home/pet/emberwatch/bridge/anafi_bridge.py` | Telemetry and optional JPEG adapter |
| `/home/pet/emberwatch/bridge/check_environment.py` | Read-only software import check |
| `/home/pet/emberwatch/bridge.env` | Ingest token only; owner-only permissions |
| `/home/pet/emberwatch/scripts/run-bridge.sh` | SSID guard and SDK environment wrapper |
| `/home/pet/.config/systemd/user/emberwatch-bridge.service` | Manually running observation service; disabled at boot |
| `/home/pet/emberwatch/logs/bridge.log` | Local SDK warnings and adapter diagnostics; owner-only |

The official Olympe 8.5.0 source archive SHA-256 was verified as `4bff18eb6c7fc162661d4b8bdf7032923b6cdc08d35055b9b24d684e060e7585`. ARM needs a native source build. The SDK advertises Python 3.9–3.11; its bundled pyenv provides 3.11.16, selected instead of the default 3.9.5. The host's Python 3.13 remains unchanged. Original product and global configuration files were backed up beside the changed files. Alchemy `config-update` was needed for the native ARM configuration. The build driver also runs under the isolated 3.11 runtime because the SDK's vendored packaging imports `distutils`, which the host's 3.13 lacks. PyYAML 6.0.3 was added to that isolated runtime for the driver's documentation extension.

The native build completed at 15:20 UTC and the separate import/conversion checks passed at 15:23 UTC. Inspect the dated records on the Pi:

```sh
tail -n 20 /home/pet/emberwatch/logs/sdk-build.log
cat /home/pet/emberwatch/logs/software-readiness.json
cat /home/pet/emberwatch/logs/camera-software-test.json
```

An active process or a zero `ExecMainStatus` while running does **not** prove success. The build completion line and successful software reports are the evidence here. The first import check failed because the Pi's Wayland environment selected EGL while the SDK imports GLX. Both launch wrappers now set `PYOPENGL_PLATFORM=glx`; the repeated checks passed. The bridge does not create a display renderer. The build began with two jobs and completed with four after checking RAM and thermal headroom. User lingering is enabled; the Pi must remain powered.

The build unit requests a 3 GiB memory limit, but this Pi kernel exposes no memory cgroup controller; do not treat that setting as an enforced bound. The four-job build was observed using approximately 1.2–1.3 GiB of system memory with swap unused. A post-build script runs SDK/message imports, installs the cached OpenCV ARM wheel and tests I420/NV12-to-JPEG conversion with synthetic pixels. These checks do not connect to the aircraft or insert observations.

## Aircraft test gate

Finish software installation with the Pi on its normal Internet Wi-Fi. Confirm that the identified aircraft is powered and grounded, and that no other pilot is using its connection. Its observed network uses WPA2. Enter its password locally; do not paste it into chat. The initial helper lacked interactive password entry; a verified third card update added `wifi-connect-ask` to helper v2. The laptop helper opens the actual root NetworkManager prompt through the restricted command:

```powershell
.\scripts\Open-PiWiFiPrompt.ps1 -PiAddress 'fe80::2ecf:67ff:fe80:173e%38' -PiUser pet -IdentityFile "$env:USERPROFILE\.ssh\emberwatch_pi_ed25519" -KnownHostsFile "$env:USERPROFILE\.ssh\emberwatch_pi_known_hosts"
```

The helper rescans `wlan0`, prompts locally and does not accept a password argument. Password entry and subsequent saved-profile reconnection succeeded. The Pi received `192.168.42.26/24`; the aircraft is `192.168.42.1`. After completing software installation, the Pi rejoined the aircraft and the bridge delivered real telemetry and decoded 640 × 360 JPEGs through the tunnel to the authenticated browser at 15:25 UTC. Aircraft firmware is 1.8.2 / HW_03. GPS was unavailable and remained null. No flight or simultaneous controller test was performed.

On this Pi, the saved aircraft profile is `64e43de0-e0ff-4ee0-a9cb-5d5cd824d732`. With the grounded aircraft available, reconnect without exposing its saved password:

```sh
sudo -n /usr/local/sbin/emberwatch-maintenance wifi-profile 64e43de0-e0ff-4ee0-a9cb-5d5cd824d732
```

The prepared bridge wrapper refuses to start unless `wlan0` is on `ANAFI-H084882`. Once the software and network checks pass, manually start observation on the Pi:

```sh
systemctl --user start emberwatch-bridge.service
tail -n 20 /home/pet/emberwatch/logs/bridge.log
```

Stop observation with `systemctl --user stop emberwatch-bridge.service`. Starting the service does not enable it at boot. The logging/service drop-in uses a graceful interrupt on stop. SDK INFO event logging is suppressed because aircraft settings events can include Wi-Fi credentials; do not re-enable it or publish raw SDK logs. This adapter receives telemetry and approximately one JPEG every two seconds; it does not provide full-frame-rate browser video or thermal measurements.

Olympe 8.5.0's default named `Front camera` stream did not match this aircraft. The bridge uses the supported `StreamInfoDefault` raw callback with `play_multiple_stream`, accepting the advertised `DefaultVideo` and unnamed decoded-media metadata. Native decoder warnings appeared during startup, but actual JPEG reception and decoding passed afterward. Treat fresh backend timestamps and decoded images as the acceptance signal, not merely a running process.

Check the laptop dashboard's connected mode for fresh telemetry and camera timestamps. Missing GPS remains null; missing camera remains unavailable. Gemini and TigerData need their own locally configured credentials and independent live verification. The animated spread remains a simulation, with no validated prediction derived from these images.

## Maintenance scope

`/usr/local/sbin/emberwatch-maintenance` is root-owned and allows bounded package installation, Wi-Fi selection with optional local password entry, clock correction, user-service setup and clean poweroff. It does not grant `pet` an arbitrary passwordless root shell. Its `cleanup` action removes that helper and its specific sudo rule when the team no longer needs it; it does not remove the Ethernet profile or SSH access. Review any later privilege changes separately.
