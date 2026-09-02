/*
  server.ts — greplet 인덱서 HTTP API(§5.5). 127.0.0.1 전용, 무인증(로컬 전용 도구).
*/
import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { loadConfig, loadWorkspaces, findWorkspace, uploadsDirFor, type WorkspaceConfig } from "./config.js";
import { extractorAvailable } from "./extract.js";
import { checkOllama } from "./embed.js";
import { openOrCreateTable, tableExists, manifestPathFor, VECTOR_DIM } from "./db.js";
import { loadManifest } from "./scan.js";
import { search, type SearchMode } from "./search.js";
import { JobManager } from "./indexJob.js";

const cfg = loadConfig();
fs.mkdirSync(cfg.dbDir, { recursive: true });
fs.mkdirSync(cfg.logsDir, { recursive: true });

let workspaces: WorkspaceConfig[] = loadWorkspaces(cfg);
const getWorkspace = (slug: string) => findWorkspace(workspaces, slug);
const jobManager = new JobManager(cfg, getWorkspace);

// Extractor 미확인 시 1회 빌드 시도(§5.6)
async function ensureExtractor(): Promise<void> {
  if (extractorAvailable(cfg)) return;
  console.log("[greplet] Extractor 실행 파일 없음 — dotnet build 시도:", cfg.extractorProjectDir);
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve) => {
    const child = spawn("dotnet", ["build", cfg.extractorProjectDir, "-c", "Release"], { windowsHide: true, stdio: "inherit" });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
  if (!extractorAvailable(cfg)) {
    console.warn("[greplet] Extractor 빌드 후에도 실행 파일을 찾을 수 없음:", cfg.extractorPath, "— dotnet run 폴백을 사용합니다.");
  }
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/healthz", (_req, res) => {
  res.status(200).send("ok");
});

app.get("/api/status", async (_req, res) => {
  const ollama = await checkOllama(cfg);
  res.json({
    ollama: { ok: ollama.ok, model: ollama.model, hasModel: ollama.hasModel },
    dbDir: cfg.dbDir,
    extractor: { ok: extractorAvailable(cfg), path: cfg.extractorPath },
    queue: jobManager.getQueueSlugs(),
  });
});

app.get("/api/workspaces", async (_req, res) => {
  const out = [];
  for (const ws of workspaces) {
    const manifestPath = manifestPathFor(cfg, ws.slug);
    const manifest = loadManifest(manifestPath);
    let chunks = 0;
    if (await tableExists(cfg, ws)) {
      const table = await openOrCreateTable(cfg, ws);
      chunks = await table.countRows();
    }
    out.push({
      slug: ws.slug,
      label: ws.label,
      kind: ws.kind,
      roots: ws.roots,
      files: Object.keys(manifest.files).length,
      chunks,
      lastRun: manifest.lastRun || null,
      indexing: jobManager.isIndexing(ws.slug),
    });
  }
  res.json(out);
});

app.post("/api/search", async (req, res) => {
  const { query, workspaces: wsParam, topN: topNRaw, mode: modeRaw } = req.body ?? {};
  if (typeof query !== "string" || query.length === 0) {
    res.status(400).json({ error: "query 는 필수 문자열입니다" });
    return;
  }
  const mode: SearchMode = ["hybrid", "vector", "fts"].includes(modeRaw) ? modeRaw : "hybrid";
  const topN = Math.min(20, Math.max(1, Number(topNRaw) || 6));

  let targets: WorkspaceConfig[];
  if (wsParam === "all") {
    targets = workspaces;
  } else if (Array.isArray(wsParam) && wsParam.length > 0) {
    targets = wsParam.map((slug: string) => getWorkspace(slug)).filter((w: WorkspaceConfig | undefined): w is WorkspaceConfig => !!w);
  } else {
    res.status(400).json({ error: "workspaces 는 슬러그 배열 또는 'all' 이어야 합니다" });
    return;
  }

  try {
    const result = await search(cfg, targets, query, topN, mode);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/index/:slug", (req, res) => {
  const slug = req.params.slug;
  if (!getWorkspace(slug)) {
    res.status(404).json({ error: `알 수 없는 워크스페이스: ${slug}` });
    return;
  }
  const force = !!(req.body?.force);
  const before = jobManager.isIndexing(slug);
  const { jobId, queued } = jobManager.enqueue(slug, force);
  res.status(before ? 200 : 202).json(queued ? { jobId, queued: true } : { jobId });
});

app.get("/api/jobs", (_req, res) => {
  res.json(jobManager.getRecentJobs(20));
});

app.get("/api/jobs/:id/events", (req, res) => {
  const jobId = req.params.id;
  const job = jobManager.getJob(jobId);
  if (!job) {
    res.status(404).end();
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  for (const ev of jobManager.getLogEvents(jobId)) {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }

  if (job.state === "done" || job.state === "failed") {
    res.write("event: done\ndata: {}\n\n");
    res.end();
    return;
  }

  const unsubscribe = jobManager.subscribe(
    jobId,
    (line) => res.write(`data: ${JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: line })}\n\n`),
    () => {
      res.write("event: done\ndata: {}\n\n");
      res.end();
    },
  );
  req.on("close", unsubscribe);
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

app.post("/api/upload/:slug", upload.array("files"), (req, res) => {
  const slug = req.params.slug;
  const ws = getWorkspace(slug);
  if (!ws) {
    res.status(404).json({ error: `알 수 없는 워크스페이스: ${slug}` });
    return;
  }
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const uploadsDir = uploadsDirFor(cfg, slug);
  fs.mkdirSync(uploadsDir, { recursive: true });

  const extSet = new Set(ws.includeExt.map((e) => e.toLowerCase()));
  const saved: string[] = [];
  for (const f of files) {
    const base = path.basename(f.originalname).replace(/\.\./g, "_");
    const ext = path.extname(base).toLowerCase();
    if (!extSet.has(ext)) continue;
    const dest = path.join(uploadsDir, base);
    fs.writeFileSync(dest, f.buffer);
    saved.push(base);
  }

  const { jobId } = jobManager.enqueue(slug, false);
  res.json({ saved, jobId });
});

app.delete("/api/workspaces/:slug/files", (req, res) => {
  const slug = req.params.slug;
  const ws = getWorkspace(slug);
  if (!ws) {
    res.status(404).json({ error: `알 수 없는 워크스페이스: ${slug}` });
    return;
  }
  const rel = String(req.query.file ?? "");
  const base = path.basename(rel).replace(/\.\./g, "_");
  if (!base) {
    res.status(400).json({ error: "file 쿼리 파라미터가 필요합니다" });
    return;
  }
  const uploadsDir = uploadsDirFor(cfg, slug);
  const target = path.join(uploadsDir, base);
  if (!target.startsWith(uploadsDir)) {
    res.status(400).json({ error: "잘못된 경로" });
    return;
  }
  if (fs.existsSync(target)) fs.unlinkSync(target);

  const { jobId } = jobManager.enqueue(slug, false);
  res.json({ deleted: base, jobId });
});

app.use(express.static(path.join(cfg.indexerRoot, "public")));

const server = app.listen(cfg.port, "127.0.0.1", async () => {
  console.log(`[greplet] 인덱서 서버 기동 — http://127.0.0.1:${cfg.port} (dbDir=${cfg.dbDir}, vectorDim=${VECTOR_DIM})`);
  await ensureExtractor();
});

process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close());
