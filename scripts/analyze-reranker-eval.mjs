#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const TOP_K = 5;
const BOOTSTRAP_SAMPLES = 4000;
const METHODS = ['B0', 'BC', 'R1'];

function fail(message) { throw new Error(message); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function sha256File(file) {
  const hash = createHash('sha256'), descriptor = fs.openSync(file, 'r'), buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    let bytes;
    while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}
function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function mean(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }
function sum(values) { return values.reduce((a, b) => a + b, 0); }
function percentile(sorted, probability) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index), upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}
function roundNumber(value) { return value == null ? null : Number(value.toFixed(10)); }
function sameMembers(a, b) { return a.length === b.length && new Set(a).size === a.length && a.every(x => b.includes(x)); }
function sameArray(a, b) { return a.length === b.length && a.every((x, i) => x === b[i]); }
function canonical(rows, scores = null) {
  return [...rows].sort((a, b) => {
    const av = scores ? scores[a.key] : a.score;
    const bv = scores ? scores[b.key] : b.score;
    if (!finite(av) || !finite(bv)) fail('Ranking contains a non-finite score');
    if (bv !== av) return bv - av;
    return String(a.key) < String(b.key) ? -1 : String(a.key) > String(b.key) ? 1 : 0;
  }).map(row => row.key);
}
function listScoreFiles(root) {
  const result = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && (entry.name === 'scores.local.jsonl' || entry.name.endsWith('.scores.jsonl'))) result.push(full);
    }
  }
  visit(root);
  return result.sort();
}
function readRows(scoresDir) {
  const files = listScoreFiles(scoresDir);
  if (!files.length) fail(`No scores.local.jsonl or *.scores.jsonl files under ${scoresDir}`);
  const rows = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.trim());
    for (let i = 0; i < lines.length; i++) {
      let row;
      try { row = JSON.parse(lines[i]); } catch (error) { fail(`${file}:${i + 1}: invalid JSON: ${error.message}`); }
      rows.push({ ...row, __source: file, __line: i + 1 });
    }
  }
  return { files, rows };
}

function validatePack(pack) {
  if (pack?.schemaVersion !== 1 || !Array.isArray(pack.cases) || !pack.cases.length) fail('Pack must be schemaVersion 1 with non-empty cases');
  if (new Set(pack.cases.map(c => c.id)).size !== pack.cases.length) fail('Duplicate pack case ID');
  for (const q of pack.cases) {
    if (typeof q.id !== 'string' || !q.id || typeof q.query !== 'string') fail('Every case requires string id and query');
    if (!Array.isArray(q.C) || !Array.isArray(q.U) || !Array.isArray(q.groups)) fail(`${q.id}: C, U, and groups must be arrays`);
    for (const poolName of ['C', 'U']) {
      const pool = q[poolName];
      if (new Set(pool.map(r => r.key)).size !== pool.length) fail(`${q.id}: duplicate ${poolName} key`);
      for (const row of pool) if (typeof row.key !== 'string' || !finite(row.score)) fail(`${q.id}: invalid ${poolName} candidate`);
    }
    const uKeys = new Set(q.U.map(row => row.key));
    if (!q.bypassExact && q.C.some(row => !uKeys.has(row.key))) fail(`${q.id}: C must be a subset of U except for an explicit exact-match bypass`);
    if (q.families != null && (!Array.isArray(q.families) || q.families.some(value => typeof value !== 'string' || !value))) fail(`${q.id}: families must be a non-empty-string array when present`);
    if (new Set(q.groups.map(g => g.id)).size !== q.groups.length) fail(`${q.id}: duplicate group ID`);
    for (const group of q.groups) {
      if (typeof group.id !== 'string' || !Array.isArray(group.keys) || !group.keys.length || new Set(group.keys).size !== group.keys.length) fail(`${q.id}: invalid group`);
    }
  }
}

