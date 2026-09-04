/*
  activity.ts — 검색/인덱싱 활동 이벤트 버스(§계약: /tmp/greplet-live/contract.md).
  EventEmitter 싱글턴 + 이벤트 ring(500) + 검색 이력 ring(200) + 누적 통계.
*/
import { EventEmitter } from "node:events";

export type ClientId = string; // "mcp:claude" | "mcp:codex" | "mcpb" | "cli" | "ui" | "unknown"
export type SearchStage = "cache" | "embed" | "vector" | "fts" | "rerank" | "glob" | "sort";
export type IndexStage = "check" | "scan" | "delete" | "extract" | "embed" | "store" | "manifest" | "fts" | "optimize";
export type SearchMode = "hybrid" | "vector" | "fts";

interface Base {
  seq: number;
  ts: string;
}

export interface SearchStartEvent extends Base {
  type: "search.start";
  id: string;
  client: ClientId;
  query: string;
  workspaces: string[];
  mode: SearchMode;
  topN: number;
  fileGlob?: string;
  session?: string;
}

export interface SearchStageEvent extends Base {
  type: "search.stage";
  id: string;
  workspace: string;
  stage: SearchStage;
  status: "enter" | "fallback" | "skip";
  note?: string;
}

export interface SearchDoneEvent extends Base {
  type: "search.done";
  id: string;
  client: ClientId;
  hits: number;
  ms: number;
  cached: boolean;
  mode: SearchMode;
  warnings: number;
  approxTokens: number;
  error?: string;
  session?: string;
}

export interface IndexStartEvent extends Base {
  type: "index.start";
  jobId: string;
  slug: string;
  force: boolean;
}

export interface IndexStageEvent extends Base {
  type: "index.stage";
  jobId: string;
  slug: string;
  stage: IndexStage;
}

export interface IndexProgressEvent extends Base {
  type: "index.progress";
  jobId: string;
  slug: string;
  stage: "embed" | "store";
  done: number;
  total: number;
}

export interface IndexDoneEvent extends Base {
  type: "index.done";
  jobId: string;
  slug: string;
  ms: number;
  added: number;
  changed: number;
  deleted: number;
  chunks: number;
}

export interface IndexFailedEvent extends Base {
  type: "index.failed";
  jobId: string;
  slug: string;
  ms: number;
  error: string;
}

export type ActivityEvent =
  | SearchStartEvent
  | SearchStageEvent
  | SearchDoneEvent
  | IndexStartEvent
  | IndexStageEvent
  | IndexProgressEvent
  | IndexDoneEvent
  | IndexFailedEvent;

export interface SearchRecord {
  id: string;
  ts: string;
  client: ClientId;
  query: string;
  workspaces: string[];
  mode: SearchMode;
  hits: number;
  ms: number;
  cached: boolean;
  warnings: number;
  approxTokens: number;
  error?: string;
  session?: string;
}

export interface ActivityStats {
  total: number;
  avgMs: number;
  p95Ms: number;
  cacheHitRate: number;
  qps1m: number;
  active: number;
  byClient: Record<string, { count: number; approxTokens: number }>;
  errors: number;
  approxTokensTotal: number;
}

/** 유니온의 각 멤버에서 키를 개별 제거하는 분배형 Omit. */
export type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

const EVENT_RING_MAX = 500;
const SEARCH_HISTORY_MAX = 200;
const QUERY_MAX_LEN = 120;

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

let seqCounter = 0;
const eventRing: ActivityEvent[] = [];
const searchHistory: SearchRecord[] = [];
const activeSearches = new Map<string, { startedAt: number; client: ClientId; query: string; workspaces: string[]; session?: string }>();

// 누적 통계
let totalCompleted = 0;
let cachedCompleted = 0;
let totalErrors = 0;
let approxTokensTotal = 0;
const byClientCounts: Record<string, { count: number; approxTokens: number }> = {};
// 최근 200건(검색 이력 ring 과 동일 범위) 의 ms 로 avg/p95 산출
// 완료 타임스탬프(ms epoch) — qps1m 계산용, 최근 60초 넘는 건 정리
const completionTimestamps: number[] = [];

