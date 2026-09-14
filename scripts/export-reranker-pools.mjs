// Offline T13 candidate-pack exporter.
// Replays the frozen T12 baseline once in an isolated instrumented runtime;
// it never modifies the production runtime or performs reranker inference.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const EXPECTED = Object.freeze({ questions: 100, scorable: 80, hits: 17, mrr: 0.16604166666666667, multiComplete: 0 });

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const fileSha256 = file => sha256(fs.readFileSync(file));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const normalizedAbs = value => String(value ?? '').replaceAll('\\', '/').toLowerCase();
const stableKey = (workspace, abs, id, startLine, endLine) =>
  JSON.stringify([workspace, normalizedAbs(abs), id, Number(startLine), Number(endLine)]);
const oldKey = row => `${normalizedAbs(row.abs)}|${row.id}`;

function parseArgs(argv) {
  const options = { source: null, output: null, gold: null, cohort: 't12', referencesOnly: false, pack: null };
  for (let i = 0; i < argv.length;) {
    const flag = argv[i++];
    if (flag === '--references-only') { options.referencesOnly = true; continue; }
    const value = argv[i++];
    assert(value, `Missing value for ${flag}`);
    if (flag === '--source') options.source = value;
    else if (flag === '--output') options.output = value;
    else if (flag === '--gold') options.gold = value;
    else if (flag === '--cohort') options.cohort = value;
    else if (flag === '--pack') options.pack = value;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  assert(['t12', 'regression40'].includes(options.cohort), `Unknown cohort: ${options.cohort}`);
  assert(options.source, '--source is required');
  assert(options.output, '--output is required');
  if (options.cohort === 't12') options.gold ??= path.join(options.source, 'sealed-test', 'gold.local.json');
  else if (!options.referencesOnly) assert(options.gold, '--gold is required for regression40');
  options.pack ??= path.join(options.output, 'pack.local.json');
  return options;
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`${file}:${index + 1}: ${error.message}`); }
  });
}

function metricSummary(rows, goldById) {
  const scorable = rows.filter(row => goldById.get(row.id).groups.length > 0);
  return {
    questions: rows.length,
    scorable: scorable.length,
    hits: scorable.filter(row => row.rank > 0).length,
    mrr: scorable.reduce((sum, row) => sum + (row.rank > 0 ? 1 / row.rank : 0), 0) / scorable.length,
    multiComplete: rows.filter(row => goldById.get(row.id).stratum === 'multi' && row.completeAt5).length,
  };
}

function grade(hits, question) {
  if (question.groups.length === 0) return { rank: null, completeAt5: null, groupRanks: [] };
  const groupRanks = question.groups.map(group => {
    const accepted = new Set(group.alternatives.map(oldKey));
    return hits.slice(0, 5).findIndex(hit => accepted.has(oldKey(hit))) + 1;
  });
  const positive = groupRanks.filter(rank => rank > 0);
  return { rank: positive.length ? Math.min(...positive) : 0, completeAt5: groupRanks.every(rank => rank > 0), groupRanks };
}

function assertMetrics(actual, label) {
  assert.equal(actual.questions, EXPECTED.questions, `${label}: question count`);
  assert.equal(actual.scorable, EXPECTED.scorable, `${label}: scorable count`);
  assert.equal(actual.hits, EXPECTED.hits, `${label}: hit@5 count`);
  assert(Math.abs(actual.mrr - EXPECTED.mrr) < 1e-12, `${label}: MRR ${actual.mrr}`);
  assert.equal(actual.multiComplete, EXPECTED.multiComplete, `${label}: multi complete@5`);
}