function familyIds(q) {
  if (Array.isArray(q.families)) return [...new Set(q.families)];
  if (typeof q.family === 'string' && q.family) return [...new Set(q.family.split('+').filter(Boolean))];
  return [];
}
function evidenceIds(q) {
  const result = new Set();
  for (const key of q.groups.flatMap(group => group.keys)) {
    result.add(`key:${key}`);
    try {
      const parsed = JSON.parse(key);
      if (Array.isArray(parsed) && parsed.length >= 3) result.add(`reference:${JSON.stringify(parsed.slice(0, 3))}`);
    } catch { /* Non-structured opaque keys still connect by exact equality. */ }
  }
  return [...result];
}
function connectedClusters(cases, clusterBy) {
  const parent = new Map(cases.map(q => [q.id, q.id]));
  const find = id => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(id) !== id) { const next = parent.get(id); parent.set(id, root); id = next; }
    return root;
  };
  const union = (a, b) => { const ar = find(a), br = find(b); if (ar !== br) parent.set(br, ar); };
  const owner = new Map();
  const identifiers = clusterBy === 'evidence' ? evidenceIds : familyIds;
  for (const q of cases) for (const identifier of identifiers(q)) {
    if (owner.has(identifier)) union(q.id, owner.get(identifier));
    else owner.set(identifier, q.id);
  }
  return new Map(cases.map(q => [q.id, identifiers(q).length ? `component:${find(q.id)}` : `id:${q.id}`]));
}

function validateRows(pack, rows) {
  const byId = new Map(pack.cases.map(c => [c.id, c]));
  if (!rows.length) fail('Scores are empty');
  const seen = new Set();
  const rounds = new Set();
  for (const row of rows) {
    if (!byId.has(row.id)) fail(`${row.__source}:${row.__line}: unknown case ${row.id}`);
    if (!Number.isInteger(row.round) || row.round < 1) fail(`${row.id}: invalid round`);
    const identity = `${row.round}\u0000${row.id}`;
    if (seen.has(identity)) fail(`${row.id}: duplicate row for round ${row.round}`);
    seen.add(identity); rounds.add(row.round);
    const q = byId.get(row.id), cKeys = q.C.map(r => r.key);
    for (const method of METHODS) {
      if (!Array.isArray(row[method])) fail(`${row.id} round ${row.round}: missing ${method}`);
      if (!sameMembers(row[method], cKeys)) fail(`${row.id} round ${row.round}: ${method} candidate set differs from C`);
    }
    if (!sameArray(row.B0, cKeys)) fail(`${row.id} round ${row.round}: B0 does not preserve frozen C order`);
    const expectedBC = q.bypassExact ? row.B0 : canonical(q.C);
    if (!sameArray(row.BC, expectedBC)) fail(`${row.id} round ${row.round}: BC violates baseline score/key ordering`);
    if (!Object.hasOwn(row, 'error')) fail(`${row.id} round ${row.round}: missing error field`);
    if (!row.cost || !Number.isInteger(row.cost.pairs) || row.cost.pairs < 0 || (row.cost.scoredPairs != null && (!Number.isInteger(row.cost.scoredPairs) || row.cost.scoredPairs < 0 || row.cost.scoredPairs > row.cost.pairs))) fail(`${row.id} round ${row.round}: invalid cost`);
    if (!finite(row.elapsedMs) || row.elapsedMs < 0) fail(`${row.id} round ${row.round}: invalid elapsedMs`);
    if (row.primaryElapsedMs != null && (!finite(row.primaryElapsedMs) || row.primaryElapsedMs < 0 || row.primaryElapsedMs > row.elapsedMs)) fail(`${row.id} round ${row.round}: invalid primaryElapsedMs`);
    if (q.bypassExact) {
      if (!sameArray(row.B0, row.BC) || !sameArray(row.B0, row.R1) || row.cost.pairs !== 0) fail(`${row.id} round ${row.round}: bypass must replay B0 without inference`);
    } else if (row.error != null) {
      if (typeof row.error !== 'string' || !sameArray(row.R1, row.B0)) fail(`${row.id} round ${row.round}: error must be a recorded B0 fallback`);
    } else {
      if (!row.scores || typeof row.scores !== 'object' || !sameMembers(Object.keys(row.scores), cKeys)) fail(`${row.id} round ${row.round}: scores do not cover C`);
      if (!sameArray(row.R1, canonical(q.C, row.scores))) fail(`${row.id} round ${row.round}: R1 violates score/key ordering`);
      if (row.cost.pairs !== q.C.length) fail(`${row.id} round ${row.round}: cost.pairs must equal inferred C size`);
    }
    const hasU0 = Array.isArray(row.U0), hasU1 = Array.isArray(row.U1);
    if (hasU1 && !hasU0) fail(`${row.id} round ${row.round}: U1 requires U0`);
    if (row.unionError != null && typeof row.unionError !== 'string') fail(`${row.id} round ${row.round}: invalid unionError`);
    if (hasU0 && !hasU1 && row.unionError == null) fail(`${row.id} round ${row.round}: incomplete U diagnostic lacks unionError`);
    if (hasU1 && row.unionError != null) fail(`${row.id} round ${row.round}: successful U diagnostic has unionError`);
    if (hasU0) {
      const uKeys = q.U.map(r => r.key);
      if (!sameArray(row.U0, uKeys) || (hasU1 && !sameMembers(row.U1, uKeys))) fail(`${row.id} round ${row.round}: U diagnostic candidate mismatch`);
      if (hasU1 && (!row.unionScores || !sameMembers(Object.keys(row.unionScores), uKeys) || !sameArray(row.U1, canonical(q.U, row.unionScores)))) fail(`${row.id} round ${row.round}: U1 violates score/key ordering`);
      const expectedExtras = q.U.length - q.C.length;
      if (!row.unionExtraCost || !Number.isInteger(row.unionExtraCost.pairs) || row.unionExtraCost.pairs < 0 || row.unionExtraCost.pairs > expectedExtras || (hasU1 && row.unionExtraCost.pairs !== expectedExtras)) fail(`${row.id} round ${row.round}: invalid unionExtraCost.pairs`);
      if (row.unionExtraCost.scoredPairs != null && (!Number.isInteger(row.unionExtraCost.scoredPairs) || row.unionExtraCost.scoredPairs < 0 || row.unionExtraCost.scoredPairs > row.unionExtraCost.pairs)) fail(`${row.id} round ${row.round}: invalid unionExtraCost.scoredPairs`);
    }
  }
  const orderedRounds = [...rounds].sort((a, b) => a - b);
  if (!sameArray(orderedRounds, Array.from({ length: orderedRounds.at(-1) }, (_, i) => i + 1))) fail('Rounds must be contiguous from 1');
  for (const round of orderedRounds) for (const q of pack.cases) if (!seen.has(`${round}\u0000${q.id}`)) fail(`Missing case ${q.id} in round ${round}`);
  if (rows.length !== pack.cases.length * orderedRounds.length) fail('Score matrix is not exactly cases × rounds');
  return orderedRounds;
}

