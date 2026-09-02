/*
  indexJob.ts — 워크스페이스 인덱스 잡(전역 큐 1개, 로그 이벤트)(§5.2).

  절차: 스캔·해시 diff → 변경/삭제 파일 행 삭제 → Extractor 호출 → Ollama 임베딩 → table.add →
        매니페스트 갱신(성공 파일만) → FTS 인덱스 재생성 → optimize.
*/
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig, WorkspaceConfig } from "./config.js";
import { uploadsDirFor } from "./config.js";
import { enumerateWorkspaceFiles, diffAgainstManifest, loadManifest, saveManifest, relativeFileKey, type Manifest } from "./scan.js";
import { runExtractor, rowId } from "./extract.js";
import { embedAll, checkOllama } from "./embed.js";
import { openOrCreateTable, deleteByFiles, rebuildFtsIndex, manifestPathFor } from "./db.js";

export type JobState = "queued" | "running" | "done" | "failed";

export interface JobLogEvent {
  ts: string;
  level: "info" | "warn" | "error";
  msg: string;
}

export interface JobRecord {
  id: string;
  slug: string;
  state: JobState;
  startedAt?: string;
  endedAt?: string;
  added: number;
  changed: number;
  deleted: number;
  chunks: number;
  error?: string;
}

const LOG_RING_MAX = 2000;
const ADD_BATCH = 200;

type LogListener = (line: string) => void;

interface QueueItem {
  jobId: string;
  slug: string;
  force: boolean;
}

export class JobManager {
  private cfg: AppConfig;
  private getWorkspace: (slug: string) => WorkspaceConfig | undefined;
  private queue: QueueItem[] = [];
  private pendingBySlug = new Map<string, string>();
  private activeSlug: string | null = null;
  private processing = false;

  private jobs = new Map<string, JobRecord>();
  private jobOrder: string[] = [];
  private logs = new Map<string, JobLogEvent[]>();
  private listeners = new Map<string, Set<LogListener>>();
  private doneListeners = new Map<string, Set<() => void>>();

  constructor(cfg: AppConfig, getWorkspace: (slug: string) => WorkspaceConfig | undefined) {
    this.cfg = cfg;
    this.getWorkspace = getWorkspace;
  }

  getQueueSlugs(): string[] {
    return this.queue.map((q) => q.slug);
  }

  isIndexing(slug: string): boolean {
    return this.activeSlug === slug || this.pendingBySlug.has(slug);
  }

