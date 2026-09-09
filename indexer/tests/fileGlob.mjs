// fileGlob은 검색 후보를 만든 뒤 거르는 힌트가 아니라, 랭킹 전의 완전한 검색 범위다.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "greplet-file-glob-"));
const srcDir = path.join(tmpRoot, "src");
const dataDir = path.join(tmpRoot, "data");
fs.mkdirSync(srcDir, { recursive: true });
const SLUG = "test-file-glob";
const workspacesPath = path.join(tmpRoot, "workspaces.json");
fs.writeFileSync(workspacesPath, JSON.stringify([{
  slug: SLUG, label: "글롭 테스트", kind: "code", roots: [srcDir],
  includeExt: [".txt"], excludeDirs: [], excludeFiles: [],
}], null, 2));
process.env.GREPLET_WORKSPACES = workspacesPath;
process.env.GREPLET_DATA_DIR = dataDir;
process.env.OLLAMA_URL = "http://127.0.0.1:1";

const { loadConfig, loadWorkspaces } = await import("../dist/config.js");
const { openOrCreateTable, rebuildFtsIndex, manifestPathFor, zeroVector } = await import("../dist/db.js");
const { saveManifest } = await import("../dist/scan.js");
const { search, fileGlobToRegex, fileGlobToSqlPredicate } = await import("../dist/search.js");

const cfg = loadConfig();
const ws = loadWorkspaces(cfg)[0];

function row(file, text, order) {
  const hash = crypto.createHash("sha256").update(text).digest("hex");
  return {
    id: `${file}#${order}`, file, abs: path.join(srcDir, ...file.split("/")), root: srcDir,
    symbol: `lines:${order}-${order}`, kind: "text", file_hash: hash,
    indexed_at: new Date().toISOString(), start_line: order, end_line: order,
    text, vector: zeroVector(),
  };
}

try {
  const table = await openOrCreateTable(cfg, ws);
  const rows = [];
  // 기존 topN*10 후처리 방식에서는 상위 10개 비일치 결과 뒤의 wanted 파일을 잃는다.
  for (let i = 0; i < 12; i++) rows.push(row(`other/high-${String(i).padStart(2, "0")}.txt`, "needle needle needle", i + 1));
  rows.push(row("wanted/low.txt", "needle", 20));
  rows.push(row("wanted/nested/also.txt", "needle", 21));
  rows.push(row("wanted/o'neil.txt", "needle", 22));
  await table.add(rows);
  await rebuildFtsIndex(table);
  saveManifest(manifestPathFor(cfg, SLUG), {
    lastRun: new Date().toISOString(), embeddings: "none", files: {},
    coverage: { status: "complete", scannedFiles: 15, indexedFiles: 15, attemptedFiles: 15,
      succeededFiles: 15, failedFiles: [], skippedPages: null, updatedAt: new Date().toISOString() },
  });

  for (const mode of ["fts", "hybrid"]) {
    const result = await search(cfg, [ws], "needle", 1, mode, { fileGlob: "wanted/**", bypassCache: true });
    assert.equal(result.hits.length, 1, `${mode}: 일치 파일이 후보 상한 밖이어도 반환해야 한다`);
    assert.match(result.hits[0].file, /^wanted\//);
  }

  const cases = [
    ["*.txt", "other/high-00.txt", true],
    ["wanted/**", "wanted/nested/also.txt", true],
    ["wanted/?ow.txt", "wanted/low.txt", true],
    ["wanted\\**", "wanted/nested/also.txt", true],
    ["wanted/*.txt", "wanted/nested/also.txt", false],
    ["wanted/o'neil.txt", "wanted/o'neil.txt", true],
  ];
  for (const [glob, file, expected] of cases) {
    assert.equal(fileGlobToRegex(glob).test(file), expected, `${glob} JS 의미`);
    const matched = await table.query().where(fileGlobToSqlPredicate(glob)).select(["file"]).toArray();
    assert.equal(matched.some(value => value.file === file), expected, `${glob} DB prefilter 의미`);
  }
  const injected = await table.query()
    .where(fileGlobToSqlPredicate("wanted/' OR true --/**"))
    .select(["file"])
    .toArray();
  assert.deepEqual(injected, [], "따옴표와 SQL 유사 입력이 predicate를 탈출하면 안 된다");
  console.log("file glob completeness tests passed");
} finally {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* Windows LanceDB handle */ }
}
