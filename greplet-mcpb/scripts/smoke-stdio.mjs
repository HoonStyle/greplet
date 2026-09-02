/*
  smoke-stdio.mjs — .mcpb 로컬 stdio 서버 E2E 검증 (SDK stdio 클라이언트)
  server/index.js 를 자식 프로세스로 띄워 initialize → tools/list → greplet 호출.
  사용: node scripts/smoke-stdio.mjs [검색어]  (greplet 인덱서가 http://localhost:7802 에 떠 있어야 함)
*/
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const query = process.argv[2] ?? "재시도 백오프 로직";

const transport = new StdioClientTransport({
  command: "node",
  args: [join(here, "..", "server", "index.js")],
  env: {
    GREPLET_BASE_URL: process.env.GREPLET_BASE_URL ?? "http://localhost:7802",
  },
});
const client = new Client({ name: "smoke-stdio", version: "0.1.0" });
await client.connect(transport);
console.log("[초기화] initialize 성공 ✅");

const tools = await client.listTools();
const names = tools.tools.map((t) => t.name);
console.log(`[툴목록] [${names.join(", ")}] ${names.includes("greplet") ? "✅" : "❌"}`);

const t0 = Date.now();
const result = await client.callTool({ name: "greplet", arguments: { query, all: true } });
console.log(`[호출  ] greplet("${query}", all) → ${Date.now() - t0}ms, isError=${result.isError ?? false}`);
console.log("-".repeat(70));
console.log((result.content?.[0]?.text ?? "(내용 없음)").split("\n").slice(0, 6).join("\n"));

await client.close();
