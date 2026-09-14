#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { analyze } from './analyze-reranker-eval.mjs';

const candidate = (key, score) => ({ key, score, file: `private/${key}.js`, symbol: `fn_${key}`, text: `secret ${key}` });
const pack = {
  schemaVersion: 1, provenance: { private: true }, cases: [
    { id: 'raw-a', query: 'secret query a', category: 'single', family: 'A+B', bypassExact: false,
      groups: [{ id: 'target-a', keys: ['a'] }], C: [candidate('b', 1), candidate('a', 1), candidate('x', 0)], U: [candidate('b', 1), candidate('a', 1), candidate('x', 0), candidate('z', -1)] },
    { id: 'raw-b', query: 'secret query b', category: 'multi', families: ['B', 'C'], family: 'ignored-joined-label', bypassExact: false,
      groups: [{ id: 'target-b1', keys: ['c'] }, { id: 'target-b2', keys: ['d'] }], C: [candidate('c', 3), candidate('e', 2), candidate('f', 1), candidate('g', 0), candidate('h', -1), candidate('d', -2)], U: [candidate('c', 3), candidate('e', 2), candidate('f', 1), candidate('g', 0), candidate('h', -1), candidate('d', -2)] },
    { id: 'raw-c', query: 'secret query c', category: 'none', bypassExact: true, groups: [], C: [candidate('j', 1)], U: [candidate('j', 1)] },
  ],
};
const baseRows = [
  { id: 'raw-a', round: 1, bypassExact: false, B0: ['b', 'a', 'x'], BC: ['a', 'b', 'x'], R1: ['a', 'x', 'b'], error: null,
    scores: { a: 4, x: 2, b: 1 }, visibility: {}, cost: { pairs: 3, scoredPairs: 3, inputTokens: 30, truncatedPairs: 0, tokenizeMs: 2, inferenceMs: 3 }, primaryElapsedMs: 6, elapsedMs: 6 },
  { id: 'raw-b', round: 1, bypassExact: false, B0: ['c', 'e', 'f', 'g', 'h', 'd'], BC: ['c', 'e', 'f', 'g', 'h', 'd'], R1: ['c', 'd', 'e', 'f', 'g', 'h'], error: null,
    scores: { c: 6, d: 5, e: 4, f: 3, g: 2, h: 1 }, visibility: {}, cost: { pairs: 6, scoredPairs: 6, inputTokens: 60, truncatedPairs: 1, tokenizeMs: 4, inferenceMs: 5 }, primaryElapsedMs: 10, elapsedMs: 10 },
  { id: 'raw-c', round: 1, bypassExact: true, B0: ['j'], BC: ['j'], R1: ['j'], error: null, scores: {}, visibility: {}, cost: { pairs: 0 }, primaryElapsedMs: 1, elapsedMs: 1 },
];

const result = analyze(pack, structuredClone(baseRows));
const report = result.publicSummary.rounds[0];
assert.equal(report.metrics.B0.hitAt5, 1);
assert.equal(report.metrics.B0.allRequiredGroupsCompleteAt5, 0.5);
assert.equal(report.metrics.R1.allRequiredGroupsCompleteAt5, 1);
assert.equal(report.metrics.R1.multiGroup.completeAt5, 1);
assert.deepEqual(report.metrics.R1.knownGroups, { total: 3, representedInU: 3, representedInC: 3, representedInTop5: 3 });
assert.equal(report.paired.R1_vs_B0.completeAt5.gains, 1);
assert.equal(report.paired.R1_vs_B0.bootstrap.hitAt5.clusterUnits, 1);
assert.match(result.publicSummary.clusterDefinition, /component-family/);
assert.equal(result.publicSummary.unscoredNoGroups, 1);
assert.equal(result.publicSummary.execution.actualInference.pairs, 9);
assert.equal(result.publicSummary.execution.actualInference.scoredPairs, 9);
assert.equal(result.publicSummary.execution.actualInference.inputTokens, 90);
assert.equal(result.publicSummary.execution.replayOnlyRows, 1);
assert.equal(report.optionalUnionDiagnostic.status, 'unavailable');

