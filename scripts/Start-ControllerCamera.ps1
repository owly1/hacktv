# Receives video from the Skycontroller's USB network. No flight commands.
[CmdletBinding()]
param(
    [string]$BackendDirectory = (Join-Path $env:USERPROFILE 'Desktop\drone'),
    [ValidateRange(1, 15)][int]$Fps = 10,
    [int]$Width = 960
)
$ErrorActionPreference = 'Stop'
$backendRoot = (Resolve-Path -LiteralPath $BackendDirectory).Path
$envFile = Join-Path $backendRoot '.env'
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) { throw 'Backend environment file is missing.' }
if ($Width -ne 0 -and ($Width -lt 320 -or $Width -gt 1920 -or $Width % 2)) {
    throw 'Width must be 0 for native size, or an even value from 320 to 1920.'
}
$nodeClient = (Get-Command node.exe -ErrorAction Stop).Source
$ffmpegClient = (Get-Command ffmpeg.exe -ErrorAction Stop).Source
$relayPath = Join-Path $PSScriptRoot '..\bridge\rtsp_camera_relay.mjs'
if (-not (Test-Path -LiteralPath $relayPath -PathType Leaf)) { throw 'Camera receiver source is missing from the bridge folder.' }
$existingRelays = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -match '[\\/]rtsp_camera_relay\.mjs(?:[\s"]|$)'
})
if ($existingRelays.Count -gt 0) {
    $sameSettings = $existingRelays.Count -eq 1 -and
        $existingRelays[0].CommandLine.IndexOf($envFile, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $existingRelays[0].CommandLine -match ('--fps\s+"?' + [regex]::Escape([string]$Fps) + '"?(?=\s|$)') -and
        $existingRelays[0].CommandLine -match ('--width\s+"?' + [regex]::Escape([string]$Width) + '"?(?=\s|$)')
    $existingStatus = $null
    try {
        $session = Invoke-RestMethod 'http://127.0.0.1:8787/api/session' -TimeoutSec 4
        if ($session.contract -eq 'emberwatch.v1' -and $session.token) {
            $existingStatus = Invoke-RestMethod 'http://127.0.0.1:8787/api/status' -Headers @{Authorization = ('Bearer ' + $session.token)} -TimeoutSec 4
        }
    } catch { }
    if ($sameSettings -and $existingStatus -and $existingStatus.video.fps -gt 0 -and
        $existingStatus.camera.age_ms -ge -2000 -and $existingStatus.camera.age_ms -lt 3000) {
        Write-Host ('Camera receiver is already running (PID ' + $existingRelays[0].ProcessId + ').')
        Write-Host ('Live dashboard: http://127.0.0.1:8787/ - ' + $existingStatus.video.fps + ' FPS. Reusing the existing receiver.')
        return
    }
    throw 'A camera receiver is already running. To change its settings, stop it in its original terminal first. If its settings already match, check the backend and USB connection before starting another.'
}
Write-Host 'Controller USB camera reception only. Keep the Pi direct observer stopped.'
Write-Host 'Backend must already be running. Ctrl+C stops this camera receiver.'
& $nodeClient "--env-file=$envFile" $relayPath --ffmpeg $ffmpegClient --fps $Fps --width $Width
if ($LASTEXITCODE -ne 0) { throw 'Controller camera reception ended with an error.' }