  getJob(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  getRecentJobs(limit = 20): JobRecord[] {
    return this.jobOrder
      .slice(-limit)
      .reverse()
      .map((id) => this.jobs.get(id)!)
      .filter(Boolean);
  }

  getLogEvents(jobId: string): JobLogEvent[] {
    return this.logs.get(jobId) ?? [];
  }

  subscribe(jobId: string, onLine: LogListener, onDone: () => void): () => void {
    if (!this.listeners.has(jobId)) this.listeners.set(jobId, new Set());
    if (!this.doneListeners.has(jobId)) this.doneListeners.set(jobId, new Set());
    this.listeners.get(jobId)!.add(onLine);
    this.doneListeners.get(jobId)!.add(onDone);
    return () => {
      this.listeners.get(jobId)?.delete(onLine);
      this.doneListeners.get(jobId)?.delete(onDone);
    };
  }

  /** slug 인덱스 잡을 큐에 등록한다. 이미 대기 중이면 그 잡을 재사용한다. */
  enqueue(slug: string, force: boolean): { jobId: string; queued: boolean } {
    const pendingId = this.pendingBySlug.get(slug);
    if (pendingId) {
      return { jobId: pendingId, queued: true };
    }

    const jobId = crypto.randomUUID();
    const rec: JobRecord = { id: jobId, slug, state: "queued", added: 0, changed: 0, deleted: 0, chunks: 0 };
    this.jobs.set(jobId, rec);
    this.logs.set(jobId, []);
    this.jobOrder.push(jobId);
    if (this.jobOrder.length > 200) this.jobOrder.shift(); // 메모리 상 넉넉히 보관, 조회는 최근 20개만

    const queuedBeforePush = this.activeSlug !== null || this.queue.length > 0;
    this.queue.push({ jobId, slug, force });
    this.pendingBySlug.set(slug, jobId);

    void this.pump();

    return { jobId, queued: queuedBeforePush };
  }

  private log(jobId: string, level: JobLogEvent["level"], msg: string): void {
    const ev: JobLogEvent = { ts: new Date().toISOString(), level, msg };
    const ring = this.logs.get(jobId);
    if (ring) {
      ring.push(ev);
      if (ring.length > LOG_RING_MAX) ring.shift();
    }
    const line = `[${ev.ts}] ${level.toUpperCase()} ${msg}`;
    for (const l of this.listeners.get(jobId) ?? []) l(line);

    try {
      const logPath = path.join(this.cfg.logsDir, `${this.jobs.get(jobId)?.slug}-${jobId}.log`);
      fs.mkdirSync(this.cfg.logsDir, { recursive: true });
      fs.appendFileSync(logPath, line + "\n", "utf8");
    } catch {
      // 로그 파일 기록 실패는 잡 자체를 막지 않는다
    }
  }

  private finish(jobId: string): void {
    for (const d of this.doneListeners.get(jobId) ?? []) d();
    this.listeners.delete(jobId);
    this.doneListeners.delete(jobId);
  }

  private async pump(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        this.pendingBySlug.delete(item.slug);
        this.activeSlug = item.slug;
        await this.runOne(item);
        this.activeSlug = null;
      }
    } finally {
      this.processing = false;
    }
  }

  private async runOne(item: QueueItem): Promise<void> {
    const rec = this.jobs.get(item.jobId)!;
    rec.state = "running";
    rec.startedAt = new Date().toISOString();

    try {
      await this.doIndex(item, rec);
      rec.state = "done";
    } catch (err) {
      rec.state = "failed";
      rec.error = err instanceof Error ? err.message : String(err);
      this.log(item.jobId, "error", `잡 실패: ${rec.error}`);
    } finally {
      rec.endedAt = new Date().toISOString();
      this.finish(item.jobId);
    }
  }

  private async doIndex(item: QueueItem, rec: JobRecord): Promise<void> {
    const jobId = item.jobId;
    const ws = this.getWorkspace(item.slug);
    if (!ws) throw new Error(`알 수 없는 워크스페이스: ${item.slug}`);

    this.log(jobId, "info", `[${ws.slug}] 인덱스 잡 시작 (force=${item.force})`);

    const uploadsDir = uploadsDirFor(this.cfg, ws.slug);
    fs.mkdirSync(uploadsDir, { recursive: true });
    const roots = [...ws.roots, uploadsDir];

    const manifestPath = manifestPathFor(this.cfg, ws.slug);
    const manifest: Manifest = loadManifest(manifestPath);

    this.log(jobId, "info", `[${ws.slug}] 파일 스캔 중...`);
    const files = enumerateWorkspaceFiles(ws, uploadsDir);
    const diff = diffAgainstManifest(files, roots, manifest, item.force);
    rec.added = diff.added.length;
    rec.changed = diff.changed.length;
    rec.deleted = diff.deleted.length;
    this.log(jobId, "info", `[${ws.slug}] 스캔 완료: added=${diff.added.length} changed=${diff.changed.length} deleted=${diff.deleted.length}`);

    const targetAbs = [...diff.added, ...diff.changed];
    const changedOrDeletedKeys = [
      ...diff.deleted,
      ...diff.changed.map((abs) => relativeFileKey(abs, roots)),
    ];

    const table = await openOrCreateTable(this.cfg, ws);

    if (changedOrDeletedKeys.length > 0) {
      this.log(jobId, "info", `[${ws.slug}] 기존 행 삭제 중 (${changedOrDeletedKeys.length}개 파일)...`);
      await deleteByFiles(table, changedOrDeletedKeys);
    }

    for (const key of diff.deleted) {
      delete manifest.files[key];
    }

    if (targetAbs.length === 0) {
      saveManifest(manifestPath, { ...manifest, lastRun: new Date().toISOString() });
      this.log(jobId, "info", `[${ws.slug}] 변경분 없음 — 삭제만 반영하고 종료`);
      return;
    }

    const ollamaStatus = await checkOllama(this.cfg);
    if (!ollamaStatus.ok || !ollamaStatus.hasModel) {
      throw new Error(
        `Ollama 준비 안 됨(${this.cfg.ollamaUrl}, model=${this.cfg.ollamaModel}) — ${ollamaStatus.error ?? "모델 미설치"}`,
      );
    }

    this.log(jobId, "info", `[${ws.slug}] Extractor 호출 중 (${targetAbs.length}개 파일)...`);
    const result = await runExtractor(this.cfg, ws, roots, targetAbs, (line) => this.log(jobId, "info", `  ${line}`));

    const failedAbs = new Set(
      result.stderr
        .split(/\r?\n/)
        .filter((l) => l.startsWith("[실패] "))
        .map((l) => l.slice("[실패] ".length).split(":")[0].trim()),
    );

    const chunksByFileKey = new Map<string, number>();
    for (const c of result.chunks) {
      chunksByFileKey.set(c.file, (chunksByFileKey.get(c.file) ?? 0) + 1);
    }

    this.log(jobId, "info", `[${ws.slug}] 청크 ${result.chunks.length}개 추출됨. 임베딩 시작...`);

    const texts = result.chunks.map((c) => c.text);
    const vectors = await embedAll(this.cfg, texts, (done, total) => {
      if (done % 320 === 0 || done === total) this.log(jobId, "info", `  임베딩 진행 ${done}/${total}`);
    });

    const now = new Date().toISOString();
    const rows = result.chunks.map((c, i) => ({
      id: rowId(c),
      file: c.file,
      abs: c.abs,
      root: c.root,
      symbol: c.symbol,
      kind: c.kind,
      file_hash: c.hash,
      indexed_at: now,
      start_line: c.startLine,
      end_line: c.endLine,
      text: c.text,
      vector: vectors[i],
    }));

    this.log(jobId, "info", `[${ws.slug}] LanceDB 반영 중 (${rows.length}행)...`);
    for (let i = 0; i < rows.length; i += ADD_BATCH) {
      await table.add(rows.slice(i, i + ADD_BATCH));
    }
    rec.chunks = rows.length;

    for (const abs of targetAbs) {
      const key = relativeFileKey(abs, roots);
      if (failedAbs.has(abs)) continue; // 추출 실패 — 매니페스트 기록 안 함(다음 실행에 재시도)
      manifest.files[key] = {
        hash: diff.hashOf.get(abs) ?? "",
        chunks: chunksByFileKey.get(key) ?? 0,
        indexedAt: now,
      };
    }
    manifest.lastRun = now;
    saveManifest(manifestPath, manifest);

    this.log(jobId, "info", `[${ws.slug}] FTS 인덱스 재생성 중...`);
    await rebuildFtsIndex(table);

    try {
      await table.optimize();
    } catch (err) {
      this.log(jobId, "warn", `optimize 스킵: ${err instanceof Error ? err.message : String(err)}`);
    }

    this.log(jobId, "info", `[${ws.slug}] 완료 — 청크 ${rows.length}개 반영`);
  }
}
