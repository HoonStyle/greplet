// activity.mjs — 활동 이벤트 버스 검증(§계약: /tmp/greplet-live/contract.md).
// incremental.mjs 와 같은 패턴(임시 워크스페이스, dist/ import, Ollama 유무 분기, 자체 assert 헬퍼)을 따른다.
//   1) 모듈 단위 — subscribeActivity 로 이벤트 수집 후 search() 2회 호출(캐시 hit/miss), getStats/getRecentSearches 확인
//   2) 인덱스 잡 — JobManager 로 잡 enqueue 후 index.start/index.stage/index.progress/index.done 순서 확인
//   3) HTTP 단위 — dist/server.js 를 자식 프로세스로 띄워 /api/events SSE, /api/search, /api/activity, SIGTERM 확인

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "greplet-activity-"));
const srcDir = path.join(tmpRoot, "src");
const dataDir = path.join(tmpRoot, "data");
fs.mkdirSync(srcDir, { recursive: true });

const SLUG = "test-activity";
const workspacesPath = path.join(tmpRoot, "workspaces.json");
fs.writeFileSync(
  workspacesPath,
  JSON.stringify(
    [
      {
        slug: SLUG,
        label: "활동 이벤트 테스트",
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

// Homebrew dotnet@8 은 keg-only 라 DOTNET_ROOT 없이는 Extractor(apphost)가 런타임을 못 찾는다(start-indexer.sh 와 동일 규칙).
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
const { search } = await import("../dist/search.js");
const { checkOllama } = await import("../dist/embed.js");
const { subscribeActivity, getRecentSearches, getStats } = await import("../dist/activity.js");

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
  return { jobId, rec };
}

// ---------- 1) 모듈 단위 ----------
async function testModuleLevel() {
  console.log("[activity] 1) 모듈 단위 — search() 이벤트 시퀀스");

  // 검색 대상 워크스페이스를 준비하기 위해 파일 하나를 인덱싱해둔다.
  fs.writeFileSync(path.join(srcDir, "a.txt"), "hello world one\nsecond line a\n");
  await runIndex();

  const ollama = await checkOllama(cfg);
  const embedReady = ollama.ok && ollama.hasModel;

  // Ollama 가 없는 환경에서는 hybrid 검색이 fts 로 강등되며 warning 을 남겨 캐시되지 않는다(search.ts: warnings.length===0 일 때만 cacheSet).
  // 캐시 hit/miss 를 검증하려면 warning 이 없는 경로가 필요하므로, embedReady 여부에 따라 모드를 고른다.
  const mode = embedReady ? "hybrid" : "fts";

  const events1 = [];
  const unsubscribe1 = subscribeActivity((ev) => events1.push(ev));
  const result1 = await search(cfg, [findWorkspace(workspaces, SLUG)], "hello", 6, mode, { client: "test" });
  unsubscribe1();

  assert.equal(result1.cached, undefined, "1회차 검색 결과는 cached 가 아니어야 함(비어있거나 false)");
  assert.equal(result1.warnings.length, 0, `1회차 검색은 warning 이 없어야 캐시가 성립함 (실제 ${JSON.stringify(result1.warnings)})`);

  const types1 = events1.map((e) => e.type);
  console.log("[activity]    1회차 이벤트 순서:", types1.join(" -> "));

  assert.equal(types1[0], "search.start", "1회차 첫 이벤트는 search.start 여야 함");
  const cacheStageIdx = types1.findIndex((t, i) => t === "search.stage" && events1[i].workspace === "*" && events1[i].stage === "cache");
  assert.notEqual(cacheStageIdx, -1, "cache stage 이벤트가 있어야 함");
  assert.equal(events1[cacheStageIdx].status, "skip", "1회차 cache stage 는 skip 이어야 함(캐시 미스)");

  const sortStageIdx = types1.findIndex((t, i) => t === "search.stage" && events1[i].workspace === "*" && events1[i].stage === "sort");
  assert.notEqual(sortStageIdx, -1, "sort stage(enter) 이벤트가 있어야 함");
  assert.equal(events1[sortStageIdx].status, "enter");
  assert.ok(sortStageIdx > cacheStageIdx, "sort stage 는 cache stage 이후여야 함");

  const doneIdx = types1.indexOf("search.done");
  assert.equal(doneIdx, types1.length - 1, "1회차 마지막 이벤트는 search.done 이어야 함");
  assert.equal(events1[doneIdx].cached, false, "1회차 search.done.cached 는 false 여야 함");

  // 워크스페이스 stage 들 확인.
  // search.ts 의 embed 강등 판단(`if (effectiveMode !== "fts")`)은 mode 를 처음부터 "fts" 로 호출하면 아예 타지 않는다.
  // 즉 embed skip 이벤트는 mode="hybrid"(Ollama 없음 -> 강등) 인 경우에만 나오고, mode="fts" 로 직접 호출하면 embed stage 자체가 없다.
  const wsStages = events1.filter((e) => e.type === "search.stage" && e.workspace === SLUG);
  const embedStage = wsStages.find((e) => e.stage === "embed");
  if (mode === "hybrid") {
    assert.ok(embedStage, "Ollama 있는 환경(mode=hybrid)에서는 embed stage 이벤트가 있어야 함");
    assert.equal(embedStage.status, "enter", "Ollama 있는 환경의 embed stage 는 enter 여야 함");
  } else {
    assert.equal(embedStage, undefined, "mode=fts 로 직접 호출하면 embed 강등 판단 자체를 안 타서 embed stage 가 없어야 함");
  }
  const ftsStage = wsStages.find((e) => e.stage === "fts");
  assert.ok(ftsStage, "fts 경로에서는 fts stage 이벤트가 있어야 함");
  assert.equal(ftsStage.status, "enter");

  // seq 단조 증가
  for (let i = 1; i < events1.length; i++) {
    assert.ok(events1[i].seq > events1[i - 1].seq, "seq 는 단조 증가해야 함");
  }

  // ---------- 2회차: 동일 질의 -> 캐시 hit ----------
  const events2 = [];
  const unsubscribe2 = subscribeActivity((ev) => events2.push(ev));
  const result2 = await search(cfg, [findWorkspace(workspaces, SLUG)], "hello", 6, mode, { client: "test" });
  unsubscribe2();

  assert.equal(result2.cached, true, "2회차 검색은 캐시 hit 이어야 함");

  const types2 = events2.map((e) => e.type);
  console.log("[activity]    2회차 이벤트 순서:", types2.join(" -> "));
  assert.deepEqual(types2, ["search.start", "search.stage", "search.done"], "2회차 이벤트는 start/cache-stage(enter)/done 세 개뿐이어야 함");
  assert.equal(events2[1].stage, "cache");
  assert.equal(events2[1].status, "enter", "2회차 cache stage 는 enter 여야 함(캐시 히트)");
  assert.equal(events2[2].cached, true, "2회차 search.done.cached 는 true 여야 함");

  for (let i = 1; i < events2.length; i++) {
    assert.ok(events2[i].seq > events2[i - 1].seq, "2회차 seq 도 단조 증가해야 함");
  }
  assert.ok(events2[0].seq > events1[events1.length - 1].seq, "2회차 seq 는 1회차보다 커야 함");

  // ---------- getStats/getRecentSearches ----------
  const stats = getStats();
  assert.equal(stats.total, 2, `getStats().total 은 2 여야 함 (실제 ${stats.total})`);
  assert.equal(stats.cacheHitRate, 0.5, `cacheHitRate 는 0.5 여야 함 (실제 ${stats.cacheHitRate})`);
  assert.equal(stats.byClient.test, 2, `byClient.test 는 2 여야 함 (실제 ${JSON.stringify(stats.byClient)})`);

  const recent = getRecentSearches(1);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].query, "hello", "getRecentSearches(1)[0].query 는 채워져 있어야 함");
  assert.deepEqual(recent[0].workspaces, [SLUG], "getRecentSearches(1)[0].workspaces 는 채워져 있어야 함");

  console.log(
    `[activity]    통과 — mode=${mode}, embedReady=${embedReady}, stats.total=${stats.total}, cacheHitRate=${stats.cacheHitRate}`,
  );
  console.log("[activity]    참고: GREPLET_ACTIVITY_QUERY=hidden 은 프로세스 시작 시 읽히므로 이 인프로세스 테스트에서는 검증 생략(별도 프로세스 필요).");
}

// ---------- 2) 인덱스 잡 ----------
async function testIndexJob() {
  console.log("[activity] 2) 인덱스 잡 — index.start/stage/progress/done 시퀀스");

  fs.writeFileSync(path.join(srcDir, "b.txt"), Array.from({ length: 50 }, (_, i) => `line ${i} of b`).join("\n") + "\n");

  const events = [];
  const unsubscribe = subscribeActivity((ev) => events.push(ev));
  const { jobId, rec } = await runIndex(true); // force 로 전체 재인덱스 -> extract/embed/store 단계까지 모두 탐
  unsubscribe();

  const jobEvents = events.filter((e) => "jobId" in e && e.jobId === jobId);
  const types = jobEvents.map((e) => e.type);
  console.log("[activity]    인덱스 잡 이벤트 순서:", types.join(" -> "));

  assert.equal(types[0], "index.start", "첫 이벤트는 index.start 여야 함");
  assert.equal(types[types.length - 1], "index.done", "마지막 이벤트는 index.done 이어야 함(실패하지 않는 한)");

  const stageEvents = jobEvents.filter((e) => e.type === "index.stage");
  assert.ok(stageEvents.length > 0, "index.stage 이벤트가 있어야 함");
  assert.equal(stageEvents[0].stage, "check", "첫 stage 는 check 여야 함");
  assert.equal(stageEvents[stageEvents.length - 1].stage, "optimize", "마지막 stage 는 optimize 여야 함");

  const progressEvents = jobEvents.filter((e) => e.type === "index.progress");
  if (progressEvents.length > 0) {
    const byStage = new Map();
    for (const p of progressEvents) {
      assert.ok(p.done <= p.total, `progress.done(${p.done}) <= total(${p.total}) 이어야 함`);
      const prev = byStage.get(p.stage);
      if (prev !== undefined) {
        assert.ok(p.done >= prev, `같은 stage(${p.stage}) 내에서 done 은 단조 증가해야 함 (이전=${prev}, 현재=${p.done})`);
      }
      byStage.set(p.stage, p.done);
    }
    console.log(`[activity]    progress 이벤트 ${progressEvents.length}건 확인(stage별 단조 증가)`);
  } else {
    console.log("[activity]    progress 이벤트 없음(청크 수가 배치 임계값 미만이거나 embed 스킵) — 통과 처리");
  }

  const finalRec = jm.getJob(jobId);
  assert.equal(finalRec.stage, "optimize", `완료 후 JobRecord.stage 는 optimize 여야 함 (실제 ${finalRec.stage})`);
  assert.ok(
    finalRec.progress === undefined || finalRec.progress.done === finalRec.progress.total,
    "완료 후 progress 는 undefined 이거나 done===total 이어야 함",
  );

  console.log(`[activity]    통과 — jobId=${jobId}, stages=${stageEvents.map((s) => s.stage).join(",")}`);
}

// ---------- 3) HTTP 단위 ----------
const HTTP_PORT = 7896;

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

async function readSseFramesUntil(reader, predicate, timeoutMs) {
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  const frames = [];
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const { value, done } = await Promise.race([
      reader.read(),
      sleep(Math.max(0, remaining)).then(() => ({ value: undefined, done: false, timedOut: true })),
    ]);
    if (done) break;
    if (value === undefined) continue; // timedOut 슬라이스, 루프 재시도(deadline 체크)
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (!raw.trim() || raw.startsWith(":")) continue;
      const frame = { event: "message" };
      for (const line of raw.split("\n")) {
        if (line.startsWith("event: ")) frame.event = line.slice("event: ".length);
        else if (line.startsWith("data: ")) frame.data = line.slice("data: ".length);
        else if (line.startsWith("id: ")) frame.id = line.slice("id: ".length);
      }
      frames.push(frame);
      if (predicate(frames)) return frames;
    }
  }
  return frames;
}

