/*
  index.js — greplet 로컬 stdio MCP 서버 (.mcpb 번들 진입점)

  Claude Desktop 이 이 서버를 사용자 PC 에서 로컬 실행 → Cowork 세션으로 프록시.
  로컬 실행이라 localhost:7802(greplet 인덱서)에 직결하며, 네트워크 리스너가 없어 인증 불필요.
  검색 로직은 mcp-server/src/greplet.ts 와 동치 (인덱서 /api/search 1회 호출 → 정규화·점수순·중복제거·출력 포맷).
  워크스페이스 목록은 인덱서 GET /api/workspaces 에서 받아 온다(60초 캐시) — 단일 소스는 indexer/workspaces.json.

  환경변수(매니페스트 user_config 에서 주입):
    GREPLET_BASE_URL            선택. 기본 http://localhost:7802
    GREPLET_CLIENT_NAME         선택. 대시보드 활동 피드에 표시할 호출자 이름 (기본 mcp:claude)
    GREPLET_DEFAULT_WORKSPACE   선택. workspace 미지정 시 기본값 (없으면 서버의 첫 워크스페이스)
    GREPLET_SESSION             선택. 호출 세션 식별자 — 대시보드 세션 필터에 사용
*/
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = process.env.GREPLET_BASE_URL || "http://localhost:7802";
const CLIENT_NAME = process.env.GREPLET_CLIENT_NAME || "mcp:claude";
const DEFAULT_WORKSPACE = process.env.GREPLET_DEFAULT_WORKSPACE || undefined;
const SESSION_HEADERS = process.env.GREPLET_SESSION ? { "X-Greplet-Session": process.env.GREPLET_SESSION } : {};

const WS_CACHE_TTL_MS = 60_000;
let wsCache = null;

function backendDownMessage(e) {
  return `인덱서 서버(${BASE_URL}) 미가동 또는 요청 실패 — indexer/start-indexer.sh(macOS/Linux) 또는 start-indexer.ps1(Windows) 로 기동할 것. 상세: ${e instanceof Error ? e.message : String(e)}`;
}

