// Usage: node scripts/trace-retrieval-eval.mjs <private-config.json>
// All gold data, runtime copies, and raw traces stay outside tracked source files.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';

const options = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const sha = data => createHash('sha256').update(data).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const gold = read(options.gold);
const frozen = read(options.freeze);
assert.equal(gold.length, 100);
assert.equal(sha(fs.readFileSync(options.gold)), frozen.goldSha256);
assert.equal(sha(fs.readFileSync(options.reserve)), frozen.reservedSha256);
const environment = read(options.environment);
function checkFiles() {
  for (const [file, hash] of Object.entries({ ...environment.manifests, ...environment.sourceHashes })) {
    assert.equal(sha(fs.readFileSync(file)), hash, 'Source or manifest changed since original benchmark');
  }
}
checkFiles();
assert(!fs.existsSync(options.output), 'Use a new private output directory');
fs.mkdirSync(options.output, { recursive: true });
const status = await (await fetch(`${options.api}/api/status`)).json();
assert.equal(status.queue.length, 0);
const allWorkspaces = await (await fetch(`${options.api}/api/workspaces`)).json();
const norm = value => String(value ?? '').replaceAll('\\', '/').toLowerCase();
const matches = (r, g) => g.expected.some(e => norm(r.abs) === norm(e.evidencePath) && norm(r.symbol).includes(norm(e.symbolContains)));
const rank = (rows, g) => rows.findIndex(r => matches(r, g)) + 1;
function replaceOnce(source, from, to) {
  assert.equal(source.split(from).length, 2, `Instrumentation anchor must occur once: ${from}`);
  return source.replace(from, to);
}
const versions = [];
const provenance = [];
for (const definition of options.versions) {
  const runtime = path.resolve(definition.runtime);
  const copy = path.resolve(definition.copy);
  assert(!fs.existsSync(copy), 'Never overwrite a runtime copy');
  assert.notEqual(runtime, copy);
  fs.mkdirSync(copy, { recursive: true });
  const moduleHashes = {};
  for (const file of fs.readdirSync(runtime).filter(file => file.endsWith('.js'))) {
    moduleHashes[file] = sha(fs.readFileSync(path.join(runtime, file)));
    fs.copyFileSync(path.join(runtime, file), path.join(copy, file));
  }
  let source = fs.readFileSync(path.join(copy, 'search.js'), 'utf8');
  source = 'import { observeRows, observeEmbed, observeReranker } from "./retrieval-trace-hook.mjs";\n' + source;
  source = replaceOnce(source, '.rerank(rr)', '.rerank(observeReranker(rr))');
  source = replaceOnce(source, 'queryVector ??= embedQuery(cfg, query)', 'queryVector ??= observeEmbed(() => embedQuery(cfg, query))');
  const rowLines = source.match(/^\s*const rows = await .*\.toArray\(\);$/gm);
  assert.equal(rowLines?.length, 6, 'Unexpected search implementation; review instrumentation');
  source = source.replace(/^(\s*const rows = await .*\.toArray\(\);)$/gm,
    '$1\n            observeRows("query_return", rows);');
  fs.writeFileSync(path.join(copy, 'search.js'), source);
  fs.copyFileSync(new URL('./retrieval-trace-hook.mjs', import.meta.url), path.join(copy, 'retrieval-trace-hook.mjs'));
  const url = pathToFileURL(copy + path.sep).href;
  const { loadConfig } = await import(url + 'config.js');
  const { search } = await import(url + 'search.js');
  const hook = await import(url + 'retrieval-trace-hook.mjs');
  const { subscribeActivity } = await import(url + 'activity.js');
  subscribeActivity(hook.observeEvent);
  const prior = read(definition.prior);
  assert.deepEqual(prior.gold, gold);
  const index = new Map(prior.runs.map(r => [`${r.id}|${r.mode}|${r.round}`, r]));
  versions.push({ name: definition.name, search, hook, index, cfg: { ...loadConfig(), dbDir: status.dbDir }, url });
  provenance.push({ name: definition.name, moduleHashes, instrumentedSearchSha256: sha(source) });
}
const { getConnection, tableNameFor } = await import(versions[0].url + 'db.js');
const db = await getConnection(versions[0].cfg);
const tableVersions = {};
for (const slug of new Set(gold.map(g => g.workspace))) {
  const table = await db.openTable(tableNameFor(slug));
  tableVersions[slug] = await table.version();
  const rows = await table.query().select(['id', 'abs', 'symbol']).limit(100000).toArray();
  for (const g of gold.filter(g => g.workspace === slug)) assert(rank(rows, g) > 0, 'Gold target absent from index');
}
fs.writeFileSync(path.join(options.output, 'provenance.local.json'), JSON.stringify({
  at: new Date().toISOString(), goldSha256: frozen.goldSha256, provenance, tableVersions,
  manifestDriftSinceOriginal: environment.manifestDriftSinceOriginal ?? [],
  environmentSha256: sha(fs.readFileSync(options.environment)),
  hookSha256: sha(fs.readFileSync(new URL('./retrieval-trace-hook.mjs', import.meta.url))),
  runnerSha256: sha(fs.readFileSync(new URL(import.meta.url))),
  protocol: { questions: 100, rounds: 5, modes: 3, versions: 2, cacheBypassed: true, topN: 5, fileGlob: null },
}, null, 2));
let warmups = 0;
for (const version of versions) for (const slug of new Set(gold.map(g => g.workspace))) {
  await version.search(version.cfg, allWorkspaces.filter(w => w.slug === slug), gold.find(g => g.workspace === slug).query, 5, 'hybrid', { bypassCache: true, client: 'local:trace-warmup' });
  warmups++;
}
const targetFile = path.join(options.output, 'traces.local.jsonl');
let searches = 0;
for (let round = 1; round <= 5; round++) {
  for (let i = 0; i < gold.length; i++) {
    const g = gold[i];
    const workspaces = allWorkspaces.filter(w => w.slug === g.workspace);
    assert.equal(workspaces.length, 1);
    for (let j = 0; j < 3; j++) {
      const mode = ['fts', 'vector', 'hybrid'][(j + i + round) % 3];
      const order = (i + round) % 2 ? versions : [...versions].reverse();
      for (const version of order) {
        const trace = { id: g.id, version: version.name, mode, round, started: performance.now(),
          events: [], snapshots: [], embeddings: [] };
        const result = await version.hook.withTrace(trace, async () => {
          const response = await version.search(version.cfg, workspaces, g.query, 5, mode,
            { bypassCache: true, client: 'local:trajectory-evaluation' });
          version.hook.observeRows('search_return', response.hits);
          version.hook.observeRows('evaluation_top5', response.hits.slice(0, 5));
          return response;
        });
        trace.ms = performance.now() - trace.started;
        delete trace.started;
        trace.cached = !!result.cached;
        trace.warnings = result.warnings;
        trace.workspaceResults = result.workspaceResults;
        trace.targetRank = rank(result.hits.slice(0, 5), g);
        const comparable = result.hits.slice(0, 5).map(h => ({ id: h.id, file: h.file, abs: h.abs, symbol: h.symbol,
          startLine: h.startLine, endLine: h.endLine, score: h.score, text: h.text.slice(0, 1200) }));
        const previous = version.index.get(`${g.id}|${mode}|${round}`);
        assert(previous);
        assert.deepEqual(comparable, previous.hits, 'Trace run differs from frozen benchmark');
        assert.equal(trace.targetRank, previous.targetRank);
        assert.equal(trace.cached, false);
        assert.equal(trace.warnings.length, 0);
        assert(result.workspaceResults.every(w => !w.failed && w.effectiveMode === mode));
        assert.equal(trace.embeddings.length, mode === 'fts' ? 0 : 1);
        assert.equal(trace.events.filter(e => e.type === 'search.done').length, 1);
        assert.equal(trace.snapshots.filter(s => s.stage === 'vector_candidates').length, mode === 'hybrid' ? 1 : 0);
        for (const snapshot of trace.snapshots) snapshot.targetRank = rank(snapshot.rows, g);
        trace.originalTop5Identical = true;
        fs.appendFileSync(targetFile, JSON.stringify(trace) + '\n');
        searches++;
      }
    }
  }
  console.log(JSON.stringify({ round, searches, originalTop5Identical: true }));
}
checkFiles();
for (const [slug, value] of Object.entries(tableVersions)) {
  assert.equal(await (await db.openTable(tableNameFor(slug))).version(), value, 'Table version changed');
}
assert.equal(sha(fs.readFileSync(options.reserve)), frozen.reservedSha256);
const verification = { searches, warmups, originalTop5Identical: searches, goldUnchanged: true,
  reserveUnchangedAndUnsearched: true, sourceAndManifestsUnchangedDuringTraceRun: true, tableVersionsUnchanged: true };
fs.writeFileSync(path.join(options.output, 'verification.local.json'), JSON.stringify(verification, null, 2));
console.log(JSON.stringify(verification));