async function testHttpLevel() {
  console.log("[activity] 3) HTTP 단위 — /api/events, /api/search, /api/activity, SIGTERM");

  const httpDataDir = path.join(tmpRoot, "http-data");
  fs.mkdirSync(httpDataDir, { recursive: true });
  const httpSrcDir = path.join(tmpRoot, "http-src");
  fs.mkdirSync(httpSrcDir, { recursive: true });
  fs.writeFileSync(path.join(httpSrcDir, "c.txt"), "hello http world\n");

  const httpWorkspacesPath = path.join(tmpRoot, "http-workspaces.json");
  fs.writeFileSync(
    httpWorkspacesPath,
    JSON.stringify(
      [
        {
          slug: "http-test",
          label: "HTTP 테스트",
          kind: "code",
          roots: [httpSrcDir],
          includeExt: [".txt"],
          excludeDirs: [],
          excludeFiles: [],
        },
      ],
      null,
      2,
    ),
  );

  const serverJs = path.resolve("dist/server.js");
  const env = {
    ...process.env,
    GREPLET_PORT: String(HTTP_PORT),
    GREPLET_DATA_DIR: httpDataDir,
    GREPLET_WORKSPACES: httpWorkspacesPath,
  };

  const child = spawn(process.execPath, [serverJs], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderrBuf = "";
  child.stderr.on("data", (d) => {
    stderrBuf += d.toString();
  });

  const baseUrl = `http://127.0.0.1:${HTTP_PORT}`;

  try {
    await waitForHealthz(baseUrl);
    console.log("[activity]    서버 기동 확인(healthz ok)");

    // ---- /api/events: hello 프레임 확인 ----
    const evController = new AbortController();
    const evRes = await fetch(`${baseUrl}/api/events`, { signal: evController.signal });
    assert.ok(evRes.ok, "/api/events 는 200 이어야 함");
    const reader = evRes.body.getReader();

    let frames = await readSseFramesUntil(reader, (fs2) => fs2.some((f) => f.event === "hello"), 5000);
    const helloFrame = frames.find((f) => f.event === "hello");
    assert.ok(helloFrame, "hello 프레임을 받아야 함");
    const helloData = JSON.parse(helloFrame.data);
    for (const key of ["stats", "recent", "jobs", "seq"]) {
      assert.ok(key in helloData, `hello data 에 ${key} 키가 있어야 함`);
    }
    console.log("[activity]    hello 프레임 키 확인 완료:", Object.keys(helloData).join(","));

    // ---- POST /api/search -> 스트림에 search.start/search.done 도착 ----
    const searchPromise = fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Greplet-Client": "cli" },
      body: JSON.stringify({ query: "hello", workspaces: "all", mode: "fts" }),
    });

    const seqBeforeSearch = Number(helloData.seq);
    const searchFrames = await readSseFramesUntil(
      reader,
      (fs2) => fs2.some((f) => f.event === "search.start") && fs2.some((f) => f.event === "search.done"),
      5000,
    );
    frames = frames.concat(searchFrames);
    const startFrame = searchFrames.find((f) => f.event === "search.start");
    const doneFrame = searchFrames.find((f) => f.event === "search.done");
    assert.ok(startFrame, "스트림에 search.start 프레임이 도착해야 함");
    assert.ok(doneFrame, "스트림에 search.done 프레임이 도착해야 함");
    const startData = JSON.parse(startFrame.data);
    assert.equal(startData.client, "cli", `search.start.data.client 는 "cli" 여야 함 (실제 ${startData.client})`);
    const lastSeq = Number(doneFrame.id);

    const searchRes = await searchPromise;
    assert.ok(searchRes.ok, "/api/search 는 200 이어야 함");

    evController.abort();
    console.log(`[activity]    search.start/search.done 스트림 도착 확인(client=cli), seqBeforeSearch=${seqBeforeSearch}, lastSeq=${lastSeq}`);

    // ---- ?after=<seq> 재접속 시 그 seq 이하 이벤트는 리플레이되지 않음 ----
    const ev2Controller = new AbortController();
    const ev2Res = await fetch(`${baseUrl}/api/events?after=${lastSeq}`, { signal: ev2Controller.signal });
    assert.ok(ev2Res.ok);
    const reader2 = ev2Res.body.getReader();
    const frames2 = await readSseFramesUntil(reader2, (fs2) => fs2.some((f) => f.event === "hello"), 5000);
    const replayed = frames2.filter((f) => f.event !== "hello");
    for (const f of replayed) {
      if (f.id !== undefined) {
        assert.ok(Number(f.id) > lastSeq, `after=${lastSeq} 재접속 시 리플레이된 이벤트 id(${f.id})는 lastSeq 보다 커야 함`);
      }
    }
    ev2Controller.abort();
    console.log(`[activity]    after=${lastSeq} 재접속 시 리플레이 이벤트 ${replayed.length}건 모두 seq > ${lastSeq} 확인`);

    // ---- GET /api/activity?limit=5 ----
    const actRes = await fetch(`${baseUrl}/api/activity?limit=5`);
    assert.ok(actRes.ok);
    const actData = await actRes.json();
    assert.ok(actData.recent.length > 0, "/api/activity recent 가 비어있지 않아야 함");
    assert.equal(actData.recent[0].client, "cli", `/api/activity recent[0].client 는 "cli" 여야 함 (실제 ${actData.recent[0].client})`);
    console.log("[activity]    /api/activity?limit=5 확인 완료");

    // ---- 잘못된 헤더는 "unknown" 으로 기록 ----
    const badRes = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Greplet-Client": "Bad Client!" },
      body: JSON.stringify({ query: "hello", workspaces: "all", mode: "fts" }),
    });
    assert.ok(badRes.ok);
    const actRes2 = await fetch(`${baseUrl}/api/activity?limit=1`);
    const actData2 = await actRes2.json();
    assert.equal(actData2.recent[0].client, "unknown", `잘못된 X-Greplet-Client 헤더는 unknown 으로 기록되어야 함 (실제 ${actData2.recent[0].client})`);
    console.log("[activity]    잘못된 클라이언트 헤더 -> unknown 기록 확인");
  } finally {
    // ---- SIGTERM 종료 확인 ----
    const exitPromise = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    child.kill("SIGTERM");
    const exitResult = await Promise.race([
      exitPromise,
      sleep(5000).then(() => ({ code: null, signal: null, timedOut: true })),
    ]);
    if (exitResult.timedOut) {
      child.kill("SIGKILL");
      throw new Error("서버가 SIGTERM 후 5초 내에 종료되지 않음(프로세스 잔류)");
    }
    console.log(`[activity]    SIGTERM 종료 확인(code=${exitResult.code}, signal=${exitResult.signal})`);
    if (stderrBuf.trim()) {
      console.log("[activity]    (server stderr 참고):", stderrBuf.trim().slice(0, 500));
    }
  }
}

async function main() {
  console.log("[activity] tmpRoot =", tmpRoot);
  await testModuleLevel();
  await testIndexJob();
  await testHttpLevel();
  console.log("[activity] 전체 통과");
}

main()
  .then(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error("[activity] 실패:", err);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    process.exit(1);
  });
