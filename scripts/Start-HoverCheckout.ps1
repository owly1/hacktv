# Opens a Pi terminal. Flight requires -Execute. QrAutoCircle starts automatically on a confirmed QR incident.
[CmdletBinding()]
param(
    [string]$PiAddress,
    [switch]$Execute,
    [ValidateSet('Hover','QrCheckout','QrOrbit','QrPreset','QrAutoCircle','QrAutoPreset')][string]$Mode = 'Hover',
    [switch]$NativeVideo
)
$ErrorActionPreference = 'Stop'
$sshClient = (Get-Command ssh.exe -ErrorAction Stop).Source
$key = Join-Path $env:USERPROFILE '.ssh\emberwatch_pi_ed25519'
$known = Join-Path $env:USERPROFILE '.ssh\emberwatch_pi_known_hosts'
foreach ($path in @($key, $known)) { if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Provisioned Pi SSH files are missing.' } }
if (-not $PiAddress) {
    $adapters = @(Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -like 'Realtek USB GbE*' })
    if ($adapters.Count -ne 1) { throw 'Connect the Pi Ethernet adapter or supply -PiAddress.' }
    $PiAddress = 'fe80::2ecf:67ff:fe80:173e%' + $adapters[0].ifIndex
}
$parsed = $null
if (-not [Net.IPAddress]::TryParse($PiAddress, [ref]$parsed)) { throw 'Use a valid Pi IP address with its numeric scope.' }
$options = @('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes',
    '-o','HostKeyAlias=fe80::2ecf:67ff:fe80:173e%38','-o','ConnectTimeout=8',
    '-o','ServerAliveInterval=5','-o','ServerAliveCountMax=3',
    '-o',('UserKnownHostsFile='+$known),'-i',$key)
$destination = 'pet@'+$PiAddress
$session = Invoke-RestMethod 'http://127.0.0.1:8787/api/session' -TimeoutSec 4
if ($session.contract -ne 'emberwatch.v1') { throw 'Start the local BOSCO backend on port 8787 first.' }
# Handle an absent tunnel on the Pi. Redirecting native stderr in Windows
# PowerShell can turn curl's expected failure into a terminating RemoteException.
# Use case for shell word tests; legacy Windows argument passing strips embedded
# double quotes, which can otherwise turn an empty listener test into true.
$tunnelProbe = @'
if curl -fsS --connect-timeout 2 --max-time 3 -o /dev/null http://127.0.0.1:8788/api/session 2>/dev/null; then
  printf 'ready\n'
else
  listeners=$(ss -H -ltn sport = :8788 2>/dev/null) || exit 1
  case $listeners in
    '') printf 'missing\n' ;;
    *) printf 'stale\n' ;;
  esac
fi
'@
$tunnelState = & $sshClient @options -T $destination $tunnelProbe.Replace("`r", '')
if ($LASTEXITCODE -ne 0) { throw 'Could not check the Pi backend tunnel. Check Pi Ethernet and SSH access.' }
$forward = @()
switch (($tunnelState | Out-String).Trim()) {
    'ready' { Write-Host 'Reusing the Pi backend tunnel.' }
    'missing' {
        Write-Host 'Creating the Pi backend tunnel.'
        $forward = @('-o','ExitOnForwardFailure=yes','-R','127.0.0.1:8788:127.0.0.1:8787')
    }
    'stale' { throw 'An existing Pi backend tunnel is not responding. Resolve it before the checkout.' }
    default { throw 'Unexpected response while checking the Pi backend tunnel.' }
}
$epoch = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString()
$liveOption = if ($Execute) { '--execute' } else { '' }
$program = if ($Mode -eq 'Hover') { 'hover_checkout.py' } elseif ($Mode -eq 'QrPreset') { 'qr_preset_demo.py' } elseif ($Mode -in @('QrAutoCircle','QrAutoPreset')) { 'qr_auto_circle.py' } else { 'qr_takeoff_demo.py' }
$extraOptions = if ($NativeVideo -or ($Mode -in @('QrCheckout','QrOrbit','QrAutoCircle'))) { '--video-width 0' } else { '' }
if ($Mode -eq 'QrAutoPreset') { $extraOptions += ' --preset --video-fps 30' }
if (($Mode -in @('QrCheckout','QrOrbit')) -or ($Mode -eq 'QrAutoCircle' -and $Execute)) {
    $extraOptions += ' --camera-calibration /home/pet/emberwatch/qr-demo/camera.local.json --preflight-file /home/pet/emberwatch/qr-demo/current-preflight.local.json'
    if ($Mode -eq 'QrOrbit') { $extraOptions += ' --full-orbit' }
}
$remote = @'
test -f /home/pet/emberwatch/qr-demo/__PROGRAM__ || exit 1
if ps -C python,python3,python3.11 -o args= | grep -qE '(hover_checkout|qr_orbit_bridge|qr_takeoff_demo|qr_preset_demo|qr_auto_circle|fire_response)\.py'; then
  printf 'A flight checkout is already running. Use its terminal; do not open another.\n' >&2
  exit 1
