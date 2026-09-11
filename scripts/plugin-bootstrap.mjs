// Resolve from the plugin location, never the caller's working directory.
// First launch installs only the locked stdio connector dependencies.
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const packageUrl = new URL('../greplet-mcpb/package.json', import.meta.url);
const cwd = fileURLToPath(new URL('../greplet-mcpb/', import.meta.url));
const require = createRequire(packageUrl);
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('greplet plugin requires Node.js 22 or newer.');
  process.exit(1);
}
try {
  require.resolve('@modelcontextprotocol/sdk/server/mcp.js');
  require.resolve('zod');
} catch {
  console.error('greplet: installing locked MCP dependencies (npm ci --ignore-scripts).');
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd, stdio: ['ignore', 2, 2], shell: process.platform === 'win32' });
  if (result.error || result.status !== 0) {
    console.error('greplet: dependency installation failed; check Node/npm and registry access.');
    process.exit(1);
  }
}
await import('../greplet-mcpb/server/index.js');
