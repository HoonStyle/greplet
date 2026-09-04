#!/usr/bin/env node
// greplet.mjs - greplet 인덱서 CLI (Node, greplet.ps1 의 크로스플랫폼 동등물 + 관리 서브커맨드)
//
// 목적: 코드/문서 폴더를 통째로 grep/read 하지 않고,
//       하이브리드 검색(벡터+FTS, LLM 생성 없음)으로 관련 청크만 ~2초에 추출.
//
// 백엔드: 자체 인덱서(Roslyn/PdfPig 청크 + Ollama bge-m3 + LanceDB), http://localhost:7802.
//         미가동이면 bash indexer/start-indexer.sh (macOS/Linux) 또는
//         pwsh indexer/start-indexer.ps1 (Windows) 로 기동할 것.
//
// 사용 예:
//   node greplet.mjs "재시도 백오프 로직"                    # 검색
//   node greplet.mjs "0x0A03" --mode fts --file "Lib/**/*.cs"
//   node greplet.mjs "에러 코드" --all --json | jq '.hits[0]'
//   node greplet.mjs status                                  # 서버·Ollama·Extractor 상태
//   node greplet.mjs workspaces                              # 워크스페이스 목록·통계
//   node greplet.mjs index code --wait                       # 증분 인덱스 후 완료까지 로그
//   node greplet.mjs index docs --force                      # 전체 재인덱스 (잡 등록만)
//
// 워크스페이스 slug 는 indexer/workspaces.json 이 단일 소스(GREPLET_WORKSPACES 로 다른 경로 지정 가능).
// -w 미지정 시 GREPLET_DEFAULT_WORKSPACE → workspaces.json 첫 항목.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VALID_MODES = ["hybrid", "vector", "fts"];

function printUsage() {
  const usage = `
greplet.mjs - greplet 인덱서 CLI

검색:
  node greplet.mjs <query> [옵션]
  node greplet.mjs -q <query> [옵션]

관리:
  node greplet.mjs status                  서버·Ollama·Extractor·큐 상태
  node greplet.mjs workspaces              워크스페이스 목록과 인덱스 통계
  node greplet.mjs index <slug> [--force] [--wait]
                                           증분 인덱스 잡 등록(--force: 전체 재인덱스, --wait: 완료까지 로그 출력)

검색 옵션:
  -q, --query <query>     검색어 (위치 인자로도 지정 가능)
  -w, --workspace <slug>  검색 워크스페이스 slug (미지정 시 기본 워크스페이스)
  --all                   모든 워크스페이스 통합 검색(서버가 병합·정렬)
  --top-n <n>             워크스페이스당 결과 개수 (기본 6, 최대 20)
  --full                  청크 전문 출력(기본은 300자 스니펫)
  --mode <mode>           hybrid(기본) | vector | fts
  --file <glob>           파일 상대경로 글롭으로 결과 필터 (예: "Lib/**/*.cs", "*.pdf")

공통 옵션:
  --json                  사람용 텍스트 대신 서버 JSON 응답을 그대로 출력
  --base-url <url>        인덱서 서버 base URL (기본 http://localhost:7802, 환경변수 GREPLET_BASE_URL)
  -h, --help              도움말 출력

사용 예:
  node greplet.mjs "재시도 백오프 로직"
  node greplet.mjs -q "설정 파일 스키마" -w docs --top-n 8
  node greplet.mjs "0x0A03" --mode fts --file "Lib/**/*.cs"
  node greplet.mjs "에러 코드 정의" --all --json
  node greplet.mjs index code --wait

워크스페이스 slug 는 indexer/workspaces.json 이 단일 소스(GREPLET_WORKSPACES 로 다른 경로 지정 가능).
-w 미지정 시 GREPLET_DEFAULT_WORKSPACE → workspaces.json 첫 항목.
`;
  process.stdout.write(usage.trimStart() + "\n");
}

function parseArgs(argv) {
  const args = {
    command: "search", // search | status | workspaces | index
    slug: null,        // index 대상
    query: null,
    workspace: "",
    all: false,
    topN: 6,
    full: false,
    mode: "hybrid",
    fileGlob: null,
    force: false,
    wait: false,
    json: false,
    baseUrl: process.env.GREPLET_BASE_URL || "http://localhost:7802",
    help: false,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h": case "--help": args.help = true; break;
      case "-q": case "--query": args.query = argv[++i]; break;
      case "-w": case "--workspace": args.workspace = argv[++i]; break;
      case "--all": args.all = true; break;
      case "--top-n": args.topN = parseInt(argv[++i], 10); break;
      case "--full": args.full = true; break;
      case "--mode": args.mode = argv[++i]; break;
      case "--file": args.fileGlob = argv[++i]; break;
      case "--force": args.force = true; break;
      case "--wait": args.wait = true; break;
      case "--json": args.json = true; break;
      case "--base-url": args.baseUrl = argv[++i]; break;
      default:
        if (a.startsWith("-")) {
          process.stderr.write(`알 수 없는 옵션: ${a} (--help 참고)\n`);
          process.exit(2);
        }
        positional.push(a);
        break;
    }
  }

  if (positional[0] === "status" || positional[0] === "workspaces") {
    args.command = positional[0];
  } else if (positional[0] === "index") {
    args.command = "index";
    args.slug = positional[1] ?? null;
  } else if (!args.query && positional.length > 0) {
    args.query = positional[0];
  }
  return args;
}

