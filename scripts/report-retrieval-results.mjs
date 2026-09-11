// Generate the complete case appendix from public, anonymized evidence only.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const base = new URL('../docs/tuning/', import.meta.url);
const inputs = ['2026-09-11-expanded-100.json', '2026-09-11-trajectory-rerun.json'];
const [original, traced] = inputs.map(file => JSON.parse(fs.readFileSync(new URL(`results/${file}`, base), 'utf8')));
assert.equal(original.protocol.querySha256, traced.protocol.querySha256);
assert.equal(original.cases.length, 100);
assert.equal(traced.cases.length, 100);
const originalById = new Map(original.cases.map(c => [c.id, c]));
assert.equal(originalById.size, 100);
assert.equal(new Set(traced.cases.map(c => c.id)).size, 100);
const cases = traced.cases.map(c => {
  const old = originalById.get(c.id);
  assert(old);
  assert.match(c.id, /^E\d{3}$/);
  assert.match(old.workspace, /^W\d+$/);
  assert.match(old.fileGroup, /^G\d{3}$/);
  const equal = c.versions.equal.evidence, weighted = c.versions.weighted.evidence;
  assert.equal(equal.evaluation_top5.targetRank, old.equalRank);
  assert.equal(weighted.evaluation_top5.targetRank, old.weightedRank);
  assert.equal(c.vectorRankAt5, old.vectorRank);
  assert.equal(c.ftsRankAt5, old.ftsRank);
  for (const stage of ['vector_candidates', 'fts_candidates']) assert.deepEqual(equal[stage], weighted[stage]);
  return { id: c.id, workspace: old.workspace, fileGroup: old.fileGroup,
    vectorCandidateRank: weighted.vector_candidates.targetRank,
    ftsCandidateRank: weighted.fts_candidates.targetRank,
    equalFusedRank: equal.fused_union.targetRank,
    weightedFusedRank: weighted.fused_union.targetRank,
    equalRank5: old.equalRank, weightedRank5: old.weightedRank,
    vectorRank5: old.vectorRank, ftsRank5: old.ftsRank,
    beforeStage: c.versions.equal.classification, afterStage: c.versions.weighted.classification };
}).sort((a, b) => a.id.localeCompare(b.id));
const select = predicate => cases.filter(predicate).map(c => c.id);
const groups = {
  gainedHit: select(c => !c.equalRank5 && c.weightedRank5 > 0),
  lostHit: select(c => c.equalRank5 > 0 && !c.weightedRank5),
  retainedHitImprovedRank: select(c => c.equalRank5 > 0 && c.weightedRank5 > 0 && c.weightedRank5 < c.equalRank5),
  retainedHitSameRank: select(c => c.equalRank5 > 0 && c.weightedRank5 === c.equalRank5),
  retainedHitWorseRank: select(c => c.equalRank5 > 0 && c.weightedRank5 > c.equalRank5),
  retainedMiss: select(c => !c.equalRank5 && !c.weightedRank5),
};
const allGrouped = Object.values(groups).flat();
assert.equal(allGrouped.length, 100);
assert.equal(new Set(allGrouped).size, 100);
assert.equal(groups.gainedHit.length, original.paired.gains);
assert.equal(groups.lostHit.length, original.paired.losses);
assert.equal(groups.retainedHitWorseRank.length, original.paired.rankWorsenedWithinTop5);
const stages = ['target_hit', 'final_top5_cutoff', 'fused_pool_cutoff', 'candidate_pool_miss'];
const stageLabels = ['적중@5', '최종 5개 밖', '반환 50개 밖', '후보 미포착'];
const transitions = Object.fromEntries(stages.map(from => [from, Object.fromEntries(stages.map(to => [to, cases.filter(c => c.beforeStage === from && c.afterStage === to).length]))]));
for (const stage of stages) {
  assert.equal(Object.values(transitions[stage]).reduce((a, b) => a + b, 0), traced.counts.equal[stage] ?? 0);
  assert.equal(stages.reduce((sum, from) => sum + transitions[from][stage], 0), traced.counts.weighted[stage] ?? 0);
}
const workspaceBreakdown = Object.keys(original.byWorkspace).map(workspace => {
  const selected = cases.filter(c => c.workspace === workspace);
  assert.equal(selected.length, original.byWorkspace[workspace].n);
  const row = { workspace, questions: selected.length,
    equalHits: selected.filter(c => c.equalRank5 > 0).length,
    weightedHits: selected.filter(c => c.weightedRank5 > 0).length,
    gains: selected.filter(c => !c.equalRank5 && c.weightedRank5 > 0).length,
    losses: selected.filter(c => c.equalRank5 > 0 && !c.weightedRank5).length,
    weightedFinalCutoff: selected.filter(c => c.afterStage === 'final_top5_cutoff').length,
    weightedCandidateMiss: selected.filter(c => c.afterStage === 'candidate_pool_miss').length };
  assert.equal(row.equalHits, original.byWorkspace[workspace].beforeHit5);
  assert.equal(row.weightedHits, original.byWorkspace[workspace].afterHit5);
  return row;
});
const comparison = {
  bothHit: select(c => c.vectorRank5 > 0 && c.weightedRank5 > 0),
  vectorOnly: select(c => c.vectorRank5 > 0 && !c.weightedRank5),
  hybridOnly: select(c => !c.vectorRank5 && c.weightedRank5 > 0),
  bothMissWithCandidate: select(c => !c.vectorRank5 && !c.weightedRank5 && c.afterStage !== 'candidate_pool_miss'),
  bothMissWithoutCandidate: select(c => !c.vectorRank5 && !c.weightedRank5 && c.afterStage === 'candidate_pool_miss'),
};
assert.equal(comparison.bothHit.length, original.vectorComparison.bothHit);
assert.equal(comparison.vectorOnly.length, original.vectorComparison.vectorOnly);
assert.equal(comparison.hybridOnly.length, original.vectorComparison.weightedOnly);
assert.equal(comparison.bothMissWithCandidate.length + comparison.bothMissWithoutCandidate.length, original.vectorComparison.bothMiss);
const rankBands = Object.fromEntries(['equal', 'weighted'].map(version => {
  const ranks = cases.map(c => c[`${version}FusedRank`]);
  return [version, { top5: ranks.filter(r => r > 0 && r <= 5).length,
    rank6to10: ranks.filter(r => r >= 6 && r <= 10).length,
    rank11to20: ranks.filter(r => r >= 11 && r <= 20).length,
    rank21to50: ranks.filter(r => r >= 21 && r <= 50).length,
    rankAbove50: ranks.filter(r => r > 50).length, absent: ranks.filter(r => r === 0).length }];
}));
const retainedMissRanks = {
  improved: select(c => groups.retainedMiss.includes(c.id) && c.equalFusedRank > 0 && c.weightedFusedRank > 0 && c.weightedFusedRank < c.equalFusedRank),
  same: select(c => groups.retainedMiss.includes(c.id) && c.equalFusedRank > 0 && c.equalFusedRank === c.weightedFusedRank),
  worse: select(c => groups.retainedMiss.includes(c.id) && c.equalFusedRank > 0 && c.weightedFusedRank > c.equalFusedRank),
  absent: select(c => groups.retainedMiss.includes(c.id) && !c.equalFusedRank && !c.weightedFusedRank),
};
assert.equal(Object.values(retainedMissRanks).flat().length, groups.retainedMiss.length);
const strictHybridOnly = select(c => c.weightedRank5 > 0 && !c.vectorRank5 && !c.ftsRank5);
const result = { schemaVersion: 1, date: '2026-09-11', newSearches: 0, uniqueQuestions: 100,
  querySha256: original.protocol.querySha256,
  inputs: inputs.map((file, i) => ({ file, canonicalJsonSha256: createHash('sha256').update(JSON.stringify([original, traced][i])).digest('hex') })),
  groups, transitions, workspaceBreakdown, comparison, strictHybridOnly, rankBands, retainedMissRanks };
