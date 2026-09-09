import http from "node:http";

const DIMENSION = 1024;

function vector(size = DIMENSION) {
  const out = new Array(size).fill(0);
  out[0] = 1;
  return out;
}

export async function startFakeOllama(model = "bge-m3") {
  let mode = "normal";
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/api/tags") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ models: [{ name: model }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/embed") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const input = Array.isArray(body.input) ? body.input : [body.input];
      requests.push({ mode, model: body.model, input });
      if (mode === "http-failure") {
        res.statusCode = 503;
        res.end("fixture unavailable");
        return;
      }
      let embeddings = input.map(() => vector(mode === "short-vector" ? 3 : DIMENSION));
      if (mode === "count-mismatch") embeddings = embeddings.slice(0, Math.max(0, embeddings.length - 1));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ embeddings }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake Ollama address unavailable");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    setMode(next) { mode = next; },
    close() { return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
