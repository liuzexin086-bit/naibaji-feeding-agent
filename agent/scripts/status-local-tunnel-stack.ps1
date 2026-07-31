$ErrorActionPreference = "Continue"

$agentHealth = $false
$gatewayHealth = $false
$publicHealth = $false
$runtimeConfig = $null

try {
  $agentHealth = (Invoke-RestMethod -Uri "http://127.0.0.1:8080/health" `
    -TimeoutSec 5).ok -eq $true
} catch {}
try {
  $gatewayHealth = (Invoke-WebRequest -Uri "http://127.0.0.1:8787/" `
    -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200
} catch {}
try {
  $publicHealth = (Invoke-WebRequest -Uri "https://org.u3u4.top/" `
    -UseBasicParsing -TimeoutSec 15).StatusCode -eq 200
} catch {}
try {
  $vars = @{}
  Get-Content -LiteralPath (Join-Path $PSScriptRoot "..\.dev.vars.staging") |
    ForEach-Object {
      if ($_ -match "^([^#=]+)=(.*)$") {
        $vars[$matches[1].Trim()] = $matches[2].Trim().Trim('"')
      }
    }
  $runtimeConfig = Invoke-RestMethod `
    -Uri "http://127.0.0.1:8080/internal/admin/feeding-agent/config" `
    -Headers @{
      "x-agent-gateway-secret" = $vars["AGENT_GATEWAY_SECRET"]
      "x-agent-admin" = "true"
      "x-auth-user" = "local-status"
      "authorization" = "Bearer local-status"
    } `
    -TimeoutSec 5
} catch {}

[pscustomobject]@{
  AgentContainer = $agentHealth
  LocalGateway = $gatewayHealth
  CloudflaredProcess = [bool](Get-Process cloudflared -ErrorAction SilentlyContinue)
  PublicHostname = $publicHealth
  AgentConfigured = [bool]($runtimeConfig -and $runtimeConfig.configured)
  AgentEnabled = [bool]($runtimeConfig -and $runtimeConfig.enabled)
  AgentHasApiKey = [bool]($runtimeConfig -and $runtimeConfig.hasApiKey)
  AgentProvider = if ($runtimeConfig) { $runtimeConfig.provider } else { $null }
  AgentModel = if ($runtimeConfig) { $runtimeConfig.model } else { $null }
  PublicURL = "https://org.u3u4.top"
}
