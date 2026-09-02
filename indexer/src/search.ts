/*
  search.ts — hybrid/vector/fts 검색(§5.3). LanceDB API 형태는 §5.4 프로브로 검증된 것을 그대로 쓴다.
*/
import { rerankers } from "@lancedb/lancedb";
import type { AppConfig, WorkspaceConfig } from "./config.js";
import { openOrCreateTable, tableExists } from "./db.js";
import { embedQuery } from "./embed.js";

export type SearchMode = "hybrid" | "vector" | "fts";

export interface SearchHit {
  workspace: string;
  file: string;
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
}

/** 하이브리드 융합 전 하위 질의(벡터·FTS)별 최소 후보 수 */
const HYBRID_MIN_POOL = 50;

const SELECT_COLS = ["file", "symbol", "kind", "start_line", "end_line", "text"];

async function searchOneWorkspace(
  cfg: AppConfig,
  ws: WorkspaceConfig,
  query: string,
  topN: number,
  mode: SearchMode,
  warnings: string[],
): Promise<SearchHit[]> {
  const exists = await tableExists(cfg, ws);
  if (!exists) return [];

  const table = await openOrCreateTable(cfg, ws);
  let effectiveMode = mode;

  try {
    if (mode === "fts") {
      const rows = await table.query().fullTextSearch(query).select(SELECT_COLS).limit(topN).toArray();
      return rows.map((r: any) => toHit(ws.slug, r, Number(r._score ?? 0)));
    }

    const qvec = await embedQuery(cfg, query);
    let q = table.query().nearestTo(qvec).distanceType("cosine");

    if (mode === "hybrid") {
      try {
        // limit 은 벡터·FTS 하위 질의 각각에 걸린다. topN 만 주면 두 목록이 거의 겹치지 않아 RRF 점수가
        // 전부 1/(60+rank) 동점이 되고 순위가 사실상 무작위가 된다 → 후보를 넉넉히 뽑아 융합한 뒤 topN 만 남긴다.
        const rr = await rerankers.RRFReranker.create();
        const poolSize = Math.max(topN * 10, HYBRID_MIN_POOL);
        const rows = await q.fullTextSearch(query).rerank(rr).select(SELECT_COLS).limit(poolSize).toArray();
        return rows.slice(0, topN).map((r: any) => toHit(ws.slug, r, Number(r._relevance_score ?? 0)));
      } catch (ftsErr) {
        // FTS 구문 오류 등 → vector 로 폴백(§5.3)
        warnings.push(`[${ws.slug}] hybrid 검색 실패 → vector 로 폴백: ${errMsg(ftsErr)}`);
        effectiveMode = "vector";
      }
    }

    const rows = await table.query().nearestTo(qvec).distanceType("cosine").select(SELECT_COLS).limit(topN).toArray();
    return rows.map((r: any) => toHit(ws.slug, r, 1 - Number(r._distance ?? 0)));
  } catch (err) {
    warnings.push(`[${ws.slug}] 검색 실패(mode=${effectiveMode}): ${errMsg(err)}`);
    return [];
  }
}

function toHit(workspace: string, row: any, score: number): SearchHit {
  return {
    workspace,
    file: row.file,
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
): Promise<SearchResponse> {
  const warnings: string[] = [];
  const perWs = await Promise.all(workspaces.map((ws) => searchOneWorkspace(cfg, ws, query, topN, mode, warnings)));
  const hits = perWs.flat().sort((a, b) => b.score - a.score);
  return { hits, mode, warnings };
}
