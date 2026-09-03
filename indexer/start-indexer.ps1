<#
  start-indexer.ps1 - greplet 인덱서 서버 백그라운드 기동(§5.6).
  이미 떠 있으면(healthz 200) 그대로 스킵하고, 아니면 새로 띄운 뒤 healthz 를 최대 10초 폴링한다.
#>
param(
  # 127.0.0.1 명시 - "localhost" 는 PowerShell(.NET HttpClient)이 IPv6(::1)를 먼저 시도하다
  # 로컬 환경에 따라 수 초 지연 후 폴백하는 경우가 있어 healthz 폴링이 불필요하게 느려진다.
  [string]$BaseUrl = "http://127.0.0.1:7802",
  # 기동 확인 후 관리 UI 를 기본 브라우저로 연다. 환경변수 GREPLET_OPEN_UI=1 과 동일.
  [switch]$OpenUI
)

if ($env:GREPLET_OPEN_UI -eq "1") { $OpenUI = $true }

function Open-GrepletUI {
  if (-not $OpenUI) { return }
  Start-Process ($BaseUrl -replace "127\.0\.0\.1", "localhost")
}

$ErrorActionPreference = "Stop"
$IndexerRoot = $PSScriptRoot
$LogPath = Join-Path $IndexerRoot "logs\server.log"

function Test-Healthz {
  try {
    $resp = Invoke-WebRequest -Uri "$BaseUrl/healthz" -TimeoutSec 2 -UseBasicParsing
    return $resp.StatusCode -eq 200
  } catch {
    return $false
  }
}

if (Test-Healthz) {
  Write-Host "[start-indexer] 이미 기동 중 ($BaseUrl) — 스킵"
  Open-GrepletUI
  exit 0
}

New-Item -ItemType Directory -Force -Path (Split-Path $LogPath) | Out-Null

$distServer = Join-Path $IndexerRoot "dist\server.js"
if (-not (Test-Path $distServer)) {
  throw "dist/server.js 가 없습니다. 먼저 'npm run build' 를 실행하세요. ($distServer)"
}

Write-Host "[start-indexer] node dist/server.js 기동 중... (로그: $LogPath)"
Start-Process -FilePath "node" -ArgumentList @($distServer) `
  -WorkingDirectory $IndexerRoot -WindowStyle Hidden `
  -RedirectStandardOutput $LogPath -RedirectStandardError "$LogPath.err"

$deadline = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $deadline) {
  if (Test-Healthz) {
    Write-Host "[start-indexer] 기동 확인 ($BaseUrl)"
    Open-GrepletUI
    exit 0
  }
  Start-Sleep -Milliseconds 500
}

Write-Warning "[start-indexer] 10초 내 healthz 응답 없음 — 로그 확인: $LogPath / $LogPath.err"
exit 1