function instrumentSearch(source, expectedHash) {
  assert.equal(sha256(source), expectedHash, 'Frozen search.js hash mismatch');
  const replaceOnce = (from, to) => {
    assert.equal(source.split(from).length, 2, `Instrumentation anchor mismatch: ${from}`);
    source = source.replace(from, to);
  };
  replaceOnce('.rerank(rr)', '.rerank(observeReranker(rr, ws.slug))');
  replaceOnce(
    'const hits = perWs.flat().sort((a, b) => b.score - a.score);',
    'observeRows("workspace_return", perWs.flat(), "*");\n        const hits = perWs.flat().sort((a, b) => b.score - a.score);',
  );
  const rows = source.match(/^\s*const rows = await .*\.toArray\(\);$/gm);
  assert.equal(rows?.length, 6, 'Unexpected frozen query materialization count');
  source = source.replace(
    /^(\s*const rows = await .*\.toArray\(\);)$/gm,
    '$1\nobserveRows("query_return", rows, ws.slug);',
  );
  return 'import { observeRows, observeReranker } from "./pool-observer.mjs";\n' + source;
}

function observerSource() {
  return `import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
const context = new AsyncLocalStorage();
const sha256 = value => createHash('sha256').update(value).digest('hex');
export const withTrace = (trace, run) => context.run(trace, run);
export function observeRows(stage, rows, workspace) {
  const trace = context.getStore();
  if (!trace) return;
  trace.snapshots.push({ stage, workspace, rows: rows.map((row, index) => ({
    rank: index + 1, id: row.id, abs: row.abs, symbol: row.symbol,
    startLine: row.start_line, endLine: row.end_line, fileHash: row.file_hash,
    textSha256: sha256(String(row.text ?? '')),
    score: Number(row._relevance_score ?? row._score ?? row._distance ?? row.score ?? 0),
  })) });
}
export function observeReranker(reranker, workspace) {
  const trace = context.getStore();
  return { rerankHybrid(query, vector, fts) {
    return context.run(trace, async () => {
      observeRows('vector_candidates', vector.toArray(), workspace);
      observeRows('fts_candidates', fts.toArray(), workspace);
      const fused = await reranker.rerankHybrid(query, vector, fts);
      observeRows('fused_union', fused.toArray(), workspace);
      return fused;
    });
  }};
}
`;
}

async function verifyEmbedding(config, expected) {
  const configured = config.ollamaModel.includes(':') ? config.ollamaModel : `${config.ollamaModel}:latest`;
  assert.equal(configured, expected.name, 'Configured embedding model changed');
  const response = await fetch(`${config.ollamaUrl}/api/tags`);
  assert(response.ok, `Embedding inventory unavailable: HTTP ${response.status}`);
  const inventory = await response.json();
  assert(inventory.models.some(model => model.name === expected.name && model.digest === expected.digest),
    'Frozen embedding model digest is unavailable');
}

async function loadHydrationMaps(db, inventory, snapshot) {
  const maps = new Map(), collisions = [];
  for (const workspace of inventory.workspaces) {
    const table = await db.openTable(workspace.table.name);
    assert.equal(await table.version(), snapshot.versions[workspace.slug], `${workspace.slug}: frozen table version`);
    const rows = await table.query().select(['id', 'abs', 'file', 'symbol', 'start_line', 'end_line', 'file_hash', 'text'])
      .limit(workspace.table.rows).toArray();
    assert.equal(rows.length, workspace.table.rows, `${workspace.slug}: frozen row count`);
    const map = new Map();
    for (const row of rows) {
      const matches = map.get(row.id) ?? [];
      matches.push(row);
      map.set(row.id, matches);
    }
    for (const [id, matches] of map) if (matches.length > 1) collisions.push({ workspace: workspace.slug, id, rows: matches.length });
    maps.set(workspace.slug, map);
  }
  return { maps, collisions };
}

function hydrateCandidate(candidate, maps) {
  const matches = maps.get(candidate.workspace)?.get(candidate.id) ?? [];
  const normalizedExact = matches.filter(row => normalizedAbs(row.abs) === normalizedAbs(candidate.abs) &&
    Number(row.start_line) === Number(candidate.startLine) && Number(row.end_line) === Number(candidate.endLine));
  const identity = stableKey(candidate.workspace, candidate.abs, candidate.id, candidate.startLine, candidate.endLine);
  assert.equal(normalizedExact.length, 1, `Ambiguous or missing hydration: ${identity}`);
  const row = normalizedExact[0];
  assert.equal(typeof row.text, 'string', `Missing text: ${identity}`);
  assert.equal(sha256(row.text), candidate.textSha256, `Hydrated text hash mismatch: ${identity}`);
  if (candidate.fileHash !== undefined) assert.equal(row.file_hash, candidate.fileHash, `Hydrated file hash mismatch: ${identity}`);
  return {
    key: identity, workspace: candidate.workspace, id: candidate.id,
    file: row.file, symbol: row.symbol, text: row.text, score: Number(candidate.score),
  };
}

