// 부분 추출 실패 계약 회귀: 구조화 failed-out, 부분 성공 보존, 실패 잡/coverage, 증분 재시도, 0청크 성공.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "greplet-partial-failure-"));
const srcDir = path.join(tmpRoot, "src");
const dataDir = path.join(tmpRoot, "data");
fs.mkdirSync(srcDir, { recursive: true });

const SLUG = "test-partial-failure";
const workspacesPath = path.join(tmpRoot, "workspaces.json");
fs.writeFileSync(workspacesPath, JSON.stringify([{
  slug: SLUG, label: "부분 실패 테스트", kind: "docs", roots: [srcDir],
  includeExt: [".txt"], excludeDirs: [], excludeFiles: [],
}], null, 2));
process.env.GREPLET_WORKSPACES = workspacesPath;
process.env.GREPLET_DATA_DIR = dataDir;

const { loadConfig, loadWorkspaces, findWorkspace } = await import("../dist/config.js");
const { runExtractor, canonicalPath } = await import("../dist/extract.js");
const { JobManager } = await import("../dist/indexJob.js");
const { manifestPathFor, openOrCreateTable } = await import("../dist/db.js");
const { loadManifest } = await import("../dist/scan.js");
const { searchEvidence } = await import("../dist/evidence.js");

const cfg = loadConfig();
const workspaces = loadWorkspaces(cfg);
const ws = findWorkspace(workspaces, SLUG);
assert.ok(ws);

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitForJob(manager, jobId) {
  for (let i = 0; i < 400; i++) {
    const rec = manager.getJob(jobId);
    if (rec?.state === "done" || rec?.state === "failed") return rec;
    await sleep(25);
  }
  throw new Error(`잡 타임아웃: ${jobId}`);
}
async function indexOnce(manager) {
  const { jobId } = manager.enqueue(SLUG, false);
  return waitForJob(manager, jobId);
}
function chunk(abs) {
  const text = fs.readFileSync(abs, "utf8");
  return {
    file: path.basename(abs), abs, root: srcDir,
    hash: crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex"),
    symbol: "lines:1-1", kind: "text", startLine: 1, endLine: 1, text,
  };
}

async function assertStructuredExtractorContract() {
  const ok = path.join(srcDir, "contract-ok.txt");
  const missing = path.join(srcDir, "contract-missing.txt");
  fs.writeFileSync(ok, "structured success\n");
  const result = await runExtractor(cfg, ws, [srcDir], [ok, missing]);
  assert.equal(result.exitCode, 2);
  assert.equal(result.failedFiles.length, 1);
  assert.equal(path.resolve(result.failedFiles[0].abs), path.resolve(missing));
  assert.match(result.failedFiles[0].message, /contract-missing|찾을|find|exist/i);
  assert.equal(result.chunks.some(c => path.resolve(c.abs) === path.resolve(ok)), true);
  assert.equal(result.chunks.some(c => path.resolve(c.abs) === path.resolve(missing)), false);
  fs.unlinkSync(ok);
}

function assertWindowsPathAliases() {
  if (process.platform !== "win32") return;
  // A junction exercises distinct path spellings without depending on 8.3
  // name generation being enabled on the test machine's volume.
  const actual = path.join(tmpRoot, "actual-directory");
  const alias = path.join(tmpRoot, "alias-directory");
  fs.mkdirSync(actual);
  fs.symlinkSync(actual, alias, "junction");
  fs.writeFileSync(path.join(actual, "ok.txt"), "alias fixture");
  assert.equal(canonicalPath(path.join(alias, "ok.txt")), canonicalPath(path.join(actual, "ok.txt")));
  assert.equal(canonicalPath(path.join(alias, "missing", "file.txt")), canonicalPath(path.join(actual, "missing", "file.txt")));
  assert.notEqual(canonicalPath(path.join(alias, "missing.txt")), canonicalPath(path.join(tmpRoot, "outside.txt")));
}

