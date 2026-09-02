// incremental.mjs — 증분 인덱싱 시나리오 검증(§8-3).
// 임시 폴더를 root 로 하는 테스트 워크스페이스(GREPLET_WORKSPACES 로 별도 json 지정)에서
//   1) 파일 2개 추가 -> 인덱스 -> 청크 수 확인
//   2) 파일 1개 수정 -> 재인덱스 -> 해당 파일 청크만 교체(id 집합 비교)
//   3) 파일 1개 삭제 -> 재인덱스 -> 그 파일 청크 0, 매니페스트에서 제거
// 실제 Ollama(bge-m3)·Extractor 를 호출하는 통합 테스트다. 임시 DB 디렉터리를 쓰고 끝나면 정리한다.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "greplet-incremental-"));
const srcDir = path.join(tmpRoot, "src");
const dataDir = path.join(tmpRoot, "data");
fs.mkdirSync(srcDir, { recursive: true });

const SLUG = "test-incremental";
const workspacesPath = path.join(tmpRoot, "workspaces.json");
fs.writeFileSync(
  workspacesPath,
  JSON.stringify(
    [
      {
        slug: SLUG,
        label: "증분 테스트",
        kind: "code",
        roots: [srcDir],
        includeExt: [".txt"],
        excludeDirs: [],
        excludeFiles: [],
      },
    ],
    null,
    2,
  ),
);

process.env.GREPLET_WORKSPACES = workspacesPath;
process.env.GREPLET_DATA_DIR = dataDir;

const { loadConfig, loadWorkspaces, findWorkspace } = await import("../dist/config.js");
const { JobManager } = await import("../dist/indexJob.js");
const { openOrCreateTable } = await import("../dist/db.js");

const cfg = loadConfig();
let workspaces = loadWorkspaces(cfg);
const jm = new JobManager(cfg, (slug) => findWorkspace(workspaces, slug));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForJob(jobId) {
  for (let i = 0; i < 600; i++) {
    const rec = jm.getJob(jobId);
    if (rec.state === "done" || rec.state === "failed") return rec;
    await sleep(500);
  }
  throw new Error(`잡 타임아웃: ${jobId}`);
}

async function runIndex(force = false) {
  const { jobId } = jm.enqueue(SLUG, force);
  const rec = await waitForJob(jobId);
  if (rec.state === "failed") throw new Error(`인덱스 잡 실패: ${rec.error}`);
  return rec;
}

async function rowsFor(fileName) {
  const ws = findWorkspace(workspaces, SLUG);
  const table = await openOrCreateTable(cfg, ws);
  const all = await table.query().select(["id", "file"]).limit(10000).toArray();
  return all.filter((r) => r.file === fileName);
}

async function main() {
  console.log("[incremental] tmpRoot =", tmpRoot);

  // ---------- 1) 파일 2개 추가 -> 인덱스 -> 청크 수 확인 ----------
  fs.writeFileSync(path.join(srcDir, "a.txt"), "hello world one\nsecond line a\n");
  fs.writeFileSync(path.join(srcDir, "b.txt"), "hello world two\nsecond line b\n");

  let rec = await runIndex();
  assert.equal(rec.added, 2, `added 는 2 여야 함 (실제 ${rec.added})`);
  assert.ok(rec.chunks >= 2, `chunks 는 2 이상이어야 함 (실제 ${rec.chunks})`);

  const ws = findWorkspace(workspaces, SLUG);
  const table1 = await openOrCreateTable(cfg, ws);
  const countAfterAdd = await table1.countRows();
  console.log(`[incremental] 1) 추가 후 총 행 수 = ${countAfterAdd}`);
  assert.ok(countAfterAdd >= 2, "추가 후 총 행 수는 2 이상이어야 함");

  // ---------- 2) 파일 1개 수정 -> 재인덱스 -> 해당 파일 청크만 교체(id 집합 비교) ----------
  const idsBefore = (await rowsFor("b.txt")).map((r) => r.id).sort();
  fs.writeFileSync(
    path.join(srcDir, "b.txt"),
    Array.from({ length: 30 }, (_, i) => `changed line ${i}`).join("\n") + "\n",
  );

  rec = await runIndex();
  assert.equal(rec.changed, 1, `changed 는 1 이어야 함 (실제 ${rec.changed})`);

  const idsAfter = (await rowsFor("b.txt")).map((r) => r.id).sort();
  console.log(`[incremental] 2) b.txt id 집합 변경 전=${idsBefore.length}건, 변경 후=${idsAfter.length}건`);
  assert.notDeepEqual(idsBefore, idsAfter, "수정 후 b.txt 의 id 집합이 이전과 달라야 함");

  const aRowsUnchanged = (await rowsFor("a.txt")).length;
  assert.ok(aRowsUnchanged >= 1, "a.txt 청크는 그대로 남아있어야 함");

  // ---------- 3) 파일 1개 삭제 -> 재인덱스 -> 그 파일 청크 0, 매니페스트에서 제거 ----------
  fs.unlinkSync(path.join(srcDir, "b.txt"));
  rec = await runIndex();
  assert.equal(rec.deleted, 1, `deleted 는 1 이어야 함 (실제 ${rec.deleted})`);

  const bRowsAfterDelete = await rowsFor("b.txt");
  assert.equal(bRowsAfterDelete.length, 0, "삭제 후 b.txt 청크는 0개여야 함");

  const manifestPath = path.join(cfg.dbDir, `${SLUG}.manifest.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.ok(!("b.txt" in manifest.files), "매니페스트에서 b.txt 가 제거되어야 함");
  assert.ok("a.txt" in manifest.files, "매니페스트에 a.txt 는 남아있어야 함");

  console.log("[incremental] 전체 통과");
}

main()
  .then(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error("[incremental] 실패:", err);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    process.exit(1);
  });
