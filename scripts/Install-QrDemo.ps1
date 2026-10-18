# Copies source/calibration to a separate Pi directory. Does not start a receiver or flight.
[CmdletBinding()]
param(
    [string]$PiAddress,
    [string]$CalibrationFile,
    [string]$PreflightFile
)
$ErrorActionPreference = 'Stop'
if (-not $PiAddress) {
    $adapters = @(Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -like 'Realtek USB GbE*' })
    if ($adapters.Count -ne 1) { throw 'Connect the Pi Ethernet adapter, or supply -PiAddress.' }
    $PiAddress = 'fe80::2ecf:67ff:fe80:173e%' + $adapters[0].ifIndex
}
$parsedAddress = $null
if (-not [System.Net.IPAddress]::TryParse($PiAddress, [ref]$parsedAddress)) { throw 'Use the Pi IP address with its numeric Ethernet scope.' }
$sshClient = (Get-Command ssh.exe -ErrorAction Stop).Source
$scpClient = (Get-Command scp.exe -ErrorAction Stop).Source
$key = Join-Path $env:USERPROFILE '.ssh\emberwatch_pi_ed25519'
$known = Join-Path $env:USERPROFILE '.ssh\emberwatch_pi_known_hosts'
foreach ($path in @($key, $known)) { if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing provisioned SSH file: $path" } }
$options = @('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes',
    '-o','HostKeyAlias=fe80::2ecf:67ff:fe80:173e%38','-o','ConnectTimeout=8',
    '-o',('UserKnownHostsFile='+$known),'-i',$key)
$sourceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\bridge')).Path
$names = @('anafi_observer.py','anafi_bridge.py','flight_recording.py','fire_detection.py','fire_location.py','fire_monitor.py','qr_circle_core.py','qr_auto_circle.py','qr_orbit_bridge.py','qr_orbit_core.py',
    'qr_orbit_pose.py','terminal_controls.py','hover_checkout.py','qr_takeoff_demo.py','qr_preset_core.py','qr_preset_demo.py','orbit-marker.txt','orbit-calibration.example.json','orbit-preflight.example.json')
$sources = @($names | ForEach-Object {
    $source = Join-Path $sourceRoot $_
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing QR experiment source: $source" }
    $source
})
$localCalibration = $null
$localPreflight = $null
if ($CalibrationFile) { $localCalibration = (Resolve-Path -LiteralPath $CalibrationFile).Path }
if ($PreflightFile) { $localPreflight = (Resolve-Path -LiteralPath $PreflightFile).Path }
$destination = 'pet@' + $PiAddress
$remoteRoot = '/home/pet/emberwatch/qr-demo'
$scpHost = if ($parsedAddress.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6) { 'pet@['+$PiAddress+']' } else { $destination }
& $sshClient @options -T $destination "umask 077; mkdir -p $remoteRoot && chmod 700 $remoteRoot"
if ($LASTEXITCODE -ne 0) { throw 'Pi SSH access failed; no receiver or flight was started.' }
& $scpClient @options @sources ($scpHost + ':' + $remoteRoot + '/')
if ($LASTEXITCODE -ne 0) { throw 'Source copy failed; no receiver or flight was started.' }
if ($localCalibration) {
    & $scpClient @options $localCalibration ($scpHost + ':' + $remoteRoot + '/camera.local.json')
    if ($LASTEXITCODE -ne 0) { throw 'Calibration copy failed.' }
}
if ($localPreflight) {
    & $scpClient @options $localPreflight ($scpHost + ':' + $remoteRoot + '/current-preflight.local.json')
    if ($LASTEXITCODE -ne 0) { throw 'Preflight record copy failed.' }
}
Write-Host ('QR preparation source copied to ' + $remoteRoot)
Write-Host 'No service, Wi-Fi profile, camera or aircraft command was changed or started.'
