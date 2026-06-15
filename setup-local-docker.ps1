param(
  [switch]$SkipStart
)

$ErrorActionPreference = 'Stop'

function Read-WithDefault {
  param([string]$Prompt, [string]$Default)
  $value = Read-Host "$Prompt [$Default]"
  if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
  return $value.Trim()
}

function New-RandomSecret {
  param([int]$Bytes = 48)
  $buffer = New-Object byte[] $Bytes
  # RNGCryptoServiceProvider works on all PowerShell / .NET versions (no Fill() needed)
  $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
  try {
    $rng.GetBytes($buffer)
  } finally {
    if ($rng -ne $null) { $rng.Dispose() }
  }
  return [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+','-').Replace('/','_')
}

function Read-SecretOrGenerate {
  param([string]$Prompt)
  $secure = Read-Host "$Prompt (leave blank to auto-generate)" -AsSecureString
  if ($secure.Length -eq 0) { return New-RandomSecret 36 }
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Assert-Command {
  param([string]$CommandName, [string]$InstallHint)
  if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
    throw "$CommandName is required. $InstallHint"
  }
}

Write-Host ""
Write-Host "Factory-MIOS local Docker setup" -ForegroundColor Cyan
Write-Host "This will create .env and start gateway + app + PgBouncer + TimescaleDB." -ForegroundColor Gray
Write-Host ""

Assert-Command docker "Install and start Docker Desktop, then run this script again."
docker compose version | Out-Null

function Get-EnvValue {
  param([string]$Path, [string]$Key, [string]$Default)
  if (-not (Test-Path $Path)) { return $Default }
  $line = Get-Content $Path | Where-Object { $_ -match "^$([regex]::Escape($Key))=" } | Select-Object -First 1
  if (-not $line) { return $Default }
  $value = $line.Substring($Key.Length + 1).Trim()
  if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
  return $value
}

function Start-FactoryMiosStack {
  param([string]$EnvPath)
  if ($SkipStart) {
    Write-Host "SkipStart selected. Run 'docker compose up -d --build' when ready." -ForegroundColor Yellow
    return
  }
  $httpPort = Get-EnvValue $EnvPath 'HTTP_PORT' '8080'
  $dbName = Get-EnvValue $EnvPath 'POSTGRES_DB' 'factory_mios'
  $dbUser = Get-EnvValue $EnvPath 'POSTGRES_USER' 'factory_mios'

  Write-Host "Starting Factory-MIOS Docker stack..." -ForegroundColor Cyan
  docker compose up -d --build

  Write-Host "Waiting for dashboard health endpoint..." -ForegroundColor Cyan
  $healthUrl = "http://localhost:$httpPort/health"
  $healthy = $false
  for ($i = 1; $i -le 40; $i++) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 3
      if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { $healthy = $true; break }
    } catch {}
    Start-Sleep -Seconds 3
  }

  if ($healthy) {
    Write-Host "Dashboard is reachable: http://localhost:$httpPort" -ForegroundColor Green
  } else {
    Write-Host "Dashboard did not become healthy yet. Check logs: docker compose logs -f app" -ForegroundColor Yellow
  }

  $policyPath = Join-Path (Get-Location) 'deploy/db/policies/001-timescale-telemetry-policies.sql'
  if (Test-Path $policyPath) {
    Write-Host "Applying TimescaleDB policies if tables exist..." -ForegroundColor Cyan
    try {
      Get-Content -Raw $policyPath | docker compose exec -T db psql -U $dbUser -d $dbName
    } catch {
      Write-Host "Policy application skipped/failed. You can rerun after tables exist:" -ForegroundColor Yellow
      Write-Host "Get-Content -Raw deploy/db/policies/001-timescale-telemetry-policies.sql | docker compose exec -T db psql -U $dbUser -d $dbName"
    }
  }

  Write-Host ""
  Write-Host "Factory-MIOS is ready." -ForegroundColor Green
  Write-Host "Dashboard: http://localhost:$httpPort"
  Write-Host "Logs:      docker compose logs -f app"
  Write-Host "Stop:      docker compose down"
  Write-Host "Adminer:   docker compose --profile tools up -d"
  Write-Host "Node-RED:  docker compose --profile iot up -d"
}

