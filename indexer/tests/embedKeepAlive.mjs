import assert from "node:assert/strict";
import http from "node:http";

const savedKeepAlive = process.env.OLLAMA_KEEP_ALIVE;
const savedOllamaUrl = process.env.OLLAMA_URL;
const requests = [];
const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/api/embed") {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push(JSON.parse(body));
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ embeddings: [[0.25, 0.5, 0.75]] }));
});

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { loadConfig } = await import("../dist/config.js");
  const { embedQuery } = await import("../dist/embed.js");
  const { port } = server.address();
  process.env.OLLAMA_URL = `http://127.0.0.1:${port}`;

  delete process.env.OLLAMA_KEEP_ALIVE;
  const defaultCfg = loadConfig();
  assert.equal(defaultCfg.ollamaKeepAlive, "30m");
  assert.deepEqual(await embedQuery(defaultCfg, "default"), [0.25, 0.5, 0.75]);
  assert.equal(requests.at(-1).model, "bge-m3");
  assert.equal(requests.at(-1).keep_alive, "30m");
  assert.deepEqual(requests.at(-1).input, ["default"]);

  process.env.OLLAMA_KEEP_ALIVE = "  2h  ";
  const overrideCfg = loadConfig();
  assert.equal(overrideCfg.ollamaKeepAlive, "2h");
  assert.deepEqual(await embedQuery(overrideCfg, "override"), [0.25, 0.5, 0.75]);
  assert.equal(requests.at(-1).keep_alive, "2h");

  await embedQuery({ ...overrideCfg, ollamaKeepAlive: 0 }, "numeric");
  assert.equal(requests.at(-1).keep_alive, 0);
  console.log("[embedKeepAlive] passed");
} finally {
  server.close();
  if (savedKeepAlive === undefined) delete process.env.OLLAMA_KEEP_ALIVE;
  else process.env.OLLAMA_KEEP_ALIVE = savedKeepAlive;
  if (savedOllamaUrl === undefined) delete process.env.OLLAMA_URL;
  else process.env.OLLAMA_URL = savedOllamaUrl;
}
