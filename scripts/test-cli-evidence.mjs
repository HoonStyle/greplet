// test-cli-evidence.mjs — greplet.mjs / greplet.ps1 회귀 테스트(docs/greplet-evidence-v1.md).
// 실제 인덱서 대신 로컬 목(mock) HTTP 서버(포트 0)를 띄우고 자식 CLI 프로세스를 실행해
// (1) 레거시 파일+앞80자 중복 제거 폐지, 빈 결과에서도 경고 보존,
// (2) evidence-search 의 라우트·바디·기본 top-n=3·JSON 출력,
// (3) evidence-get 의 참조 파일 처리와 비2xx 응답 보존을 검증한다.
// 실패는 섹션 단위로 모아 마지막에 한꺼번에 보고한다.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "greplet.mjs");
const psPath = path.join(repoRoot, "greplet.ps1");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "greplet-cli-evidence-"));
const failures = [];

async function section(name, fn) {
  try {
    await fn();
    console.log(`[cli-evidence] OK   ${name}`);
  } catch (err) {
    console.error(`[cli-evidence] FAIL ${name}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    failures.push({ name, error: err instanceof Error ? err.stack ?? err.message : String(err) });
  }
}

// ---------- 목 워크스페이스 정의(단일 slug) ----------
const workspacesPath = path.join(tmpRoot, "workspaces.json");
fs.writeFileSync(workspacesPath, JSON.stringify([{ slug: "code", label: "Code", kind: "code" }]));

// ---------- 목 HTTP 서버 ----------
let capturedEvidenceSearchBody = null;
let capturedEvidenceGetBody = null;

const HASH_OK = "a".repeat(64);
const HASH_STALE = "b".repeat(64);

function jsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : null); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

const DUP_HITS = [
  { workspace: "code", file: "Lib/Calculator.cs", symbol: "Compute", kind: "method", score: 0.9,
    startLine: 10, endLine: 20, text: "shared eighty char prefix ".repeat(4).slice(0, 80) + " alpha tail behavior" },
  { workspace: "code", file: "Lib/Calculator.cs", symbol: "Compute", kind: "method", score: 0.85,
    startLine: 30, endLine: 40, text: "shared eighty char prefix ".repeat(4).slice(0, 80) + " beta tail behavior different" },
  { workspace: "code", file: "Lib/Other.cs", symbol: "Other", kind: "method", score: 0.5,
    startLine: 1, endLine: 5, text: "unrelated other file text" },
];

const FULL_TEXT = "X".repeat(350);

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/search") {
      const body = await jsonBody(req);
      if (body.query === "DUPQUERY") return send(res, 200, { hits: DUP_HITS, warnings: [], cached: false });
      if (body.query === "EMPTYQUERY") return send(res, 200, { hits: [], warnings: ["fts로 강등됨"], cached: false });
      if (body.query === "FULLQUERY") {
        return send(res, 200, {
          hits: [{ workspace: "code", file: "Lib/Full.cs", symbol: "Full", kind: "method", score: 0.7,
            startLine: 1, endLine: 2, text: FULL_TEXT }],
          warnings: [], cached: false,
        });
      }
      return send(res, 200, { hits: [], warnings: [] });
    }
    if (req.method === "POST" && req.url === "/api/evidence/search") {
      capturedEvidenceSearchBody = await jsonBody(req);
      return send(res, 200, {
        schemaVersion: 1, query: capturedEvidenceSearchBody.query, mode: capturedEvidenceSearchBody.mode,
        targets: [{ workspace: "code", label: "Code", status: "ok", effectiveMode: capturedEvidenceSearchBody.mode,
          warnings: [], hits: [] }],
      });
    }
    if (req.method === "POST" && req.url === "/api/evidence/get") {
      const body = await jsonBody(req);
      capturedEvidenceGetBody = body;
      const ref = body.evidenceRef;
      if (ref && ref.contentHash === HASH_STALE) {
        return send(res, 409, { error: { code: "stale_evidence", message: "근거 버전이 변경됐습니다" }, status: 409 });
      }
      if (ref && ref.contentHash === HASH_OK) {
        return send(res, 200, {
          schemaVersion: 1,
          evidence: { workspace: ref.workspace, file: "Lib/Calculator.cs", symbol: "Compute", kind: "method",
            text: "verified full chunk text", freshness: "verified", checkedAt: new Date().toISOString(),
            evidenceRef: ref },
        });
      }
      return send(res, 404, { error: { code: "not_found", message: "근거 참조가 인덱스에 없습니다" }, status: 404 });
    }
    send(res, 404, { error: { code: "not_found", message: "unknown route" } });
  } catch (err) {
    send(res, 500, { error: { code: "search_error", message: String(err) } });
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

// spawnSync 는 이벤트 루프를 통째로 막아 같은 프로세스에서 도는 목 서버가 응답할 수 없게 된다
// (자식이 fetch 타임아웃까지 걸린다) - 반드시 비동기 spawn 을 써야 한다.
function run(cmd, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, GREPLET_BASE_URL: baseUrl, GREPLET_WORKSPACES: workspacesPath, ...extraEnv };
    delete env.GREPLET_DEFAULT_WORKSPACE;
    const child = spawn(cmd, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => resolve({ status: null, stdout, stderr, spawnError: err }));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function runCli(args, extraEnv = {}) {
  return run(process.execPath, [cliPath, ...args], extraEnv);
}

function writeRefFile(obj) {
  const p = path.join(tmpRoot, `ref-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

// ---------- 1. 레거시 CLI(Node) 중복 제거 폐지 + 경고 보존 ----------
await section("node search: 같은 파일+앞80자, 다른 뒤쪽 동작이 모두 표시된다", async () => {
  const r = await runCli(["DUPQUERY", "-w", "code"]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const scoreLines = r.stdout.split("\n").filter((l) => l.startsWith("#"));
  assert.equal(scoreLines.length, DUP_HITS.length, `모든 히트가 표시돼야 함:\n${r.stdout}`);
  assert.match(r.stdout, /alpha tail/);
  assert.match(r.stdout, /beta tail/);
  assert.match(r.stdout, /총 3건/);
});

await section("node search: --full 플래그는 여전히 전문을 출력한다", async () => {
  const r = await runCli(["FULLQUERY", "-w", "code", "--full"]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, new RegExp(FULL_TEXT));
});

await section("node search: 결과 0건이어도 경고를 표시한다", async () => {
  const r = await runCli(["EMPTYQUERY", "-w", "code"]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /결과 없음/);
  assert.match(r.stdout, /경고: fts로 강등됨/);
});

// ---------- 2. evidence-search ----------
await section("evidence-search: 라우트/바디/기본 top-n=3/JSON 출력", async () => {
  capturedEvidenceSearchBody = null;
  const r = await runCli(["evidence-search", "재시도 로직", "-w", "code"]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.ok(capturedEvidenceSearchBody, "서버가 요청을 받아야 함");
  assert.equal(capturedEvidenceSearchBody.query, "재시도 로직");
  assert.deepEqual(capturedEvidenceSearchBody.workspaces, ["code"]);
  assert.equal(capturedEvidenceSearchBody.topN, 3);
  assert.equal(capturedEvidenceSearchBody.mode, "hybrid");
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.query, "재시도 로직");
  const jsonOccurrences = r.stdout.split('"schemaVersion"').length - 1;
  assert.equal(jsonOccurrences, 1, "JSON 출력은 한 번만 있어야 함");
});

await section("evidence-search: --all, --top-n, --mode, --file 전달", async () => {
  capturedEvidenceSearchBody = null;
  const r = await runCli(["evidence-search", "쿼리", "--all", "--top-n", "10", "--mode", "fts", "--file", "*.cs"]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.equal(capturedEvidenceSearchBody.workspaces, "all");
  assert.equal(capturedEvidenceSearchBody.topN, 10);
  assert.equal(capturedEvidenceSearchBody.mode, "fts");
  assert.equal(capturedEvidenceSearchBody.fileGlob, "*.cs");
});

await section("evidence-search: top-n > 20 은 거부된다", async () => {
  const r = await runCli(["evidence-search", "쿼리", "-w", "code", "--top-n", "21"]);
  assert.notEqual(r.status, 0);
});

// ---------- 3. evidence-get ----------
await section("evidence-get: 정상 참조 -> JSON 출력, 종료 코드 0", async () => {
  const refFile = writeRefFile({
    workspace: "code", chunkId: "chunk-1", fileHash: HASH_OK, contentHash: HASH_OK, startLine: 1, endLine: 5,
  });
  const r = await runCli(["evidence-get", "--ref-file", refFile]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.evidence.freshness, "verified");
  assert.equal(capturedEvidenceGetBody.evidenceRef.chunkId, "chunk-1");
});

await section("evidence-get: 409(stale) 응답을 그대로 보존하고 nonzero, '서버 미가동' 오인 없음", async () => {
  const refFile = writeRefFile({
    workspace: "code", chunkId: "chunk-1", fileHash: HASH_OK, contentHash: HASH_STALE, startLine: 1, endLine: 5,
  });
  const r = await runCli(["evidence-get", "--ref-file", refFile]);
  assert.notEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.status, 409);
  assert.equal(parsed.error.code, "stale_evidence");
  assert.doesNotMatch(r.stderr, /미가동/);
});

await section("evidence-get: 없는 참조 파일 -> nonzero", async () => {
  const r = await runCli(["evidence-get", "--ref-file", path.join(tmpRoot, "does-not-exist.json")]);
  assert.notEqual(r.status, 0);
});

await section("evidence-get: 참조 파일 내용이 배열이면 -> nonzero", async () => {
  const refFile = writeRefFile([1, 2, 3]);
  const r = await runCli(["evidence-get", "--ref-file", refFile]);
  assert.notEqual(r.status, 0);
});

// ---------- 4. PowerShell(가능하면) ----------
async function pwshAvailable() {
  const r = await run("pwsh", ["-NoLogo", "-Command", "$PSVersionTable.PSVersion.Major"]);
  return !r.spawnError && r.status === 0;
}

if (await pwshAvailable()) {
  await section("pwsh: 기존 위치 인자(-Query) 호출이 여전히 동작한다", async () => {
    const r = await run("pwsh", ["-NoLogo", "-NoProfile", "-File", psPath, "DUPQUERY", "-Workspace", "code"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const scoreLines = r.stdout.split("\n").filter((l) => l.startsWith("#"));
    assert.equal(scoreLines.length, DUP_HITS.length, `모든 히트가 표시돼야 함:\n${r.stdout}`);
  });

  await section("pwsh: -Command EvidenceSearch 는 위험 메타문자를 안전하게 node 로 위임한다", async () => {
    capturedEvidenceSearchBody = null;
    const dangerousQuery = '$(rm -rf /tmp/should-not-run); `echo hacked`; & whoami';
    const r = await run("pwsh", [
      "-NoLogo", "-NoProfile", "-File", psPath, "-Command", "EvidenceSearch", dangerousQuery,
      "-Workspace", "code",
    ]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(capturedEvidenceSearchBody, "서버가 요청을 받아야 함");
    assert.equal(capturedEvidenceSearchBody.query, dangerousQuery, "메타문자가 그대로 전달돼야 함(셸 해석 없이)");
  });

  await section("pwsh: $LASTEXITCODE 가 node CLI 의 종료 코드를 그대로 전파한다", async () => {
    const r = await run("pwsh", [
      "-NoLogo", "-NoProfile", "-File", psPath, "-Command", "EvidenceGet",
      "-RefFile", path.join(tmpRoot, "does-not-exist.json"),
    ]);
    assert.notEqual(r.status, 0);
  });
} else {
  console.log("[cli-evidence] SKIP pwsh 관련 테스트 (pwsh 미설치)");
}

server.close();
fs.rmSync(tmpRoot, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n[cli-evidence] ${failures.length}개 실패`);
  process.exit(1);
} else {
  console.log("\n[cli-evidence] 모든 테스트 통과");
}
