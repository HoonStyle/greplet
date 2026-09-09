// 다중 루트 상대키 충돌은 전역 차단하되, 신뢰 가능한 watcher의 warm cache에서는 전체 열거를 반복하지 않는다.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "greplet-source-validation-"));
const rootA = path.join(tmpRoot, "root-a");
const rootB = path.join(tmpRoot, "root-b");
const dataDir = path.join(tmpRoot, "data");
const slug = "source-validation";
for (const dir of [rootA, rootB, path.join(dataDir, "uploads", slug)]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(rootA, "a.txt"), "a");
fs.writeFileSync(path.join(rootB, "b.txt"), "b");
process.env.GREPLET_DATA_DIR = dataDir;

const { loadConfig } = await import("../dist/config.js");
const { sourceIssue, clearSourceValidationCache, getSourceValidationStats } = await import("../dist/sourceValidation.js");
const cfg = loadConfig();
const ws = { slug, label: "출처 검증", kind: "docs", roots: [rootA, rootB],
  includeExt: [".txt"], excludeDirs: [], excludeFiles: [] };

async function waitFor(expected) {
  for (let i = 0; i < 80; i++) {
    const issue = await sourceIssue(cfg, ws, [ws]);
    if (expected ? issue?.includes("a.txt") : issue === undefined) return issue;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`source validation 상태 전환 타임아웃(expected=${expected})`);
}

try {
  clearSourceValidationCache();
  assert.equal(await sourceIssue(cfg, ws, [ws]), undefined);
  const afterCold = getSourceValidationStats();
  assert.equal(await sourceIssue(cfg, ws, [ws]), undefined);
  const afterWarm = getSourceValidationStats();
  if (afterWarm.cacheHits > afterCold.cacheHits) {
    assert.equal(afterWarm.fullScans, afterCold.fullScans, "warm 검증은 전체 열거를 반복하면 안 된다");
  } else {
    assert.ok(afterWarm.unreliableScans > afterCold.unreliableScans, "감시 불가 환경은 매번 안전하게 재검증해야 한다");
  }

  fs.writeFileSync(path.join(rootB, "a.txt"), "collision");
  assert.match(await waitFor(true), /a\.txt/);
  assert.ok(getSourceValidationStats().invalidations > 0 || getSourceValidationStats().unreliableScans > 0);

  fs.unlinkSync(path.join(rootB, "a.txt"));
  assert.equal(await waitFor(false), undefined);

  const collidingWs = { ...ws, slug: "source_validation" };
  assert.match(await sourceIssue(cfg, ws, [ws, collidingWs]), /저장 이름이 충돌/);
  console.log("source validation cache tests passed");
} finally {
  clearSourceValidationCache();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* watcher release */ }
}
