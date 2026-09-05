/** Version-bound retrieval. A verified hash is not a semantic correctness verdict. */
import fs from "node:fs";
import path from "node:path";
import type { Express, Request } from "express";
import type { AppConfig, WorkspaceConfig } from "./config.js";
import { uploadsDirFor } from "./config.js";
import { manifestPathFor, openOrCreateTable, tableExists, tableNameFor } from "./db.js";
import { enumerateWorkspaceFiles, loadManifest, relativeFileKey, sha256File } from "./scan.js";
import { sha256Text } from "./extract.js";
import { search, type SearchHit, type SearchMode, type SearchOptions } from "./search.js";

export interface EvidenceRef {
  workspace: string;
  chunkId: string;
  fileHash: string;
  startLine: number;
  endLine: number;
  contentHash: string;
}

export class EvidenceError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

function invalid(message: string): never { throw new EvidenceError(400, "invalid_request", message); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("JSON 객체가 필요합니다");
  return value as Record<string, unknown>;
}
function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) invalid(`${name}은 비어 있지 않은 문자열이어야 합니다`);
  return value;
}
function positiveInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid(`${name}은 양의 정수여야 합니다`);
  return value;
}
function hash(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid(`${name}은 SHA-256이어야 합니다`);
  return value;
}

export function parseEvidenceRef(value: unknown): EvidenceRef {
  const r = object(value);
  const ref = {
    workspace: requiredString(r.workspace, "workspace"), chunkId: requiredString(r.chunkId, "chunkId"),
    fileHash: hash(r.fileHash, "fileHash"), contentHash: hash(r.contentHash, "contentHash"),
    startLine: positiveInt(r.startLine, "startLine"), endLine: positiveInt(r.endLine, "endLine"),
  };
  if (ref.endLine < ref.startLine) invalid("endLine은 startLine보다 작을 수 없습니다");
  return ref;
}

function parseSearch(value: unknown, workspaces: WorkspaceConfig[]) {
  const p = object(value);
  const query = requiredString(p.query, "query");
  const topN = p.topN === undefined ? 3 : positiveInt(p.topN, "topN");
  if (topN > 20) invalid("topN은 최대 20입니다");
  const mode = p.mode === undefined ? "hybrid" : p.mode;
  if (mode !== "hybrid" && mode !== "fts" && mode !== "vector") invalid("mode는 hybrid, vector, fts 중 하나입니다");
  const fileGlob = p.fileGlob === undefined ? undefined : requiredString(p.fileGlob, "fileGlob");
  let slugs: string[];
  if (p.workspaces === "all") slugs = workspaces.map(w => w.slug);
  else if (Array.isArray(p.workspaces) && p.workspaces.length) slugs = p.workspaces.map(w => requiredString(w, "workspace"));
  else invalid("workspaces는 비어 있지 않은 슬러그 배열 또는 'all'이어야 합니다");
  const targets = [...new Set(slugs)].map(slug => {
    const ws = workspaces.find(w => w.slug === slug);
    if (!ws) invalid(`미등록 워크스페이스: ${slug}`);
    return ws;
  });
  return { query, topN, mode: mode as SearchMode, fileGlob, targets };
}

function location(h: Pick<SearchHit, "kind" | "startLine" | "endLine">) {
  return { unit: h.kind === "page" ? "page" as const : "line" as const, start: h.startLine, end: h.endLine };
}

/** Match-centred excerpt; location deliberately describes the entire source chunk. */
export function excerpt(text: string, query: string) {
  const lines = text.split("\n");
  if (lines[0]?.startsWith("// ")) {
    lines.shift(); // generated file header
    if (lines[0]?.startsWith("// page ")) lines.shift();
    else if (lines[0]?.startsWith("// namespace ")) {
      lines.shift();
      if (/^\/\/ (class|struct|interface|record|enum) /.test(lines[0] ?? "")) lines.shift();
    }
  }
  const body = lines.join("\n");
  const lower = body.toLowerCase();
  const terms = [query, ...query.split(/\s+/).sort((a, b) => b.length - a.length)].filter(Boolean);
  let match = -1;
  for (const term of terms) { match = lower.indexOf(term.toLowerCase()); if (match >= 0) break; }
  const start = Math.max(0, match - 100);
  return { text: body.slice(start, start + 300), truncated: start > 0 || body.length > start + 300, locationScope: "chunk" as const };
}

