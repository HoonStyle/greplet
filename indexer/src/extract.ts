/*
  extract.ts — Extractor(C#) 프로세스 호출·JSONL 파싱(§4.2).
  GREPLET_EXTRACTOR 경로가 있으면 그 실행 파일을, 없으면 `dotnet run --project ... -c Release --` 로 폴백한다.
*/
import { spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { AppConfig, WorkspaceConfig } from "./config.js";

export interface ExtractedChunk {
  file: string;
  abs: string;
  root: string;
  hash: string;
  symbol: string;
  kind: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface ExtractResult {
  chunks: ExtractedChunk[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function extractorAvailable(cfg: AppConfig): boolean {
  return fs.existsSync(cfg.extractorPath);
}

function buildArgs(ws: WorkspaceConfig, roots: string[], filesListPath: string, outPath: string): string[] {
  const args: string[] = [];
  for (const root of roots) {
    args.push("--root", path.resolve(root)); // same normalisation as relativeFileKey (no 8.3 expansion)
  }
  args.push("--ext", ws.includeExt.join(","));
  if (ws.excludeDirs.length > 0) args.push("--exclude-dir", ws.excludeDirs.join(","));
  if (ws.excludeFiles.length > 0) args.push("--exclude-file", ws.excludeFiles.join(","));
  args.push("--files", filesListPath);
  if (ws.pdfPasswordFile) args.push("--pdf-password-file", ws.pdfPasswordFile);
  args.push("--out", outPath);
  return args;
}

/** 대상 파일 목록(절대경로)을 Extractor 로 넘겨 청크를 뽑는다. */
export async function runExtractor(
  cfg: AppConfig,
  ws: WorkspaceConfig,
  roots: string[],
  targetFiles: string[],
  onLog?: (line: string) => void,
): Promise<ExtractResult> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "greplet-extract-"));
  const filesListPath = path.join(tmpDir, "files.txt");
  const outPath = path.join(tmpDir, "chunks.jsonl");
  fs.writeFileSync(filesListPath, targetFiles.join("\n"), "utf8");

  const args = buildArgs(ws, roots, filesListPath, outPath);
  const useExe = extractorAvailable(cfg);
  const command = useExe ? cfg.extractorPath : "dotnet";
  const spawnArgs = useExe ? args : ["run", "--project", cfg.extractorProjectDir, "-c", "Release", "--", ...args];

  const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, spawnArgs, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      stdout += s;
      if (onLog) s.split(/\r?\n/).filter(Boolean).forEach(onLog);
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      stderr += s;
      if (onLog) s.split(/\r?\n/).filter(Boolean).forEach((l) => onLog(`[stderr] ${l}`));
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });

  const chunks: ExtractedChunk[] = [];
  if (fs.existsSync(outPath)) {
    const rl = readline.createInterface({ input: fs.createReadStream(outPath, "utf8"), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      chunks.push(JSON.parse(line) as ExtractedChunk);
    }
  }

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 임시 폴더 정리 실패는 무시(다음 OS 재시작 시 정리됨)
  }

  // exitCode 0(전체 성공) 또는 2(일부 실패, 계속 진행)만 정상 — 그 외는 예외
  if (result.exitCode !== 0 && result.exitCode !== 2) {
    throw new Error(`Extractor 비정상 종료(code=${result.exitCode}): ${result.stderr.slice(-2000)}`);
  }

  return { chunks, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

/** LanceDB row id 규칙: `${file}#${symbol}` (§5.1). */
export function rowId(chunk: Pick<ExtractedChunk, "file" | "symbol">): string {
  return `${chunk.file}#${chunk.symbol}`;
}

export function sha256Text(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}
