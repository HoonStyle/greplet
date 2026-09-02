#!/usr/bin/env node
// greplet.mjs - greplet 인덱서 빠른 검색 헬퍼 (Node CLI, greplet.ps1 동등물)
//
// 목적: 코드/문서 폴더를 통째로 grep/read 하지 않고,
//       하이브리드 검색(벡터+FTS, LLM 생성 없음)으로 관련 청크만 ~2초에 추출.
//
// 백엔드: 자체 인덱서(Roslyn/PdfPig 청크 + Ollama bge-m3 + LanceDB), http://localhost:7802.
//         미가동이면 bash indexer/start-indexer.sh (macOS/Linux) 또는
//         pwsh indexer/start-indexer.ps1 (Windows) 로 기동할 것.
//
// 사용 예:
//   node greplet.mjs "재시도 백오프 로직"
//   node greplet.mjs -q "설정 파일 스키마" -w docs --top-n 8
//   node greplet.mjs "에러 코드 정의" --all           # 워크스페이스 통합 검색
//   node greplet.mjs "..." --full                     # 청크 전문 출력
//   node greplet.mjs "0x0A03" --mode fts               # 정확 토큰 검색(상수·메서드명 등)
//
// 워크스페이스 slug 는 indexer/workspaces.json 이 단일 소스(GREPLET_WORKSPACES 로 다른 경로 지정 가능).
// -w 미지정 시 GREPLET_DEFAULT_WORKSPACE → workspaces.json 첫 항목.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function printUsage() {
  const usage = `
greplet.mjs - greplet 인덱서 빠른 검색 헬퍼

목적: 코드/문서 폴더를 통째로 grep/read 하지 않고,
      하이브리드 검색(벡터+FTS, LLM 생성 없음)으로 관련 청크만 ~2초에 추출.

백엔드: 자체 인덱서(Roslyn/PdfPig 청크 + Ollama bge-m3 + LanceDB), http://localhost:7802.
        미가동이면 bash indexer/start-indexer.sh (macOS/Linux) 또는
        pwsh indexer/start-indexer.ps1 (Windows) 로 기동할 것.

사용법:
  node greplet.mjs <query> [옵션]
  node greplet.mjs -q <query> [옵션]

옵션:
  -q, --query <query>     검색어 (위치 인자로도 지정 가능)
  -w, --workspace <slug>  검색 워크스페이스 slug (미지정 시 기본 워크스페이스)
  --all                   모든 워크스페이스 통합 검색(서버가 병합·정렬)
  --top-n <n>             워크스페이스당 결과 개수 (기본 6)
  --full                  청크 전문 출력(기본은 300자 스니펫)
  --mode <mode>           hybrid(기본) | vector | fts
  --base-url <url>        인덱서 서버 base URL (기본 http://localhost:7802)
  -h, --help              도움말 출력

사용 예:
  node greplet.mjs "재시도 백오프 로직"
  node greplet.mjs -q "설정 파일 스키마" -w docs --top-n 8
  node greplet.mjs "에러 코드 정의" --all
  node greplet.mjs "..." --full
  node greplet.mjs "0x0A03" --mode fts

워크스페이스 slug 는 indexer/workspaces.json 이 단일 소스(GREPLET_WORKSPACES 로 다른 경로 지정 가능).
-w 미지정 시 GREPLET_DEFAULT_WORKSPACE → workspaces.json 첫 항목.
`;
  process.stdout.write(usage.trimStart() + "\n");
}

function parseArgs(argv) {
  const args = {
    query: null,
    workspace: "",
    all: false,
    topN: 6,
    full: false,
    mode: "hybrid",
    baseUrl: "http://localhost:7802",
    help: false,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "-q":
      case "--query":
        args.query = argv[++i];
        break;
      case "-w":
      case "--workspace":
        args.workspace = argv[++i];
        break;
      case "--all":
        args.all = true;
        break;
      case "--top-n":
        args.topN = parseInt(argv[++i], 10);
        break;
      case "--full":
        args.full = true;
        break;
      case "--mode":
        args.mode = argv[++i];
        break;
      case "--base-url":
        args.baseUrl = argv[++i];
        break;
      default:
        positional.push(a);
        break;
    }
  }

  if (!args.query && positional.length > 0) {
    args.query = positional[0];
  }

  return args;
}

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

function locationSuffix(h) {
  return h.kind === "page" ? "" : ` (L${h.startLine}-${h.endLine})`;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  if (!args.query) {
    printUsage();
    process.exit(1);
  }

  const validModes = ["hybrid", "vector", "fts"];
  if (!validModes.includes(args.mode)) {
    process.stderr.write(`잘못된 --mode 값: "${args.mode}" (사용 가능: ${validModes.join(", ")})\n`);
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

  const body = JSON.stringify({
    query: args.query,
    workspaces: args.all ? "all" : [workspace],
    topN: args.topN,
    mode: args.mode,
  });

  let resp;
  try {
    resp = await fetch(`${args.baseUrl}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(120000),
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
  } catch (e) {
    process.stderr.write(
      `인덱서 서버(${args.baseUrl}) 미가동 — bash indexer/start-indexer.sh (macOS/Linux) 또는 pwsh indexer/start-indexer.ps1 (Windows) 로 기동\n상세: ${
        e instanceof Error ? e.message : String(e)
      }\n`,
    );
    process.exit(1);
  }

  const data = await resp.json();
  const hits = data.hits || [];
  const label = args.all ? `ALL(${allWorkspaces.join(",")})` : workspace;

  if (hits.length === 0) {
    process.stdout.write(`결과 없음 (targets=${args.all ? "all" : workspace}, query="${args.query}")\n`);
    process.exit(0);
  }

  const lines = [`[${label}] "${args.query}" -> 총 ${hits.length}건 (점수순)`, "=".repeat(70)];

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

  if (data.warnings && data.warnings.length > 0) {
    lines.push(`(경고: ${data.warnings.join(" · ")})`);
  }

  process.stdout.write(lines.join("\n") + "\n");
}

main();