function hitMetadata(h: SearchHit) {
  const contentHash = sha256Text(h.text);
  const evidenceRef: EvidenceRef = {
    workspace: h.workspace, chunkId: h.id, fileHash: h.fileHash,
    startLine: h.startLine, endLine: h.endLine, contentHash,
  };
  return { workspace: h.workspace, file: h.file, symbol: h.symbol, kind: h.kind,
    location: location(h), fileHash: h.fileHash, contentHash, indexedAt: h.indexedAt, evidenceRef };
}

/** Detect relative-key collisions before trusting an index that cannot distinguish roots. */
function sourceIssue(cfg: AppConfig, ws: WorkspaceConfig, all: WorkspaceConfig[]): string | undefined {
  if (all.filter(w => tableNameFor(w.slug) === tableNameFor(ws.slug)).length !== 1) {
    return "워크스페이스 저장 이름이 충돌합니다. 출처 이름을 분리하고 재인덱싱하세요.";
  }
  const uploads = uploadsDirFor(cfg, ws.slug);
  const roots = [...ws.roots, uploads];
  if (roots.filter(r => fs.existsSync(r)).length < 2) return undefined;
  const seen = new Map<string, string>();
  for (const abs of enumerateWorkspaceFiles(ws, uploads)) {
    const file = relativeFileKey(abs, roots);
    const previous = seen.get(file);
    if (previous && path.resolve(previous) !== path.resolve(abs)) {
      return `여러 루트의 상대경로가 충돌합니다: ${file}. 워크스페이스 분리 후 재인덱싱하세요.`;
    }
    seen.set(file, abs);
  }
  return undefined;
}

type TargetStatus = "ok" | "no_hits" | "not_indexed" | "indexing" | "search_error" | "ambiguous_source";
type EvidenceHit = ReturnType<typeof hitMetadata> & { freshness: "unchecked"; excerpt: ReturnType<typeof excerpt> };
interface EvidenceTarget {
  workspace: string; label: string; status: TargetStatus; effectiveMode: SearchMode | null;
  warnings: string[]; hits: EvidenceHit[];
}
type IsIndexing = (slug: string) => boolean;

export async function searchEvidence(cfg: AppConfig, workspaces: WorkspaceConfig[], body: unknown,
  isIndexing: IsIndexing = () => false, options: SearchOptions = {}) {
  const p = parseSearch(body, workspaces);
  const targets = await Promise.all(p.targets.map(async ws => {
    const target: EvidenceTarget = { workspace: ws.slug, label: ws.label, status: "no_hits", effectiveMode: null, warnings: [], hits: [] };
    try {
      const issue = sourceIssue(cfg, ws, workspaces);
      if (issue) return { ...target, status: "ambiguous_source" as const, warnings: [issue] };
      if (isIndexing(ws.slug)) return { ...target, status: "indexing" as const };
      if (!loadManifest(manifestPathFor(cfg, ws.slug)).lastRun || !await tableExists(cfg, ws)) {
        return { ...target, status: "not_indexed" as const };
      }
      const result = await search(cfg, [ws], p.query, p.topN, p.mode, { ...options, fileGlob: p.fileGlob, snippetChars: 300, bypassCache: true });
      if (isIndexing(ws.slug)) return { ...target, status: "indexing" as const };
      const outcome = result.workspaceResults[0];
      target.effectiveMode = outcome.effectiveMode;
      target.warnings = result.warnings;
      if (outcome.failed) { target.status = "search_error"; return target; }
      target.hits = result.hits.map(h => ({ ...hitMetadata(h), freshness: "unchecked", excerpt: excerpt(h.text, p.query) }));
      target.status = target.hits.length ? "ok" : "no_hits";
      return target;
    } catch (error) {
      return { ...target, status: "search_error" as const, warnings: [error instanceof Error ? error.message : String(error)] };
    }
  }));
  return { schemaVersion: 1 as const, query: p.query, mode: p.mode, targets };
}

