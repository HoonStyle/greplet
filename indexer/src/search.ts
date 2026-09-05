/*
  search.ts — hybrid/vector/fts 검색(§5.3). LanceDB API 형태는 §5.4 프로브로 검증된 것을 그대로 쓴다.
*/
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { rerankers } from "@lancedb/lancedb";
import type { AppConfig, WorkspaceConfig } from "./config.js";
import { openOrCreateTable, tableExists, manifestPathFor } from "./db.js";
import { embedQuery } from "./embed.js";
import { loadManifest } from "./scan.js";
import { emitActivity, type ClientId } from "./activity.js";
import { approxResponseTokens } from "./tokens.js";

export type SearchMode = "hybrid" | "vector" | "fts";

export interface SearchHit {
  id: string;
  workspace: string;
  file: string;
  abs: string;
  symbol: string;
  kind: string;
  startLine: number;
  endLine: number;
  score: number;
  text: string;
  root: string;
  fileHash: string;
  indexedAt: string;
}

export interface WorkspaceSearchOutcome {
  workspace: string;
  effectiveMode: SearchMode;
  failed: boolean;
}

export interface SearchResponse {
  hits: SearchHit[];
  mode: SearchMode;
  warnings: string[];
  cached?: boolean;
  workspaceResults: WorkspaceSearchOutcome[];
}

export interface SearchOptions {
  // 결과를 파일 상대경로 글롭으로 거른다. `*` 는 세그먼트 안, `**` 는 깊이 무관. 예: "Lib/**" + "/*.cs"
  fileGlob?: string;
  // 활동 이벤트 태깅용 클라이언트 식별자. 캐시 키에는 포함하지 않는다.
  client?: ClientId;
  // 활동 이벤트 태깅용 호출 세션 식별자. 캐시 키에는 포함하지 않는다.
  session?: string;
  // 응답 근사 토큰 수 계산용 스니펫 길이(문자). undefined=전문. 캐시 키에는 포함하지 않는다.
  snippetChars?: number;
  bypassCache?: boolean;
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

const SELECT_COLS = ["id", "file", "abs", "root", "file_hash", "indexed_at", "symbol", "kind", "start_line", "end_line", "text"];

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
  searchId: string,
  outcome: WorkspaceSearchOutcome,
): Promise<SearchHit[]> {
  const finish = (hits: SearchHit[], actualMode: SearchMode): SearchHit[] => {
    outcome.effectiveMode = actualMode;
    return hits;
  };
  const stage = (
    s: "cache" | "embed" | "vector" | "fts" | "rerank" | "glob" | "sort",
    status: "enter" | "fallback" | "skip",
    note?: string,
  ) => emitActivity({ type: "search.stage", id: searchId, workspace: ws.slug, stage: s, status, ...(note !== undefined ? { note } : {}) });

  const exists = await tableExists(cfg, ws);
  if (!exists) return [];

  const table = await openOrCreateTable(cfg, ws);
  let effectiveMode = mode;
  // 글롭 필터는 검색 후 적용하므로 후보를 더 뽑는다
  const limit = fileRe ? topN * GLOB_POOL_FACTOR : topN;
  const applyGlob = (hits: SearchHit[]) => {
    if (!fileRe) return hits;
    stage("glob", "enter");
    return hits.filter((h) => fileRe.test(h.file)).slice(0, topN);
  };

  // 임베딩 없는(구버전 매니페스트는 있음으로 간주) 워크스페이스는 hybrid/vector 를 fts 로 강등한다.
  // 영벡터에 cosine 을 적용하면 NaN 이 나오므로 이 강등이 유일한 보호막이다.
  if (effectiveMode !== "fts") {
    const manifest = loadManifest(manifestPathFor(cfg, ws.slug));
    if (manifest.embeddings === "none") {
      warnings.push(`[${ws.slug}] 임베딩 없음 → fts 로 강등`);
      stage("embed", "skip");
      effectiveMode = "fts";
    }
  }

  try {
    if (effectiveMode === "fts") {
      stage("fts", "enter");
      const rows = await table.query().fullTextSearch(query).select(SELECT_COLS).limit(limit).toArray();
      return finish(applyGlob(rows.map((r: any) => toHit(ws.slug, r, Number(r._score ?? 0)))), "fts");
    }

    let qvec: number[];
    try {
      stage("embed", "enter");
      qvec = await embedQuery(cfg, query);
    } catch (embedErr) {
      // 질의 임베딩 실패(Ollama 미가동 등) 시 fts 로 폴백해 결과가 비지 않게 한다.
      const msg = errMsg(embedErr);
      warnings.push(`[${ws.slug}] 질의 임베딩 실패 → fts 로 폴백: ${msg}`);
      stage("embed", "fallback", msg.slice(0, 80));
      stage("fts", "enter");
      const rows = await table.query().fullTextSearch(query).select(SELECT_COLS).limit(limit).toArray();
      return finish(applyGlob(rows.map((r: any) => toHit(ws.slug, r, Number(r._score ?? 0)))), "fts");
    }
    let q = table.query().nearestTo(qvec).distanceType("cosine");

    if (effectiveMode === "hybrid") {
      try {
        // limit 은 벡터·FTS 하위 질의 각각에 걸린다. topN 만 주면 두 목록이 거의 겹치지 않아 RRF 점수가
        // 전부 1/(60+rank) 동점이 되고 순위가 사실상 무작위가 된다 → 후보를 넉넉히 뽑아 융합한 뒤 topN 만 남긴다.
        stage("vector", "enter");
        stage("fts", "enter");
        stage("rerank", "enter");
        const rr = await rerankers.RRFReranker.create();
        const poolSize = Math.max(limit * 10, HYBRID_MIN_POOL);
        const rows = await q.fullTextSearch(query).rerank(rr).select(SELECT_COLS).limit(poolSize).toArray();
        return finish(applyGlob(rows.slice(0, limit).map((r: any) => toHit(ws.slug, r, Number(r._relevance_score ?? 0)))), "hybrid");
      } catch (ftsErr) {
        // FTS 구문 오류 등 → vector 로 폴백(§5.3)
        const msg = errMsg(ftsErr);
        warnings.push(`[${ws.slug}] hybrid 검색 실패 → vector 로 폴백: ${msg}`);
        stage("rerank", "fallback", msg.slice(0, 80));
        effectiveMode = "vector";
      }
    }

    try {
      if (effectiveMode === "vector") stage("vector", "enter");
      const rows = await table.query().nearestTo(qvec).distanceType("cosine").select(SELECT_COLS).limit(limit).toArray();
      return finish(applyGlob(rows.map((r: any) => toHit(ws.slug, r, 1 - Number(r._distance ?? 0)))), "vector");
    } catch (vecErr) {
      // Ollama 가 잡 중간에 죽는 등 vector 경로 실패 시 fts 로 폴백해 결과가 비지 않게 한다.
      const msg = errMsg(vecErr);
      warnings.push(`[${ws.slug}] vector 검색 실패 → fts 로 폴백: ${msg}`);
      stage("vector", "fallback", msg.slice(0, 80));
      stage("fts", "enter");
      const rows = await table.query().fullTextSearch(query).select(SELECT_COLS).limit(limit).toArray();
      return finish(applyGlob(rows.map((r: any) => toHit(ws.slug, r, Number(r._score ?? 0)))), "fts");
    }
  } catch (err) {
    outcome.failed = true;
    outcome.effectiveMode = effectiveMode;
    warnings.push(`[${ws.slug}] 검색 실패(mode=${effectiveMode}): ${errMsg(err)}`);
    return [];
  }
}

