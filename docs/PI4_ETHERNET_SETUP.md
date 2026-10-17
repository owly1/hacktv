# Pi 4B through a laptop USB Ethernet adapter

Status checked 17 October 2026. This connection is an alternative to USB gadget mode. No microSD reimaging or USB gadget configuration is required when the existing Pi OS and login are usable.

## Physical connection

1. Plug the USB-A Ethernet adapter into the Windows laptop.
2. Connect an Ethernet cable from that adapter to the Pi 4B's Ethernet port.
3. Power the Pi using its appropriate USB-C power supply.
4. Keep the laptop's Wi-Fi on its normal Internet connection. Later, the Pi's separate Wi-Fi interface can join the drone network.

## Verified on this hardware

- Windows detects the Realtek USB Gigabit Ethernet adapter.
- The direct cable link negotiated at 1 Gbps.
- Key-authenticated SSH login as the existing Linux user `pet` succeeds through the dedicated Ethernet link.
- Authenticated inspection identifies a Raspberry Pi 4 Model B Rev 1.5, aarch64, approximately 4 GB RAM, Debian 13 Trixie and system Python 3.13.5.
- Three bounded one-boot card setup steps completed successfully. They authorized the laptop's public key, installed a stable direct Ethernet profile and added a local interactive Wi-Fi password action to the restricted maintenance helper. Each restored the original boot command and preserved existing keys/password. The card was not reimaged. The private SSH key remains only on the laptop.
- The NetworkManager profile `Emberwatch direct Ethernet` uses IPv6 link-local addressing and disables IPv4 DHCP, so the direct cable no longer drops while searching for a router. The observed Pi address is `fe80::2ecf:67ff:fe80:173e%38`; the scope number belongs to the current Windows adapter and can change.
- An encrypted reverse SSH tunnel binds **only** `127.0.0.1:8787` on the Pi and forwards to `127.0.0.1:8788` on this laptop. An authenticated invalid telemetry request was correctly rejected with HTTP 400; no fabricated observation was stored.
- The verified official Olympe 8.5.0 source build completed with isolated Python 3.11.16. Olympe/message imports and OpenCV conversion checks passed.
- The grounded ANAFI Extended on `ANAFI-H084882`, firmware 1.8.2 / HW_03, delivered fresh telemetry and decoded 640 × 360 JPEGs through the Pi and tunnel to the laptop backend. The connected dashboard visibly displayed the real camera image. The observation service was manually started and remains disabled at boot. The application implements no flight controls; flight and controller operation were not tested.

For subsequent use, keep the Ethernet cable attached and use the launch/stop steps in [Pi runtime handoff](PI_RUNTIME_HANDOFF.md). The laptop Wi-Fi remains available for Internet access while the Pi Wi-Fi receives aircraft data.

## Obtain access without a monitor

Preferred: get the configured Pi username and a local login method from the person who prepared the card. Passwords should be entered locally, never pasted into chat. A public SSH key can be authorized once an existing login is available.

Alternative: borrow a USB microSD reader or use a laptop card slot. Identify and inspect the exact card and preserve existing data before considering a fresh OS installation. A newly imaged OS can have a chosen username and SSH public key configured in Raspberry Pi Imager. Reimaging overwrites the selected card; it requires a separate deliberate decision after the card is identified.

The USB Ethernet adapter does not read the microSD card. A running SSH service does not reveal the configured Linux username. Windows `whoami` output such as `COMPUTER\\user` identifies the Windows account, not the Pi account.

## Connect after a login is available

On a direct cable, IPv6 link-local access can work even before an IPv4 address or Internet sharing is configured. A link-local address needs the Windows adapter's current numeric scope, for example `fe80::1234%38`. The example is not this Pi's actual address. Reconnecting an adapter may change the scope; inspect the current interface rather than assuming a number.

From PowerShell, substitute the actual username and scoped address:

```powershell
ssh -l YOUR_PI_USERNAME 'YOUR_PI_ADDRESS'
```

Verify the first SSH host fingerprint through a trusted method. Enter any password locally. After an authorized public key has been installed on the Pi, subsequent setup can use that key; private keys stay on the laptop.

## Connect the bridge to the laptop backend

Start the laptop backend using the existing integration guide. The default backend listens at `127.0.0.1:8787`. In a second PowerShell window, from the project folder:

```powershell
.\scripts\Connect-PiBackend.ps1 -PiAddress 'YOUR_PI_ADDRESS' -PiUser YOUR_PI_USERNAME
```

An optional `-IdentityFile` selects a locally held SSH private key; `-KnownHostsFile` selects the locally verified host-key file. Use `-BackendPort 8788` for this laptop's current backend. The helper accepts IPv4, IPv6 with a numeric interface scope, and hostnames. Keep its window open while the bridge is running. The Pi bridge uses `http://127.0.0.1:8787` through that tunnel.

Windows does not need an SSH server for this direction. Pi SSH must allow the forwarding and retain `GatewayPorts no`. The Pi loopback-only listener and authenticated path to the laptop were verified on this hardware.

Pi Internet access is a separate question. Its normal Wi-Fi can be used for initial installation before joining the drone network. Windows Internet Connection Sharing is another option, but it has not been enabled or changed during these checks. The laptop keeps its own Internet access for Gemini and TigerData.

## Software verification still required

Run `bridge/check_environment.py` through the SDK's Python environment after the build completes. The system's Python 3.13 is separate from the SDK's supported Python 3.11 environment. Parrot Olympe on ARM requires a source build; authenticated network access does not prove SDK or live drone compatibility.

Then verify the exact ANAFI/controller variant, read-only telemetry, authenticated backend ingestion and optionally JPEG snapshots. TigerData and Gemini require their own account credentials and live tests. Keep simulation and observed data distinct. The supplied bridge contains no flight commands.

The tunnel helper passed PowerShell syntax checking and previews with hostname, IPv4 and scoped IPv6 inputs, and established the actual scoped IPv6 connection. A root-owned maintenance helper permits only bounded package, clock and Wi-Fi setup actions; the regular account was not granted an arbitrary passwordless root shell. Pi bridge secrets are stored in a user-owned mode-0600 environment file, and laptop tokens are in a Git-ignored `.env`.

## Official references

- [Raspberry Pi SSH access](https://www.raspberrypi.com/documentation/computers/remote-access.html#enable-the-ssh-server)
- [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
- [OpenSSH forwarding](https://man.openbsd.org/ssh#R)
- [Parrot Olympe installation support](https://developer.parrot.com/docs/olympe/installation_procedures/installation.html)