/** GET /api/workspaces — 60초 캐시 */
async function fetchWorkspaces() {
  if (wsCache && Date.now() - wsCache.at < WS_CACHE_TTL_MS) return wsCache.list;
  const resp = await fetch(`${BASE_URL}/api/workspaces`, {
    headers: { "X-Greplet-Client": CLIENT_NAME, ...SESSION_HEADERS },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`/api/workspaces HTTP ${resp.status}: ${await resp.text()}`);
  const list = await resp.json();
  wsCache = { at: Date.now(), list };
  return list;
}

/** 인덱서 /api/search 1회 호출 */
async function callSearchApi(workspaces, query, topN, mode, fileGlob, full) {
  const resp = await fetch(`${BASE_URL}/api/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Greplet-Client": CLIENT_NAME,
      "X-Greplet-Snippet": full ? "full" : "300",
      ...SESSION_HEADERS,
    },
    body: JSON.stringify({ query, workspaces, topN, mode, ...(fileGlob ? { fileGlob } : {}) }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!resp.ok) throw new Error(`/api/search HTTP ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

function locationSuffix(h) {
  return h.kind === "page" ? "" : ` (L${h.startLine}-${h.endLine})`;
}

async function listWorkspacesText() {
  let list;
  try {
    list = await fetchWorkspaces();
  } catch (e) {
    throw new Error(backendDownMessage(e));
  }
  if (list.length === 0) return "워크스페이스 없음 (indexer/workspaces.json 을 확인할 것)";
  return list
    .map(
      (w) =>
        `${w.slug.padEnd(20)} ${w.kind.padEnd(5)} files=${String(w.files).padStart(5)} chunks=${String(w.chunks).padStart(7)}` +
        `  last=${w.lastRun ?? "-"}${w.indexing ? "  (인덱싱 중)" : ""}  ${w.label}`,
    )
    .join("\n");
}

/** greplet 본체 — 인덱서 서버 1회 호출 → 포맷팅(greplet.ts 동치) */
async function runGreplet({ query, workspace, all, topN, full, mode, fileGlob }) {
  let slugs;
  try {
    slugs = (await fetchWorkspaces()).map((w) => w.slug);
  } catch (e) {
    throw new Error(backendDownMessage(e));
  }

  const ws = workspace ?? DEFAULT_WORKSPACE ?? slugs[0];
  if (!all) {
    if (!ws) throw new Error("워크스페이스가 하나도 없다 — indexer/workspaces.json 을 확인할 것");
    if (!slugs.includes(ws)) throw new Error(`알 수 없는 워크스페이스 "${ws}" — 사용 가능: ${slugs.join(", ")}`);
  }
  const targets = all ? "all" : [ws];

  let data;
  try {
    data = await callSearchApi(targets, query, topN, mode, fileGlob, full);
  } catch (e) {
    throw new Error(backendDownMessage(e));
  }

  const label = all ? `ALL(${slugs.join(",")})` : ws;
  if (data.hits.length === 0) return `결과 없음 (targets=${all ? "all" : ws}, query="${query}")`;

  const filterTag = fileGlob ? ` file=${fileGlob}` : "";
  const lines = [`[${label}] "${query}"${filterTag} -> 총 ${data.hits.length}건 (점수순)`, "=".repeat(70)];

  let rank = 1;
  const seen = new Set();
  for (const h of data.hits) {
    const key = `${h.file}|${h.text.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const wsTag = all ? `[${h.workspace}] ` : "";
    lines.push(`#${rank}  score ${h.score.toFixed(4)}  |  ${wsTag}${h.file} :: ${h.symbol}${locationSuffix(h)}`);
    if (full) {
      lines.push(h.text);
    } else {
      let snip = h.text.replace(/\s+/g, " ");
      if (snip.length > 300) snip = snip.slice(0, 300) + " ...";
      lines.push(snip);
    }
    lines.push("-".repeat(70));
    rank++;
  }
  if (data.warnings.length > 0) lines.push(`(경고: ${data.warnings.join(" · ")})`);
  return lines.join("\n");
}

// ---------- MCP 서버 (stdio) ----------
const server = new McpServer({ name: "greplet", version: "0.9.0" });

server.registerTool(
  "greplet",
  {
    title: "코드/문서 하이브리드 검색",
    description:
      "인덱스된 소스코드·PDF·문서 워크스페이스에서 관련 청크를 검색한다. " +
      "자체 인덱서(Roslyn/PdfPig 청크 + Ollama bge-m3 + LanceDB, LLM 생성 없음)가 관련 청크만 반환. " +
      '"코드에서 ~찾아줘", "문서에 ~어떻게 정의됐어", "~구현이 어디 있어" 같은 내용 조회에 사용. ' +
      "읽기 전용. mode=fts 로 상수·메서드명 등 정확 토큰 검색이 가능하다. " +
      "워크스페이스 목록은 greplet_workspaces 툴로 확인.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      query: z.string().min(1).describe("검색어 (자연어/키워드)"),
      workspace: z
        .string()
        .optional()
        .describe("검색 워크스페이스 slug (indexer/workspaces.json). 미지정 시 서버 기본값. 목록은 greplet_workspaces"),
      all: z.boolean().default(false).describe("true면 모든 워크스페이스 통합 검색, 점수순 병합. 출력이 길어지니 대상이 분명하면 workspace 를 지정할 것"),
      topN: z.number().int().min(1).max(20).default(6).describe("워크스페이스당 결과 개수 (기본 6, 최대 20)"),
      full: z.boolean().default(false).describe("true면 청크 전문 출력 (기본 300자 스니펫)"),
      mode: z
        .enum(["hybrid", "vector", "fts"])
        .default("hybrid")
        .describe("검색 방식: hybrid(기본) · vector(의미 기반만) · fts(정확 토큰만, 상수·메서드명 등에 유리)"),
      fileGlob: z
        .string()
        .optional()
        .describe('결과를 파일 상대경로 글롭으로 필터. `*` 는 세그먼트 안, `**` 는 깊이 무관. 예: "Lib/**/*.cs", "*.pdf"'),
    },
  },
  async ({ query, workspace, all, topN, full, mode, fileGlob }) => {
    try {
      const text = await runGreplet({ query, workspace, all, topN, full, mode, fileGlob });
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
      };
    }
  },
);

server.registerTool(
  "greplet_workspaces",
  {
    title: "greplet 워크스페이스 목록",
    description: "인덱서에 정의된 워크스페이스(slug·종류·파일 수·청크 수·마지막 인덱스 시각)를 나열한다. 읽기 전용.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {},
  },
  async () => {
    try {
      return { content: [{ type: "text", text: await listWorkspacesText() }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`greplet stdio MCP 서버 기동 (backend: ${BASE_URL})\n`);
