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
  # On the field workstation, the TUN/proxy may be the only route that can
  # complete Cloudflare Tunnel's edge handshake. Pass the user's existing
  # WinINET proxy to the child process without persisting or logging secrets.
  $systemProxy = $null
  try {
    $internetSettings = Get-ItemProperty `
      -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" `
      -ErrorAction Stop
    if ($internetSettings.ProxyEnable -eq 1 -and $internetSettings.ProxyServer) {
      $systemProxy = [string]$internetSettings.ProxyServer
      if ($systemProxy -match "(?i)(?:^|;)https?=([^;]+)") {
        $systemProxy = $matches[1]
      }
      if ($systemProxy -notmatch "^[a-z][a-z0-9+.-]*://") {
        $systemProxy = "http://$systemProxy"
      }
    }
  } catch {
    $systemProxy = $null
  }

  $previousTunnelToken = $env:TUNNEL_TOKEN
  $previousHttpProxy = $env:HTTP_PROXY
  $previousHttpsProxy = $env:HTTPS_PROXY
  $previousEdgeBindAddress = $env:TUNNEL_EDGE_BIND_ADDRESS
  try {
    if ($systemProxy -and -not $env:HTTP_PROXY) {
      $env:HTTP_PROXY = $systemProxy
    }
    if ($systemProxy -and -not $env:HTTPS_PROXY) {
      $env:HTTPS_PROXY = $systemProxy
    }
    $env:TUNNEL_TOKEN = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
    $tunnelArguments = @("tunnel", "--no-autoupdate", "--protocol", "http2", "run")
    $dnsResolver = $env:TUNNEL_DNS_RESOLVER_ADDRS
    if (-not $dnsResolver) {
      $dnsResolver = Get-DnsClientServerAddress -AddressFamily IPv4 `
        -ErrorAction SilentlyContinue |
        Where-Object {
          $_.InterfaceAlias -notmatch "(?i)Meta|Loopback|WSL|Bluetooth" -and
          $_.ServerAddresses
        } |
        ForEach-Object { $_.ServerAddresses } |
        Where-Object { $_ -notmatch "^(0|127\.|169\.254\.|198\.18\.)" } |
        Select-Object -First 1
      if ($dnsResolver) {
        $dnsResolver = "$dnsResolver`:53"
      }
    }
    if ($dnsResolver) {
      # Meta's fake-IP DNS answers (198.18.0.0/16) are not valid Tunnel
      # edge addresses. Prefer the active physical adapter's resolver.
      $tunnelArguments += @("--dns-resolver-addrs", $dnsResolver)
    }
    $metaAdapter = Get-NetAdapter -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Status -eq "Up" -and
        ($_.Name -match "(?i)Meta" -or $_.InterfaceDescription -match "(?i)Meta")
      } |
      Select-Object -First 1
    if ($metaAdapter) {
      $physicalEdgeIp = Get-NetIPAddress -AddressFamily IPv4 `
        -ErrorAction SilentlyContinue |
        Where-Object {
          $_.InterfaceIndex -ne $metaAdapter.ifIndex -and
          $_.IPAddress -notmatch "^(0|127\.|169\.254\.|198\.18\.)" -and
          $_.PrefixOrigin -ne "WellKnown"
        } |
        Sort-Object InterfaceIndex |
        Select-Object -ExpandProperty IPAddress -First 1
      if ($physicalEdgeIp) {
        # Bind the long-lived Tunnel socket to the physical NIC so the TUN
        # adapter cannot route it back to a 198.18/16 fake-IP endpoint.
        if (-not $env:TUNNEL_EDGE_BIND_ADDRESS) {
          $env:TUNNEL_EDGE_BIND_ADDRESS = $physicalEdgeIp
        }
      }
    }
    Start-Process -FilePath $cloudflaredPath `
      -ArgumentList $tunnelArguments `
      -WorkingDirectory $agentRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $runtimeDir "cloudflared.out.log") `
      -RedirectStandardError (Join-Path $runtimeDir "cloudflared.err.log")
  } finally {
    if ($null -eq $previousTunnelToken) { Remove-Item Env:TUNNEL_TOKEN -ErrorAction SilentlyContinue } else { $env:TUNNEL_TOKEN = $previousTunnelToken }
    if ($null -eq $previousHttpProxy) { Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue } else { $env:HTTP_PROXY = $previousHttpProxy }
    if ($null -eq $previousHttpsProxy) { Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue } else { $env:HTTPS_PROXY = $previousHttpsProxy }
    if ($null -eq $previousEdgeBindAddress) { Remove-Item Env:TUNNEL_EDGE_BIND_ADDRESS -ErrorAction SilentlyContinue } else { $env:TUNNEL_EDGE_BIND_ADDRESS = $previousEdgeBindAddress }
  }
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
