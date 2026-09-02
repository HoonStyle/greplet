/*
  greplet.ts — greplet 인덱서(/api/search) 프록시 (greplet.ps1 로직 동치 이식)

  ps1 대비 동치 보장 지점:
    - 점수 내림차순 통합 정렬 (all) — 서버가 이미 병합·정렬해 돌려주므로 그대로 사용
    - "파일명|선두 80자" 키로 중복 제거
    - 스니펫: 공백 정규화 후 300자 + " ..."
    - 출력 포맷: "#rank  score x.xxxx  |  [ws] file :: symbol (L{start}-{end})" (PDF 는 :: p.N)

  워크스페이스 목록은 하드코딩하지 않고 인덱서 GET /api/workspaces 에서 받아 온다(60초 캐시).
  단일 소스는 indexer/workspaces.json 하나다.
*/

export type SearchMode = "hybrid" | "vector" | "fts";

export interface GrepletParams {
  query: string;
  /** 미지정 시 GREPLET_DEFAULT_WORKSPACE → 서버의 첫 워크스페이스 순으로 결정 */
  workspace?: string;
  all: boolean;
  topN: number;
  full: boolean;
  mode: SearchMode;
}

interface Hit {
  workspace: string;
  file: string;
  symbol: string;
  kind: string;
  startLine: number;
  endLine: number;
  score: number;
  text: string;
}

interface SearchApiResponse {
  hits: Hit[];
  mode: SearchMode;
  warnings: string[];
}

export interface WorkspaceInfo {
  slug: string;
  label: string;
  kind: string;
  files: number;
  chunks: number;
  lastRun: string | null;
  indexing: boolean;
}

export interface BackendConfig {
  baseUrl: string; // 예: http://localhost:7802
  defaultWorkspace?: string;
}

const WS_CACHE_TTL_MS = 60_000;
let wsCache: { at: number; list: WorkspaceInfo[] } | null = null;

/** GET /api/workspaces — 60초 캐시 */
export async function fetchWorkspaces(cfg: BackendConfig): Promise<WorkspaceInfo[]> {
  if (wsCache && Date.now() - wsCache.at < WS_CACHE_TTL_MS) return wsCache.list;
  const resp = await fetch(`${cfg.baseUrl}/api/workspaces`, { signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`/api/workspaces HTTP ${resp.status}: ${await resp.text()}`);
  const list = (await resp.json()) as WorkspaceInfo[];
  wsCache = { at: Date.now(), list };
  return list;
}

function backendDownMessage(cfg: BackendConfig, e: unknown): string {
  return (
    `인덱서 서버(${cfg.baseUrl}) 미가동 또는 요청 실패 — indexer/start-indexer.sh(macOS/Linux) 또는 start-indexer.ps1(Windows) 로 기동할 것. ` +
    `상세: ${e instanceof Error ? e.message : String(e)}`
  );
}

async function callSearchApi(
  cfg: BackendConfig,
  workspaces: string[] | "all",
  query: string,
  topN: number,
  mode: SearchMode,
): Promise<SearchApiResponse> {
  const resp = await fetch(`${cfg.baseUrl}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, workspaces, topN, mode }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!resp.ok) {
    throw new Error(`/api/search HTTP ${resp.status}: ${await resp.text()}`);
  }
  return (await resp.json()) as SearchApiResponse;
}

/** symbol 뒤에 붙는 위치 표기. PDF(symbol 이 이미 p.N)는 생략, 그 외는 (L{start}-{end}). */
function locationSuffix(h: Hit): string {
  return h.kind === "page" ? "" : ` (L${h.startLine}-${h.endLine})`;
}

/** 워크스페이스 목록을 사람이 읽을 표로 */
export async function listWorkspacesText(cfg: BackendConfig): Promise<string> {
  let list: WorkspaceInfo[];
  try {
    list = await fetchWorkspaces(cfg);
  } catch (e) {
    throw new Error(backendDownMessage(cfg, e));
  }
  if (list.length === 0) return "워크스페이스 없음 (indexer/workspaces.json 을 확인할 것)";
  const lines = list.map(
    (w) =>
      `${w.slug.padEnd(20)} ${w.kind.padEnd(5)} files=${String(w.files).padStart(5)} chunks=${String(w.chunks).padStart(7)}` +
      `  last=${w.lastRun ?? "-"}${w.indexing ? "  (인덱싱 중)" : ""}  ${w.label}`,
  );
  return lines.join("\n");
}

/** greplet 본체 — 인덱서 서버 1회 호출 → 포맷팅해 텍스트로 반환 */
export async function runGreplet(cfg: BackendConfig, p: GrepletParams): Promise<string> {
  let slugs: string[];
  try {
    slugs = (await fetchWorkspaces(cfg)).map((w) => w.slug);
  } catch (e) {
    throw new Error(backendDownMessage(cfg, e));
  }

  let workspace = p.workspace ?? cfg.defaultWorkspace ?? slugs[0];
  if (!p.all) {
    if (!workspace) throw new Error("워크스페이스가 하나도 없다 — indexer/workspaces.json 을 확인할 것");
    if (!slugs.includes(workspace)) {
      throw new Error(`알 수 없는 워크스페이스 "${workspace}" — 사용 가능: ${slugs.join(", ")}`);
    }
  }
  const targets: string[] | "all" = p.all ? "all" : [workspace];

  let data: SearchApiResponse;
  try {
    data = await callSearchApi(cfg, targets, p.query, p.topN, p.mode);
  } catch (e) {
    throw new Error(backendDownMessage(cfg, e));
  }

  const label = p.all ? `ALL(${slugs.join(",")})` : workspace;

  if (data.hits.length === 0) {
    return `결과 없음 (targets=${p.all ? "all" : workspace}, query="${p.query}")`;
  }

  const lines: string[] = [];
  lines.push(`[${label}] "${p.query}" -> 총 ${data.hits.length}건 (점수순)`);
  lines.push("=".repeat(70));

  let rank = 1;
  const seen = new Set<string>();
  for (const h of data.hits) {
    const key = `${h.file}|${h.text.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const wsTag = p.all ? `[${h.workspace}] ` : "";
    lines.push(`#${rank}  score ${h.score.toFixed(4)}  |  ${wsTag}${h.file} :: ${h.symbol}${locationSuffix(h)}`);
    if (p.full) {
      lines.push(h.text);
    } else {
      let snip = h.text.replace(/\s+/g, " ");
      if (snip.length > 300) snip = snip.slice(0, 300) + " ...";
      lines.push(snip);
    }
    lines.push("-".repeat(70));
    rank++;
  }

  if (data.warnings.length > 0) {
    lines.push(`(경고: ${data.warnings.join(" · ")})`);
  }
  return lines.join("\n");
}
