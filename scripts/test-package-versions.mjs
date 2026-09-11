// Version metadata and real MCP initialize responses must agree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = file => JSON.parse(fs.readFileSync(new URL(file, root), 'utf8'));
const version = read('indexer/package.json').version;
for (const component of ['indexer', 'mcp-server', 'greplet-mcpb']) {
  assert.equal(read(`${component}/package.json`).version, version, `${component} package`);
  const lock = read(`${component}/package-lock.json`);
  assert.equal(lock.version, version, `${component} lockfile`);
  assert.equal(lock.packages[''].version, version, `${component} root lock entry`);
}
assert.equal(read('greplet-mcpb/manifest.json').version, version, 'bundle manifest');
const extractor = fs.readFileSync(new URL('Extractor/Extractor.csproj', root), 'utf8');
assert.equal(extractor.match(/<Version>([^<]+)<\/Version>/)?.[1], version, 'Extractor version');
if (process.argv.includes('--metadata-only')) {
  console.log(`Version metadata agrees: ${version}`);
  process.exit(0);
}

const require = createRequire(new URL('mcp-server/package.json', root));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const stdio = new Client({ name: 'version-test', version: '0' });
try {
  await stdio.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('greplet-mcpb/server/index.js', root))],
  }));
  assert.equal(stdio.getServerVersion()?.version, version, 'stdio initialize version');
} finally {
  await stdio.close();
}

const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const token = randomBytes(24).toString('hex');
const child = spawn(process.execPath, [fileURLToPath(new URL('mcp-server/dist/index.js', root))], {
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(port), MCP_AUTH_TOKEN: token, GREPLET_BASE_URL: 'http://127.0.0.1:1' },
});
const remote = new Client({ name: 'version-test', version: '0' });
let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk.toString(); });
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('MCP startup timed out')), 10000);
    let output = '';
    function finish(error) {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
      error ? reject(error) : resolve();
    }
    const onData = chunk => { output += chunk.toString(); if (output.includes(`http://127.0.0.1:${port}/mcp`)) finish(); };
    const onError = error => finish(error);
    const onExit = code => finish(new Error(`MCP exited ${code}: ${stderr}`));
    child.stdout.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
  await remote.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  assert.equal(remote.getServerVersion()?.version, version, 'HTTP initialize version');
} finally {
  await remote.close();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
}
console.log(`Version metadata and stdio/HTTP MCP initialize agree: ${version}`);
