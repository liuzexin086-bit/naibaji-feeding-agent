$ErrorActionPreference = "Stop"

$agentRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $agentRoot ".wrangler"
$tokenPath = Join-Path $agentRoot ".cloudflared-token"
$cloudflaredPath = Join-Path $env:LOCALAPPDATA `
  "Microsoft\WinGet\Packages\Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe\cloudflared.exe"
$dockerDesktopPath = "C:\Program Files\Docker\Docker\Docker Desktop.exe"

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

if (-not (docker version --format "{{.Server.Version}}" 2>$null)) {
  if (Test-Path -LiteralPath $dockerDesktopPath) {
    Start-Process -FilePath $dockerDesktopPath -WindowStyle Hidden
  }
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Seconds 2
    if (docker version --format "{{.Server.Version}}" 2>$null) { break }
  }
}
if (-not (docker version --format "{{.Server.Version}}" 2>$null)) {
  throw "Docker Desktop is not ready."
}

$agentContainer = docker ps -a --filter "name=^/naibaji-feeding-agent-local$" `
  --format "{{.Names}}" | Select-Object -First 1
if ($agentContainer -ne "naibaji-feeding-agent-local") {
  throw "Container naibaji-feeding-agent-local is missing; rebuild it from E:\plan\agent."
}
$runningContainer = docker ps --filter "name=^/naibaji-feeding-agent-local$" `
  --format "{{.Names}}" | Select-Object -First 1
if ($runningContainer -ne "naibaji-feeding-agent-local") {
  docker start naibaji-feeding-agent-local | Out-Null
}

$gateway = Get-NetTCPConnection -State Listen -LocalPort 8787 `
  -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $gateway) {
  Start-Process -FilePath "npx.cmd" `
    -ArgumentList @(
      "wrangler", "dev",
      "--env", "staging",
      "--ip", "127.0.0.1",
      "--port", "8787",
      "--local",
      "--enable-containers=false",
      "--show-interactive-dev-session", "false"
    ) `
    -WorkingDirectory $agentRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $runtimeDir "local-tunnel.out.log") `
    -RedirectStandardError (Join-Path $runtimeDir "local-tunnel.err.log")
}

if (-not (Test-Path -LiteralPath $tokenPath)) {
  throw "Tunnel token file is missing: $tokenPath"
}
if (-not (Test-Path -LiteralPath $cloudflaredPath)) {
  throw "cloudflared is missing: $cloudflaredPath"
}
$tunnelProcess = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" |
  Where-Object { $_.CommandLine -match "tunnel.*run" } |
  Select-Object -First 1
if (-not $tunnelProcess) {
  $env:TUNNEL_TOKEN = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
  Start-Process -FilePath $cloudflaredPath `
    -ArgumentList @("tunnel", "--no-autoupdate", "--protocol", "http2", "run") `
    -WorkingDirectory $agentRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $runtimeDir "cloudflared.out.log") `
    -RedirectStandardError (Join-Path $runtimeDir "cloudflared.err.log")
  Remove-Item Env:TUNNEL_TOKEN
}

for ($attempt = 0; $attempt -lt 20; $attempt++) {
  Start-Sleep -Seconds 1
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:8080/health" -TimeoutSec 2
    $page = Invoke-WebRequest -Uri "http://127.0.0.1:8787/" `
      -UseBasicParsing -TimeoutSec 2
    if ($health.ok -and $page.StatusCode -eq 200) { exit 0 }
  } catch {
    # Continue until the bounded startup window expires.
  }
}
throw "Local Agent or Worker gateway did not become healthy."