function mergeFusedUnion(trace) {
  const rows = trace.snapshots.filter(snapshot => snapshot.stage === 'fused_union')
    .flatMap(snapshot => snapshot.rows.map(row => ({ ...row, workspace: snapshot.workspace })));
  const seen = new Set();
  return rows.sort((a, b) => b.score - a.score).filter(row => {
    const key = stableKey(row.workspace, row.abs, row.id, row.startLine, row.endLine);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeRegressionGold(rawGold, hydration) {
  const unavailableGoldMappings = [], mappingCounts = [];
  const normalized = rawGold.map(question => {
    const rows = [...(hydration.maps.get(question.workspace)?.values() ?? [])].flat();
    assert(rows.length > 0, `${question.id}: requested workspace is absent from frozen DB`);
    const alternatives = question.expected.flatMap(expected => rows.filter(row => {
      const fileMatches = normalizedAbs(row.abs) === normalizedAbs(expected.evidencePath) ||
        normalizedAbs(row.file).endsWith(normalizedAbs(expected.fileSuffix));
      if (!fileMatches) return false;
      if (expected.evidencePage !== undefined) return row.start_line <= expected.evidencePage && row.end_line >= expected.evidencePage;
      if (expected.symbolContains !== undefined) return normalizedAbs(row.symbol).includes(normalizedAbs(expected.symbolContains));
      if (expected.textContains !== undefined) return normalizedAbs(row.text).includes(normalizedAbs(expected.textContains));
      return false;
    })).map(row => ({
      workspace: question.workspace, id: row.id, abs: row.abs, start_line: row.start_line, end_line: row.end_line,
      file_hash: row.file_hash,
    }));
    const unique = [...new Map(alternatives.map(row => [stableKey(row.workspace, row.abs, row.id, row.start_line, row.end_line), row])).values()];
    mappingCounts.push({ caseId: question.id, variants: unique.length });
    if (unique.length === 0) unavailableGoldMappings.push({ caseId: question.id, workspace: question.workspace, reason: 'no_strict_frozen_row_match' });
    return {
      id: question.id, query: question.query, stratum: question.kind, origin: 'mixed40',
      familyLabel: `${question.workspace}:${question.kind}`, requestedWorkspace: question.workspace,
      groups: [{ name: 'known-target', alternatives: unique }],
    };
  });
  return { normalized, unavailableGoldMappings, mappingCounts };
}

async function exportReferenceDocuments({ source, output, pack: packPath, cohort }) {
  const snapshotPath = path.join(source, 'snapshot.local.json');
  const freezePath = path.join(source, 'freeze.local.json');
  const inventoryPath = path.join(source, 'catalog', 'inventory.local.json');
  for (const file of [snapshotPath, freezePath, inventoryPath, packPath]) {
    assert(fs.statSync(file).isFile(), `Missing input: ${file}`);
  }
  assert(fs.statSync(output).isDirectory(), `Output directory does not exist: ${output}`);
  const destination = path.join(output, 'reference-documents.local.json');
  assert(!fs.existsSync(destination), `Refusing to overwrite output: ${destination}`);

  const snapshot = readJson(snapshotPath), freeze = readJson(freezePath), inventory = readJson(inventoryPath), pack = readJson(packPath);
  assert.equal(pack.schemaVersion, 1, 'Unsupported pack schema');
  assert.equal(fileSha256(snapshotPath), freeze.snapshotSha256, 'Snapshot hash differs from freeze');
  assert.equal(pack.provenance.database.path.replaceAll('\\', '/'), snapshot.dbDir.replaceAll('\\', '/'), 'Pack database path mismatch');
  assert.deepEqual(pack.provenance.database.versions, snapshot.versions, 'Pack database versions mismatch');
  assert.equal(pack.provenance.sourceFiles.snapshot.sha256, fileSha256(snapshotPath), 'Pack snapshot hash mismatch');

  const dependencyEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'indexer', 'node_modules', '@lancedb', 'lancedb', 'dist', 'index.js');
  assert(fs.statSync(dependencyEntry).isFile(), `Missing LanceDB dependency: ${dependencyEntry}`);
  const { connect } = await import(pathToFileURL(dependencyEntry).href);
  const db = await connect(snapshot.dbDir);
  const hydration = await loadHydrationMaps(db, inventory, snapshot);
  const referenceKeys = [...new Set(pack.cases.flatMap(item => item.groups.flatMap(group => group.keys)))];
  const documents = {};
  for (const key of referenceKeys) {
    let identity;
    try { identity = JSON.parse(key); }
    catch { throw new Error(`Invalid candidate key JSON in pack: ${key}`); }
    assert(Array.isArray(identity) && identity.length === 5, `Invalid candidate key shape: ${key}`);
    const [workspace, abs, id, startLine, endLine] = identity;
    assert.equal(stableKey(workspace, abs, id, startLine, endLine), key, `Non-canonical candidate key: ${key}`);
    const matches = (hydration.maps.get(workspace)?.get(id) ?? []).filter(row =>
      normalizedAbs(row.abs) === abs && Number(row.start_line) === Number(startLine) && Number(row.end_line) === Number(endLine));
    assert.equal(matches.length, 1, `Gold reference is missing or ambiguous in frozen DB: ${key}`);
    const row = matches[0];
    assert.equal(typeof row.text, 'string', `Gold reference text missing: ${key}`);
    documents[key] = {
      workspace, file: row.file, symbol: row.symbol, text: row.text, sourceHash: row.file_hash,
      startLine: Number(row.start_line), endLine: Number(row.end_line), textSha256: sha256(row.text),
    };
  }
  const packSha256 = fileSha256(packPath);
  const result = {
    schemaVersion: 1, cohort, createdAt: new Date().toISOString(),
    pack: { path: packPath, sha256: packSha256, verified: true },
    frozenSource: {
      snapshot: { path: snapshotPath, sha256: fileSha256(snapshotPath) },
      database: { path: snapshot.dbDir, versions: snapshot.versions },
      identityScheme: pack.provenance.identityScheme,
    },
    references: { requested: referenceKeys.length, hydrated: Object.keys(documents).length, missing: 0, ambiguous: 0 },
    exporterSourceSnapshot: fs.existsSync(path.join(output, 'exporter-source.local.mjs'))
      ? { path: path.join(output, 'exporter-source.local.mjs'), sha256: fileSha256(path.join(output, 'exporter-source.local.mjs')) }
      : { available: false, reason: 'successful exporter source was not captured with the original pack' },
    documents,
  };
  fs.writeFileSync(destination, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ completed: true, referencesOnly: true, cohort, destination, packSha256, references: result.references }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.referencesOnly) return exportReferenceDocuments(options);
  const { source, output, gold: goldPath, cohort } = options;
  const files = {
    config: path.join(source, 'test-config.local.json'), snapshot: path.join(source, 'snapshot.local.json'),
    freeze: path.join(source, 'freeze.local.json'), gold: goldPath,
    inventory: path.join(source, 'catalog', 'inventory.local.json'),
  };
  if (cohort === 't12') Object.assign(files, {
    runs: path.join(source, 'test-results', 'runs.local.jsonl'),
    completion: path.join(source, 'test-results', 'completion.local.json'),
  });
  for (const file of Object.values(files)) assert(fs.statSync(file).isFile(), `Missing input: ${file}`);
  assert(!fs.existsSync(output), `Refusing to overwrite output: ${output}`);

  const config = readJson(files.config), snapshot = readJson(files.snapshot), freeze = readJson(files.freeze);
  const completion = cohort === 't12' ? readJson(files.completion) : null;
  const inventory = readJson(files.inventory), goldFile = readJson(files.gold);
  const rawGold = Array.isArray(goldFile) ? goldFile : goldFile.items;
  assert.equal(rawGold.length, cohort === 't12' ? EXPECTED.questions : 40, `${cohort}: question count`);
  assert.equal(new Set(rawGold.map(item => item.id)).size, rawGold.length, `${cohort}: duplicate question id`);
  if (cohort === 't12') {
    assert.equal(fileSha256(files.gold), freeze.testSha256, 'Gold hash differs from freeze');
    assert.equal(fileSha256(files.gold), completion.dataSha256, 'Gold hash differs from completed run');
  }
  assert.equal(fileSha256(files.snapshot), freeze.snapshotSha256, 'Snapshot hash differs from freeze');
  if (cohort === 't12') {
    assert.equal(fileSha256(files.snapshot), completion.snapshotSha256, 'Snapshot hash differs from completed run');
    assert.equal(fileSha256(files.config), completion.configSha256, 'Config hash differs from completed run');
  }
  assert.equal(config.snapshot.replaceAll('\\', '/'), files.snapshot.replaceAll('\\', '/'), 'Config snapshot path mismatch');
  assert.deepEqual(config.embedding, freeze.embedding, 'Embedding freeze mismatch');
  if (cohort === 't12') assert.deepEqual(completion.embedding, freeze.embedding, 'Completed embedding mismatch');

  const implementationHashes = {};
  for (const [name, expectedHash] of Object.entries(snapshot.compiledHashes)) {
    const actual = fileSha256(path.join(snapshot.baseline, name));
    assert.equal(actual, expectedHash, `Frozen implementation changed: ${name}`);
    implementationHashes[name] = actual;
  }

  const persisted = cohort === 't12' ? readJsonl(files.runs).filter(row => row.method === 'A0' &&
    row.policy === 'production_scoped_prefix3' && row.order === 'normal' && row.round === 1) : [];
  const persistedById = new Map(persisted.map(row => [row.id, row]));

  fs.mkdirSync(output, { recursive: false });
  const runtime = path.join(output, 'frozen-runtime.local');
  fs.mkdirSync(runtime);
  const dependencyTree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'indexer', 'node_modules');
  assert(fs.statSync(dependencyTree).isDirectory(), `Missing frozen runtime dependencies: ${dependencyTree}`);
  fs.symlinkSync(dependencyTree, path.join(runtime, 'node_modules'), 'junction');
  for (const name of fs.readdirSync(snapshot.baseline).filter(name => name.endsWith('.js'))) {
    fs.copyFileSync(path.join(snapshot.baseline, name), path.join(runtime, name));
  }
  const instrumentedSearch = instrumentSearch(fs.readFileSync(path.join(runtime, 'search.js'), 'utf8'), snapshot.compiledHashes['search.js']);
  fs.writeFileSync(path.join(runtime, 'search.js'), instrumentedSearch);
  fs.writeFileSync(path.join(runtime, 'pool-observer.mjs'), observerSource());

  const runtimeUrl = pathToFileURL(runtime + path.sep).href;
  const { loadConfig } = await import(runtimeUrl + 'config.js');
  const { search } = await import(runtimeUrl + 'search.js');
  const hook = await import(runtimeUrl + 'pool-observer.mjs');
  const { subscribeActivity } = await import(runtimeUrl + 'activity.js');
  const { getConnection } = await import(runtimeUrl + 'db.js');
  const eventsByTrace = new WeakMap();
  subscribeActivity(event => {
    const active = activeTrace;
    if (active) eventsByTrace.get(active).push(event);
  });
  let activeTrace = null;

  const baseConfig = { ...loadConfig(), dbDir: snapshot.dbDir };
  await verifyEmbedding(baseConfig, freeze.embedding);
  const db = await getConnection(baseConfig);
  const hydration = await loadHydrationMaps(db, inventory, snapshot);
  const workspaces = inventory.workspaces.map(workspace => ({
    slug: workspace.slug, label: workspace.label, kind: workspace.kind, roots: workspace.api.roots,
    includeExt: [], excludeDirs: [], excludeFiles: [], pdfPasswordFile: null,
  }));
  const regressionMapping = cohort === 'regression40' ? normalizeRegressionGold(rawGold, hydration) : null;
  const gold = cohort === 't12' ? rawGold : regressionMapping.normalized;
  const goldById = new Map(gold.map(item => [item.id, item]));
  let persistedMetrics = null;
  if (cohort === 't12') {
    assert.equal(persisted.length, EXPECTED.questions, 'Persisted baseline selection');
    assert.equal(new Set(persisted.map(row => row.id)).size, EXPECTED.questions, 'Persisted baseline duplicate id');
    for (const row of persisted) assert(!row.failed && row.warnings.length === 0, `${row.id}: persisted baseline was not clean`);
    persistedMetrics = metricSummary(persisted, goldById);
    assertMetrics(persistedMetrics, 'Persisted B0');
  }

  const rerunRows = [], rawCases = [];
  const startedAt = new Date().toISOString();
  for (let index = 0; index < gold.length; index++) {
    const question = gold[index];
    const trace = { snapshots: [] };
    eventsByTrace.set(trace, []);
    activeTrace = trace;
    const started = performance.now();
    let result;
    const requestedWorkspaces = cohort === 't12' ? workspaces : workspaces.filter(workspace => workspace.slug === question.requestedWorkspace);
    assert.equal(requestedWorkspaces.length, cohort === 't12' ? workspaces.length : 1, `${question.id}: requested scope unavailable`);
    try {
      result = await hook.withTrace(trace, () => search(baseConfig, requestedWorkspaces, question.query, 5, 'hybrid', {
        bypassCache: true, client: 'local:t13-pool-export',
      }));
    } finally { activeTrace = null; }
    assert(!result.cached, `${question.id}: unexpected cache hit`);
    assert.equal(result.warnings.length, 0, `${question.id}: rerun warning: ${result.warnings.join('; ')}`);
    assert(result.workspaceResults.every(row => !row.failed), `${question.id}: workspace failure`);
    const judged = grade(result.hits, question);
    if (cohort === 't12') {
      const original = persistedById.get(question.id);
      assert(original, `${question.id}: persisted baseline missing`);
      assert.deepEqual(result.hits.slice(0, 5).map(hit => [hit.workspace, hit.id, hit.abs]),
        original.hits.map(hit => [hit.workspace, hit.id, hit.abs]), `${question.id}: B0 top5 drift`);
      assert.equal(judged.rank, original.rank, `${question.id}: B0 rank drift`);
      assert.equal(judged.completeAt5, original.completeAt5, `${question.id}: B0 completion drift`);
    }
    rerunRows.push({ id: question.id, ...judged });

    const bypassExact = eventsByTrace.get(trace).some(event => event.type === 'search.stage' && event.note === 'Exact symbol definitions');
    const cRows = result.hits.map(hit => ({
      workspace: hit.workspace, id: hit.id, abs: hit.abs, startLine: hit.startLine, endLine: hit.endLine,
      fileHash: hit.fileHash, textSha256: sha256(String(hit.text ?? '')), score: hit.score,
    }));
    const uRows = mergeFusedUnion(trace);
    rawCases.push({ question, bypassExact, cRows, uRows, elapsedMs: performance.now() - started });
    if ((index + 1) % 10 === 0) console.log(JSON.stringify({ exported: index + 1, total: gold.length }));
  }
  const rerunMetrics = metricSummary(rerunRows, goldById);
  if (cohort === 't12') {
    assertMetrics(rerunMetrics, 'Rerun B0');
    assert.deepEqual(rerunMetrics, persistedMetrics, 'Rerun aggregate differs from persisted B0');
  }

  const unknowns = [], ambiguousGoldMappings = [];
  const cases = rawCases.map(({ question, bypassExact, cRows, uRows }) => {
    if (!bypassExact && uRows.length === 0) unknowns.push({ caseId: question.id, pool: 'U', reason: 'no_fused_union_observed' });
    const familyIds = [...new Set(question.groups.flatMap(group => group.alternatives.map(alt => alt.familyId).filter(Boolean)))].sort();
    return {
      id: question.id, query: question.query, category: question.stratum,
      family: familyIds.length ? familyIds.join('+') : (question.familyLabel ?? question.origin),
      groups: question.groups.map((group, index) => {
        const keys = group.alternatives.flatMap(alt => {
          if (Number.isFinite(Number(alt.start_line)) && Number.isFinite(Number(alt.end_line))) {
            return [stableKey(alt.workspace, alt.abs, alt.id, alt.start_line, alt.end_line)];
          }
          const matches = (hydration.maps.get(alt.workspace)?.get(alt.id) ?? [])
            .filter(row => normalizedAbs(row.abs) === normalizedAbs(alt.abs));
          assert(matches.length > 0, `${question.id}: gold alternative cannot be mapped`);
          const variants = matches.map(row => stableKey(alt.workspace, row.abs, alt.id, row.start_line, row.end_line));
          if (variants.length > 1) ambiguousGoldMappings.push({ caseId: question.id, groupId: `g${index + 1}`, variants });
          return variants;
        });
        return { id: `g${index + 1}`, keys: [...new Set(keys)] };
      }),
      bypassExact,
      C: cRows.map(row => hydrateCandidate(row, hydration.maps)),
      U: uRows.map(row => hydrateCandidate(row, hydration.maps)),
    };
  });
  for (const item of cases) for (const poolName of ['C', 'U']) {
    assert.equal(new Set(item[poolName].map(candidate => candidate.key)).size, item[poolName].length,
      `${item.id}: ${poolName} contains non-unique [workspace,id] keys`);
  }

  const pack = {
    schemaVersion: 1,
    provenance: {
      createdAt: new Date().toISOString(), startedAt,
      sourceKind: cohort === 't12' ? 'frozen_t12_retrieval_rerun' : 'frozen_mixed40_regression_rerun',
      retrievalCalls: gold.length, rerankerInferenceCalls: 0,
      sourceFiles: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, { path: file, sha256: fileSha256(file) }])),
      frozenBaseline: { path: snapshot.baseline, implementationHashes, instrumentedSearchSha256: sha256(instrumentedSearch) },
      database: { path: snapshot.dbDir, versions: snapshot.versions }, embedding: freeze.embedding,
      selection: {
        method: 'A0', policy: 'production_scoped_prefix3', order: 'normal', round: 1, topN: 5, mode: 'hybrid',
        scope: cohort === 't12' ? 'all frozen workspaces in inventory order' : 'one explicit gold workspace per case',
      },
      pools: {
        C: 'full globally sorted result.hits returned by the frozen baseline before consumer top5 slicing',
        U: 'deduplicated fused_union observations, merged by descending existing fusion score with stable original order',
      },
      baselineComparison: cohort === 't12'
        ? { exactTop5AndRanks: true, persisted: persistedMetrics, rerun: rerunMetrics }
        : { historicalCompared: false, reason: 'current frozen-policy paired baseline', rerun: rerunMetrics },
      identityScheme: 'JSON.stringify([workspace, normalizedAbsoluteSourcePath, id, startLine, endLine]); absolute path uses forward slashes and lowercase',
      identityAudit: {
        databaseWorkspaceIdCollisions: hydration.collisions.length, exportedPoolKeyCollisions: 0,
        hydratedTextHashesVerified: cases.reduce((sum, item) => sum + item.C.length + item.U.length, 0),
        ambiguousGoldMappings,
        unavailableGoldMappings: regressionMapping?.unavailableGoldMappings ?? [],
        regressionGoldMappingCounts: regressionMapping?.mappingCounts ?? [],
      },
      unknowns,
    },
    cases,
  };
  fs.writeFileSync(path.join(output, 'pack.local.json'), JSON.stringify(pack, null, 2));
  fs.writeFileSync(path.join(output, 'completion.local.json'), JSON.stringify({
    completedAt: new Date().toISOString(), schemaVersion: 1, questions: cases.length,
    packSha256: fileSha256(path.join(output, 'pack.local.json')), baselineComparison: pack.provenance.baselineComparison,
    candidateCounts: {
      C: cases.reduce((sum, item) => sum + item.C.length, 0), U: cases.reduce((sum, item) => sum + item.U.length, 0),
    }, unknowns,
  }, null, 2));
  console.log(JSON.stringify({ completed: true, output, questions: cases.length, baseline: rerunMetrics, unknowns: unknowns.length }));
}

await main();