function observations(q, ranking) {
  const top = ranking.slice(0, TOP_K), topSet = new Set(top);
  const groupRows = q.groups.map(group => ({
    id: group.id,
    inC: group.keys.some(key => q.C.some(row => row.key === key)),
    inU: group.keys.some(key => q.U.some(row => row.key === key)),
    top5: group.keys.some(key => topSet.has(key)),
  }));
  const relevant = new Set(q.groups.flatMap(group => group.keys));
  const first = top.findIndex(key => relevant.has(key));
  return {
    scored: q.groups.length > 0,
    multi: q.groups.length > 1,
    hit: q.groups.length ? Number(first >= 0) : null,
    rr: q.groups.length ? (first >= 0 ? 1 / (first + 1) : 0) : null,
    complete: q.groups.length ? Number(groupRows.every(group => group.top5)) : null,
    rank: q.groups.length && first >= 0 ? first + 1 : 0,
    groupRows,
  };
}
function metricBlock(items) {
  const scored = items.filter(x => x.obs.scored), multi = scored.filter(x => x.obs.multi);
  const groupRows = items.flatMap(x => x.obs.groupRows);
  return {
    totalCases: items.length,
    scoredCases: scored.length,
    unscoredNoGroups: items.length - scored.length,
    hitAt5: roundNumber(mean(scored.map(x => x.obs.hit))),
    mrrAt5: roundNumber(mean(scored.map(x => x.obs.rr))),
    allRequiredGroupsCompleteAt5: roundNumber(mean(scored.map(x => x.obs.complete))),
    multiGroup: { cases: multi.length, completeAt5: roundNumber(mean(multi.map(x => x.obs.complete))) },
    knownGroups: {
      total: groupRows.length,
      representedInU: groupRows.filter(x => x.inU).length,
      representedInC: groupRows.filter(x => x.inC).length,
      representedInTop5: groupRows.filter(x => x.top5).length,
    },
  };
}
function pairedBlock(items, baseline, challenger) {
  const scored = items.filter(x => x[baseline].scored);
  const gains = scored.filter(x => !x[baseline].hit && x[challenger].hit);
  const losses = scored.filter(x => x[baseline].hit && !x[challenger].hit);
  const retained = scored.filter(x => x[baseline].hit && x[challenger].hit);
  return {
    baseline, challenger, scoredCases: scored.length,
    hitAt5: { gains: gains.length, losses: losses.length, net: gains.length - losses.length },
    completeAt5: {
      gains: scored.filter(x => !x[baseline].complete && x[challenger].complete).length,
      losses: scored.filter(x => x[baseline].complete && !x[challenger].complete).length,
    },
    retainedHits: { count: retained.length, rankDrops: retained.filter(x => x[challenger].rank > x[baseline].rank).length },
  };
}
function makeRng(seed = 130914) {
  let state = seed >>> 0;
  return () => { state = (1664525 * state + 1013904223) >>> 0; return state / 0x100000000; };
}
function bootstrap(items, baseline, challenger, field, seed, clusterBy) {
  const eligible = items.filter(x => x[baseline][field] != null && x[challenger][field] != null);
  if (!eligible.length) return { delta: null, ci95: null, clusterUnits: 0, samples: 0 };
  const clusterById = connectedClusters(eligible.map(item => item.case), clusterBy);
  const clusters = new Map();
  for (const item of eligible) {
    const key = clusterById.get(item.case.id);
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(item);
  }
  const units = [...clusters.values()], rng = makeRng(seed), estimates = [];
  for (let iteration = 0; iteration < BOOTSTRAP_SAMPLES; iteration++) {
    const sampled = [];
    for (let i = 0; i < units.length; i++) sampled.push(...units[Math.floor(rng() * units.length)]);
    estimates.push(mean(sampled.map(x => x[challenger][field] - x[baseline][field])));
  }
  estimates.sort((a, b) => a - b);
  return {
    delta: roundNumber(mean(eligible.map(x => x[challenger][field] - x[baseline][field]))),
    ci95: [roundNumber(percentile(estimates, 0.025)), roundNumber(percentile(estimates, 0.975))],
    clusterUnits: units.length, samples: BOOTSTRAP_SAMPLES,
  };
}
function latency(values) {
  return { rows: values.length, totalMs: roundNumber(sum(values)), meanMs: roundNumber(mean(values)), medianMs: roundNumber(percentile([...values].sort((a, b) => a - b), 0.5)) };
}
function safeErrorType(error) { return error == null ? null : (String(error).match(/^[A-Za-z][A-Za-z0-9_.-]*/)?.[0] ?? 'Error'); }