$envPath = Join-Path (Get-Location) '.env'
if (Test-Path $envPath) {
  $overwrite = Read-WithDefault "Existing .env found. Overwrite? (y/n)" "n"
  if ($overwrite.ToLower() -ne 'y') {
    Write-Host "Keeping existing .env" -ForegroundColor Yellow
    Start-FactoryMiosStack $envPath
    exit 0
  }
}

$httpPort = Read-WithDefault "Dashboard host port" "8080"
$appPort = Read-WithDefault "Internal app port" "3000"
$dbPort = Read-WithDefault "PostgreSQL host port" "5432"
$adminerPort = Read-WithDefault "Adminer host port" "8081"
$nodeRedPort = Read-WithDefault "Node-RED host port" "1880"
$dbName = Read-WithDefault "Database name" "factory_mios"
$dbUser = Read-WithDefault "Database user" "factory_mios"
$dbPassword = Read-SecretOrGenerate "Database password"
$jwtSecret = Read-SecretOrGenerate "JWT secret"
$enableDemoUsers = Read-WithDefault "Enable demo admin users for local testing? (true/false)" "false"
$nodeRedUrl = Read-WithDefault "Node-RED live URL" "http://host.docker.internal:1880/api/live"
$tbToken = Read-WithDefault "ThingsBoard token (optional)" ""
$geminiKey = Read-WithDefault "Gemini API key for chatbot (optional)" ""
$anthropicKey = Read-WithDefault "Anthropic API key for chatbot (optional)" ""

$envText = @"
COMPOSE_PROJECT_NAME=factory-mios
NODE_ENV=production
PORT=$appPort
HTTP_PORT=$httpPort
TZ=Asia/Kolkata

POSTGRES_DB=$dbName
POSTGRES_USER=$dbUser
POSTGRES_PASSWORD=$dbPassword
POSTGRES_PORT=$dbPort
ADMINER_PORT=$adminerPort
NODE_RED_PORT=$nodeRedPort

PGHOST=pgbouncer
PGPORT=6432
PGDATABASE=$dbName
PGUSER=$dbUser
PGPASSWORD=$dbPassword
PGPOOL_MAX=10
PGPOOL_IDLE_TIMEOUT_MS=30000
PGPOOL_CONNECTION_TIMEOUT_MS=5000

PGBOUNCER_MAX_CLIENT_CONN=1000
PGBOUNCER_DEFAULT_POOL_SIZE=50
PGBOUNCER_RESERVE_POOL_SIZE=10

DATA_CONNECTOR_SECRET=$jwtSecret
JWT_SECRET=$jwtSecret
JWT_EXPIRE=24h
JSON_BODY_LIMIT=1mb
RATE_LIMIT_MAX=1000
AUTH_RATE_LIMIT_MAX=20
AI_RATE_LIMIT_MAX=60
ALLOW_QUERY_TOKEN_AUTH=false
ENABLE_DEFAULT_USERS=$enableDemoUsers

NODE_RED_URL=$nodeRedUrl
DATA_IMPORT_DIR=/app/imports
DATA_SOURCE_PREVIEW_ROWS=100
DATA_SOURCE_CACHE_TTL_MS=30000
DATA_SOURCE_SQL_TIMEOUT_MS=10000
DATA_SOURCE_MQTT_TIMEOUT_MS=10000
GEMINI_API_KEY=$geminiKey
ANTHROPIC_API_KEY=$anthropicKey
TB_TOKEN=$tbToken
TB_MACHINE_ID=MACHINE001

MQTT_BROKER=mqtt://host.docker.internal:1883
MQTT_TOPIC=factory-machine001
"@

Set-Content -Path $envPath -Value $envText -Encoding UTF8
Write-Host "Created .env" -ForegroundColor Green

Start-FactoryMiosStack $envPath
