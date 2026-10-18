# Starts the already provisioned Windows/Pi setup. Contains no credentials.
[CmdletBinding()]
param(
    [ValidateSet('Start', 'Backend', 'Pi')]
    [string]$Mode = 'Start',
    [string]$BackendDirectory = (Join-Path $env:USERPROFILE 'Desktop\drone'),
    [string]$PiAddress,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$backendRoot = (Resolve-Path -LiteralPath $BackendDirectory).Path
$nodeClient = (Get-Command node.exe -ErrorAction Stop).Source
$sshClient = (Get-Command ssh.exe -ErrorAction Stop).Source
$privateKey = Join-Path $env:USERPROFILE '.ssh\emberwatch_pi_ed25519'
$knownHosts = Join-Path $env:USERPROFILE '.ssh\emberwatch_pi_known_hosts'
foreach ($requiredPath in @((Join-Path $backendRoot '.env'), (Join-Path $backendRoot 'backend\server.mjs'), $privateKey, $knownHosts)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) { throw "Required setup file is missing: $requiredPath" }
}

if (-not $PiAddress) {
    $adapters = @(Get-NetAdapter | Where-Object {
        $_.Status -eq 'Up' -and $_.InterfaceDescription -like 'Realtek USB GbE*'
    })
    if ($adapters.Count -ne 1) {
        throw 'Connect the Pi Ethernet adapter, or supply -PiAddress with its scoped IPv6 address.'
    }
    $PiAddress = 'fe80::2ecf:67ff:fe80:173e%' + $adapters[0].ifIndex
}
$parsedAddress = $null
if (-not [System.Net.IPAddress]::TryParse($PiAddress, [ref]$parsedAddress)) {
    throw 'PiAddress must be the configured Pi IP address, including its numeric Ethernet scope.'
}

# Verify against the already trusted identity even if Windows changes the
# adapter's interface number after a restart. No new host key is accepted.
# Let OpenSSH select the family for the literal Pi address. Forcing -6 also
# restricts reverse-forward destinations and breaks IPv4 loopback 127.0.0.1.
$sshBase = @('-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'HostKeyAlias=fe80::2ecf:67ff:fe80:173e%38',
    '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-i', $privateKey, '-o', ('UserKnownHostsFile=' + $knownHosts))
$destination = 'pet@' + $PiAddress
$url = 'http://127.0.0.1:8787/'
$startupScriptPath = $PSCommandPath

# Read authenticated health only from a compatible local backend, or return no status.
function Get-BackendStatus {
    try {
        $session = Invoke-RestMethod ($url + 'api/session') -TimeoutSec 4
        if ($session.contract -ne 'emberwatch.v1' -or -not $session.token) { return $null }
        return Invoke-RestMethod ($url + 'api/status') -Headers @{ Authorization = 'Bearer ' + $session.token } -TimeoutSec 6
    } catch { return $null }
}

# Probe the Pi's loopback forward without changing the receiver or network configuration.
function Test-PiTunnel {
    try {
        $probe = & $sshClient @sshBase -T $destination 'curl -fsS --connect-timeout 2 --max-time 3 -o /dev/null http://127.0.0.1:8788/api/session && printf ready' 2>$null
        return $LASTEXITCODE -eq 0 -and ($probe -join '').Trim() -eq 'ready'
    } catch { return $false }
}

if ($CheckOnly) {
    $status = Get-BackendStatus
    if (-not $status) { throw 'The configured backend is not currently reachable on laptop port 8787.' }
    $result = & $sshClient @sshBase -T $destination 'test -f /home/pet/emberwatch/bridge/anafi_observer.py && test -r /home/pet/emberwatch/bridge.env && test -x /usr/local/sbin/emberwatch-maintenance && printf ready' 2>$null
    if ($LASTEXITCODE -ne 0 -or ($result -join '') -ne 'ready') { throw 'Pi access or its saved observation setup is unavailable.' }
    if (-not (Test-PiTunnel)) { throw 'The existing Pi-to-backend tunnel is not currently responding.' }
    Write-Host 'Startup files, trusted Pi SSH access and observer configuration: ready.'
    Write-Host ('Current backend: ' + $url)
    Write-Host ('Gemini configured: ' + [bool]$status.gemini.configured)
    Write-Host ('Storage: ' + $status.storage.status)
    Write-Host 'Check-only completed. No process, network profile or aircraft state was changed.'
    return
}

