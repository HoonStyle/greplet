/*
  activityLog.ts — 검색 활동(SearchRecord)을 로컬 일자별 JSONL 파일로 영속화한다(§계약: /tmp/greplet-live/contract.md).
  파일 경로: <dataDir>/logs/activity/search-YYYY-MM-DD.jsonl, 한 줄에 SearchRecord 하나(JSON).
  재시작 시 최근 기록을 복원해 activity.ts 의 searchHistory/누적 통계를 되살리고,
  /api/usage 에 쓸 일별 사용량 요약(readUsage)을 제공한다.
  GREPLET_ACTIVITY_LOG=off 이면 기록/조회 모두 no-op.
*/
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { onSearchRecord, type SearchRecord } from "./activity.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function activityDir(cfg: AppConfig): string {
  return path.join(cfg.logsDir, "activity");
}

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC 기준. 서버는 로컬 1대에서 동작하므로 단순화)
}

function fileForDate(cfg: AppConfig, dateKey: string): string {
  return path.join(activityDir(cfg), `search-${dateKey}.jsonl`);
}

function appendRecord(cfg: AppConfig, record: SearchRecord): void {
  const file = fileForDate(cfg, dateStr(new Date(record.ts)));
  fs.appendFile(file, `${JSON.stringify(record)}\n`, (err) => {
    if (err) console.error("[greplet] 활동 로그 기록 실패:", err.message);
  });
}

/** search-YYYY-MM-DD.jsonl 파일명에서 날짜 문자열을 뽑는다. 형식이 아니면 null. */
function parseFileDate(name: string): string | null {
  const m = /^search-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
  return m ? m[1] : null;
}

function pruneOldFiles(cfg: AppConfig): void {
  const dir = activityDir(cfg);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - cfg.activityRetentionDays * DAY_MS;
  for (const name of entries) {
    const dateKey = parseFileDate(name);
    if (!dateKey) continue;
    const t = Date.parse(`${dateKey}T00:00:00Z`);
    if (Number.isFinite(t) && t < cutoff) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch (err) {
        console.error("[greplet] 활동 로그 정리 실패:", name, (err as Error).message);
      }
    }
  }
}

let pruneTimer: NodeJS.Timeout | null = null;

/** 활동 로그 디렉터리를 만들고, 오래된 파일을 정리하고, 이후 완료되는 검색을 파일에 append 하도록 구독한다. */
export function initActivityLog(cfg: AppConfig): void {
  if (!cfg.activityLog) return;

  fs.mkdirSync(activityDir(cfg), { recursive: true });
  pruneOldFiles(cfg);

  if (pruneTimer) clearInterval(pruneTimer);
  pruneTimer = setInterval(() => pruneOldFiles(cfg), DAY_MS);
  pruneTimer.unref();

  onSearchRecord((record) => appendRecord(cfg, record));
}

function readLinesReversed(file: string): SearchRecord[] {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: SearchRecord[] = [];
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as SearchRecord);
    } catch {
      // 손상된 줄은 건너뛴다
    }
  }
  return out; // newest-first (파일 내에서)
}

/** 최신 파일부터 역순으로 읽어 limit 건을 채울 때까지 모으고, oldest -> newest 순으로 반환한다. */
export async function restoreRecent(cfg: AppConfig, limit = 200): Promise<SearchRecord[]> {
  if (!cfg.activityLog) return [];
  const dir = activityDir(cfg);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const dateKeys = entries
    .map(parseFileDate)
    .filter((d): d is string => d !== null)
    .sort()
    .reverse(); // newest first

  const collected: SearchRecord[] = []; // newest-first accumulation
  for (const dateKey of dateKeys) {
    if (collected.length >= limit) break;
    const perFile = readLinesReversed(fileForDate(cfg, dateKey)); // newest-first
    for (const record of perFile) {
      if (collected.length >= limit) break;
      collected.push(record);
    }
  }
  return collected.reverse(); // oldest -> newest
}

interface ClientUsage {
  searches: number;
  approxTokens: number;
}

interface DayUsage {
  date: string;
  searches: number;
  hits: number;
  approxTokens: number;
  avgMs: number;
  cached: number;
  errors: number;
  byClient: Record<string, ClientUsage>;
}

export interface UsageResult {
  days: DayUsage[];
  total: {
    searches: number;
    approxTokens: number;
    byClient: Record<string, ClientUsage>;
  };
  disabled?: boolean;
}

function emptyDay(dateKey: string): DayUsage {
  return { date: dateKey, searches: 0, hits: 0, approxTokens: 0, avgMs: 0, cached: 0, errors: 0, byClient: {} };
}

/** 오늘부터 days 일(오늘 포함)의 일별 사용량 요약을 만든다. days 는 1..366 로 clamp. */
export function readUsage(cfg: AppConfig, days = 7): UsageResult {
  if (!cfg.activityLog) {
    return { days: [], total: { searches: 0, approxTokens: 0, byClient: {} }, disabled: true };
  }
  const clamped = Math.min(366, Math.max(1, Math.round(days)));

  const dayKeys: string[] = [];
  const now = Date.now();
  for (let i = clamped - 1; i >= 0; i -= 1) {
    dayKeys.push(dateStr(new Date(now - i * DAY_MS)));
  }

  const dayResults: DayUsage[] = [];
  for (const dateKey of dayKeys) {
    const day = emptyDay(dateKey);
    const records = readLinesReversed(fileForDate(cfg, dateKey));
    let msSum = 0;
    for (const record of records) {
      try {
        day.searches += 1;
        day.hits += Number(record.hits) || 0;
        day.approxTokens += Number(record.approxTokens) || 0;
        msSum += Number(record.ms) || 0;
        if (record.cached) day.cached += 1;
        if (record.error) day.errors += 1;
        const clientEntry = day.byClient[record.client] ?? { searches: 0, approxTokens: 0 };
        clientEntry.searches += 1;
        clientEntry.approxTokens += Number(record.approxTokens) || 0;
        day.byClient[record.client] = clientEntry;
      } catch {
        // 개별 레코드 처리 실패는 건너뛴다
      }
    }
    day.avgMs = day.searches > 0 ? Math.round(msSum / day.searches) : 0;
    dayResults.push(day);
  }

  const total = { searches: 0, approxTokens: 0, byClient: {} as Record<string, ClientUsage> };
  for (const day of dayResults) {
    total.searches += day.searches;
    total.approxTokens += day.approxTokens;
    for (const [client, usage] of Object.entries(day.byClient)) {
      const entry = total.byClient[client] ?? { searches: 0, approxTokens: 0 };
      entry.searches += usage.searches;
      entry.approxTokens += usage.approxTokens;
      total.byClient[client] = entry;
    }
  }

  return { days: dayResults, total };
}
