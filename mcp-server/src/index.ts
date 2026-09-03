/*
  index.ts — greplet 원격 MCP 서버 (Streamable HTTP, stateless)

  구조: 클라이언트 → [이 서버: Bearer 검증 + MCP 툴 greplet / greplet_workspaces] → greplet 인덱서 /api (localhost)
  환경변수:
    MCP_AUTH_TOKEN              필수. 클라이언트 Bearer 토큰 (미설정 시 기동 거부)
    GREPLET_BASE_URL            선택. 기본 http://localhost:7802
    GREPLET_DEFAULT_WORKSPACE   선택. workspace 미지정 시 기본값 (없으면 서버의 첫 워크스페이스)
    PORT                        선택. 기본 7801
*/
import express from "express";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { listWorkspacesText, runGreplet, type BackendConfig } from "./greplet.js";

// ---------- 설정 (기동 시 fail-fast) ----------
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? "";
const backend: BackendConfig = {
  baseUrl: process.env.GREPLET_BASE_URL ?? "http://localhost:7802",
  defaultWorkspace: process.env.GREPLET_DEFAULT_WORKSPACE || undefined,
};
const PORT = Number(process.env.PORT ?? 7801);

if (!AUTH_TOKEN) {
  console.error("[fatal] MCP_AUTH_TOKEN 미설정 — 무인증 공개 금지. 기동 중단.");
  process.exit(1);
}

// ---------- MCP 서버 (요청마다 새 인스턴스 — stateless) ----------
function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "greplet", version: "0.6.0" });

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
        all: z
          .boolean()
          .default(false)
          .describe("true면 모든 워크스페이스 통합 검색, 점수순 병합. 출력이 길어지니 대상이 분명하면 workspace 를 지정할 것"),
        topN: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(6)
          .describe("워크스페이스당 결과 개수 (기본 6, 최대 20)"),
        full: z.boolean().default(false).describe("true면 청크 전문 출력 (기본 300자 스니펫)"),
        mode: z
          .enum(["hybrid", "vector", "fts"])
          .default("hybrid")
          .describe("검색 방식: hybrid(기본, 의미+정확 토큰 RRF 병합) · vector(의미 기반만) · fts(정확 토큰만, 상수·메서드명 등에 유리)"),
        fileGlob: z
          .string()
          .optional()
          .describe('결과를 파일 상대경로 글롭으로 필터. `*` 는 세그먼트 안, `**` 는 깊이 무관. 예: "Lib/**/*.cs", "*.pdf"'),
      },
    },
    async ({ query, workspace, all, topN, full, mode, fileGlob }) => {
      try {
        const text = await runGreplet(backend, { query, workspace, all, topN, full, mode, fileGlob });
        return { content: [{ type: "text", text }] };
      } catch (e) {
        // 백엔드 미가동 등 — isError 로 원인 명시 (클라이언트 헛재시도 방지)
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
        return { content: [{ type: "text", text: await listWorkspacesText(backend) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
      }
    },
  );

  return server;
}

// ---------- Bearer 인증 (타이밍세이프 비교) ----------
function checkAuth(header: string | undefined): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const expect = Buffer.from(AUTH_TOKEN);
  return given.length === expect.length && timingSafeEqual(given, expect);
}

// ---------- HTTP 앱 ----------
const app = express();
app.use(express.json({ limit: "1mb" }));

// 상태 확인용 (무인증, 정보 노출 없음)
app.get("/healthz", (_req, res) => {
  res.status(200).send("ok");
});

app.post("/mcp", async (req, res) => {
  if (!checkAuth(req.headers.authorization)) {
    console.warn(`[401] ${req.ip} — 인증 실패`);
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: Bearer 토큰 필요" },
      id: null,
    });
    return;
  }
  // stateless: 요청마다 서버·전송 새로 생성 (세션 상태 없음, 읽기 툴에 충분)
  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[error] MCP 요청 처리 실패:", e);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// stateless 모드에선 GET(SSE 스트림)·DELETE(세션 종료) 미지원
const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless server)" },
    id: null,
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.listen(PORT, "127.0.0.1", () => {
  console.log(`greplet MCP 서버 기동 — http://127.0.0.1:${PORT}/mcp (backend: ${backend.baseUrl})`);
});