if ($Mode -eq 'Backend') {
    Set-Location -LiteralPath $backendRoot
    Write-Host 'BOSCO backend. Keep this window open; Ctrl+C stops it.'
    & $nodeClient --env-file=.env backend/server.mjs
    return
}

$startObservation = 'sudo -n /usr/local/sbin/emberwatch-maintenance set-clock __EMBERWATCH_UTC_EPOCH__ >/dev/null || exit 1; if test x$(nmcli -g GENERAL.CON-UUID device show wlan0) != x64e43de0-e0ff-4ee0-a9cb-5d5cd824d732; then sudo -n /usr/local/sbin/emberwatch-maintenance wifi-profile 64e43de0-e0ff-4ee0-a9cb-5d5cd824d732 || exit 1; fi; systemctl --user reset-failed emberwatch-bridge.service; systemctl --user start emberwatch-bridge.service || exit 1; systemctl --user is-active emberwatch-bridge.service; exec bash -l'

# Build observation startup with a fresh laptop clock and an optional interactive shell.
function Get-ObservationCommand([bool]$Interactive) {
    # A Pi 4 can lose wall-clock time while powered off; it has no Internet
    # on aircraft Wi-Fi. Fresh evidence requires the laptop and Pi clocks
    # to agree. The pre-existing bounded helper performs this correction.
    $epoch = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString()
    $command = $startObservation.Replace('__EMBERWATCH_UTC_EPOCH__', $epoch)
    if (-not $Interactive) { $command = $command.Replace('; exec bash -l', '') }
    return $command
}

if ($Mode -eq 'Pi') {
    Write-Host 'Connecting the Pi Wi-Fi to the saved aircraft network and starting camera reception.'
    Write-Host 'Keep this window open. The receiver has no flight controls.'
    $remoteStartup = Get-ObservationCommand $true
    & $sshClient @sshBase -t -o ExitOnForwardFailure=yes -R '127.0.0.1:8788:127.0.0.1:8787' $destination $remoteStartup
    if ($LASTEXITCODE -ne 0) { throw 'Pi connection ended. Check Pi power, the cable, aircraft Wi-Fi and whether another Pi tunnel window is already open.' }
    return
}

# These are visible interactive terminals: the user needs them to monitor
# the running services, keep the tunnel open and stop the setup later.
# Open the operator-visible backend or tunnel terminal using this launcher's selected paths.
function Open-StartupWindow([string]$ChildMode) {
    $windowsShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = @('-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File',
        ('"' + $startupScriptPath + '"'), '-Mode', $ChildMode, '-BackendDirectory',
        ('"' + $backendRoot + '"'), '-PiAddress', ('"' + $PiAddress + '"'))
    Start-Process -FilePath $windowsShell -ArgumentList $arguments -WindowStyle Normal | Out-Null
}

$status = Get-BackendStatus
if (-not $status) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort 8787 -ErrorAction SilentlyContinue
    if ($listener) { throw 'Port 8787 is occupied by a service that did not answer as the BOSCO backend. No existing process was stopped.' }
    Open-StartupWindow 'Backend'
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Seconds 1
        $status = Get-BackendStatus
        if ($status) { break }
    }
    if (-not $status) { throw 'The backend did not start. Read the backend window for the error.' }
}

# Reuse an existing working tunnel rather than starting a duplicate.
if (Test-PiTunnel) {
    Write-Host 'A Pi backend tunnel is already responding. Reusing it.'
    $ensureReceiver = Get-ObservationCommand $false
    & $sshClient @sshBase -T $destination $ensureReceiver
    if ($LASTEXITCODE -ne 0) { throw 'The Pi receiver could not be started.' }
} else {
    Open-StartupWindow 'Pi'
}

Write-Host ('Open live dashboard: ' + $url)
Write-Host ('Gemini configured: ' + [bool]$status.gemini.configured)
Write-Host 'Keep the backend and Pi connection windows open. Leave Replay off.'
Start-Process $url