export function analyze(pack, rows, { clusterBy = 'family' } = {}) {
  if (!['family', 'evidence'].includes(clusterBy)) fail('clusterBy must be family or evidence');
  validatePack(pack);
  const rounds = validateRows(pack, rows);
  const byId = new Map(pack.cases.map(c => [c.id, c]));
  const observationsByRound = {};
  const publicCases = [];
  const caseAnon = new Map(pack.cases.map((q, i) => [q.id, `Q${String(i + 1).padStart(3, '0')}`]));
  const categoryValues = [...new Set(pack.cases.map(q => q.category ?? 'uncategorized'))].sort();
  const categoryAnon = new Map(categoryValues.map((value, i) => [value, `category-${String(i + 1).padStart(3, '0')}`]));
  const candidateAnon = new Map(); let candidateIndex = 0;
  for (const q of pack.cases) for (const row of [...q.C, ...q.U]) if (!candidateAnon.has(row.key)) candidateAnon.set(row.key, `K${String(++candidateIndex).padStart(6, '0')}`);

  for (const round of rounds) {
    const roundRows = rows.filter(row => row.round === round);
    const items = roundRows.map(row => {
      const q = byId.get(row.id), item = { case: q, row };
      for (const method of METHODS) item[method] = observations(q, row[method]);
      if (row.U0 && row.U1) for (const method of ['U0', 'U1']) item[method] = observations(q, row[method]);
      else if (q.bypassExact) for (const method of ['U0', 'U1']) item[method] = observations(q, row.B0);
      return item;
    });
    observationsByRound[round] = items;
    for (const item of items) {
      const q = item.case, row = item.row;
      publicCases.push({
        id: caseAnon.get(q.id), round, category: categoryAnon.get(q.category ?? 'uncategorized'),
        bypassExact: Boolean(q.bypassExact), requiredGroups: q.groups.length,
        knownGroups: item.B0.groupRows.map((group, i) => ({ id: `G${String(i + 1).padStart(2, '0')}`, inU: group.inU, inC: group.inC })),
        methods: Object.fromEntries([...METHODS, ...(item.U1 ? ['U0', 'U1'] : [])].map(method => [method, {
          hitAt5: item[method].hit, reciprocalRankAt5: roundNumber(item[method].rr), allRequiredGroupsCompleteAt5: item[method].complete,
        }])),
        execution: { fallback: row.error != null, errorType: safeErrorType(row.error), unionFallback: row.unionError != null, unionErrorType: safeErrorType(row.unionError), unionDiagnosticSource: row.U1 ? 'inference' : q.bypassExact ? 'bypass-replay' : 'unavailable', pairs: row.cost.pairs, scoredPairs: row.cost.scoredPairs ?? row.cost.pairs, unionExtraPairs: row.unionExtraCost?.pairs ?? null, primaryElapsedMs: roundNumber(row.primaryElapsedMs ?? row.elapsedMs), elapsedMs: roundNumber(row.elapsedMs) },
      });
    }
  }

  const roundReports = rounds.map(round => {
    const items = observationsByRound[round];
    const metrics = Object.fromEntries(METHODS.map(method => [method, metricBlock(items.map(item => ({ obs: item[method] })))]));
    const optionalAvailable = items.filter(item => item.U0 && item.U1), optionalFailed = items.filter(item => item.row.unionError != null);
    const optional = optionalAvailable.length === items.length
      ? { status: 'available', U0: metricBlock(items.map(item => ({ obs: item.U0 }))), U1: metricBlock(items.map(item => ({ obs: item.U1 }))) }
      : { status: 'unavailable', availableRows: optionalAvailable.length, failedRows: optionalFailed.length, notAttemptedRows: items.length - optionalAvailable.length - optionalFailed.length };
    const paired = {};
    for (const baseline of ['B0', 'BC']) {
      const key = `R1_vs_${baseline}`;
      paired[key] = pairedBlock(items, baseline, 'R1');
      paired[key].bootstrap = {
        hitAt5: bootstrap(items, baseline, 'R1', 'hit', 130914 + round * 10 + (baseline === 'BC' ? 1 : 0), clusterBy),
        mrrAt5: bootstrap(items, baseline, 'R1', 'rr', 130914 + round * 10 + (baseline === 'BC' ? 2 : 0), clusterBy),
        completeAt5: bootstrap(items, baseline, 'R1', 'complete', 130914 + round * 10 + (baseline === 'BC' ? 3 : 0), clusterBy),
      };
    }
    const categories = {};
    for (const category of categoryValues) {
      const selected = items.filter(item => (item.case.category ?? 'uncategorized') === category);
      categories[categoryAnon.get(category)] = Object.fromEntries(METHODS.map(method => [method, metricBlock(selected.map(item => ({ obs: item[method] })))]));
    }
    return { round, metrics, optionalUnionDiagnostic: optional, paired, categories };
  });

  const inferred = rows.filter(row => row.cost.pairs > 0 && row.error == null), replay = rows.filter(row => row.cost.pairs === 0 && row.error == null), fallbacks = rows.filter(row => row.error != null), unionFallbacks = rows.filter(row => row.unionError != null);
  const costRows = [...rows.map(row => row.cost), ...rows.filter(row => row.unionExtraCost).map(row => row.unionExtraCost)].filter(cost => cost.pairs > 0);
  const inputTokensAvailable = costRows.every(cost => Number.isInteger(cost.inputTokens) && cost.inputTokens >= 0);
  const timingAvailable = costRows.every(cost => finite(cost.inferenceMs) && finite(cost.tokenizeMs));
  const execution = {
    rows: rows.length, inferenceRows: inferred.length, replayOnlyRows: replay.length, fallbackRows: fallbacks.length, unionFallbackRows: unionFallbacks.length,
    errorsByType: Object.fromEntries([...new Set(fallbacks.map(row => safeErrorType(row.error)))].sort().map(type => [type, fallbacks.filter(row => safeErrorType(row.error) === type).length])),
    unionErrorsByType: Object.fromEntries([...new Set(unionFallbacks.map(row => safeErrorType(row.unionError)))].sort().map(type => [type, unionFallbacks.filter(row => safeErrorType(row.unionError) === type).length])),
    actualInference: {
      pairs: sum(costRows.map(cost => cost.pairs)),
      scoredPairs: sum(costRows.map(cost => cost.scoredPairs ?? cost.pairs)),
      inputTokens: inputTokensAvailable ? sum(costRows.map(cost => cost.inputTokens)) : null,
      inputTokensStatus: inputTokensAvailable ? 'available' : 'unavailable',
      truncatedPairs: costRows.every(cost => Number.isInteger(cost.truncatedPairs)) ? sum(costRows.map(cost => cost.truncatedPairs)) : null,
    },
    latency: {
      inferredRows: latency(inferred.map(row => row.primaryElapsedMs ?? row.elapsedMs)), replayOnlyRows: latency(replay.map(row => row.primaryElapsedMs ?? row.elapsedMs)), fallbackRows: latency(fallbacks.map(row => row.primaryElapsedMs ?? row.elapsedMs)),
      optionalUnionRows: latency(rows.filter(row => row.unionExtraCost).map(row => row.elapsedMs - (row.primaryElapsedMs ?? row.elapsedMs))),
      modelInferenceMs: timingAvailable ? roundNumber(sum(costRows.map(cost => cost.inferenceMs))) : null,
      tokenizationMs: timingAvailable ? roundNumber(sum(costRows.map(cost => cost.tokenizeMs))) : null,
      detailedTimingStatus: timingAvailable ? 'available' : 'unavailable',
    },
  };
  const publicSummary = {
    schemaVersion: 1, evaluationLabel: 'existing-qrels provisional',
    clusterDefinition: clusterBy === 'family' ? 'transitive shared component-family identifiers' : 'transitive shared required-reference identities',
    interpretation: 'Only recorded known groups are positive evidence; unrecorded candidates are unknown, not irrelevant. This is not a completed blind judgment.',
    topK: TOP_K, totalCases: pack.cases.length, scoredCases: pack.cases.filter(q => q.groups.length).length,
    unscoredNoGroups: pack.cases.filter(q => !q.groups.length).length, rounds: roundReports, execution, cases: publicCases,
  };
  const privateSummary = {
    schemaVersion: 1, clusterDefinition: publicSummary.clusterDefinition, publicSummary,
    sourceProvenance: pack.provenance ?? null,
    anonymousMap: {
      cases: Object.fromEntries(caseAnon), categories: Object.fromEntries(categoryAnon), candidates: Object.fromEntries(candidateAnon),
      groups: Object.fromEntries(pack.cases.map(q => [q.id, Object.fromEntries(q.groups.map((g, i) => [g.id, `G${String(i + 1).padStart(2, '0')}`]))])),
    },
  };
  return { privateSummary, publicSummary };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!['--pack', '--scores-dir', '--output', '--ids', '--cluster-by'].includes(key) || !argv[i + 1]) fail('Usage: node scripts/analyze-reranker-eval.mjs --pack FILE --scores-dir DIR --output FRESH_DIR [--ids PILOT_IDS.json] [--cluster-by family|evidence]');
    args[key.slice(2)] = argv[i + 1];
  }
  if (!args.pack || !args['scores-dir'] || !args.output) fail('Usage: node scripts/analyze-reranker-eval.mjs --pack FILE --scores-dir DIR --output FRESH_DIR [--ids PILOT_IDS.json] [--cluster-by family|evidence]');
  if (args['cluster-by'] != null && !['family', 'evidence'].includes(args['cluster-by'])) fail('--cluster-by must be family or evidence');
  return args;
}
function selectCases(pack, idsFile) {
  if (!idsFile) return { selectedPack: pack, selectedIds: pack.cases.map(q => q.id), cohort: 'full' };
  const ids = readJson(idsFile), known = new Map(pack.cases.map(q => [q.id, q]));
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !known.has(id))) fail('--ids must contain a non-empty, unique frozen subset of pack case IDs');
  return { selectedPack: { ...pack, cases: ids.map(id => known.get(id)) }, selectedIds: ids, cohort: 'pilot' };
}
function verifyCompletedScores(files, rows, fullPackSha256, selectedIds) {
  if (files.length !== 1) fail('Expected exactly one completed score JSONL under --scores-dir');
  const scoreFile = files[0], dir = path.dirname(scoreFile);
  const environmentFile = path.join(dir, 'environment.local.json'), completeFile = path.join(dir, 'complete.local.json');
  if (!fs.existsSync(environmentFile) || !fs.existsSync(completeFile)) fail('Scores require sibling environment.local.json and complete.local.json manifests');
  const environment = readJson(environmentFile), complete = readJson(completeFile);
  if (environment.schemaVersion !== 1) fail('Unknown scorer environment schema');
  if (environment.packSha256 !== fullPackSha256) fail('Scorer environment packSha256 does not match the full input pack');
  if (!Array.isArray(environment.queryIds) || !sameArray(environment.queryIds, selectedIds)) fail('Scorer environment queryIds do not exactly match the selected full/pilot cohort and order');
  if (!Number.isInteger(environment.rounds) || environment.rounds < 1) fail('Invalid scorer environment rounds');
  if (complete.questions !== selectedIds.length || complete.rounds !== environment.rounds || complete.scoreRows !== selectedIds.length * environment.rounds) fail('Completion manifest does not match the expected cohort × rounds matrix');
  if (rows.length !== complete.scoreRows) fail('Score JSONL row count does not match completion manifest');
  if (complete.scoresSha256 !== sha256File(scoreFile)) fail('Score JSONL sha256 does not match completion manifest; output may be partial or changed');
  return { environment, complete };
}
function assertPublicSafe(publicSummary, pack) {
  const rendered = JSON.stringify(publicSummary);
  const forbiddenFields = ['query', 'path', 'workspace', 'function', 'text', 'file', 'symbol', 'scores', 'visibility', 'family'];
  for (const field of forbiddenFields) if (new RegExp(`"${field}"\\s*:`, 'i').test(rendered)) fail(`Public summary contains forbidden field ${field}`);
  const publicStrings = new Set();
  (function collect(value) {
    if (typeof value === 'string') publicStrings.add(value);
    else if (Array.isArray(value)) for (const item of value) collect(item);
    else if (value && typeof value === 'object') { for (const [key, item] of Object.entries(value)) { publicStrings.add(key); collect(item); } }
  })(publicSummary);
  const secrets = new Set();
  for (const q of pack.cases) {
    secrets.add(q.id); if (q.query) secrets.add(q.query); if (q.family) secrets.add(q.family);
    for (const group of q.groups) { secrets.add(group.id); for (const key of group.keys) secrets.add(key); }
    for (const row of [...q.C, ...q.U]) {
      secrets.add(row.key);
      for (const field of ['file', 'path', 'workspace', 'function', 'symbol', 'text']) if (row[field]) secrets.add(String(row[field]));
    }
  }
  for (const secret of secrets) if (secret && publicStrings.has(String(secret))) fail('Public summary contains a private source value');
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv), output = path.resolve(args.output);
  if (fs.existsSync(output)) fail('Output must be a fresh, non-existent directory');
  const fullPackSha256 = sha256File(args.pack), pack = readJson(args.pack), { selectedPack, selectedIds, cohort } = selectCases(pack, args.ids);
  const { files, rows } = readRows(args['scores-dir']);
  const manifests = verifyCompletedScores(files, rows, fullPackSha256, selectedIds);
  const { privateSummary, publicSummary } = analyze(selectedPack, rows, { clusterBy: args['cluster-by'] ?? 'family' });
  publicSummary.cohort = cohort;
  privateSummary.cohort = cohort;
  privateSummary.scorerEnvironment = manifests.environment;
  privateSummary.completionManifest = manifests.complete;
  assertPublicSafe(publicSummary, selectedPack);
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'summary.local.json'), JSON.stringify({ ...privateSummary, inputs: { pack: path.resolve(args.pack), packSha256: fullPackSha256, ids: args.ids ? path.resolve(args.ids) : null, scoreFiles: files.map(file => path.resolve(file)) } }, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'summary.public.json'), JSON.stringify(publicSummary, null, 2) + '\n');
  console.log(JSON.stringify({ output, cohort, cases: publicSummary.totalCases, rounds: publicSummary.rounds.length, scoredCases: publicSummary.scoredCases, fallbackRows: publicSummary.execution.fallbackRows }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { main(); } catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1; }
}
