// Compare complete hybrid returns against uninstrumented frozen runtimes, not only top 5.
// Usage: node scripts/verify-retrieval-trace-equivalence.mjs <private-config.json>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const cfg = read(process.argv[2]);
const environment = read(cfg.environment);
const provenance = read(path.join(cfg.output, 'provenance.local.json'));
const verification = read(path.join(cfg.output, 'verification.local.json'));
assert.equal(verification.searches, 3000);
function checkFiles() {
  for (const [file, hash] of Object.entries({ ...environment.manifests, ...environment.sourceHashes })) assert.equal(sha(file), hash);
}
checkFiles();
assert.equal(sha(cfg.gold), provenance.goldSha256);
const gold = read(cfg.gold);
const traces = fs.readFileSync(path.join(cfg.output, 'traces.local.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  .filter(t => t.round === 1 && t.mode === 'hybrid');
assert.equal(traces.length, 200);
const status = await (await fetch(`${cfg.api}/api/status`)).json();
assert.equal(status.queue.length, 0);
const workspaces = await (await fetch(`${cfg.api}/api/workspaces`)).json();
let checked = 0;
for (const definition of cfg.versions) {
  const url = pathToFileURL(path.resolve(definition.runtime) + path.sep).href;
  const expected = provenance.provenance.find(v => v.name === definition.name).moduleHashes;
  for (const [file, hash] of Object.entries(expected)) assert.equal(sha(path.join(definition.runtime, file)), hash);
  const { search } = await import(url + 'search.js');
  const { loadConfig } = await import(url + 'config.js');
  const { getConnection, tableNameFor } = await import(url + 'db.js');
  const config = { ...loadConfig(), dbDir: status.dbDir };
  const db = await getConnection(config);
  const checkVersions = async () => {
    for (const [slug, version] of Object.entries(provenance.tableVersions)) {
      assert.equal(await (await db.openTable(tableNameFor(slug))).version(), version);
    }
  };
  await checkVersions();
  for (const g of gold) {
    const t = traces.find(t => t.id === g.id && t.version === definition.name);
    const result = await search(config, workspaces.filter(w => w.slug === g.workspace), g.query, 5, 'hybrid', { bypassCache: true, client: 'local:trace-equivalence' });
    const rows = t.snapshots.find(s => s.stage === 'search_return').rows;
    assert.deepEqual(result.hits.map(r => [r.id, r.abs, r.symbol, r.score]), rows.map(r => [r.id, r.abs, r.symbol, r.score]));
    assert.deepEqual(result.warnings, t.warnings);
    assert.deepEqual(result.workspaceResults, t.workspaceResults);
    assert.equal(!!result.cached, t.cached);
    checked++;
  }
  await checkVersions();
}
checkFiles();
const report = { uninstrumentedHybridSearches: checked, fullReturnOrderScoresAndIdentityMatch: checked,
  effectiveModesWarningsAndCacheMatch: checked, sourceManifestsAndTableVersionsUnchangedDuringCheck: true };
fs.writeFileSync(path.join(cfg.output, 'equivalence.local.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