// ---------- 워크스페이스 정의 파일 (greplet-shared.ps1 동치) ----------
function getWorkspacesPath() {
  if (process.env.GREPLET_WORKSPACES) return process.env.GREPLET_WORKSPACES;
  return join(__dirname, "indexer", "workspaces.json");
}

function getWorkspaceSlugs() {
  const path = getWorkspacesPath();
  if (!existsSync(path)) return [];
  const json = JSON.parse(readFileSync(path, "utf8"));
  return json.map((w) => w.slug);
}

function getDefaultWorkspace() {
  if (process.env.GREPLET_DEFAULT_WORKSPACE) return process.env.GREPLET_DEFAULT_WORKSPACE;
  const slugs = getWorkspaceSlugs();
  return slugs.length > 0 ? slugs[0] : null;
}

// ---------- HTTP ----------
function serverDown(baseUrl, e) {
  process.stderr.write(
    `인덱서 서버(${baseUrl}) 미가동 — bash indexer/start-indexer.sh (macOS/Linux) 또는 pwsh indexer/start-indexer.ps1 (Windows) 로 기동\n상세: ${
      e instanceof Error ? e.message : String(e)
    }\n`,
  );
  process.exit(1);
}

/** 호출 세션·클라이언트 자동 감지: GREPLET_SESSION → CODEX_THREAD_ID/CODEX_SESSION_ID(Codex 셸 툴 환경) → CLAUDE_CODE_SESSION_ID.
 *  Codex 를 우선하는 이유: Claude Code 가 Codex 에 위임하면 두 변수가 모두 상속되는데, 출력을 읽는 쪽은 Codex 이기 때문. */
function callerHeaders() {
  const env = process.env;
  const codexId = env.CODEX_THREAD_ID || env.CODEX_SESSION_ID;
  const session = env.GREPLET_SESSION || codexId || env.CLAUDE_CODE_SESSION_ID;
  const client = env.GREPLET_CLIENT_NAME || (codexId ? "cli:codex" : env.CLAUDE_CODE_SESSION_ID ? "cli:claude" : "cli");
  return { "X-Greplet-Client": client, ...(session ? { "X-Greplet-Session": session } : {}) };
}

async function api(baseUrl, path, init = {}, timeoutMs = 120000) {
  let resp;
  try {
    resp = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...callerHeaders(), ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    serverDown(baseUrl, e);
  }
  const text = await resp.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!resp.ok) {
    const msg = data && data.error ? data.error : `HTTP ${resp.status} ${resp.statusText}`;
    process.stderr.write(`요청 실패: ${msg}\n`);
    process.exit(1);
  }
  return data;
}

function emitJson(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleString("ko-KR") : "-";
}

// ---------- 서브커맨드 ----------
async function cmdStatus(args) {
  const s = await api(args.baseUrl, "/api/status", {}, 10000);
  if (args.json) return emitJson(s);
  const ollama = s.ollama.ok ? (s.ollama.hasModel ? `연결됨 (${s.ollama.model})` : `모델 없음 (${s.ollama.model})`) : "미가동 (fts 전용)";
  process.stdout.write(
    [
      `서버      ${args.baseUrl}`,
      `Ollama    ${ollama}`,
      `Extractor ${s.extractor.ok ? "준비됨" : "없음 (dotnet run 폴백)"}  ${s.extractor.path}`,
      `DB        ${s.dbDir}`,
      `큐        ${s.queue.length === 0 ? "비어 있음" : s.queue.join(", ")}`,
    ].join("\n") + "\n",
  );
}

async function cmdWorkspaces(args) {
  const list = await api(args.baseUrl, "/api/workspaces", {}, 10000);
  if (args.json) return emitJson(list);
  if (list.length === 0) {
    process.stdout.write("워크스페이스 없음 (indexer/workspaces.json 을 확인할 것)\n");
    return;
  }
  const lines = list.map(
    (w) =>
      `${w.slug.padEnd(20)} ${w.kind.padEnd(5)} files=${String(w.files).padStart(6)} chunks=${String(w.chunks).padStart(8)}` +
      `  emb=${(w.embeddings ?? "?").padEnd(8)} last=${fmtDate(w.lastRun)}${w.indexing ? "  (인덱싱 중)" : ""}  ${w.label}`,
  );
  process.stdout.write(lines.join("\n") + "\n");
}

