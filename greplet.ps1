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
  [Parameter(Mandatory = $true)]
  [string]$Query,
  [string]$Workspace = "",                        # 미지정 시 Get-GrepletDefaultWorkspace
  [switch]$All,                                    # 지정 시 모든 워크스페이스 통합 검색(서버가 병합·정렬)
  [int]$TopN = 6,
  [switch]$Full,                                   # 지정 시 청크 전문 출력(기본은 300자 스니펫)
  [ValidateSet("hybrid", "vector", "fts")]
  [string]$Mode = "hybrid",
  [string]$BaseUrl = "http://localhost:7802"
)

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

try {
  $resp = Invoke-RestMethod -Uri "$BaseUrl/api/search" -Method Post `
            -Headers @{ "Content-Type" = "application/json" } -Body $body -TimeoutSec 120
} catch {
  Write-Error "인덱서 서버($BaseUrl) 미가동 — pwsh indexer/start-indexer.ps1 로 기동`n상세: $($_.Exception.Message)"
  exit 1
}

$hits = @($resp.hits)
$label = if ($All) { "ALL(" + ($AllWorkspaces -join ",") + ")" } else { $Workspace }

if ($hits.Count -eq 0) {
  Write-Output "결과 없음 (targets=$(if ($All) { 'all' } else { $Workspace }), query=`"$Query`")"
  exit 0
}

Write-Output "[$label] `"$Query`" -> 총 $($hits.Count)건 (점수순)"
Write-Output ("=" * 70)

# 출력 (파일+앞부분 중복 제거) — 서버가 이미 점수순 정렬해 돌려준다
$rank = 1
$seen = @{}
foreach ($r in $hits) {
  $key = "$($r.file)|" + ($r.text.Substring(0, [math]::Min(80, $r.text.Length)))
  if ($seen.ContainsKey($key)) { continue }
  $seen[$key] = $true

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
