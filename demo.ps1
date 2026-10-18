# Compatibility wrapper; the same launcher is used on Windows and macOS.
# .\demo.ps1 -Port 9000 or npm run demo -- --port 9000
param([int]$Port = 0)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22+ is required.' }
$arguments = @('scripts/demo.mjs')
if ($Port) { $arguments += @('--port', "$Port") }
& node @arguments
exit $LASTEXITCODE
