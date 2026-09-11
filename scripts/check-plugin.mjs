import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const read = p => JSON.parse(readFileSync(new URL(p, root), 'utf8'));
const claude = read('.claude-plugin/plugin.json');
const codex = read('.codex-plugin/plugin.json');
const version = read('greplet-mcpb/package.json').version;
for (const plugin of [claude, codex]) {
  assert.equal(plugin.name, 'greplet');
  assert.equal(plugin.version, version);
}
assert.equal(read('.claude-plugin/marketplace.json').plugins[0].source, './');
assert.equal(read('.agents/plugins/marketplace.json').plugins[0].source.path, './');
assert.deepEqual(read('.mcp.json').mcpServers.greplet.args,
  ['${CLAUDE_PLUGIN_ROOT}/scripts/plugin-bootstrap.mjs']);
assert.deepEqual(codex.mcpServers.greplet.args, ['scripts/plugin-bootstrap.mjs']);
assert.equal(codex.mcpServers.greplet.cwd, '.');
for (const path of ['scripts/plugin-bootstrap.mjs', 'skills/greplet/SKILL.md', 'greplet-mcpb/server/index.js']) {
  assert.ok(existsSync(new URL(path, root)), path);
}
console.log('Plugin manifests, versions, and local entrypoints verified.');
