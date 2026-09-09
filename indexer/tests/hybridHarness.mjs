// 외부 Ollama 없이 실제 LanceDB hybrid/vector/fallback 분기를 결정적으로 검증한다.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeOllama } from "./fakeOllama.mjs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "greplet-hybrid-"));
const dataDir = path.join(tmpRoot, "data");
process.env.GREPLET_DATA_DIR = dataDir;

const fake = await startFakeOllama();
const { loadConfig } = await import("../dist/config.js");
const { openOrCreateTable, rebuildFtsIndex, manifestPathFor, zeroVector } = await import("../dist/db.js");
const { saveManifest } = await import("../dist/scan.js");
const { search } = await import("../dist/search.js");
const { checkOllama } = await import("../dist/embed.js");
const cfg = { ...loadConfig(), ollamaUrl: fake.url };

function unit(axis) {
  const value = zeroVector();
  value[axis] = 1;
  return value;
}
function workspace(slug) {
  const root = path.join(tmpRoot, slug);
  fs.mkdirSync(root, { recursive: true });
  return { slug, label: slug, kind: "code", roots: [root], includeExt: [".txt"], excludeDirs: [], excludeFiles: [] };
}
function row(ws, file, text, vector, order) {
  return {
    id: `${file}#${order}`, file, abs: path.join(ws.roots[0], ...file.split("/")), root: ws.roots[0],
    symbol: `lines:${order}-${order}`, kind: "text",
    file_hash: crypto.createHash("sha256").update(text).digest("hex"), indexed_at: new Date().toISOString(),
    start_line: order, end_line: order, text, vector,
  };
}
async function prepare(ws, rows, withFts) {
  const table = await openOrCreateTable(cfg, ws);
  await table.add(rows);
  if (withFts) await rebuildFtsIndex(table);
  const now = new Date().toISOString();
  saveManifest(manifestPathFor(cfg, ws.slug), {
    lastRun: now, embeddings: cfg.ollamaModel, files: {},
    coverage: { status: "complete", scannedFiles: rows.length, indexedFiles: rows.length,
      attemptedFiles: rows.length, succeededFiles: rows.length, failedFiles: [], skippedPages: null, updatedAt: now },
  });
}

try {
  const status = await checkOllama(cfg);
  assert.equal(status.ok, true);
  assert.equal(status.hasModel, true);

  const normal = workspace("hybrid-normal");
  await prepare(normal, [
    row(normal, "vector/semantic.txt", "semantic-only content", unit(0), 1),
    row(normal, "fts/exact.txt", "needle needle exact content", unit(1), 2),
  ], true);

  fake.setMode("normal");
  const orders = [];
  for (let i = 0; i < 3; i++) {
    const result = await search(cfg, [normal], "needle", 2, "hybrid", { bypassCache: true });
    assert.equal(result.workspaceResults[0].effectiveMode, "hybrid");
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(new Set(result.hits.map(hit => hit.file)), new Set(["vector/semantic.txt", "fts/exact.txt"]));
    orders.push(result.hits.map(hit => hit.id));
  }
  assert.deepEqual(orders[1], orders[0]);
  assert.deepEqual(orders[2], orders[0]);

  const noFts = workspace("hybrid-no-fts");
  await prepare(noFts, [row(noFts, "vector-only.txt", "semantic content", unit(0), 1)], false);
  let result = await search(cfg, [noFts], "needle", 1, "hybrid", { bypassCache: true });
  assert.equal(result.workspaceResults[0].effectiveMode, "vector");
  assert.equal(result.hits[0].file, "vector-only.txt");
  assert.equal(result.warnings.some(value => value.includes("hybrid 검색 실패") && value.includes("vector")), true);

  fake.setMode("short-vector");
  result = await search(cfg, [normal], "needle", 1, "vector", { bypassCache: true });
  assert.equal(result.workspaceResults[0].effectiveMode, "fts");
  assert.equal(result.hits[0].file, "fts/exact.txt");
  assert.equal(result.warnings.some(value => value.includes("vector 검색 실패") && value.includes("fts")), true);

  fake.setMode("http-failure");
  result = await search(cfg, [normal], "needle", 1, "hybrid", { bypassCache: true });
  assert.equal(result.workspaceResults[0].effectiveMode, "fts");
  assert.equal(result.hits[0].file, "fts/exact.txt");
  assert.equal(result.warnings.some(value => value.includes("질의 임베딩 실패") && value.includes("fts")), true);

  fake.setMode("count-mismatch");
  const raw = await fetch(`${fake.url}/api/embed`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: cfg.ollamaModel, input: ["one"] }) });
  assert.deepEqual((await raw.json()).embeddings, []);

  const filtered = workspace("vector-file-glob");
  const filteredRows = [];
  for (let i = 0; i < 12; i++) filteredRows.push(row(filtered, `other/high-${i}.txt`, "semantic", unit(0), i + 1));
  filteredRows.push(row(filtered, "wanted/low.txt", "semantic", unit(0), 20));
  await prepare(filtered, filteredRows, true);
  fake.setMode("normal");
  result = await search(cfg, [filtered], "semantic", 1, "vector", { fileGlob: "wanted/**", bypassCache: true });
  assert.equal(result.workspaceResults[0].effectiveMode, "vector");
  assert.equal(result.hits[0].file, "wanted/low.txt");

  console.log("deterministic hybrid harness tests passed");
} finally {
  await fake.close();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* Windows LanceDB handle */ }
}