function toHit(workspace: string, row: any, score: number): SearchHit {
  return {
    id: row.id,
    workspace,
    file: row.file,
    abs: row.abs ?? "",
    symbol: row.symbol,
    kind: row.kind,
    startLine: row.start_line,
    endLine: row.end_line,
    score,
    text: row.text,
    root: row.root,
    fileHash: row.file_hash,
    indexedAt: row.indexed_at,
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
  const id = randomUUID();
  const t0 = performance.now();
  const client: ClientId = opts.client ?? "unknown";
  const session = opts.session;

  emitActivity({
    type: "search.start",
    id,
    client,
    query,
    workspaces: workspaces.map((ws) => ws.slug),
    mode,
    topN,
    ...(opts.fileGlob !== undefined ? { fileGlob: opts.fileGlob } : {}),
    ...(session !== undefined ? { session } : {}),
  });

  try {
    const key = cacheKey(cfg, workspaces, query, topN, mode, opts);
    const cached = opts.bypassCache ? undefined : cacheGet(key);
    if (cached) {
      emitActivity({ type: "search.stage", id, workspace: "*", stage: "cache", status: "enter" });
      emitActivity({
        type: "search.done",
        id,
        client,
        hits: cached.hits.length,
        ms: Math.round(performance.now() - t0),
        cached: true,
        mode: cached.mode,
        warnings: cached.warnings.length,
        approxTokens: approxResponseTokens(cached.hits, opts.snippetChars),
        ...(session !== undefined ? { session } : {}),
      });
      return { ...cached, cached: true };
    }
    emitActivity({ type: "search.stage", id, workspace: "*", stage: "cache", status: "skip" });

    const fileRe = opts.fileGlob ? fileGlobToRegex(opts.fileGlob) : null;
    const warnings: string[] = [];
    const workspaceResults = workspaces.map((ws): WorkspaceSearchOutcome => ({ workspace: ws.slug, effectiveMode: mode, failed: false }));
    const perWs = await Promise.all(
      workspaces.map((ws, i) => searchOneWorkspace(cfg, ws, query, topN, mode, warnings, fileRe, id, workspaceResults[i])),
    );
    emitActivity({ type: "search.stage", id, workspace: "*", stage: "sort", status: "enter" });
    const hits = perWs.flat().sort((a, b) => b.score - a.score);
    const result: SearchResponse = { hits, mode, warnings, workspaceResults };
    // 경고(폴백·실패)가 있는 응답은 일시적일 수 있으니 캐시하지 않는다
    if (!opts.bypassCache && warnings.length === 0) cacheSet(key, result);

    emitActivity({
      type: "search.done",
      id,
      client,
      hits: hits.length,
      ms: Math.round(performance.now() - t0),
      cached: false,
      mode,
      warnings: warnings.length,
      approxTokens: approxResponseTokens(hits, opts.snippetChars),
      ...(session !== undefined ? { session } : {}),
    });
    return result;
  } catch (err) {
    emitActivity({
      type: "search.done",
      id,
      client,
      hits: 0,
      ms: Math.round(performance.now() - t0),
      cached: false,
      mode,
      warnings: 0,
      approxTokens: 0,
      error: errMsg(err),
      ...(session !== undefined ? { session } : {}),
    });
    throw err;
  }
}
