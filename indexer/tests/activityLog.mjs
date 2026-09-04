// activityLog.mjs — 검색 활동 로그 영속화 검증(§계약: /tmp/greplet-live/contract.md).
//   1) 서버를 띄워 검색을 몇 건 수행 -> logs/activity/search-<오늘>.jsonl 파일 생성 확인, /api/usage 확인
//   2) 서버를 SIGTERM 으로 끄고 같은 데이터 디렉터리로 재기동 -> /api/activity 로 카운터/이력 복원 확인
//   3) GREPLET_ACTIVITY_LOG=off 인 별도 서버 -> 파일 미생성 + /api/usage.disabled===true 확인

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "greplet-activitylog-"));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForHealthz(baseUrl, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return (async function poll() {
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${baseUrl}/healthz`);
        if (res.ok) return;
      } catch {
        // 서버 아직 미기동
      }
      await sleep(300);
    }
    throw new Error("서버가 healthz 응답을 하지 않음(타임아웃)");
  })();
}

function makeWorkspace(tmpDir, slug) {
  const srcDir = path.join(tmpDir, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, "a.txt"), "hello activity log world\n");
  const workspacesPath = path.join(tmpDir, "workspaces.json");
  fs.writeFileSync(
    workspacesPath,
    JSON.stringify(
      [
        {
          slug,
          label: "활동 로그 테스트",
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
  return workspacesPath;
}

function spawnServer(port, env) {
  const serverJs = path.resolve("dist/server.js");
  const child = spawn(process.execPath, [serverJs], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stderrBuf = "";
  child.stderr.on("data", (d) => {
    stderrBuf += d.toString();
  });
  return { child, getStderr: () => stderrBuf };
}

async function stopServer(child) {
  const exitPromise = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.kill("SIGTERM");
  const result = await Promise.race([exitPromise, sleep(5000).then(() => ({ timedOut: true }))]);
  if (result.timedOut) {
    child.kill("SIGKILL");
    throw new Error("서버가 SIGTERM 후 5초 내에 종료되지 않음(프로세스 잔류)");
  }
  return result;
}

async function doSearch(baseUrl, client = "cli") {
  const res = await fetch(`${baseUrl}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Greplet-Client": client },
    body: JSON.stringify({ query: "hello", workspaces: "all", mode: "fts" }),
  });
  assert.ok(res.ok, "/api/search 는 200 이어야 함");
  return res.json();
}