function sqlString(value: string): string { return `'${value.replace(/'/g, "''")}'`; }
function inside(file: string, root: string): boolean {
  const rel = path.relative(root, file);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export async function getEvidence(cfg: AppConfig, workspaces: WorkspaceConfig[], body: unknown, isIndexing: IsIndexing = () => false) {
  const ref = parseEvidenceRef(object(body).evidenceRef);
  const ws = workspaces.find(w => w.slug === ref.workspace);
  if (!ws) throw new EvidenceError(404, "not_found", "워크스페이스를 찾을 수 없습니다");
  const issue = sourceIssue(cfg, ws, workspaces);
  if (issue) throw new EvidenceError(409, "ambiguous_source", issue);
  const checkBusy = () => { if (isIndexing(ws.slug)) throw new EvidenceError(409, "indexing", "인덱싱 완료 후 다시 조회하세요"); };
  checkBusy();
  if (!await tableExists(cfg, ws)) throw new EvidenceError(404, "not_found", "근거 인덱스를 찾을 수 없습니다");
  const table = await openOrCreateTable(cfg, ws);
  const condition = `id = ${sqlString(ref.chunkId)}`;
  const exact = `${condition} AND file_hash = ${sqlString(ref.fileHash)} AND start_line = ${ref.startLine} AND end_line = ${ref.endLine}`;
  const rows = await table.query().where(exact).select([
    "id", "file", "abs", "root", "symbol", "kind", "file_hash", "indexed_at", "start_line", "end_line", "text",
  ]).toArray();
  checkBusy();
  if (!rows.length) {
    const existing = await table.query().where(condition).select(["id"]).limit(1).toArray();
    checkBusy();
    if (existing.length) throw new EvidenceError(409, "stale_evidence", "근거 버전이나 위치가 변경됐습니다. 다시 검색하세요.");
    throw new EvidenceError(404, "not_found", "근거 참조가 인덱스에 없습니다. 다시 검색하세요.");
  }
  const row = rows.find((r: any) => r.file_hash === ref.fileHash && r.start_line === ref.startLine &&
    r.end_line === ref.endLine && sha256Text(r.text) === ref.contentHash);
  if (!row) throw new EvidenceError(409, "stale_evidence", "근거 버전이 변경됐습니다. 다시 검색하세요.");
  const roots = [...ws.roots, uploadsDirFor(cfg, ws.slug)];
  // Do not accept a path from the request, or a row from a previously configured root.
  let currentHash: string;
  try {
    const realFile = fs.realpathSync(row.abs);
    const allowed = roots.some(root => fs.existsSync(root) && inside(realFile, fs.realpathSync(root)));
    if (!allowed || relativeFileKey(row.abs, roots) !== row.file) {
      throw new EvidenceError(409, "stale_evidence", `근거의 원본 경로가 현재 워크스페이스에 속하지 않습니다 [DEBUG abs=${row.abs} real=${realFile} roots=${roots.join(";")} realRoots=${roots.map(r => fs.existsSync(r) ? fs.realpathSync(r) : "MISSING").join(";")} key=${relativeFileKey(row.abs, roots)} file=${row.file}]`);
    }
    currentHash = sha256File(realFile);
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    throw new EvidenceError(409, "source_unavailable", "원본 파일이 삭제됐거나 읽을 수 없습니다");
  }
  if (currentHash !== ref.fileHash) throw new EvidenceError(409, "stale_evidence", "원본 파일이 변경됐습니다. 재인덱싱 후 다시 검색하세요.");
  checkBusy();
  const h: SearchHit = { id: row.id, workspace: ws.slug, file: row.file, abs: row.abs, root: row.root,
    symbol: row.symbol, kind: row.kind, startLine: row.start_line, endLine: row.end_line,
    fileHash: row.file_hash, indexedAt: row.indexed_at, text: row.text, score: 0 };
  return { schemaVersion: 1 as const, evidence: { ...hitMetadata(h), text: h.text,
    freshness: "verified" as const, checkedAt: new Date().toISOString() } };
}

export function registerEvidenceRoutes(app: Express, cfg: AppConfig, getWorkspaces: () => WorkspaceConfig[],
  isIndexing: IsIndexing, requestOptions: (req: Request) => SearchOptions = () => ({})) {
  for (const operation of ["search", "get"] as const) {
    app.post(`/api/evidence/${operation}`, async (req, res) => {
      try {
        const data = operation === "search"
          ? await searchEvidence(cfg, getWorkspaces(), req.body, isIndexing, requestOptions(req))
          : await getEvidence(cfg, getWorkspaces(), req.body, isIndexing);
        res.json(data);
      } catch (error) {
        const e = error instanceof EvidenceError ? error : new EvidenceError(500, "search_error", error instanceof Error ? error.message : String(error));
        res.status(e.status).json({ error: { code: e.code, message: e.message }, status: e.status });
      }
    });
  }
}