fs.writeFileSync(new URL('results/2026-09-11-trajectory-details.json', base), JSON.stringify(result, null, 2) + '\n');

const rankText = n => n === 0 ? '—' : String(n);
const retained = groups.retainedHitImprovedRank.length + groups.retainedHitSameRank.length + groups.retainedHitWorseRank.length;
const groupLabels = { gainedHit: '신규 적중', lostHit: '적중 손실', retainedHitImprovedRank: '적중 유지 · 순위 개선',
  retainedHitSameRank: '적중 유지 · 순위 동일', retainedHitWorseRank: '적중 유지 · 순위 하락', retainedMiss: '미적중 유지' };
const caseRow = c => `| ${c.id} | ${c.workspace} / ${c.fileGroup} | ${rankText(c.vectorCandidateRank)} | ${rankText(c.ftsCandidateRank)} | ${rankText(c.equalFusedRank)} → ${rankText(c.weightedFusedRank)} |`;
const table = rows => ['| 문항 | 워크스페이스 / 파일군 | vector 후보 순위 | FTS 후보 순위 | 융합 순위 1:1 → 4:1 |',
  '|---|---|---:|---:|---:|', ...rows.map(caseRow)].join('\n');
const lines = [
  '# T09 부록 — 100문항 전체 결과', '',
  '**범위:** 이미 완료한 T07·T09 결과를 재집계했다. 추가 검색 0회, 튜닝 변경 없음, 독립 문항 수는 100이다. 원시 문항·함수·경로 대신 기존 익명 ID를 사용한다.', '',
  `**전체 변화:** 신규 적중 **${groups.gainedHit.length}개**, 적중 손실 **${groups.lostHit.length}개**, 적중 유지 **${retained}개**, 미적중 유지 **${groups.retainedMiss.length}개**. 적중 유지 사례는 순위 개선 ${groups.retainedHitImprovedRank.length}개·동일 ${groups.retainedHitSameRank.length}개·하락 ${groups.retainedHitWorseRank.length}개다.`, '',
  '## 전후 결과 전체 집계', '',
  '| 1:1 → 4:1 변화 | 문항 수 |', '|---|---:|',
  ...Object.keys(groups).map(k => `| ${groupLabels[k]} | ${groups[k].length} |`), '| **합계** | **100** |', '',
  '아래 그룹은 서로 겹치지 않는다. 하위 단계의 원인 분류와 비교할 때는 같은 문항이 다른 표에도 등장하므로 표 사이의 숫자를 합산하지 않는다.', '',
  `**계속 미적중한 ${groups.retainedMiss.length}개:** 후보 안의 ${retainedMissRanks.improved.length}개는 모두 융합 순위가 개선됐지만 5위 안에 들지 못했다. 나머지 ${retainedMissRanks.absent.length}개는 두 설정 모두 후보에 없었다. 적중@5가 그대로여도 순위 변화는 별도로 기록한다.`, '',
  '## 실패 위치의 이동', '',
  '| 1:1 위치 ↓ / 4:1 위치 → | 적중@5 | 최종 5개 밖 | 반환 50개 밖 | 후보 미포착 |',
  '|---|---:|---:|---:|---:|',
  ...stages.map((s, i) => `| ${stageLabels[i]} | ${stages.map(to => transitions[s][to]).join(' | ')} |`), '',
  '최종 5개는 벤치의 평가 경계다. 반환 50개는 같은 hybrid 실행의 DB/검색 함수 반환 경계이며, 둘을 실행 오류로 해석하지 않는다.', '',
  '## 워크스페이스별 미적중 분포', '',
  '| 워크스페이스 | N | 적중 1:1 → 4:1 | 신규 / 손실 | 4:1 최종 5개 밖 | 4:1 후보 미포착 |',
  '|---|---:|---:|---:|---:|---:|',
  ...workspaceBreakdown.map(w => `| ${w.workspace} | ${w.questions} | ${w.equalHits} → ${w.weightedHits} | ${w.gains} / ${w.losses} | ${w.weightedFinalCutoff} | ${w.weightedCandidateMiss} |`), '',
  '워크스페이스별 문항 수와 분포가 다르므로 서비스 전체 성능 순위로 일반화하지 않는다.', '',
  '## 벡터 대비 hybrid만 적중한 두 사례', '',
  table(cases.filter(c => comparison.hybridOnly.includes(c.id))), '',
  '이 사례는 벡터 단독의 상위 5개에서는 미적중이었다. E027은 FTS 단독도 적중했고, 벡터·FTS 단독이 모두 놓쳤지만 hybrid가 적중한 사례는 E041 한 개다. 두 사례 모두 적중은 유지했으나 가중치 변경 후 순위가 하락했다. 벡터 우선 정책의 후속 실험에서도 보존 여부를 확인한다.', '',
  '## 융합 후 정답 순위 분포', '',
  '| 순위 구간 | 1:1 | 4:1 |', '|---|---:|---:|',
  ...[['top5', '1~5'], ['rank6to10', '6~10'], ['rank11to20', '11~20'], ['rank21to50', '21~50'], ['rankAbove50', '51 이상'], ['absent', '전체 후보에 없음']].map(([key, label]) => `| ${label} | ${rankBands.equal[key]} | ${rankBands.weighted[key]} |`), '',
  '기존 pool=50 trace의 전체 융합 순위를 집계했다. topN·pool을 바꿔 실행한 결과가 아니며, 순위 구간만 보고 반환 수 확대를 채택하지 않는다.', '',
  '## 전체 100문항', '',
  '`—`는 해당 후보 목록에 목표가 없다는 뜻이다. 융합 순위가 6 이상이면 적중@5에서는 실패다. vector·FTS 순위는 별도 단독 검색의 상위 5개가 아니라 **동일 hybrid 호출에 들어간 각 후보 50개 내 순위**다. 두 설정에서 후보 순위가 같으므로 한 번만 표기했다.', '',
];
for (const [key, ids] of Object.entries(groups)) {
  lines.push('<details>', `<summary>${groupLabels[key]} — ${ids.length}문항</summary>`, '',
    table(cases.filter(c => ids.includes(c.id))), '', '</details>', '');
}
lines.push('## 근거와 재생성', '',
  '- [주 보고서: 단계별 실패 진단](2026-09-11-trajectory-rerun.md)',
  '- [추가 집계 JSON](results/2026-09-11-trajectory-details.json)',
  '- [T07 원래 적중 결과](results/2026-09-11-expanded-100.json) · [T09 단계별 순위](results/2026-09-11-trajectory-rerun.json)', '',
  '저장소 루트에서 `node scripts/report-retrieval-results.mjs`로 재생성한다. 공개된 두 JSON만 사용하며 문항 해시·100개 ID·전후 순위·회귀 수·워크스페이스 합계·전이표 합계를 대조한다. 비공개 원시 자료나 검색 서비스 접속이 필요하지 않다.', '',
  'T07~T09 평가와 실행 도구는 `6aa26ed`에 기록돼 있다. 이 부록은 동일 실험의 결과 보완이며 새 튜닝 단계가 아니다.', '');
fs.writeFileSync(new URL('2026-09-11-trajectory-details.md', base), lines.join('\n'));
console.log(JSON.stringify({ groups: Object.fromEntries(Object.entries(groups).map(([k, ids]) => [k, ids.length])),
  rankBands, workspaceBreakdown, hybridOnly: comparison.hybridOnly, checks: '100 cases reconciled; no searches' }, null, 2));