async function cmdIndex(args) {
  if (!args.slug) {
    process.stderr.write("index <slug> 형식으로 워크스페이스를 지정하세요. 목록: node greplet.mjs workspaces\n");
    process.exit(2);
  }
  const data = await api(
    args.baseUrl,
    `/api/index/${encodeURIComponent(args.slug)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: args.force }) },
    10000,
  );
  if (!args.wait) {
    if (args.json) return emitJson(data);
    process.stdout.write(`잡 등록: ${data.jobId}${data.queued ? " (대기열)" : ""}  slug=${args.slug} force=${args.force}\n`);
    return;
  }

  // --wait: SSE 로그를 완료까지 흘린다
  const url = `${args.baseUrl}/api/jobs/${data.jobId}/events`;
  let resp;
  try {
    resp = await fetch(url);
  } catch (e) {
    serverDown(args.baseUrl, e);
  }
  const events = [];
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let done = false;
  while (!done) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const eventLine = frame.split("\n").find((l) => l.startsWith("event:"));
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (eventLine && eventLine.slice(6).trim() === "done") { done = true; break; }
      if (!dataLine) continue;
      const ev = JSON.parse(dataLine.slice(5).trim());
      if (args.json) events.push(ev);
      else process.stdout.write(`[${ev.ts}] ${String(ev.level).toUpperCase()} ${ev.msg}\n`);
    }
  }
  const jobs = await api(args.baseUrl, "/api/jobs", {}, 10000);
  const job = jobs.find((j) => j.id === data.jobId) ?? null;
  if (args.json) return emitJson({ jobId: data.jobId, job, events });
  if (job) {
    process.stdout.write(`--- ${job.state}${job.error ? `: ${job.error}` : ""} ---\n`);
    if (job.state === "failed") process.exit(1);
  }
}

// ---------- 검색 (greplet.ps1 / greplet-mcpb runGreplet 동치 출력) ----------
function locationSuffix(h) {
  return h.kind === "page" ? "" : ` (L${h.startLine}-${h.endLine})`;
}

async function cmdSearch(args) {
  if (!args.query) {
    printUsage();
    process.exit(1);
  }
  if (!VALID_MODES.includes(args.mode)) {
    process.stderr.write(`잘못된 --mode 값: "${args.mode}" (사용 가능: ${VALID_MODES.join(", ")})\n`);
    process.exit(1);
  }

  let workspace = args.workspace;
  if (!workspace) {
    workspace = getDefaultWorkspace();
    if (!workspace && !args.all) {
      process.stderr.write("워크스페이스가 없습니다 - indexer/workspaces.json 을 확인하세요\n");
      process.exit(1);
    }
  }
  const allWorkspaces = getWorkspaceSlugs();

  const data = await api(args.baseUrl, "/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Greplet-Snippet": (args.full || args.json) ? "full" : "300" },
    body: JSON.stringify({
      query: args.query,
      workspaces: args.all ? "all" : [workspace],
      topN: args.topN,
      mode: args.mode,
      ...(args.fileGlob ? { fileGlob: args.fileGlob } : {}),
    }),
  });
  if (args.json) return emitJson(data);

  const hits = data.hits || [];
  const label = args.all ? `ALL(${allWorkspaces.join(",")})` : workspace;
  const filterTag = args.fileGlob ? ` file=${args.fileGlob}` : "";

  if (hits.length === 0) {
    process.stdout.write(`결과 없음 (targets=${args.all ? "all" : workspace}${filterTag}, query="${args.query}")\n`);
    return;
  }

  const lines = [`[${label}] "${args.query}"${filterTag} -> 총 ${hits.length}건 (점수순${data.cached ? ", 캐시" : ""})`, "=".repeat(70)];
  let rank = 1;
  const seen = new Set();
  for (const h of hits) {
    const key = `${h.file}|${h.text.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const wsTag = args.all ? `[${h.workspace}] ` : "";
    lines.push(`#${rank}  score ${h.score.toFixed(4)}  |  ${wsTag}${h.file} :: ${h.symbol}${locationSuffix(h)}`);
    if (args.full) {
      lines.push(h.text);
    } else {
      let snip = h.text.replace(/\s+/g, " ");
      if (snip.length > 300) snip = snip.slice(0, 300) + " ...";
      lines.push(snip);
    }
    lines.push("-".repeat(70));
    rank++;
  }
  if (data.warnings && data.warnings.length > 0) lines.push(`(경고: ${data.warnings.join(" · ")})`);
  process.stdout.write(lines.join("\n") + "\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }
  switch (args.command) {
    case "status": return cmdStatus(args);
    case "workspaces": return cmdWorkspaces(args);
    case "index": return cmdIndex(args);
    default: return cmdSearch(args);
  }
}

main();
