/*
  search.ts — hybrid/vector/fts 검색(§5.3). LanceDB API 형태는 §5.4 프로브로 검증된 것을 그대로 쓴다.
*/
import { rerankers } from "@lancedb/lancedb";
import type { AppConfig, WorkspaceConfig } from "./config.js";
import { openOrCreateTable, tableExists, manifestPathFor } from "./db.js";
import { embedQuery } from "./embed.js";
import { loadManifest } from "./scan.js";

export type SearchMode = "hybrid" | "vector" | "fts";

export interface SearchHit {
  workspace: string;
  file: string;
  abs: string;
  symbol: string;
  kind: string;
  startLine: number;
  endLine: number;
  score: number;
  text: string;
}

export interface SearchResponse {
  hits: SearchHit[];
  mode: SearchMode;
  warnings: string[];
  cached?: boolean;
}

export interface SearchOptions {
  // 결과를 파일 상대경로 글롭으로 거른다. `*` 는 세그먼트 안, `**` 는 깊이 무관. 예: "Lib/**" + "/*.cs"
  fileGlob?: string;
}

/** 파일 글롭 → 정규식. scan.ts 의 파일명 글롭과 달리 경로 전체를 대상으로 하며 `**` 를 지원한다. */
export function fileGlobToRegex(glob: string): RegExp {
  const g = glob.replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i++;
        if (g[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  // 앞에 경로가 더 있어도 되게(부분 일치) — "*.cs" 가 "a/b/c.cs" 에도 맞도록
  return new RegExp("(^|/)" + re + "$", "i");
}

/** 하이브리드 융합 전 하위 질의(벡터·FTS)별 최소 후보 수 */
const HYBRID_MIN_POOL = 50;

const SELECT_COLS = ["file", "abs", "symbol", "kind", "start_line", "end_line", "text"];

/** 파일 글롭 필터가 있을 때 후보를 넉넉히 뽑기 위한 배수 */
const GLOB_POOL_FACTOR = 10;

// ---------- 결과 캐시(§8) ----------
// 키: 질의 파라미터 + 대상 워크스페이스별 매니페스트 lastRun. 인덱스가 갱신되면 lastRun 이 바뀌어 자연히 무효화된다.
const CACHE_MAX = 200;
const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; value: SearchResponse }>();

function cacheKey(cfg: AppConfig, workspaces: WorkspaceConfig[], query: string, topN: number, mode: SearchMode, opts: SearchOptions): string {
  const versions = workspaces.map((ws) => `${ws.slug}@${loadManifest(manifestPathFor(cfg, ws.slug)).lastRun || "-"}`).join(",");
  return JSON.stringify([query, topN, mode, opts.fileGlob ?? "", versions]);
}

function cacheGet(key: string): SearchResponse | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  // LRU: 재삽입으로 최근 사용 순서 유지
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

function cacheSet(key: string, value: SearchResponse): void {
  cache.set(key, { at: Date.now(), value });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function clearSearchCache(): void {
  cache.clear();
}

async function searchOneWorkspace(
  cfg: AppConfig,
  ws: WorkspaceConfig,
  query: string,
  topN: number,
  mode: SearchMode,
  warnings: string[],
  fileRe: RegExp | null,
): Promise<SearchHit[]> {
  const exists = await tableExists(cfg, ws);
  if (!exists) return [];

  const table = await openOrCreateTable(cfg, ws);
  let effectiveMode = mode;
  // 글롭 필터는 검색 후 적용하므로 후보를 더 뽑는다
  const limit = fileRe ? topN * GLOB_POOL_FACTOR : topN;
  const applyGlob = (hits: SearchHit[]) => (fileRe ? hits.filter((h) => fileRe.test(h.file)).slice(0, topN) : hits);

  // 임베딩 없는(구버전 매니페스트는 있음으로 간주) 워크스페이스는 hybrid/vector 를 fts 로 강등한다.
  // 영벡터에 cosine 을 적용하면 NaN 이 나오므로 이 강등이 유일한 보호막이다.
  if (effectiveMode !== "fts") {
    const manifest = loadManifest(manifestPathFor(cfg, ws.slug));
    if (manifest.embeddings === "none") {
      warnings.push(`[${ws.slug}] 임베딩 없음 → fts 로 강등`);
      effectiveMode = "fts";
    }
  }

  try {
    if (effectiveMode === "fts") {
      const rows = await table.query().fullTextSearch(query).select(SELECT_COLS).limit(limit).toArray();
      return applyGlob(rows.map((r: any) => toHit(ws.slug, r, Number(r._score ?? 0))));
    }

    let qvec: number[];
    try {
      qvec = await embedQuery(cfg, query);
    } catch (embedErr) {
      // 질의 임베딩 실패(Ollama 미가동 등) 시 fts 로 폴백해 결과가 비지 않게 한다.
      warnings.push(`[${ws.slug}] 질의 임베딩 실패 → fts 로 폴백: ${errMsg(embedErr)}`);
      const rows = await table.query().fullTextSearch(query).select(SELECT_COLS).limit(limit).toArray();
      return applyGlob(rows.map((r: any) => toHit(ws.slug, r, Number(r._score ?? 0))));
    }
    let q = table.query().nearestTo(qvec).distanceType("cosine");

    if (effectiveMode === "hybrid") {
      try {
        // limit 은 벡터·FTS 하위 질의 각각에 걸린다. topN 만 주면 두 목록이 거의 겹치지 않아 RRF 점수가
        // 전부 1/(60+rank) 동점이 되고 순위가 사실상 무작위가 된다 → 후보를 넉넉히 뽑아 융합한 뒤 topN 만 남긴다.
        const rr = await rerankers.RRFReranker.create();
        const poolSize = Math.max(limit * 10, HYBRID_MIN_POOL);
        const rows = await q.fullTextSearch(query).rerank(rr).select(SELECT_COLS).limit(poolSize).toArray();
        return applyGlob(rows.slice(0, limit).map((r: any) => toHit(ws.slug, r, Number(r._relevance_score ?? 0))));
      } catch (ftsErr) {
        // FTS 구문 오류 등 → vector 로 폴백(§5.3)
        warnings.push(`[${ws.slug}] hybrid 검색 실패 → vector 로 폴백: ${errMsg(ftsErr)}`);
        effectiveMode = "vector";
      }
    }

    try {
      const rows = await table.query().nearestTo(qvec).distanceType("cosine").select(SELECT_COLS).limit(limit).toArray();
      return applyGlob(rows.map((r: any) => toHit(ws.slug, r, 1 - Number(r._distance ?? 0))));
    } catch (vecErr) {
      // Ollama 가 잡 중간에 죽는 등 vector 경로 실패 시 fts 로 폴백해 결과가 비지 않게 한다.
      warnings.push(`[${ws.slug}] vector 검색 실패 → fts 로 폴백: ${errMsg(vecErr)}`);
      const rows = await table.query().fullTextSearch(query).select(SELECT_COLS).limit(limit).toArray();
      return applyGlob(rows.map((r: any) => toHit(ws.slug, r, Number(r._score ?? 0))));
    }
  } catch (err) {
    warnings.push(`[${ws.slug}] 검색 실패(mode=${effectiveMode}): ${errMsg(err)}`);
    return [];
  }
}

function toHit(workspace: string, row: any, score: number): SearchHit {
  return {
    workspace,
    file: row.file,
    abs: row.abs ?? "",
    symbol: row.symbol,
    kind: row.kind,
    startLine: row.start_line,
    endLine: row.end_line,
    score,
    text: row.text,
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function search(
  cfg: AppConfig,
  workspaces: WorkspaceConfig[],
  query: string,
  topN: number,
  mode: SearchMode,
  opts: SearchOptions = {},
): Promise<SearchResponse> {
  const key = cacheKey(cfg, workspaces, query, topN, mode, opts);
  const cached = cacheGet(key);
  if (cached) return { ...cached, cached: true };

  const fileRe = opts.fileGlob ? fileGlobToRegex(opts.fileGlob) : null;
  const warnings: string[] = [];
  const perWs = await Promise.all(workspaces.map((ws) => searchOneWorkspace(cfg, ws, query, topN, mode, warnings, fileRe)));
  const hits = perWs.flat().sort((a, b) => b.score - a.score);
  const result: SearchResponse = { hits, mode, warnings };
  // 경고(폴백·실패)가 있는 응답은 일시적일 수 있으니 캐시하지 않는다
  if (warnings.length === 0) cacheSet(key, result);
  return result;
}
