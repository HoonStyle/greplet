// evidence.mjs — 근거 조회 API 회귀 테스트(docs/greplet-evidence-v1.md, docs/migration-roadmap.md).
// 합성 레거시 5세트 + 현재 코드 + 스펙(PDF) 워크스페이스를 임시 root·별도 DB 에 만들고,
// 실제 Extractor·LanceDB·JobManager 로 인덱싱한 뒤 searchEvidence/getEvidence/HTTP 라우트를 검증한다.
// 실패는 섹션 단위로 모아 마지막에 한꺼번에 보고한다(한 결함이 나머지 검증을 막지 않도록).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildTestPdf } from "./evidence-pdf.mjs";

const indexerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "greplet-evidence-"));
const dataDir = path.join(tmpRoot, "data");
const failures = [];

function section(name, fn) {
  return (async () => {
    try {
      await fn();
      console.log(`[evidence] OK   ${name}`);
    } catch (err) {
      console.error(`[evidence] FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
      failures.push({ name, error: err instanceof Error ? err.stack ?? err.message : String(err) });
    }
  })();
}

function root(name) {
  const dir = path.join(tmpRoot, "src", name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------- fixture 파일 내용: 같은 상대경로/심볼, 긴 공유 접두사, 서로 다른(또는 legacy-b/legacy-c 는 동일한) 뒤쪽 동작 ----------
function calculatorFile(suffix) {
  return (
    "namespace Billing;\n\n" +
    "public class Calculator\n" +
    "{\n" +
    "    // Shared regression fixture header identical across all legacy variants for prefix-dedup test.\n" +
    "    public int Compute(int input)\n" +
    "    {\n" +
    "        int adjusted = input * 2 + 1;\n" +
    suffix +
    "    }\n" +
    "}\n"
  );
}

const SUFFIX = {
  a: "        if (adjusted > 100) return adjusted - 1; // alpha subtracts one\n        return adjusted;\n",
  bc: "        if (adjusted > 100) return adjusted * 2; // shared beta/gamma behavior\n        return adjusted;\n",
  d: "        if (adjusted > 100) return 0; // delta clamps to zero\n        return adjusted;\n",
  e: "        if (adjusted > 100) return -adjusted; // epsilon negates\n        return adjusted;\n",
  current: "        if (adjusted > 100) return adjusted - 1; // current: matches alpha post-fix\n        return adjusted;\n",
};

const CURRENT_EXTRA =
  "\npublic class CalculatorExtras\n" +
  "{\n" +
  "    public int Validate(int adjusted) { return adjusted >= 0 ? 1 : 0; }\n" +
  "    public int Reset(int adjusted) { return 0; }\n" +
  "    public int Adjust(int adjusted) { return adjusted + 1; }\n" +
  "    public int AdjustMore(int adjusted) { return adjusted + 2; }\n" +
  "}\n";

// ---------- 워크스페이스 구성 ----------
const legacyRoots = {
  "legacy-a": root("legacy-a"),
  "legacy-b": root("legacy-b"),
  "legacy-c": root("legacy-c"),
  "legacy-d": root("legacy-d"),
  "legacy-e": root("legacy-e"),
};
fs.mkdirSync(path.join(legacyRoots["legacy-a"], "Billing"), { recursive: true });
fs.mkdirSync(path.join(legacyRoots["legacy-b"], "Billing"), { recursive: true });
fs.mkdirSync(path.join(legacyRoots["legacy-c"], "Billing"), { recursive: true });
fs.mkdirSync(path.join(legacyRoots["legacy-d"], "Billing"), { recursive: true });
fs.mkdirSync(path.join(legacyRoots["legacy-e"], "Billing"), { recursive: true });
fs.writeFileSync(path.join(legacyRoots["legacy-a"], "Billing", "Calculator.cs"), calculatorFile(SUFFIX.a));
fs.writeFileSync(path.join(legacyRoots["legacy-b"], "Billing", "Calculator.cs"), calculatorFile(SUFFIX.bc));
fs.writeFileSync(path.join(legacyRoots["legacy-c"], "Billing", "Calculator.cs"), calculatorFile(SUFFIX.bc));
fs.writeFileSync(path.join(legacyRoots["legacy-d"], "Billing", "Calculator.cs"), calculatorFile(SUFFIX.d));
fs.writeFileSync(path.join(legacyRoots["legacy-e"], "Billing", "Calculator.cs"), calculatorFile(SUFFIX.e));

const currentRoot = root("current");
fs.mkdirSync(path.join(currentRoot, "Billing"), { recursive: true });
fs.writeFileSync(path.join(currentRoot, "Billing", "Calculator.cs"), calculatorFile(SUFFIX.current) + CURRENT_EXTRA);

const specRoot = root("spec");
const specSmallText =
  "Spec: Calculator.Compute should clamp adjusted values above one hundred to the legacy alpha behavior, returning adjusted minus one.";
const specLines = [];
for (let i = 0; i < 220; i++) {
  specLines.push(`Spec line ${String(i).padStart(4, "0")}: calculator adjustment behavior padding text for split window test.`);
}
const specLargeText = specLines.join("\n");
fs.writeFileSync(path.join(specRoot, "spec-normal.pdf"), buildTestPdf([specSmallText]));
fs.writeFileSync(path.join(specRoot, "spec-large.pdf"), buildTestPdf([specLargeText]));

// 두 root 가 같은 상대경로를 갖는 모호한 출처 워크스페이스(§3)
const ambigRootA = root("ambig-a");
const ambigRootB = root("ambig-b");
fs.writeFileSync(path.join(ambigRootA, "Dup.cs"), "public class DupA { public int M() { return 1; } }\n");
fs.writeFileSync(path.join(ambigRootB, "Dup.cs"), "public class DupB { public int M() { return 2; } }\n");

// 한 번도 인덱싱하지 않는 워크스페이스(§ not_indexed)
const neverRoot = root("never-indexed");
fs.writeFileSync(path.join(neverRoot, "Idle.cs"), "public class Idle { public int M() { return 0; } }\n");

const workspaces = [
  { slug: "legacy-a", label: "레거시 A", kind: "code", roots: [legacyRoots["legacy-a"]], includeExt: [".cs"], excludeDirs: [], excludeFiles: [] },
  { slug: "legacy-b", label: "레거시 B", kind: "code", roots: [legacyRoots["legacy-b"]], includeExt: [".cs"], excludeDirs: [], excludeFiles: [] },
  { slug: "legacy-c", label: "레거시 C", kind: "code", roots: [legacyRoots["legacy-c"]], includeExt: [".cs"], excludeDirs: [], excludeFiles: [] },
  { slug: "legacy-d", label: "레거시 D", kind: "code", roots: [legacyRoots["legacy-d"]], includeExt: [".cs"], excludeDirs: [], excludeFiles: [] },
  { slug: "legacy-e", label: "레거시 E", kind: "code", roots: [legacyRoots["legacy-e"]], includeExt: [".cs"], excludeDirs: [], excludeFiles: [] },
  { slug: "current-code", label: "현재 코드", kind: "code", roots: [currentRoot], includeExt: [".cs"], excludeDirs: [], excludeFiles: [] },
  { slug: "spec-docs", label: "스펙", kind: "docs", roots: [specRoot], includeExt: [".pdf"], excludeDirs: [], excludeFiles: [] },
  { slug: "ambiguous-ws", label: "모호한 출처", kind: "code", roots: [ambigRootA, ambigRootB], includeExt: [".cs"], excludeDirs: [], excludeFiles: [] },
  { slug: "never-indexed", label: "미인덱싱", kind: "code", roots: [neverRoot], includeExt: [".cs"], excludeDirs: [], excludeFiles: [] },
];
const workspacesPath = path.join(tmpRoot, "workspaces.json");
fs.writeFileSync(workspacesPath, JSON.stringify(workspaces, null, 2));

process.env.GREPLET_WORKSPACES = workspacesPath;
process.env.GREPLET_DATA_DIR = dataDir;
process.env.OLLAMA_URL = "http://127.0.0.1:1"; // Always deterministic/offline, even if the user's shell configures Ollama.

// Homebrew dotnet@8 은 keg-only 라 DOTNET_ROOT 없이는 Extractor(apphost)가 런타임을 못 찾는다(incremental.mjs 와 동일 규칙).
if (!process.env.DOTNET_ROOT) {
  for (const keg of ["/opt/homebrew/opt/dotnet@8/libexec", "/usr/local/opt/dotnet@8/libexec"]) {
    if (fs.existsSync(path.join(keg, "dotnet"))) {
      process.env.DOTNET_ROOT = keg;
      break;
    }
  }
}

const { loadConfig, loadWorkspaces, findWorkspace } = await import("../dist/config.js");
const { JobManager } = await import("../dist/indexJob.js");
const { manifestPathFor } = await import("../dist/db.js");
const { loadManifest } = await import("../dist/scan.js");
const { searchEvidence, getEvidence, EvidenceError } = await import("../dist/evidence.js");

const cfg = loadConfig();
const allWorkspaces = loadWorkspaces(cfg);
const jm = new JobManager(cfg, (slug) => findWorkspace(allWorkspaces, slug));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForJob(jobId) {
  for (let i = 0; i < 1200; i++) {
    const rec = jm.getJob(jobId);
    if (rec.state === "done" || rec.state === "failed") return rec;
    await sleep(500);
  }
  throw new Error(`잡 타임아웃: ${jobId}`);
}

async function runIndex(slug, force = false) {
  const { jobId } = jm.enqueue(slug, force);
  const rec = await waitForJob(jobId);
  if (rec.state === "failed") throw new Error(`인덱스 잡 실패(${slug}): ${rec.error}`);
  return rec;
}

function ws(slug) {
  return findWorkspace(allWorkspaces, slug);
}

async function evidenceSearch(body, isIndexing = () => false) {
  return searchEvidence(cfg, allWorkspaces, body, isIndexing);
}

async function evidenceGet(evidenceRefBody, isIndexing = () => false) {
  return getEvidence(cfg, allWorkspaces, { evidenceRef: evidenceRefBody }, isIndexing);
}

async function expectEvidenceError(promise, status, code) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof EvidenceError, `EvidenceError 여야 함 (실제 ${err?.constructor?.name})`);
    assert.equal(err.status, status, `status 는 ${status} 여야 함 (실제 ${err.status}, code=${err.code}, msg=${err.message})`);
    if (code) assert.equal(err.code, code, `code 는 ${code} 여야 함 (실제 ${err.code})`);
    return err;
  }
  throw new Error(`오류가 발생해야 함 (status=${status}, code=${code})`);
}

function findHitFor(target, filePred = () => true) {
  return target.hits.find((h) => filePred(h.file));
}

async function main() {
  console.log("[evidence] tmpRoot =", tmpRoot);

  // ---------- 초기 인덱싱(모호한 출처·미인덱싱 워크스페이스 제외) ----------
  for (const slug of ["legacy-a", "legacy-b", "legacy-c", "legacy-d", "legacy-e", "current-code", "spec-docs"]) {
    const rec = await runIndex(slug);
    if (rec.chunks === 0 && slug !== "spec-docs") {
      throw new Error(`초기 인덱싱에서 청크가 0개(${slug}) — fixture 나 Extractor 를 확인해야 함`);
    }
  }

  const manifestEmbeddings = loadManifest(manifestPathFor(cfg, "legacy-a")).embeddings;
  console.log(`[evidence] embeddings=${manifestEmbeddings} (OLLAMA_URL=${process.env.OLLAMA_URL})`);

  // ================= 1) 검색 응답 구조·출처 보존·기본값/최댓값 =================
  await section("검색: 워크스페이스별 출처 보존(빈 결과 포함) + schemaVersion", async () => {
    const res = await evidenceSearch({ query: "Compute", workspaces: ["legacy-a", "legacy-b", "never-indexed"] });
    assert.equal(res.schemaVersion, 1);
    assert.equal(res.query, "Compute");
    assert.equal(res.targets.length, 3);
    const a = res.targets.find((t) => t.workspace === "legacy-a");
    const b = res.targets.find((t) => t.workspace === "legacy-b");
    const never = res.targets.find((t) => t.workspace === "never-indexed");
    assert.equal(a.status, "ok");
    assert.equal(b.status, "ok");
    assert.equal(never.status, "not_indexed");
  });

  await section("검색: 같은 본문(legacy-b/legacy-c)도 출처가 다르면 모두 남고 건수가 일치", async () => {
    const res = await evidenceSearch({ query: "Compute", workspaces: ["legacy-b", "legacy-c"] });
    const b = res.targets.find((t) => t.workspace === "legacy-b");
    const c = res.targets.find((t) => t.workspace === "legacy-c");
    assert.equal(b.hits.length, 1);
    assert.equal(c.hits.length, 1);
    assert.equal(b.hits[0].contentHash, c.hits[0].contentHash, "같은 본문이므로 contentHash 는 같아야 함");
    assert.equal(b.hits[0].fileHash, c.hits[0].fileHash, "같은 파일 바이트이므로 fileHash 도 같아야 함");
    assert.notEqual(b.workspace, c.workspace, "출처(workspace)는 병합되지 않고 구분돼야 함");
  });

  await section("검색: 서로 다른 워크스페이스의 같은 심볼을 혼동하지 않음(뒤쪽 동작 상이)", async () => {
    const res = await evidenceSearch({ query: "Compute", workspaces: ["legacy-a", "legacy-d", "legacy-e"] });
    const texts = res.targets.map((t) => t.hits[0]?.excerpt.text ?? "");
    assert.ok(texts[0].includes("alpha subtracts"), "legacy-a 발췌에 alpha 동작이 보여야 함");
    assert.ok(texts[1].includes("delta clamps"), "legacy-d 발췌에 delta 동작이 보여야 함");
    assert.ok(texts[2].includes("epsilon negates"), "legacy-e 발췌에 epsilon 동작이 보여야 함");
    const hashes = new Set(res.targets.map((t) => t.hits[0].fileHash));
    assert.equal(hashes.size, 3, "세 워크스페이스의 fileHash 는 모두 달라야 함");
  });

  await section("검색: topN 기본값 3, 최댓값 20 초과 거부", async () => {
    const def = await evidenceSearch({ query: "adjusted", workspaces: ["current-code"] });
    assert.ok(def.targets[0].hits.length <= 3, `기본 topN=3 이내여야 함 (실제 ${def.targets[0].hits.length})`);
    const capped = await evidenceSearch({ query: "adjusted", workspaces: ["current-code"], topN: 2 });
    assert.equal(capped.targets[0].hits.length, 2);
    await assert.rejects(
      evidenceSearch({ query: "adjusted", workspaces: ["current-code"], topN: 21 }),
      (err) => err instanceof EvidenceError && err.status === 400 && err.code === "invalid_request",
    );
  });

  await section("검색: 잘못된 요청 400(query 누락, workspaces 형식, mode, 미등록 워크스페이스)", async () => {
    await expectEvidenceError(evidenceSearch({ workspaces: ["legacy-a"] }), 400, "invalid_request");
    await expectEvidenceError(evidenceSearch({ query: "x", workspaces: [] }), 400, "invalid_request");
    await expectEvidenceError(evidenceSearch({ query: "x", workspaces: "legacy-a" }), 400, "invalid_request");
    await expectEvidenceError(evidenceSearch({ query: "x", workspaces: ["legacy-a"], mode: "bogus" }), 400, "invalid_request");
    await expectEvidenceError(evidenceSearch({ query: "x", workspaces: ["no-such-ws"] }), 400, "invalid_request");
  });

  // ================= 2) 메타데이터/해시 일관성 =================
  let refA;
  await section("메타데이터: fileHash·contentHash 가 실제 바이트/텍스트의 SHA-256 과 일치", async () => {
    const res = await evidenceSearch({ query: "Compute", workspaces: ["legacy-a"] });
    const hit = res.targets[0].hits[0];
    refA = hit.evidenceRef;
    const detail = await evidenceGet(refA);
    const bytes = fs.readFileSync(path.join(legacyRoots["legacy-a"], "Billing", "Calculator.cs"));
    const expectedFileHash = crypto.createHash("sha256").update(bytes).digest("hex");
    const expectedContentHash = crypto.createHash("sha256").update(detail.evidence.text, "utf8").digest("hex");
    assert.equal(hit.fileHash, expectedFileHash);
    assert.equal(hit.contentHash, expectedContentHash);
    assert.equal(detail.evidence.fileHash, expectedFileHash);
    assert.equal(detail.evidence.contentHash, expectedContentHash);
    assert.equal(detail.evidence.freshness, "verified");
    assert.equal(detail.schemaVersion, 1);
    assert.equal(detail.evidence.text.includes("alpha subtracts"), true);
  });

  // ================= 3) 상세 조회: 워크스페이스 혼동 금지 / 잘못된 참조 =================
  await section("조회: 다른 워크스페이스 필드로 바꾸면 실제 내용 불일치 시 stale, 동일 내용이면 검증 통과", async () => {
    // legacy-a 의 해시로 legacy-d(다른 내용) 를 가리키면 stale
    const crossed = { ...refA, workspace: "legacy-d" };
    await expectEvidenceError(evidenceGet(crossed), 409, "stale_evidence");

    // legacy-b/legacy-c 는 내용이 완전히 같으므로 워크스페이스만 바꿔도 정상적으로 검증됨(내용 동일성일 뿐 출처 오염이 아님)
    const bRes = await evidenceSearch({ query: "Compute", workspaces: ["legacy-b"] });
    const bRef = bRes.targets[0].hits[0].evidenceRef;
    const asC = { ...bRef, workspace: "legacy-c" };
    const detail = await evidenceGet(asC);
    assert.equal(detail.evidence.workspace, "legacy-c");
  });

  await section("조회: 잘못된 해시/범위/존재하지 않는 참조", async () => {
    const tamperedHash = { ...refA, fileHash: refA.fileHash.slice(0, -1) + (refA.fileHash.endsWith("0") ? "1" : "0") };
    await expectEvidenceError(evidenceGet(tamperedHash), 409, "stale_evidence");

    const tamperedRange = { ...refA, startLine: refA.startLine + 1 };
    await expectEvidenceError(evidenceGet(tamperedRange), 409, "stale_evidence");

    const noSuchChunk = { ...refA, chunkId: refA.chunkId + "#nope" };
    await expectEvidenceError(evidenceGet(noSuchChunk), 404, "not_found");

    const noSuchWs = { ...refA, workspace: "no-such-ws" };
    await expectEvidenceError(evidenceGet(noSuchWs), 404, "not_found");

    const badHashFormat = { ...refA, fileHash: "not-a-hash" };
    await expectEvidenceError(evidenceGet(badHashFormat), 400, "invalid_request");

    const badRange = { ...refA, startLine: refA.endLine + 5 };
    await expectEvidenceError(evidenceGet(badRange), 400, "invalid_request");
  });

  // ================= 4) 변경 없는 재인덱싱은 같은 참조 유지 =================
  await section("재인덱싱(변경 없음): 근거 참조가 그대로 유지됨", async () => {
    await runIndex("legacy-a", false);
    const res = await evidenceSearch({ query: "Compute", workspaces: ["legacy-a"] });
    const refAfter = res.targets[0].hits[0].evidenceRef;
    assert.deepEqual(refAfter, refA, "청크 내용이 안 바뀌었으니 evidenceRef 는 동일해야 함");
    const detail = await evidenceGet(refA);
    assert.equal(detail.evidence.freshness, "verified");
  });

  // ================= 5) 동일 심볼 본문 변경: 재인덱싱 전/후 모두 오래된 근거는 정상 처리 안 함 =================
  await section("동일 심볼 본문 변경: 재인덱싱 전에도 원본 해시 불일치로 stale, 재인덱싱 후에도 이전 참조는 stale, 새 참조는 검증됨", async () => {
    const before = await evidenceGet(refA); // 사전 확인: 아직 유효
    assert.equal(before.evidence.freshness, "verified");

    const filePath = path.join(legacyRoots["legacy-a"], "Billing", "Calculator.cs");
    fs.writeFileSync(filePath, calculatorFile("        if (adjusted > 100) return 999; // mutated for staleness test\n        return adjusted;\n"));

    // 재인덱싱 전: 원본 파일 해시가 이미 달라졌으므로 즉시 stale
    await expectEvidenceError(evidenceGet(refA), 409, "stale_evidence");

    await runIndex("legacy-a", false);

    // 재인덱싱 후: 이전 참조는 여전히 정상 근거로 반환되면 안 됨
    await expectEvidenceError(evidenceGet(refA), 409, "stale_evidence");

    // 새로 검색하면 새 참조가 나오고, 그 참조는 검증됨
    const res = await evidenceSearch({ query: "Compute", workspaces: ["legacy-a"] });
    const newRef = res.targets[0].hits[0].evidenceRef;
    assert.notDeepEqual(newRef, refA, "본문이 바뀌었으니 새 evidenceRef 는 이전과 달라야 함");
    const detail = await evidenceGet(newRef);
    assert.equal(detail.evidence.freshness, "verified");
    assert.ok(detail.evidence.text.includes("mutated for staleness test"));
  });

  // ================= 6) 삭제된 원본 =================
  await section("삭제된 원본: 재인덱싱 전에는 source_unavailable", async () => {
    const res = await evidenceSearch({ query: "Compute", workspaces: ["legacy-e"] });
    const refE = res.targets[0].hits[0].evidenceRef;
    fs.rmSync(path.join(legacyRoots["legacy-e"], "Billing", "Calculator.cs"));
    await expectEvidenceError(evidenceGet(refE), 409, "source_unavailable");
    // 정리: 재인덱싱해 매니페스트도 일관되게 만든다(다음 섹션에 영향 없음)
    await runIndex("legacy-e", false);
    await expectEvidenceError(evidenceGet(refE), 404, "not_found");
  });

  // ================= 7) 빈 결과 vs 미인덱싱 =================
  await section("빈 결과 vs 미인덱싱 구분", async () => {
    const noHits = await evidenceSearch({ query: "zzz_absolutely_not_present_zzz", workspaces: ["legacy-d"] });
    assert.equal(noHits.targets[0].status, "no_hits");
    const notIndexed = await evidenceSearch({ query: "anything", workspaces: ["never-indexed"] });
    assert.equal(notIndexed.targets[0].status, "not_indexed");
    await expectEvidenceError(evidenceGet({
      workspace: "never-indexed", chunkId: "Idle.cs#Idle.M()",
      fileHash: "0".repeat(64), contentHash: "0".repeat(64), startLine: 1, endLine: 1,
    }), 404, "not_found");
  });

  // ================= 8) hybrid 요청이 임베딩 없는 데이터에서 fts 로 강등 =================
  await section("hybrid 요청이 임베딩 없는 데이터에서 fts 로 강등 + 경고", async () => {
    assert.equal(manifestEmbeddings, "none", `이 테스트는 Ollama 없는 환경을 전제로 함 (실제 embeddings=${manifestEmbeddings})`);
    const res = await evidenceSearch({ query: "Compute", workspaces: ["legacy-d"], mode: "hybrid" });
    const t = res.targets[0];
    assert.equal(t.effectiveMode, "fts");
    assert.ok(t.warnings.some((w) => w.includes("fts")), `fts 강등 경고가 있어야 함 (실제 ${JSON.stringify(t.warnings)})`);
    assert.equal(t.status, "ok");
  });

  // ================= 9) 모호한 출처 =================
  await section("모호한 출처: 검색은 ambiguous_source, 조회는 409", async () => {
    const res = await evidenceSearch({ query: "M", workspaces: ["ambiguous-ws"] });
    assert.equal(res.targets[0].status, "ambiguous_source");
    assert.ok(res.targets[0].warnings.length > 0);
    await expectEvidenceError(evidenceGet({
      workspace: "ambiguous-ws", chunkId: "Dup.cs#DupA.M()",
      fileHash: "0".repeat(64), contentHash: "0".repeat(64), startLine: 1, endLine: 1,
    }), 409, "ambiguous_source");
  });

  // ================= 10) 인덱싱 중 상태 =================
  await section("인덱싱 중: 검색은 indexing 상태, 조회는 409", async () => {
    fs.writeFileSync(
      path.join(legacyRoots["legacy-d"], "Billing", "Extra.cs"),
      "namespace Billing;\npublic class Extra { public int N() { return 1; } }\n",
    );
    const { jobId } = jm.enqueue("legacy-d", false);
    assert.ok(jm.isIndexing("legacy-d"), "enqueue 직후에는 isIndexing 이 true 여야 함");
    const res = await evidenceSearch({ query: "Compute", workspaces: ["legacy-d"] }, (slug) => jm.isIndexing(slug));
    assert.equal(res.targets[0].status, "indexing");
    await expectEvidenceError(
      evidenceGet(
        { workspace: "legacy-d", chunkId: "x#y", fileHash: "0".repeat(64), contentHash: "0".repeat(64), startLine: 1, endLine: 1 },
        (slug) => jm.isIndexing(slug),
      ),
      409,
      "indexing",
    );
    const rec = await waitForJob(jobId);
    assert.equal(rec.state, "done");
  });

  // ================= 11) PDF 페이지/분할 청크 조회 =================
  await section("PDF: 일반 페이지 조회(위치·본문 일치)", async () => {
    const res = await evidenceSearch({ query: "clamp", workspaces: ["spec-docs"], mode: "fts" });
    const t = res.targets[0];
    assert.equal(t.status, "ok", `spec-docs 검색이 히트를 반환해야 함 (targets=${JSON.stringify(t)})`);
    const hit = t.hits.find((h) => h.file.endsWith("spec-normal.pdf"));
    assert.ok(hit, "spec-normal.pdf 히트가 있어야 함");
    assert.equal(hit.location.unit, "page");
    assert.equal(hit.location.start, 1);
    assert.equal(hit.location.end, 1);
    const detail = await evidenceGet(hit.evidenceRef);
    assert.ok(detail.evidence.text.includes("alpha behavior"), "본문 전체에 스펙 문장이 그대로 있어야 함");
  });

  await section("PDF: 3000자 초과 페이지가 분할되고, 분할 청크 각각을 정확히 재조회", async () => {
    const res = await evidenceSearch({ query: "padding", workspaces: ["spec-docs"], mode: "fts", topN: 20 });
    const t = res.targets[0];
    const largeHits = t.hits.filter((h) => h.file.endsWith("spec-large.pdf"));
    assert.ok(largeHits.length >= 2, `spec-large.pdf 는 최소 2개 분할 청크를 가져야 함 (실제 ${largeHits.length})`);
    for (const h of largeHits) {
      assert.equal(h.location.unit, "page");
      const detail = await evidenceGet(h.evidenceRef);
      assert.equal(detail.evidence.evidenceRef.chunkId, h.evidenceRef.chunkId);
      assert.ok(detail.evidence.text.length > 0);
      assert.equal(crypto.createHash("sha256").update(detail.evidence.text, "utf8").digest("hex"), h.evidenceRef.contentHash);
    }
    const ids = new Set(largeHits.map((h) => h.evidenceRef.chunkId));
    assert.equal(ids.size, largeHits.length, "분할 청크의 chunkId 는 서로 달라야 함");
  });

  // ================= 12) HTTP 라우트(임시 포트) =================
  await section("HTTP: /api/evidence/search, /api/evidence/get 이 직접 호출과 동일한 근거를 반환", async () => {
    const port = await getFreePort();
    const child = spawn(process.execPath, [path.join(indexerRoot, "dist", "server.js")], {
      env: { ...process.env, GREPLET_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    try {
      await waitForHttp(`http://127.0.0.1:${port}/healthz`, 20000);

      const searchRes = await fetch(`http://127.0.0.1:${port}/api/evidence/search`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "Compute", workspaces: ["legacy-b"] }),
      });
      assert.equal(searchRes.status, 200);
      const searchBody = await searchRes.json();
      assert.equal(searchBody.schemaVersion, 1);
      const httpRef = searchBody.targets[0].hits[0].evidenceRef;

      const getRes = await fetch(`http://127.0.0.1:${port}/api/evidence/get`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ evidenceRef: httpRef }),
      });
      assert.equal(getRes.status, 200);
      const getBody = await getRes.json();
      assert.equal(getBody.evidence.freshness, "verified");

      const badRes = await fetch(`http://127.0.0.1:${port}/api/evidence/search`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaces: ["legacy-b"] }),
      });
      assert.equal(badRes.status, 400);
      const badBody = await badRes.json();
      assert.equal(badBody.error.code, "invalid_request");

      const notFoundRes = await fetch(`http://127.0.0.1:${port}/api/evidence/get`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ evidenceRef: { ...httpRef, chunkId: httpRef.chunkId + "#nope" } }),
      });
      assert.equal(notFoundRes.status, 404);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.on("close", resolve));
      if (failures.length && out) console.error("[evidence] 서버 로그:\n" + out.slice(-4000));
    }
  });

  if (failures.length) {
    console.error(`\n[evidence] 실패 ${failures.length}건:`);
    for (const f of failures) console.error(`- ${f.name}\n  ${f.error}\n`);
    throw new Error(`${failures.length}건 실패`);
  }
  console.log("\n[evidence] 전체 통과");
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch (err) {
      lastErr = err;
    }
    await sleep(200);
  }
  throw new Error(`서버가 기동하지 않음: ${url} (${lastErr?.message ?? ""})`);
}

main()
  .then(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error("[evidence] 실패:", err instanceof Error ? err.message : err);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    process.exit(1);
  });
