# Emberwatch demo: starts the backend and opens the dashboard straight into
# Demo mode (hardcoded historical fire cases, simulated ANAFI-01, live Gemini).
# No drone needed. Run from PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\demo.ps1
# or: npm run demo
# -Port 9000 runs it on another port (e.g. next to an already-running backend).
# Ctrl+C stops the backend.
param([int]$Port = 0)
$requestedPort = $Port
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22+ is required (https://nodejs.org).' }
if (-not (Test-Path .env)) { throw 'Missing .env - copy .env.example to .env and fill in the tokens and GEMINI_API_KEY.' }

$port = 8787
$line = Select-String -Path .env -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
if ($line) { $port = [int]$line.Matches[0].Groups[1].Value }
if ($requestedPort) {
  # Environment variables win over .env, so the page's own origin must be allowed too.
  $port = $requestedPort; $env:PORT = "$requestedPort"
  $origins = Select-String -Path .env -Pattern '^\s*ALLOWED_ORIGINS\s*=\s*(.*)$' | Select-Object -First 1
  $env:ALLOWED_ORIGINS = (@("http://127.0.0.1:$requestedPort", "http://localhost:$requestedPort") + $(if ($origins) { $origins.Matches[0].Groups[1].Value.Trim() } else { @() })) -join ','
}
$url = "http://127.0.0.1:$port/?demo"

function Test-Backend {
  try { Invoke-WebRequest "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}

if (Test-Backend) {
  # A backend started before the demo code existed has no /api/demo routes:
  # an unauthenticated POST gets 401 from a current backend, 404 from an old one.
  $status = 0
  try { Invoke-WebRequest "http://127.0.0.1:$port/api/demo/analyze" -Method Post -UseBasicParsing -TimeoutSec 3 | Out-Null }
  catch { if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode } }
  if ($status -eq 404) {
    throw "An older Emberwatch backend is running on port $port without the demo routes. Stop it (Ctrl+C in its window) and run this again, or use: .\demo.ps1 -Port 9000"
  }
  Write-Host "Emberwatch is already running - opening $url"
  Start-Process $url
  exit 0
}

if (-not (Test-Path node_modules/pg)) { Write-Host 'Installing dependencies...'; npm install --no-audit --no-fund | Out-Null }

# Open the browser once the backend answers.
Start-Job -ArgumentList $port, $url -ScriptBlock {
  param($port, $url)
  for ($i = 0; $i -lt 60; $i++) {
    try { Invoke-WebRequest "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 2 | Out-Null; Start-Process $url; return } catch { Start-Sleep -Milliseconds 500 }
  }
} | Out-Null

Write-Host "Starting Emberwatch demo on $url  (Ctrl+C to stop)"
node --env-file=.env backend/server.mjs
