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

  // One request embeds its query once across workspaces, while independent
  // requests and FTS-only searches retain their own behavior.
  const second = workspace("hybrid-second");
  await prepare(second, [row(second, "second.txt", "needle second", unit(0), 1)], true);
  let calls = fake.requests.length;
  const shared = await search(cfg, [normal, second], "needle", 2, "hybrid", { bypassCache: true });
  assert.equal(fake.requests.length - calls, 1);
  assert.equal(shared.workspaceResults.every(ws => ws.effectiveMode === "hybrid" && !ws.failed), true);
  assert.deepEqual(shared.warnings, []);
  calls = fake.requests.length;
  await search(cfg, [normal, second], "needle", 2, "fts", { bypassCache: true });
  assert.equal(fake.requests.length - calls, 0);
  await search(cfg, [normal, second], "needle", 2, "vector", { bypassCache: true });
  assert.equal(fake.requests.length - calls, 1);
  calls = fake.requests.length;
  fake.setMode("http-failure");
  const fallback = await search(cfg, [normal, second], "needle", 2, "hybrid", { bypassCache: true });
  assert.equal(fake.requests.length - calls, 4, "one shared initial request plus three retries");
  assert.equal(fallback.workspaceResults.every(ws => ws.effectiveMode === "fts" && !ws.failed), true);
  assert.equal(fallback.warnings.length, 2);
  fake.setMode("normal");

  const definitions = workspace("symbol-definitions");
  await prepare(definitions, [
    { ...row(definitions, "src/one.cs", "validator body", unit(1), 1), symbol: "Validator.Validate(Config)" },
    { ...row(definitions, "src/two.cs", "validator overload", unit(1), 2), symbol: "Validator.Validate(Config,bool)#2" },
    { ...row(definitions, "src/merged.cs", "small members", unit(1), 3), symbol: "Validator.{Other(),Validate(Config)}" },
    { ...row(definitions, "tests/caller.cs", "Validator.Validate Validator.Validate", unit(0), 4), symbol: "Tests.CallsValidator()" },
    { ...row(definitions, "src/unrelated.cs", "other type", unit(1), 5), symbol: "OtherValidator.Validate(Config)" },
  ], true);
  calls = fake.requests.length;
  const exact = await search(cfg, [definitions], "Validator.Validate", 5, "hybrid", { bypassCache: true });
  assert.deepEqual(new Set(exact.hits.map(h => h.file)), new Set(["src/one.cs", "src/two.cs", "src/merged.cs"]));
  assert.equal(fake.requests.length, calls, "definition-only query does not need Ollama");
  const exactFiltered = await search(cfg, [definitions], "Validator.Validate", 5, "hybrid", { fileGlob: "src/one.cs", bypassCache: true });
  assert.deepEqual(exactFiltered.hits.map(h => h.file), ["src/one.cs"]);
  await search(cfg, [definitions], "Validator.Unknown", 5, "hybrid", { bypassCache: true });
  assert.equal(fake.requests.length, calls + 1, "missing definition falls through to hybrid");
  await search(cfg, [definitions], "Validator.Validate", 5, "hybrid", { bypassCache: true, symbolFirst: false });
  assert.equal(fake.requests.length, calls + 2, "diagnostic opt-out uses hybrid");

  const definitionManifestPath = manifestPathFor(cfg, definitions.slug);
  const definitionManifest = JSON.parse(fs.readFileSync(definitionManifestPath, "utf8"));
  saveManifest(definitionManifestPath, { ...definitionManifest, embeddings: "none" });
  calls = fake.requests.length;
  const exactWithoutEmbeddings = await search(cfg, [definitions], "Validator.Validate", 5, "hybrid", { bypassCache: true });
  assert.deepEqual(new Set(exactWithoutEmbeddings.hits.map(h => h.file)), new Set(["src/one.cs", "src/two.cs", "src/merged.cs"]));
  assert.equal(fake.requests.length, calls, "definition lookup also works in embedding-free indexes");
  const missingWithoutEmbeddings = await search(cfg, [definitions], "Validator.Unknown", 5, "hybrid", { bypassCache: true });
  assert.equal(missingWithoutEmbeddings.workspaceResults[0].effectiveMode, "fts");
  assert.equal(fake.requests.length, calls);

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
