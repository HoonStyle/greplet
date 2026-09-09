import fs, { type FSWatcher } from "node:fs";
import path from "node:path";
import type { AppConfig, WorkspaceConfig } from "./config.js";
import { uploadsDirFor } from "./config.js";
import { tableNameFor } from "./db.js";
import { enumerateWorkspaceFiles, findRelativeKeyCollision } from "./scan.js";

const CACHE_TTL_MS = 30_000;

interface ValidationEntry {
  signature: string;
  issue?: string;
  checkedAt: number;
  dirty: boolean;
  reliable: boolean;
  watchers: FSWatcher[];
}

export interface SourceValidationStats {
  fullScans: number;
  cacheHits: number;
  invalidations: number;
  unreliableScans: number;
}

const cache = new Map<string, ValidationEntry>();
const stats: SourceValidationStats = { fullScans: 0, cacheHits: 0, invalidations: 0, unreliableScans: 0 };

function signature(cfg: AppConfig, ws: WorkspaceConfig): string {
  return JSON.stringify({
    roots: [...ws.roots, uploadsDirFor(cfg, ws.slug)].map(root => path.resolve(root)),
    includeExt: ws.includeExt,
    excludeDirs: ws.excludeDirs,
    excludeFiles: ws.excludeFiles,
  });
}

function closeEntry(entry: ValidationEntry | undefined): void {
  for (const watcher of entry?.watchers ?? []) watcher.close();
}

function scanForCollision(cfg: AppConfig, ws: WorkspaceConfig): string | undefined {
  stats.fullScans++;
  const uploads = uploadsDirFor(cfg, ws.slug);
  const roots = [...ws.roots, uploads];
  const collision = findRelativeKeyCollision(enumerateWorkspaceFiles(ws, uploads), roots);
  return collision
    ? `여러 루트의 상대경로가 충돌합니다: ${collision}. 워크스페이스 분리 후 재인덱싱하세요.`
    : undefined;
}

function createWatchedEntry(cfg: AppConfig, ws: WorkspaceConfig, sig: string): ValidationEntry {
  const roots = [...ws.roots, uploadsDirFor(cfg, ws.slug)].map(root => path.resolve(root));
  const entry: ValidationEntry = { signature: sig, checkedAt: 0, dirty: false, reliable: true, watchers: [] };
  cache.set(ws.slug, entry);
  // 존재하지 않는 root의 생성은 관측할 수 없으므로 이 환경에서는 캐시를 신뢰하지 않는다.
  if (!roots.every(root => fs.existsSync(root))) entry.reliable = false;
  if (entry.reliable) {
    try {
      for (const root of roots) {
        const watcher = fs.watch(root, { recursive: true, persistent: false }, () => {
          if (cache.get(ws.slug) !== entry) return;
          if (!entry.dirty) stats.invalidations++;
          entry.dirty = true;
        });
        watcher.on("error", () => {
          if (cache.get(ws.slug) !== entry) return;
          entry.reliable = false;
          entry.dirty = true;
          for (const current of entry.watchers) current.close();
          entry.watchers = [];
        });
        entry.watchers.push(watcher);
      }
    } catch {
      entry.reliable = false;
      closeEntry(entry);
      entry.watchers = [];
    }
  }
  return entry;
}

/**
 * 상대키 충돌을 전역 차단한다. 신뢰 가능한 recursive watcher가 있을 때만 짧게 캐시하고,
 * 감시 불가·오류·TTL 만료·설정 변경에서는 전체 열거로 돌아간다.
 */
export async function sourceIssue(cfg: AppConfig, ws: WorkspaceConfig, all: WorkspaceConfig[]): Promise<string | undefined> {
  if (all.filter(candidate => tableNameFor(candidate.slug) === tableNameFor(ws.slug)).length !== 1) {
    return "워크스페이스 저장 이름이 충돌합니다. 출처 이름을 분리하고 재인덱싱하세요.";
  }

  // 직전 동기식 파일 변경의 watcher 이벤트가 전달될 기회를 준 뒤 캐시 신선도를 판단한다.
  await new Promise<void>(resolve => setImmediate(resolve));
  const sig = signature(cfg, ws);
  let entry = cache.get(ws.slug);
  if (entry && entry.signature !== sig) {
    closeEntry(entry);
    cache.delete(ws.slug);
    entry = undefined;
  }
  if (entry?.reliable && !entry.dirty && Date.now() - entry.checkedAt < CACHE_TTL_MS) {
    stats.cacheHits++;
    return entry.issue;
  }

  if (!entry || !entry.reliable) {
    closeEntry(entry);
    entry = createWatchedEntry(cfg, ws, sig);
  }
  if (!entry.reliable) {
    stats.unreliableScans++;
    entry.issue = scanForCollision(cfg, ws);
    entry.checkedAt = Date.now();
    return entry.issue;
  }

  entry.dirty = false;
  entry.issue = scanForCollision(cfg, ws);
  entry.checkedAt = Date.now();
  await new Promise<void>(resolve => setImmediate(resolve));
  // 스캔 도중 변경이 관측됐으면 한 번 더 전체 스캔한다. 계속 변하면 캐시하지 않는다.
  if (entry.dirty) {
    entry.dirty = false;
    entry.issue = scanForCollision(cfg, ws);
    entry.checkedAt = Date.now();
    await new Promise<void>(resolve => setImmediate(resolve));
    if (entry.dirty) entry.reliable = false;
  }
  return entry.issue;
}

export function invalidateSourceValidation(slug: string): void {
  const entry = cache.get(slug);
  if (entry && !entry.dirty) stats.invalidations++;
  if (entry) entry.dirty = true;
}

export function getSourceValidationStats(): SourceValidationStats {
  return { ...stats };
}

export function clearSourceValidationCache(): void {
  for (const entry of cache.values()) closeEntry(entry);
  cache.clear();
  stats.fullScans = 0;
  stats.cacheHits = 0;
  stats.invalidations = 0;
  stats.unreliableScans = 0;
}
