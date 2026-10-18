# Start the provisioned Pi's combined QR-circle/person-search receiver; never take off or queue a maneuver.
[CmdletBinding()]
param([string]$PiAddress)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$session = Invoke-RestMethod 'http://127.0.0.1:8787/api/session' -TimeoutSec 4
$headers = @{Authorization = 'Bearer ' + $session.token}
$dive = Invoke-RestMethod 'http://127.0.0.1:8787/api/dive' -Headers $headers -TimeoutSec 4
if ($dive.workflow -ne 'qr-circle-dive-v1') { throw 'Restart the backend from this checkout with node scripts/qr-dive-demo.mjs.' }
if ($dive.person_detection.model_status -eq 'disabled') { throw 'Person inference is disabled. Restart using node scripts/qr-dive-demo.mjs.' }
$autonomy = Invoke-RestMethod 'http://127.0.0.1:8787/api/autonomy' -Headers $headers -TimeoutSec 4
if ($autonomy.enabled) { throw 'End the current flight session and confirm landing before receiver setup.' }
if ($dive.commands | Where-Object { $_.status -in @('pending','delivered','in_progress') }) {
    throw 'A search command is still active. Stop it and confirm its outcome before receiver setup.'
}
if (-not $PiAddress) {
    $adapters = @(Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -like 'Realtek USB GbE*' })
    if ($adapters.Count -ne 1) { throw 'Connect the Pi Ethernet adapter or supply -PiAddress.' }
    $PiAddress = 'fe80::2ecf:67ff:fe80:173e%' + $adapters[0].ifIndex
}
$parsed = $null
if (-not [Net.IPAddress]::TryParse($PiAddress,[ref]$parsed)) { throw 'Use the configured Pi IP address with its numeric scope.' }
$ssh = (Get-Command ssh.exe).Source
$scp = (Get-Command scp.exe).Source
$options = @('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes',
    '-o','HostKeyAlias=fe80::2ecf:67ff:fe80:173e%38','-o','ConnectTimeout=8',
    '-o','ServerAliveInterval=5','-o','ServerAliveCountMax=3',
    '-i',($env:USERPROFILE+'/.ssh/emberwatch_pi_ed25519'),
    '-o',('UserKnownHostsFile='+$env:USERPROFILE+'/.ssh/emberwatch_pi_known_hosts'))
$destination = 'pet@'+$PiAddress
$remoteCheck = @'
if ps -C python,python3,python3.11 -o args= | grep -qE '(qr_dive_response|anafi_bridge|fire_response|qr_auto_circle|qr_preset_demo|qr_takeoff_demo|hover_checkout)\.py'; then
  printf 'Another aircraft receiver is active. Stop it in its owner terminal before deploying.\n' >&2
  exit 73
fi
mkdir -p /home/pet/emberwatch/qr-dive
'@
& $ssh @options -T $destination $remoteCheck.Replace("`r",'')
if ($LASTEXITCODE -ne 0) { throw 'Receiver ownership/deployment check failed.' }
$scpHost = if ($parsed.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetworkV6) { 'pet@['+$PiAddress+']' } else { $destination }
$sources = @(Get-ChildItem -LiteralPath (Join-Path $root 'bridge') -Filter '*.py' -File | ForEach-Object { $_.FullName })
& $scp @options @sources (Join-Path $root 'bridge/run_qr_dive.sh') ($scpHost+':/home/pet/emberwatch/qr-dive/')
if ($LASTEXITCODE -ne 0) { throw 'Dive receiver source copy failed.' }
$probeCommand = @'
if curl -fsS --connect-timeout 2 --max-time 3 http://127.0.0.1:8788/api/session 2>/dev/null; then
  exit 0
fi
listeners=$(ss -H -ltn sport = :8788 2>/dev/null) || exit 1
case $listeners in
  '') printf 'missing\n' ;;
  *) printf 'stale\n' ;;
esac
'@
$probe = & $ssh @options -T $destination $probeCommand.Replace("`r",'')
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the existing Pi backend tunnel.' }
$probeText = ($probe -join '').Trim()
$forward = @()
if ($probeText -eq 'missing') { $forward = @('-o','ExitOnForwardFailure=yes','-R','127.0.0.1:8788:127.0.0.1:8787') }
elseif ($probeText -eq 'stale') { throw 'The Pi port is occupied by an unresponsive tunnel. Resolve its owner session first.' }
else {
    $remoteSession = $probeText | ConvertFrom-Json
    if ($remoteSession.contract -ne $session.contract -or $remoteSession.token -ne $session.token) {
        throw 'The Pi tunnel belongs to another backend. Use its owner session; do not reuse it for this receiver.'
    }
}
$epoch = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString()
Write-Host 'Receiver starts OFF. In Live, click Start BOSCO and present the fire QR to take off and circle.'
Write-Host 'D pauses the circle for measured descent/person search/return, then reacquires QR. X requests landing.'
Write-Host 'Keep this terminal and the controlling dashboard open. Only one receiver may own the aircraft.'
& $ssh @options @forward -tt $destination ('bash /home/pet/emberwatch/qr-dive/run_qr_dive.sh '+$epoch)
if ($LASTEXITCODE -ne 0) { throw 'Receiver ended. Check the aircraft; do not infer touchdown from terminal closure.' }
