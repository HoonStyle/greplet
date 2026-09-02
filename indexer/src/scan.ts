/*
  scan.ts — 파일 열거·SHA256·매니페스트 diff(§5.2).
  파일 열거 규칙은 Extractor(C#) FileScanner.cs 와 동일해야 한다:
    ext 소문자 비교, 경로 세그먼트 중 하나라도 exclude-dir 이면 제외, 파일명 글롭 매칭.
*/
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { WorkspaceConfig } from "./config.js";

export interface ManifestFileEntry {
  hash: string;
  chunks: number;
  indexedAt: string;
}

export interface Manifest {
  lastRun: string;
  files: Record<string, ManifestFileEntry>;
  /** 이 워크스페이스의 임베딩 모델명, 또는 벡터 없음("none"). 미정(구버전 매니페스트)이면 임베딩 있음("bge-m3")으로 간주한다. */
  embeddings?: string;
}

export function emptyManifest(): Manifest {
  return { lastRun: "", files: {} };
}

export function loadManifest(manifestPath: string): Manifest {
  if (!fs.existsSync(manifestPath)) return emptyManifest();
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
  } catch {
    return emptyManifest();
  }
}

/** 임시 파일에 쓴 뒤 rename 으로 원자적으로 반영한다. 검색이 매니페스트를 읽으므로 잡 도중 부분 쓰기를 읽지 않게 한다. */
export function saveManifest(manifestPath: string, manifest: Manifest): void {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const tmpPath = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), "utf8");
  fs.renameSync(tmpPath, manifestPath);
}

function matchesGlob(name: string, glob: string): boolean {
  const pattern = "^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$";
  return new RegExp(pattern, "i").test(name);
}

function walk(root: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

/** 워크스페이스의 모든 root(+uploads) 를 규칙대로 열거한다. */
export function enumerateWorkspaceFiles(ws: WorkspaceConfig, uploadsDir: string): string[] {
  const roots = [...ws.roots, uploadsDir];
  const extSet = new Set(ws.includeExt.map((e) => e.toLowerCase()));
  const excludeDirSet = new Set(ws.excludeDirs.map((d) => d.toLowerCase()));

  const results: string[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const all: string[] = [];
    walk(root, all);
    for (const file of all) {
      const ext = path.extname(file).toLowerCase();
      if (!extSet.has(ext)) continue;

      const rel = path.relative(root, file);
      const segments = rel.split(/[\\/]/);
      if (segments.some((seg) => excludeDirSet.has(seg.toLowerCase()))) continue;

      const fileName = path.basename(file);
      if (ws.excludeFiles.some((g) => matchesGlob(fileName, g))) continue;

      results.push(file);
    }
  }
  return results;
}

/** abs 경로가 속한 root(가장 긴 접두 일치)를 찾아 '/' 구분자 상대경로를 만든다(Extractor 의 file 필드와 동치). */
export function relativeFileKey(absPath: string, roots: string[]): string {
  let best: string | null = null;
  for (const r of roots) {
    const full = path.resolve(r);
    if (absPath.toLowerCase().startsWith(full.toLowerCase())) {
      if (best === null || full.length > best.length) best = full;
    }
  }
  const root = best ?? path.dirname(absPath);
  return path.relative(root, absPath).replace(/\\/g, "/");
}

export function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export interface DiffResult {
  added: string[];
  changed: string[];
  deleted: string[];
  hashOf: Map<string, string>; // absPath -> hash (added/changed 대상만)
}

/**
 * 현재 파일 목록과 매니페스트를 비교해 added/changed/deleted 를 산출한다.
 * force 면 전부 changed 로 취급(§5.2-1).
 */
export function diffAgainstManifest(
  files: string[],
  roots: string[],
  manifest: Manifest,
  force: boolean,
): DiffResult {
  const currentKeys = new Set<string>();
  const added: string[] = [];
  const changed: string[] = [];
  const hashOf = new Map<string, string>();

  for (const abs of files) {
    const key = relativeFileKey(abs, roots);
    currentKeys.add(key);
    const hash = sha256File(abs);
    hashOf.set(abs, hash);

    const existing = manifest.files[key];
    if (force || !existing) {
      if (!existing) added.push(abs);
      else changed.push(abs);
    } else if (existing.hash !== hash) {
      changed.push(abs);
    }
  }

  const deleted = Object.keys(manifest.files).filter((k) => !currentKeys.has(k));

  return { added, changed, deleted, hashOf };
}
