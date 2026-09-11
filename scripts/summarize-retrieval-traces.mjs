// Usage: node scripts/summarize-retrieval-traces.mjs <private-trace-dir> <private-id-map> <public-output.json>
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { classifyRetrievalTrace } from './classify-retrieval-trace.mjs';

const [directory, mappingFile, output] = process.argv.slice(2);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const verification = read(path.join(directory, 'verification.local.json'));
// Older raw verification used a shorter field name for the same during-run check.
if ('sourceAndManifestsUnchanged' in verification) {
  verification.sourceAndManifestsUnchangedDuringTraceRun = verification.sourceAndManifestsUnchanged;
  delete verification.sourceAndManifestsUnchanged;
}
const provenance = read(path.join(directory, 'provenance.local.json'));
const equivalence = read(path.join(directory, 'equivalence.local.json'));
assert.equal(equivalence.fullReturnOrderScoresAndIdentityMatch, 200);
assert.equal(verification.searches, 3000);
const mapping = new Map(read(mappingFile).map(m => [m.privateId, m.publicId]));
const raw = fs.readFileSync(path.join(directory, 'traces.local.jsonl'), 'utf8');
const traces = raw.trim().split('\n').map(JSON.parse);
assert.equal(traces.length, 3000);
const key = t => `${t.id}|${t.version}|${t.mode}|${t.round}`;
const index = new Map(traces.map(t => [key(t), t]));
assert.equal(index.size, 3000);
const questions = [...new Set(traces.map(t => t.id))];
assert.equal(questions.length, 100);
const stages = ['vector_candidates', 'fts_candidates', 'fused_union', 'query_return', 'search_return', 'evaluation_top5'];
const snapshot = (t, stage) => t.snapshots.find(s => s.stage === stage);
const fingerprint = rows => JSON.stringify(rows.map(r => [r.id, r.rowid, r.score]));
const counts = {};
let identicalCandidatePairs = 0, stableHybridQuestions = 0;
const cases = [];
for (const id of questions) {
  const publicId = mapping.get(id);
  assert.match(publicId, /^E\d{3}$/);
  const row = { id: publicId, versions: {} };
  for (const version of ['equal', 'weighted']) {
    counts[version] ??= {};
    const first = index.get(`${id}|${version}|hybrid|1`);
    const classification = classifyRetrievalTrace(first);
    counts[version][classification] = (counts[version][classification] ?? 0) + 1;
    const sourceIds = new Set([...snapshot(first, 'vector_candidates').rows, ...snapshot(first, 'fts_candidates').rows].map(r => r.rowid));
    const fusedIds = new Set(snapshot(first, 'fused_union').rows.map(r => r.rowid));
    assert.deepEqual(fusedIds, sourceIds);
    assert.equal(snapshot(first, 'fused_union').rows.length, sourceIds.size);
    const evidence = Object.fromEntries(stages.map(stage => {
      const s = snapshot(first, stage);
      return [stage, { count: s.rows.length, targetRank: s.targetRank }];
    }));
    for (let round = 1; round <= 5; round++) {
      const current = index.get(`${id}|${version}|hybrid|${round}`);
      assert.equal(classifyRetrievalTrace(current), classification);
      for (const stage of stages) assert.equal(fingerprint(snapshot(current, stage).rows), fingerprint(snapshot(first, stage).rows));
      assert.equal(current.embeddings[0].hash, first.embeddings[0].hash);
      if (version === 'weighted') {
        const equal = index.get(`${id}|equal|hybrid|${round}`);
        for (const stage of ['vector_candidates', 'fts_candidates']) {
          assert.equal(fingerprint(snapshot(current, stage).rows), fingerprint(snapshot(equal, stage).rows));
        }
        assert.equal(current.embeddings[0].hash, equal.embeddings[0].hash);
        identicalCandidatePairs++;
      }
    }
    stableHybridQuestions++;
    row.versions[version] = { classification, evidence };
  }
  row.vectorRankAt5 = index.get(`${id}|weighted|vector|1`).targetRank;
  row.ftsRankAt5 = index.get(`${id}|weighted|fts|1`).targetRank;
  row.weightingRegression = row.versions.equal.evidence.evaluation_top5.targetRank > 0 && row.versions.weighted.evidence.evaluation_top5.targetRank === 0;
  cases.push(row);
}
const anomalies = traces.filter(t => ['inconsistent_trace', 'not_observed', 'execution_error', 'fallback'].includes(classifyRetrievalTrace(t)));
assert.equal(anomalies.length, 0);
const summary = {
  date: provenance.at.slice(0, 10), schemaVersion: 1,
  scope: 'Observed retrieval trajectories; no agent planning, answer, or safety evaluation',
  protocol: { ...provenance.protocol, searches: traces.length, hybridTraces: 1000, reservedUnsearched: 15,
    querySha256: provenance.goldSha256, tracedLatencyComparableToOriginal: false },
  verification: { ...verification, identicalCandidatePairs, stableHybridQuestionVersions: stableHybridQuestions,
    ...equivalence,
    manifestDriftSinceOriginalCount: provenance.manifestDriftSinceOriginal.length, anomalies: anomalies.length,
    rawTraceSha256: createHash('sha256').update(raw).digest('hex') },
  counts, cases,
  instrumentation: { hookSha256: provenance.hookSha256, runnerSha256AtExecution: provenance.runnerSha256,
    searchRuntimeHashes: provenance.provenance.map(p => ({ version: p.name, original: p.moduleHashes['search.js'], instrumented: p.instrumentedSearchSha256 })) },
};
fs.writeFileSync(output, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ counts, verification: summary.verification,
  regressions: cases.filter(c => c.weightingRegression).map(c => c.id),
  vectorOnly: cases.filter(c => c.vectorRankAt5 > 0 && !c.versions.weighted.evidence.evaluation_top5.targetRank).map(c => c.id),
}, null, 2));