fi
sudo -n /usr/local/sbin/emberwatch-maintenance set-clock __EPOCH__ >/dev/null || exit 1
systemctl --user stop emberwatch-bridge.service || exit 1
if ps -C python,python3,python3.11 -o args= | grep -qE '(anafi_observer|anafi_bridge)\.py'; then
  printf 'Another laptop receiver is active. Stop it in its own terminal first.\n' >&2
  exit 1
fi
case $(nmcli -g GENERAL.CONNECTION device show wlan0) in
  ANAFI-H084882) ;;
  *) sudo -n /usr/local/sbin/emberwatch-maintenance wifi-profile 64e43de0-e0ff-4ee0-a9cb-5d5cd824d732 || exit 25 ;;
esac
set -a
. /home/pet/emberwatch/bridge.env
set +a
export PYOPENGL_PLATFORM=glx
exec /bin/bash /home/pet/emberwatch/sdk/olympe-8.5.0/products/olympe/linux/env/setenv python -u /home/pet/emberwatch/qr-demo/__PROGRAM__ --controller direct --no-window --backend http://127.0.0.1:8788 --drone-id ANAFI-H084882 --out-dir /home/pet/emberwatch/qr-demo/anafi_out __LIVE_OPTION__ __EXTRA_OPTIONS__
'@
$remote = $remote.Replace("`r", '').Replace('__EPOCH__', $epoch).Replace('__LIVE_OPTION__', $liveOption).Replace('__PROGRAM__', $program).Replace('__EXTRA_OPTIONS__', $extraOptions)
Write-Host 'Keep the Skycontroller off. This terminal owns the direct Pi flight connection.'
Write-Host 'Esc or X requests landing without Enter; LAND + Enter and Ctrl+C also request landing.'
if ($Execute -and $Mode -eq 'Hover') { Write-Host 'Starts DISARMED. TAKEOFF TEST + Enter requests a real, short takeoff/hover/landing checkout.' }
elseif ($Execute -and $Mode -eq 'QrPreset') {
    Write-Host 'Starts DISARMED. ARM QR PRESET + Enter, then selected-QR recognition, requests takeoff.'
    Write-Host 'No calibration or object tracking: align the intended circle center 1 m ahead of the launch point.'
    Write-Host 'One circle, then nearby hover until X or the 30-second timeout. Flight cap: 90 seconds.'
}
elseif ($Execute -and $Mode -eq 'QrAutoPreset') {
    Write-Host 'AUTONOMOUS DEMO: selected QR and accepted fire incident trigger one preset circle, then landing.'
    Write-Host 'One metre radius, centre 1 m ahead of launch heading. Camera aims at that planned centre.'
    Write-Host 'No QR-size measurement, camera calibration or typed arming phrase. Keep this terminal open.'
}
elseif ($Execute -and $Mode -eq 'QrAutoCircle') {
    Write-Host 'AUTONOMOUS: a stable selected QR and accepted fire incident start takeoff automatically.'
    Write-Host 'One metre radius, camera tracking, one orbit, then land. No typed arming phrase.'
    Write-Host 'Requires measured calibration and current physical preflight. Keep this terminal open.'
}
elseif ($Execute) {
    $startPhrase = if ($Mode -eq 'QrOrbit') { 'START QR ORBIT' } else { 'START QR CHECKOUT' }
    Write-Host ('Starts DISARMED. '+$startPhrase+' + Enter requests takeoff, then calibrated QR waiting.')
    Write-Host 'Requires measured calibration and a current physical preflight, including tested X-key landing.'
}
else { Write-Host 'Reception only. No flight commands are enabled.' }
& $sshClient @options @forward -tt $destination $remote
if ($LASTEXITCODE -eq 25) { throw 'Pi tunnel setup passed, but aircraft Wi-Fi could not connect. Power on the grounded ANAFI with a charged battery, keep the Skycontroller off, wait for ANAFI-H084882, then retry.' }
if ($LASTEXITCODE -ne 0) { throw 'Checkout connection ended. Do not infer that the drone landed from the terminal closing.' }
