<#
  greplet-shared.ps1 - greplet.ps1 이 쓰는 공통 헬퍼.

  워크스페이스 목록의 단일 소스는 indexer/workspaces.json 이다(환경변수 GREPLET_WORKSPACES 로 다른 경로 지정 가능).
  mcp-server · greplet-mcpb 는 인덱서 GET /api/workspaces 로 같은 목록을 받아 온다.
#>

# 워크스페이스 정의 파일 경로 - GREPLET_WORKSPACES 환경변수 우선, 없으면 indexer/workspaces.json
function Get-GrepletWorkspacesPath {
  if ($env:GREPLET_WORKSPACES) { return $env:GREPLET_WORKSPACES }
  return (Join-Path $PSScriptRoot "indexer\workspaces.json")
}

# -All 대상 워크스페이스 슬러그 목록 (하드코딩 금지)
function Get-GrepletWorkspaceSlugs {
  param([string]$WorkspacesPath = (Get-GrepletWorkspacesPath))
  if (-not (Test-Path $WorkspacesPath)) { return @() }
  $json = Get-Content -Path $WorkspacesPath -Raw -Encoding UTF8 | ConvertFrom-Json
  return @($json | ForEach-Object { $_.slug })
}

# -Workspace 미지정 시 기본값: GREPLET_DEFAULT_WORKSPACE → workspaces.json 첫 항목
function Get-GrepletDefaultWorkspace {
  if ($env:GREPLET_DEFAULT_WORKSPACE) { return $env:GREPLET_DEFAULT_WORKSPACE }
  $slugs = Get-GrepletWorkspaceSlugs
  if ($slugs.Count -gt 0) { return $slugs[0] }
  return $null
}
