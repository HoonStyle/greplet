<#
  greplet.ps1 - greplet 인덱서 빠른 검색 헬퍼

  목적: 코드/문서 폴더를 통째로 grep/read 하지 않고,
        하이브리드 검색(벡터+FTS, LLM 생성 없음)으로 관련 청크만 ~2초에 추출.

  백엔드: 자체 인덱서(Roslyn/PdfPig 청크 + Ollama bge-m3 + LanceDB), http://localhost:7802.
          미가동이면 pwsh indexer/start-indexer.ps1 로 기동할 것.

  사용 예:
    pwsh greplet.ps1 -Query "재시도 백오프 로직"
    pwsh greplet.ps1 -Query "설정 파일 스키마" -Workspace docs -TopN 8
    pwsh greplet.ps1 -Query "에러 코드 정의" -All          # 워크스페이스 통합 검색
    pwsh greplet.ps1 -Query "..." -Full                    # 청크 전문 출력
    pwsh greplet.ps1 -Query "0x0A03" -Mode fts             # 정확 토큰 검색(상수·메서드명 등)

  워크스페이스 slug 는 indexer/workspaces.json 이 단일 소스(GREPLET_WORKSPACES 로 다른 경로 지정 가능).
  -Workspace 미지정 시 GREPLET_DEFAULT_WORKSPACE → workspaces.json 첫 항목.
#>
param(
  [Parameter(Position = 0)]
  [string]$Query,
  [string]$Workspace = "",                        # 미지정 시 Get-GrepletDefaultWorkspace
  [switch]$All,                                    # 지정 시 모든 워크스페이스 통합 검색(서버가 병합·정렬)
  [int]$TopN = 6,
  [switch]$Full,                                   # 지정 시 청크 전문 출력(기본은 300자 스니펫)
  [ValidateSet("hybrid", "vector", "fts")]
  [string]$Mode = "hybrid",
  [string]$BaseUrl = $(if ($env:GREPLET_BASE_URL) { $env:GREPLET_BASE_URL } else { "http://localhost:7802" }),
  [ValidateSet("Search", "EvidenceSearch", "EvidenceGet")]
  [string]$Command = "Search",                    # EvidenceSearch/EvidenceGet 는 Node CLI(greplet.mjs)로 위임
  [string]$RefFile,
  [string]$FileGlob
)

if ($Command -eq "EvidenceSearch" -or $Command -eq "EvidenceGet") {
  $nodeScript = Join-Path $PSScriptRoot "greplet.mjs"
  $nodeArgs = @()
  if ($Command -eq "EvidenceSearch") {
    $nodeArgs += "evidence-search"
    if ($Query) { $nodeArgs += $Query }
    if ($Workspace) { $nodeArgs += @("-w", $Workspace) }
    if ($All) { $nodeArgs += "--all" }
    $nodeArgs += @("--top-n", $TopN)
    $nodeArgs += @("--mode", $Mode)
    if ($FileGlob) { $nodeArgs += @("--file", $FileGlob) }
  } else {
    $nodeArgs += "evidence-get"
    if ($RefFile) { $nodeArgs += @("--ref-file", $RefFile) }
  }
  $nodeArgs += @("--base-url", $BaseUrl)
  & node $nodeScript @nodeArgs
  exit $LASTEXITCODE
}

if (-not $Query) { Write-Error "-Query 가 필요합니다"; exit 2 }

. (Join-Path $PSScriptRoot "greplet-shared.ps1")

if (-not $Workspace) {
  $Workspace = Get-GrepletDefaultWorkspace
  if (-not $Workspace -and -not $All) { Write-Error "워크스페이스가 없습니다 - indexer/workspaces.json 을 확인하세요"; exit 1 }
}

$AllWorkspaces = Get-GrepletWorkspaceSlugs

$body = @{
  query      = $Query
  # 주의: PowerShell 은 if/else 블록이 파이프라인으로 값을 반환할 때 단일 요소 배열을 스칼라로
  # 풀어버린다(back-tick 없는 배열 언롤링) - 선두 콤마(,)로 한 겹 더 감싸 배열 그대로 보존해야 한다.
  workspaces = if ($All) { "all" } else { , @($Workspace) }
  topN       = $TopN
  mode       = $Mode
} | ConvertTo-Json

# 호출 세션·클라이언트 자동 감지: GREPLET_SESSION → CODEX_THREAD_ID/CODEX_SESSION_ID(Codex 셸 툴 환경) → CLAUDE_CODE_SESSION_ID
# Codex 우선: Claude Code 가 Codex 에 위임하면 두 변수가 모두 상속되는데, 출력을 읽는 쪽은 Codex 이기 때문
$codexId = if ($env:CODEX_THREAD_ID) { $env:CODEX_THREAD_ID } else { $env:CODEX_SESSION_ID }
$session = if ($env:GREPLET_SESSION) { $env:GREPLET_SESSION } elseif ($codexId) { $codexId } else { $env:CLAUDE_CODE_SESSION_ID }
$client = if ($env:GREPLET_CLIENT_NAME) { $env:GREPLET_CLIENT_NAME } elseif ($codexId) { "cli:codex" } elseif ($env:CLAUDE_CODE_SESSION_ID) { "cli:claude" } else { "cli" }
$headers = @{ "Content-Type" = "application/json"; "X-Greplet-Client" = $client; "X-Greplet-Snippet" = $(if ($Full) { "full" } else { "300" }) }
if ($session) { $headers["X-Greplet-Session"] = $session }

try {
  $resp = Invoke-RestMethod -Uri "$BaseUrl/api/search" -Method Post `
            -Headers $headers -Body $body -TimeoutSec 120
} catch {
  Write-Error "인덱서 서버($BaseUrl) 미가동 — pwsh indexer/start-indexer.ps1 로 기동`n상세: $($_.Exception.Message)"
  exit 1
}

$hits = @($resp.hits)
$label = if ($All) { "ALL(" + ($AllWorkspaces -join ",") + ")" } else { $Workspace }

if ($hits.Count -eq 0) {
  Write-Output "결과 없음 (targets=$(if ($All) { 'all' } else { $Workspace }), query=`"$Query`")"
  if ($resp.warnings -and $resp.warnings.Count -gt 0) {
    Write-Output "(경고: $($resp.warnings -join ' · '))"
  }
  exit 0
}

Write-Output "[$label] `"$Query`" -> 총 $($hits.Count)건 (점수순)"
Write-Output ("=" * 70)

# 출력 (서버가 이미 점수순 정렬해 돌려준다) — 출처가 다르면 본문이 같아도 모두 보존한다
$rank = 1
foreach ($r in $hits) {
  $wsTag = if ($All) { "[$($r.workspace)] " } else { "" }
  $loc = if ($r.kind -eq "page") { "" } else { " (L$($r.startLine)-$($r.endLine))" }
  Write-Output ("#{0}  score {1}  |  {2}{3} :: {4}{5}" -f $rank, [math]::Round($r.score, 4), $wsTag, $r.file, $r.symbol, $loc)
  if ($Full) {
    Write-Output $r.text
  } else {
    $snip = $r.text -replace "\s+", " "
    if ($snip.Length -gt 300) { $snip = $snip.Substring(0, 300) + " ..." }
    Write-Output $snip
  }
  Write-Output ("-" * 70)
  $rank++
}

if ($resp.warnings -and $resp.warnings.Count -gt 0) {
  Write-Output "(경고: $($resp.warnings -join ' · '))"
}
