/*
  config.ts — 환경변수 + workspaces.json 로드(§2, §3).

  환경변수:
    GREPLET_PORT        기본 7802
    GREPLET_DATA_DIR     기본값 (리포 밖, 머신 로컬), OS별로 다름:
                           Windows: %LOCALAPPDATA%\greplet
                           macOS:   ~/Library/Application Support/greplet
                           Linux:   $XDG_DATA_HOME/greplet (기본 ~/.local/share/greplet)
    OLLAMA_URL           기본 http://localhost:11434
    GREPLET_WORKSPACES   workspaces.json 경로, 기본 이 폴더의 workspaces.json
    GREPLET_EXTRACTOR    Extractor 실행 파일 경로, 기본 ../Extractor/bin/Release/net8.0/Extractor(.exe)
                           (Windows: Extractor.exe, 그 외: Extractor)
*/
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

export type WorkspaceKind = "code" | "docs";

export interface WorkspaceConfig {
  slug: string;
  label: string;
  kind: WorkspaceKind;
  roots: string[];
  includeExt: string[];
  excludeDirs: string[];
  excludeFiles: string[];
  pdfPasswordFile: string | null;
}

export interface AppConfig {
  port: number;
  dataDir: string;
  dbDir: string;
  logsDir: string;
  ollamaUrl: string;
  ollamaModel: string;
  workspacesPath: string;
  extractorPath: string;
  extractorProjectDir: string;
  indexerRoot: string;
}

// 이 파일(config.ts)이 dist/ 또는 src/ 어디서 실행되든 indexer 루트를 일관되게 구한다.
const here = path.dirname(fileURLToPath(import.meta.url));
const INDEXER_ROOT = path.resolve(here, ".."); // dist/config.js -> ../ , src/config.ts(tsx) -> ../

const DEFAULT_CODE_EXT = [".cs", ".csproj", ".sln", ".xaml", ".proto", ".config", ".settings", ".manifest", ".md"];
const DEFAULT_EXCLUDE_DIRS = ["bin", "obj", ".vs", ".vscode", ".git", "packages", "node_modules", ".serena", ".claude"];
const DEFAULT_EXCLUDE_FILES = ["*.Designer.cs", "AssemblyInfo.cs", "*.g.cs", "*.g.i.cs"];
const DEFAULT_DOCS_EXT = [".pdf"];

/** OS별 기본 데이터 디렉터리(§2)를 구한다. */
export function defaultDataDir(): string {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "greplet");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "greplet");
  }
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "greplet");
}

export function loadConfig(): AppConfig {
  const dataDir = process.env.GREPLET_DATA_DIR ?? defaultDataDir();

  const extractorProjectDir = path.join(INDEXER_ROOT, "..", "Extractor");
  const extractorExeName = process.platform === "win32" ? "Extractor.exe" : "Extractor";
  const defaultExtractorPath = path.join(extractorProjectDir, "bin", "Release", "net8.0", extractorExeName);

  return {
    port: Number(process.env.GREPLET_PORT ?? 7802),
    dataDir,
    dbDir: path.join(dataDir, "db"),
    logsDir: path.join(dataDir, "logs"),
    ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
    ollamaModel: "bge-m3",
    workspacesPath: process.env.GREPLET_WORKSPACES ?? path.join(INDEXER_ROOT, "workspaces.json"),
    extractorPath: process.env.GREPLET_EXTRACTOR ?? defaultExtractorPath,
    extractorProjectDir,
    indexerRoot: INDEXER_ROOT,
  };
}

export function uploadsDirFor(cfg: AppConfig, slug: string): string {
  return path.join(cfg.dataDir, "uploads", slug);
}

interface RawWorkspaceEntry {
  slug: string;
  label: string;
  kind: WorkspaceKind;
  roots: string[];
  includeExt?: string[];
  excludeDirs?: string[];
  excludeFiles?: string[];
  pdfPasswordFile?: string | null;
}

/** workspaces.json 을 읽어 공통 기본값(§3)을 적용한 워크스페이스 목록을 만든다. */
export function loadWorkspaces(cfg: AppConfig): WorkspaceConfig[] {
  const raw = fs.readFileSync(cfg.workspacesPath, "utf8");
  const entries = JSON.parse(raw) as RawWorkspaceEntry[];

  return entries.map((e) => {
    const defaultExt = e.kind === "docs" ? DEFAULT_DOCS_EXT : DEFAULT_CODE_EXT;
    return {
      slug: e.slug,
      label: e.label,
      kind: e.kind,
      roots: e.roots,
      includeExt: e.includeExt ?? defaultExt,
      excludeDirs: e.excludeDirs ?? (e.kind === "docs" ? [] : DEFAULT_EXCLUDE_DIRS),
      excludeFiles: e.excludeFiles ?? (e.kind === "docs" ? [] : DEFAULT_EXCLUDE_FILES),
      pdfPasswordFile: e.pdfPasswordFile ?? null,
    };
  });
}

export function findWorkspace(list: WorkspaceConfig[], slug: string): WorkspaceConfig | undefined {
  return list.find((w) => w.slug === slug);
}