function truncateQuery(q: string): string {
  if (process.env.GREPLET_ACTIVITY_QUERY === "hidden") return "(hidden)";
  return q.length > QUERY_MAX_LEN ? q.slice(0, QUERY_MAX_LEN) : q;
}

export function emitActivity(ev: DistributiveOmit<ActivityEvent, "seq" | "ts">): ActivityEvent {
  seqCounter += 1;
  const full = { ...ev, seq: seqCounter, ts: new Date().toISOString() } as ActivityEvent;

  if (full.type === "search.start") {
    (full as SearchStartEvent).query = truncateQuery((full as SearchStartEvent).query);
  }

  eventRing.push(full);
  if (eventRing.length > EVENT_RING_MAX) eventRing.shift();

  if (full.type === "search.start") {
    const e = full as SearchStartEvent;
    activeSearches.set(e.id, { startedAt: Date.now(), client: e.client, query: e.query, workspaces: e.workspaces, session: e.session });
  } else if (full.type === "search.done") {
    const e = full as SearchDoneEvent;
    const active = activeSearches.get(e.id);
    activeSearches.delete(e.id);

    const record: SearchRecord = {
      id: e.id,
      ts: e.ts,
      client: e.client,
      query: active?.query ?? "",
      workspaces: active?.workspaces ?? [],
      mode: e.mode,
      hits: e.hits,
      ms: e.ms,
      cached: e.cached,
      warnings: e.warnings,
      approxTokens: e.approxTokens,
      ...(e.error !== undefined ? { error: e.error } : {}),
      ...((e.session ?? active?.session) !== undefined ? { session: e.session ?? active?.session } : {}),
    };

    searchHistory.push(record);
    if (searchHistory.length > SEARCH_HISTORY_MAX) searchHistory.shift();

    totalCompleted += 1;
    if (e.cached) cachedCompleted += 1;
    if (e.error) totalErrors += 1;
    approxTokensTotal += e.approxTokens;
    const clientEntry = byClientCounts[e.client] ?? { count: 0, approxTokens: 0 };
    clientEntry.count += 1;
    clientEntry.approxTokens += e.approxTokens;
    byClientCounts[e.client] = clientEntry;
    completionTimestamps.push(Date.now());
  }

  try {
    emitter.emit("event", full);
  } catch {
    // 리스너 예외는 발행자에게 전파하지 않는다
  }

  return full;
}

export function subscribeActivity(fn: (ev: ActivityEvent) => void): () => void {
  const wrapped = (ev: ActivityEvent) => {
    try {
      fn(ev);
    } catch {
      // 리스너 예외를 삼킨다
    }
  };
  emitter.on("event", wrapped);
  return () => emitter.off("event", wrapped);
}

export function getRecentEvents(afterSeq = 0): ActivityEvent[] {
  return eventRing.filter((e) => e.seq > afterSeq);
}

export function getRecentSearches(limit = 50): SearchRecord[] {
  return searchHistory.slice(-limit).reverse();
}

export function getStats(): ActivityStats {
  const now = Date.now();
  while (completionTimestamps.length > 0 && now - completionTimestamps[0] > 60_000) {
    completionTimestamps.shift();
  }

  const recentForLatency = searchHistory.slice(-SEARCH_HISTORY_MAX);
  const msList = recentForLatency.map((r) => r.ms).sort((a, b) => a - b);
  const avgMs = msList.length > 0 ? msList.reduce((a, b) => a + b, 0) / msList.length : 0;
  const p95Ms = msList.length > 0 ? msList[Math.min(msList.length - 1, Math.ceil(msList.length * 0.95) - 1)] : 0;

  return {
    total: totalCompleted,
    avgMs: Math.round(avgMs),
    p95Ms: Math.round(p95Ms),
    cacheHitRate: totalCompleted > 0 ? cachedCompleted / totalCompleted : 0,
    qps1m: completionTimestamps.length / 60,
    active: activeSearches.size,
    byClient: { ...byClientCounts },
    errors: totalErrors,
    approxTokensTotal,
  };
}

export function listenerCount(): number {
  return emitter.listenerCount("event");
}