assert.throws(() => analyze(pack, structuredClone(baseRows).map(row => row.id === 'raw-a' ? { ...row, R1: ['a', 'b'] } : row)), /candidate set differs/);
assert.throws(() => analyze(pack, structuredClone(baseRows).map(row => row.id === 'raw-a' ? { ...row, R1: ['b', 'a', 'x'] } : row)), /R1 violates score\/key ordering/);
const tiedR1 = structuredClone(baseRows);
Object.assign(tiedR1[0], { R1: ['a', 'b', 'x'], scores: { a: 4, b: 4, x: 2 } });
assert.doesNotThrow(() => analyze(pack, tiedR1));
assert.throws(() => analyze(pack, tiedR1.map(row => row.id === 'raw-a' ? { ...row, R1: ['b', 'a', 'x'] } : row)), /R1 violates score\/key ordering/);
assert.throws(() => analyze(pack, structuredClone(baseRows).map(row => row.id === 'raw-a' ? { ...row, BC: ['b', 'a', 'x'] } : row)), /BC violates baseline score\/key ordering/);
assert.throws(() => analyze(pack, structuredClone(baseRows).slice(0, 2)), /Missing case raw-c/);
assert.throws(() => analyze(pack, structuredClone(baseRows).map(row => row.id === 'raw-c' ? { ...row, R1: [], cost: { pairs: 1 } } : row)), /candidate set differs|bypass must replay/);
const unionFailure = structuredClone(baseRows);
Object.assign(unionFailure[0], { U0: ['b', 'a', 'x', 'z'], unionError: 'RuntimeError: synthetic', unionExtraCost: { pairs: 1, scoredPairs: 0, inputTokens: 4, truncatedPairs: 0, tokenizeMs: 1, inferenceMs: 1 }, elapsedMs: 8 });
const unionResult = analyze(pack, unionFailure).publicSummary;
assert.equal(unionResult.rounds[0].optionalUnionDiagnostic.failedRows, 1);
assert.equal(unionResult.execution.unionFallbackRows, 1);
assert.equal(unionResult.execution.fallbackRows, 0);
const bypassOutsideU = structuredClone(pack);
bypassOutsideU.cases[2].U = [];
assert.doesNotThrow(() => analyze(bypassOutsideU, structuredClone(baseRows)));
const nonBypassOutsideU = structuredClone(pack);
nonBypassOutsideU.cases[0].U = nonBypassOutsideU.cases[0].U.filter(row => row.key !== 'a');
assert.throws(() => analyze(nonBypassOutsideU, structuredClone(baseRows)), /C must be a subset of U/);
const referenceOverlap = structuredClone(pack);
referenceOverlap.cases[0].family = 'separate-a';
delete referenceOverlap.cases[1].families;
referenceOverlap.cases[1].family = 'separate-b';
referenceOverlap.cases[0].groups = [{ id: 'reference-a', keys: ['["ws","path/file.js","symbol",10,20]'] }];
referenceOverlap.cases[1].groups = [{ id: 'reference-b', keys: ['["ws","path/file.js","symbol",30,40]'] }];
assert.equal(analyze(referenceOverlap, structuredClone(baseRows), { clusterBy: 'family' }).publicSummary.rounds[0].paired.R1_vs_B0.bootstrap.hitAt5.clusterUnits, 2);
const evidenceResult = analyze(referenceOverlap, structuredClone(baseRows), { clusterBy: 'evidence' }).publicSummary;
assert.equal(evidenceResult.rounds[0].paired.R1_vs_B0.bootstrap.hitAt5.clusterUnits, 1);
assert.match(evidenceResult.clusterDefinition, /required-reference/);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'reranker-eval-'));
try {
  const packFile = path.join(temp, 'pack.local.json'), scoresDir = path.join(temp, 'scores'), output = path.join(temp, 'report');
  fs.mkdirSync(scoresDir);
  const packText = JSON.stringify(pack), scoreText = baseRows.map(row => JSON.stringify(row)).join('\n') + '\n';
  fs.writeFileSync(packFile, packText);
  fs.writeFileSync(path.join(scoresDir, 'scores.local.jsonl'), scoreText);
  fs.writeFileSync(path.join(scoresDir, 'environment.local.json'), JSON.stringify({ schemaVersion: 1, packSha256: createHash('sha256').update(packText).digest('hex'), queryIds: pack.cases.map(q => q.id), rounds: 1 }));
  fs.writeFileSync(path.join(scoresDir, 'complete.local.json'), JSON.stringify({ questions: 3, rounds: 1, scoreRows: 3, scoresSha256: createHash('sha256').update(scoreText).digest('hex') }));
  const run = spawnSync(process.execPath, [path.resolve('scripts/analyze-reranker-eval.mjs'), '--pack', packFile, '--scores-dir', scoresDir, '--output', output], { cwd: path.resolve('.'), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const publicText = fs.readFileSync(path.join(output, 'summary.public.json'), 'utf8');
  const local = JSON.parse(fs.readFileSync(path.join(output, 'summary.local.json'), 'utf8'));
  for (const secret of ['raw-a', 'raw-b', 'raw-c', 'secret query', 'private/', 'target-a', 'family-a', 'fn_a', '"a"']) assert(!publicText.includes(secret), `public output leaked ${secret}`);
  assert.equal(local.anonymousMap.cases['raw-a'], 'Q001');
  const rerun = spawnSync(process.execPath, [path.resolve('scripts/analyze-reranker-eval.mjs'), '--pack', packFile, '--scores-dir', scoresDir, '--output', output], { cwd: path.resolve('.'), encoding: 'utf8' });
  assert.notEqual(rerun.status, 0);
  assert.match(rerun.stderr, /fresh/);
  const badOutput = path.join(temp, 'bad-report');
  fs.writeFileSync(path.join(scoresDir, 'complete.local.json'), JSON.stringify({ questions: 3, rounds: 1, scoreRows: 3, scoresSha256: '0'.repeat(64) }));
  const badHash = spawnSync(process.execPath, [path.resolve('scripts/analyze-reranker-eval.mjs'), '--pack', packFile, '--scores-dir', scoresDir, '--output', badOutput], { cwd: path.resolve('.'), encoding: 'utf8' });
  assert.notEqual(badHash.status, 0);
  assert.match(badHash.stderr, /sha256/);
  assert(!fs.existsSync(badOutput));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('reranker evaluation analyzer: all deterministic tests passed');