async function assertPartialRetryAndZeroChunks() {
  const a = path.join(srcDir, "a.txt");
  const b = path.join(srcDir, "b.txt");
  fs.writeFileSync(a, "alpha\n");
  fs.writeFileSync(b, "beta\n");
  const calls = [];
  let failB = true;
  const fakeExtractor = async (_cfg, _ws, _roots, targets) => {
    calls.push(targets.map(value => path.basename(value)).sort());
    const failedFiles = failB && targets.includes(b)
      ? [{ abs: b, message: "fixture: drive C:\\ and message:colon", kind: "io" }]
      : [];
    const failed = new Set(failedFiles.map(value => path.resolve(value.abs)));
    const chunks = targets
      .filter(value => !failed.has(path.resolve(value)) && path.basename(value) !== "empty.txt")
      .map(chunk);
    return { chunks, failedFiles, exitCode: failedFiles.length ? 2 : 0, stdout: "", stderr: "사람용: 진단: 콜론" };
  };
  const manager = new JobManager(cfg, slug => slug === SLUG ? ws : undefined, {
    runExtractor: fakeExtractor,
    checkOllama: async () => ({ ok: false, hasModel: false, model: cfg.ollamaModel, error: "fixture offline" }),
  });

  let rec = await indexOnce(manager);
  assert.equal(rec.state, "failed");
  assert.deepEqual(rec.failedFiles, ["b.txt"]);
  assert.equal(rec.succeededFiles, 1);
  let manifest = loadManifest(manifestPathFor(cfg, SLUG));
  assert.ok(manifest.files["a.txt"], "성공 파일은 부분 실패에서도 보존되어야 한다");
  assert.equal(manifest.files["b.txt"], undefined, "실패 파일은 성공 매니페스트로 기록되면 안 된다");
  assert.equal(manifest.coverage?.status, "partial");
  assert.deepEqual(manifest.coverage?.failedFiles, ["b.txt"]);
  let evidence = await searchEvidence(cfg, workspaces, { query: "alpha", workspaces: [SLUG], mode: "fts" });
  assert.equal(evidence.targets[0].coverage.status, "partial");
  assert.equal(evidence.targets[0].warnings.some(value => value.includes("부분 상태")), true);
  const table = await openOrCreateTable(cfg, ws);
  let rows = await table.query().select(["file"]).limit(100).toArray();
  assert.deepEqual(rows.map(row => row.file).sort(), ["a.txt"]);

  failB = false;
  rec = await indexOnce(manager);
  assert.equal(rec.state, "done");
  assert.deepEqual(calls[1], ["b.txt"], "다음 증분 실행은 실패 파일만 재시도해야 한다");
  manifest = loadManifest(manifestPathFor(cfg, SLUG));
  assert.ok(manifest.files["b.txt"]);
  assert.equal(manifest.coverage?.status, "complete");
  assert.deepEqual(manifest.coverage?.failedFiles, []);
  evidence = await searchEvidence(cfg, workspaces, { query: "beta", workspaces: [SLUG], mode: "fts" });
  assert.equal(evidence.targets[0].coverage.status, "complete");
  assert.equal(evidence.targets[0].warnings.some(value => value.includes("부분 상태")), false);

  fs.writeFileSync(path.join(srcDir, "empty.txt"), "");
  rec = await indexOnce(manager);
  assert.equal(rec.state, "done");
  manifest = loadManifest(manifestPathFor(cfg, SLUG));
  assert.equal(manifest.files["empty.txt"]?.chunks, 0, "0청크 성공 파일은 재시도 대상이 아니어야 한다");
  assert.equal(manifest.coverage?.status, "complete");
}

try {
  assertWindowsPathAliases();
  await assertStructuredExtractorContract();
  await assertPartialRetryAndZeroChunks();
  console.log("partial failure contract tests passed");
} finally {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* Windows LanceDB handle */ }
}
