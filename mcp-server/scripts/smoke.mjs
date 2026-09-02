/*
  smoke.mjs — greplet MCP 서버 E2E 스모크 테스트 (SDK 클라이언트)

  검증 항목 :
    무토큰 → 401 검증: 무토큰 → 401 / 정상 토큰 → 성공
    D1(사전): tools/list에 greplet 노출, tools/call 결과 포맷 확인

  사용: node scripts/smoke.mjs [서버URL] [토큰] [검색어]
    기본 URL http://127.0.0.1:7801/mcp · 토큰 $env:MCP_AUTH_TOKEN · 검색어 "재시도 백오프 로직"
*/
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2] ?? "http://127.0.0.1:7801/mcp";
const token = process.argv[3] ?? process.env.MCP_AUTH_TOKEN;
const query = process.argv[4] ?? "재시도 백오프 로직";

if (!token) {
  console.error("토큰 필요: 인자 또는 $env:MCP_AUTH_TOKEN");
  process.exit(1);
}

// ---- D2a: 무토큰 요청은 401 이어야 한다 ----
{
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
  });
  console.log(`[D2a] 무토큰 → HTTP ${resp.status} ${resp.status === 401 ? "✅" : "❌ (401 기대)"}`);
}

// ---- D2b + D1: 정상 토큰으로 initialize → tools/list → tools/call ----
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: "greplet-smoke", version: "0.1.0" });
await client.connect(transport);
console.log("[D2b] 정상 토큰 → initialize 성공 ✅");

const tools = await client.listTools();
const names = tools.tools.map((t) => t.name);
console.log(`[D1 ] tools/list → [${names.join(", ")}] ${names.includes("greplet") ? "✅" : "❌"}`);

const t0 = Date.now();
const result = await client.callTool({ name: "greplet", arguments: { query, all: true } });
const ms = Date.now() - t0;
console.log(`[D1 ] tools/call greplet("${query}", all) → ${ms}ms, isError=${result.isError ?? false}`);
console.log("-".repeat(70));
console.log(result.content?.[0]?.text ?? "(내용 없음)");

await client.close();
