// Reclassify anonymized observations; this does not infer unrecorded trajectory stages.
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const source = new URL('../docs/tuning/results/2026-09-11-expanded-100.json', import.meta.url);
const data = JSON.parse(readFileSync(source, 'utf8'));
assert.equal(data.cases.length, data.protocol.actuallyEvaluated);
assert.equal(new Set(data.cases.map(c => c.id)).size, data.cases.length);
const cases = data.cases.map(c => {
  for (const key of ['ftsRank', 'vectorRank', 'equalRank', 'weightedRank']) {
    assert(Number.isInteger(c[key]) && c[key] >= 0 && c[key] <= 5);
  }
  assert.match(c.id, /^E\d{3}$/);
  return {
    id: c.id,
    outcome: c.weightedRank > 0 ? 'target_hit_at_5' : 'target_miss_at_5',
    comparison: c.vectorRank > 0
      ? (c.weightedRank > 0 ? 'both_hit' : 'vector_only_hit')
      : (c.weightedRank > 0 ? 'hybrid_only_hit' : 'both_miss'),
    regression: c.equalRank > 0 && c.weightedRank === 0,
    attribution: c.weightedRank > 0 ? 'no_target_miss' : 'unresolved_candidate_or_ranking_stage',
    evidence: { vectorRankAt5: c.vectorRank, equalRankAt5: c.equalRank, weightedRankAt5: c.weightedRank },
    candidatePoolTrace: 'not_observed',
    agentSafety: 'not_observed',
  };
});
const count = label => cases.filter(c => c.comparison === label).length;
const summary = Object.fromEntries(['both_hit', 'vector_only_hit', 'hybrid_only_hit', 'both_miss'].map(k => [k, count(k)]));
assert.equal(summary.both_hit + summary.hybrid_only_hit, data.paired.afterHit5);
assert.equal(cases.filter(c => c.regression).length, data.paired.losses);
const report = {
  schemaVersion: 1,
  scope: 'retrospective top-5 observations, not a full AgentAudit evaluation',
  source: '2026-09-11-expanded-100.json',
  querySha256: data.protocol.querySha256,
  newSearches: 0,
  uniqueQuestions: cases.length,
  summary,
  cases,
};
writeFileSync(new URL('../docs/tuning/results/2026-09-11-trajectory-audit.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ uniqueQuestions: cases.length, summary, regressions: cases.filter(c => c.regression).map(c => c.id) }));