async function testOnAndRestart() {
  console.log("[activityLog] 1) 기록 + /api/usage + 재기동 복원");

  const dataDir = path.join(tmpRoot, "on-data");
  fs.mkdirSync(dataDir, { recursive: true });
  const workspacesPath = makeWorkspace(path.join(tmpRoot, "on"), "activitylog-on");
  const port = 7897;
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { GREPLET_PORT: String(port), GREPLET_DATA_DIR: dataDir, GREPLET_WORKSPACES: workspacesPath };

  let { child } = spawnServer(port, env);
  await waitForHealthz(baseUrl);
  console.log("[activityLog]    1차 서버 기동 확인");

  await doSearch(baseUrl);
  await doSearch(baseUrl);

  // fire-and-forget append 가 반영될 시간을 잠깐 준다.
  await sleep(300);

  const today = new Date().toISOString().slice(0, 10);
  const logFile = path.join(dataDir, "logs", "activity", `search-${today}.jsonl`);
  assert.ok(fs.existsSync(logFile), `활동 로그 파일이 있어야 함: ${logFile}`);
  const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);
  assert.ok(lines.length >= 1, "활동 로그 파일에 최소 1줄이 있어야 함");
  const lastRecord = JSON.parse(lines[lines.length - 1]);
  assert.ok(typeof lastRecord.approxTokens === "number", "마지막 레코드의 approxTokens 는 숫자여야 함");
  assert.equal(typeof lastRecord.client, "string", "마지막 레코드의 client 는 문자열이어야 함");
  console.log(`[activityLog]    로그 파일 확인 완료(${lines.length}줄), 마지막 client=${lastRecord.client}`);

  const usageRes = await fetch(`${baseUrl}/api/usage?days=2`);
  assert.ok(usageRes.ok, "/api/usage 는 200 이어야 함");
  const usageData = await usageRes.json();
  assert.equal(usageData.days.length, 2, `/api/usage?days=2 는 days.length===2 여야 함 (실제 ${usageData.days.length})`);
  const lastDay = usageData.days[usageData.days.length - 1];
  assert.equal(lastDay.date, today, `마지막 날짜는 오늘(${today})이어야 함 (실제 ${lastDay.date})`);
  assert.ok(lastDay.searches >= 1, "오늘 searches 는 1 이상이어야 함");
  assert.ok(typeof usageData.total.approxTokens === "number", "total.approxTokens 는 숫자여야 함");
  console.log(`[activityLog]    /api/usage?days=2 확인 완료 — 오늘 searches=${lastDay.searches}, total.approxTokens=${usageData.total.approxTokens}`);

  const actBefore = await (await fetch(`${baseUrl}/api/activity`)).json();
  const totalBefore = actBefore.stats.total;

  await stopServer(child);
  console.log("[activityLog]    1차 서버 SIGTERM 종료 확인");

  // 같은 env(같은 데이터 디렉터리)로 재기동
  ({ child } = spawnServer(port, env));
  await waitForHealthz(baseUrl);
  console.log("[activityLog]    2차 서버(재기동) 기동 확인");

  const actAfter = await (await fetch(`${baseUrl}/api/activity`)).json();
  assert.ok(actAfter.stats.total >= totalBefore, `재기동 후 stats.total(${actAfter.stats.total}) 은 이전(${totalBefore}) 이상이어야 함`);
  assert.ok(actAfter.recent.length > 0, "재기동 후 recent 검색 이력이 비어있지 않아야 함");
  console.log(`[activityLog]    재기동 후 카운터/이력 복원 확인 — total: ${totalBefore} -> ${actAfter.stats.total}, recent.length=${actAfter.recent.length}`);

  await stopServer(child);
  console.log("[activityLog]    2차 서버 SIGTERM 종료 확인");
}

async function testOff() {
  console.log("[activityLog] 2) GREPLET_ACTIVITY_LOG=off");

  const dataDir = path.join(tmpRoot, "off-data");
  fs.mkdirSync(dataDir, { recursive: true });
  const workspacesPath = makeWorkspace(path.join(tmpRoot, "off"), "activitylog-off");
  const port = 7898;
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    GREPLET_PORT: String(port),
    GREPLET_DATA_DIR: dataDir,
    GREPLET_WORKSPACES: workspacesPath,
    GREPLET_ACTIVITY_LOG: "off",
  };

  const { child } = spawnServer(port, env);
  try {
    await waitForHealthz(baseUrl);
    console.log("[activityLog]    off 서버 기동 확인");

    await doSearch(baseUrl);
    await sleep(300);

    const activityDir = path.join(dataDir, "logs", "activity");
    const files = fs.existsSync(activityDir) ? fs.readdirSync(activityDir) : [];
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
    assert.equal(jsonlFiles.length, 0, `GREPLET_ACTIVITY_LOG=off 이면 jsonl 파일이 생성되지 않아야 함 (실제 ${jsonlFiles.join(",")})`);
    console.log("[activityLog]    jsonl 파일 미생성 확인");

    const usageRes = await fetch(`${baseUrl}/api/usage`);
    assert.ok(usageRes.ok);
    const usageData = await usageRes.json();
    assert.equal(usageData.disabled, true, "/api/usage 는 disabled: true 를 반환해야 함");
    console.log("[activityLog]    /api/usage disabled:true 확인");
  } finally {
    await stopServer(child);
    console.log("[activityLog]    off 서버 SIGTERM 종료 확인");
  }
}

async function main() {
  console.log("[activityLog] tmpRoot =", tmpRoot);
  await testOnAndRestart();
  await testOff();
  console.log("[activityLog] 전체 통과");
}

main()
  .then(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error("[activityLog] 실패:", err);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    process.exit(1);
  });
