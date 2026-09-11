// Render the anonymous T12 report from published aggregate data. No private corpus is needed.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const dataUrl=new URL('../docs/tuning/results/2026-09-11-workspace-routing.json',import.meta.url);
const reportUrl=new URL('../docs/tuning/2026-09-11-workspace-routing.md',import.meta.url);
const d=JSON.parse(fs.readFileSync(dataUrl,'utf8'));
assert.equal(d.cases.length,100);assert.equal(new Set(d.cases.map(q=>q.id)).size,100);
assert.deepEqual(['single','multi','ambiguous','out_of_scope'].map(s=>d.cases.filter(q=>q.stratum===s).length),[60,20,10,10]);
const f=(n,digits=1)=>{assert(typeof n==='number'&&Number.isFinite(n),'Missing numeric metric');return n.toFixed(digits);};
const m=d.methods.policies.production_scoped_prefix3;
const fixed=d.methods.policies.weighted4_all_scopes;
for(const [policy,methods]of Object.entries(d.methods.policies))for(const [method,s]of Object.entries(methods)){
 const rows=d.cases.map(q=>q.results[policy][method]);
 const scored=rows.filter(r=>r.rank!==null);
 assert.equal(scored.length,s.scorable);assert.equal(scored.filter(r=>r.rank>0).length,s.hits);
 assert.equal(scored.filter(r=>r.completeAt5).length,s.completeAt5);
 assert.ok(Math.abs(scored.reduce((n,r)=>n+(r.rank>0?1/r.rank:0),0)/scored.length-s.mrr)<1e-12);
 assert.equal(scored.filter(r=>r.requiredScopeCovered).length,s.scopeCovered);
}
assert.equal(d.executed.main,100*4*2*3);
assert.equal(d.executed.testTotal,d.executed.main+d.executed.canonicalAll+d.executed.vector+d.executed.order+d.executed.concurrency);
const clusterCounts=Object.values(d.cases.filter(q=>q.resamplingCluster).reduce((n,q)=>{n[q.resamplingCluster]=(n[q.resamplingCluster]??0)+1;return n;},{})).sort((a,b)=>b-a);
assert.deepEqual(clusterCounts,d.testSampling.clusterSizes);assert.equal(clusterCounts.reduce((a,b)=>a+b,0),80);
for(const method of ['A1','A2','AO']){
 const pairs=d.cases.filter(q=>q.results.production_scoped_prefix3.A0.rank!==null).map(q=>({id:q.id,b:q.results.production_scoped_prefix3.A0,a:q.results.production_scoped_prefix3[method]}));
 assert.deepEqual(pairs.filter(p=>p.b.rank===0&&p.a.rank>0).map(p=>p.id),d.comparisons[method].vsOriginal.gains);
 assert.deepEqual(pairs.filter(p=>p.b.rank>0&&p.a.rank===0).map(p=>p.id),d.comparisons[method].vsOriginal.losses);
 const canonicalPairs=d.cases.filter(q=>q.canonicalAllRank!==null).map(q=>({id:q.id,b:q.canonicalAllRank,a:q.results.production_scoped_prefix3[method].rank}));
 assert.deepEqual(canonicalPairs.filter(p=>p.b===0&&p.a>0).map(p=>p.id),d.comparisons[method].vsCanonical.gains);
 assert.deepEqual(canonicalPairs.filter(p=>p.b>0&&p.a===0).map(p=>p.id),d.comparisons[method].vsCanonical.losses);
}
for(const method of ['A0','A1','A2','AO']){
 const failures=d.cases.reduce((n,q)=>{for(const [stage,count]of Object.entries(q.results.production_scoped_prefix3[method].groupFailures))n[stage]=(n[stage]??0)+count;return n;},{});
 assert.deepEqual(failures,d.groupFailures[method]);
}
const checkDiagnostic=(summary,rank,groupRanks)=>{
 const rows=d.cases.map(q=>({rank:rank(q),groups:groupRanks(q)}));
 assert(rows.every(r=>r.rank===null||Number.isInteger(r.rank)&&r.rank>=0&&r.rank<=5));
 const scored=rows.filter(r=>r.rank!==null);assert.equal(scored.length,80);assert.equal(summary.scorable,80);
 assert.equal(scored.filter(r=>r.rank>0).length,summary.hits);
 assert.ok(Number.isFinite(summary.mrr)&&Math.abs(scored.reduce((n,r)=>n+(r.rank>0?1/r.rank:0),0)/80-summary.mrr)<1e-12);
 assert.equal(scored.filter(r=>r.groups.length&&r.groups.every(x=>x>0)).length,summary.completeAt5);
};
checkDiagnostic(d.canonicalAll,q=>q.canonicalAllRank,q=>q.canonicalAllGroupRanks);
for(const method of ['A0','AO'])checkDiagnostic(d.vector[method],q=>q.vectorRanks[method],q=>q.vectorGroupRanks[method]);
const names={A0:'전체 검색',A1:'카드 임베딩 유사도',A2:'작은 ML 분류기',AO:'정답 범위 제공(진단)'};
const rows=['A0','A1','A2','AO'].map(k=>`| ${k} ${names[k]} | ${m[k].hits}/80 | ${f(m[k].mrr,4)} | ${m[k].byStratum.multi.completeAt5}/20 | ${m[k].narrowed}/80 | ${m[k].abstained}/100 |`).join('\n');
const gateNames={explicitCompatibility:'운영 연결 후 명시 범위·전체 요청 호환성',requiredGroupCoverage:'필수 범위 보존 ≥95%',multiScopeExclusion:'복수 질문의 필수 범위 누락 0',harmfulSingleton:'모호·범위 밖 질문의 단일 범위 강제 0',
 narrowing:'답이 있는 문항의 ≥50%에서 ≤3범위로 축소',newHit:'신규 적중 ≥1',hitLoss:'기존 적중 손실 0',mrr:'MRR 하락 없음',stratumQuality:'구간별 적중·복수 근거 완성 회귀 없음',
 order:'입력 순서와 결과 무관',errors:'비교군·진단을 포함한 검색 오류 0',fallbackWarnings:'다른 검색 모드로 폴백한 경고 0',responseStability:'반복·동시 요청의 결과 동일',latency:'동시성별 p95 허용선 이내',selectorCompute:'선택 계산 p95 ≤10ms'};
const gateRows=Object.entries(d.gates).map(([k,v])=>`| ${gateNames[k]} | ${v===null?'미실행(P4)':v?'통과':'실패'} |`).join('\n');
const latencyRows=Object.entries(d.methods.concurrency.levels).map(([level,v])=>`| ${level} | ${f(v.A0.p95)}ms | ${f(v[d.candidate].p95)}ms | ${f(v.A0.p95*1.10+25)}ms |`).join('\n');
const stages=['required_scope_excluded','candidate_not_observed','fusion_or_query_limit_drop','returned_pool_filter_drop','final_top5_cutoff'];
const stageLabels=['필수 범위 배제','후보에서 미관측','융합·검색 풀 제한에서 탈락','반환 풀 후처리에서 탈락','반환 후보의 최종 top5 밖'];
const stageRows=stages.map((s,i)=>`| ${stageLabels[i]} | ${d.groupFailures.A0[s]??0} | ${d.groupFailures.A1[s]??0} | ${d.groupFailures.A2[s]??0} | ${d.groupFailures.AO[s]??0} |`).join('\n');
const c=d.comparisons[d.candidate].vsOriginal;
const text=`# T12 — 워크스페이스 선택기 전후 비교

**결정: ${d.outcome==='not_adopted'?'자동 선택기 운영 채택 보류':'오프라인 통과; 운영 통합 검증 필요'}.** 검증군에서 A1을 후보로 고정한 뒤 신규 **100문항 전부**, 2개 융합 정책·4개 방법·3회 반복을 실행했다. 기존 v0.11.2의 명시 범위·전체 검색 동작과 버전은 유지한다.

## 무엇을 튜닝했나

| 방법 | 바꾼 부분 | 동결한 설정 |
|---|---|---|
| A1 | 질문과 범위 설명·대표 주제의 코사인 유사도로 범위 선택 | 설명 10개·주제 52개, 최소 점수 0.35, 최고점과 차이 ≤0.20, 후보 1~3개; 불확실하면 전체 |
| A2 | 같은 고정 임베딩 위에 다중 라벨 로지스틱 회귀 학습 | 학습 150개, L2=0.001, 600회 갱신, 최소 점수 0.5, 점수 차이 ≤0.05 우선. 2개 미만이면 점수 0.5 이상 후보로 채움; 최대 3개 |

임베더·BM25·청크·검색 후보 풀은 바꾸지 않았다. A1·A2 모두 질문 임베딩을 검색과 공유한다. 임계값·정규화는 검증 50개로 결정했으며 시험 결과로 후보를 바꾸지 않았다. LLM 선택기는 미실행이다.

개발 검증의 채점 가능 ${d.validationDecision.A1.scorable}개에서 A0/A1/A2 적중은 **${d.validationDecision.A0.hits}/${d.validationDecision.A1.hits}/${d.validationDecision.A2.hits}개**, A1/A2의 실제 축소는 **${d.validationDecision.A1.narrowed}/${d.validationDecision.A2.narrowed}개**였다. A1을 진단 후보로 선택했지만 두 방식 모두 축소 목표에는 미달했다. 이후에도 계획한 신규 100개를 전부 실행했다.

## 같은 질문의 전후 결과

아래는 실제 운영 융합 정책(단일 범위 prefix3, 복수 범위 4:1 RRF)을 사용한 결과다. 적중@5는 필수 근거 중 **하나 이상**, 복수 근거 완성은 **모든 필수 근거**가 상위 5개에 있는 경우다.

| 방법 | 적중@5 | MRR@5 | 복수 근거 완성 | 보류·확대 없이 ≤3범위 검색 | 전체 보류 |
|---|---:|---:|---:|---:|---:|
${rows}

A1은 A0 대비 신규 적중 ${c.gains.length}개·기존 적중 손실 ${c.losses.length}개다. 적중 차이 ${f(c.hitDifferencePp)}%p의 95% 재표집 구간은 질문 단위 **[${c.questionBootstrap95Pp.map(x=>f(x)).join(', ')}]%p**, 근거 묶음 단위 **[${c.familyBlockBootstrap95Pp.map(x=>f(x)).join(', ')}]%p**다. 모든 관측 쌍의 적중 여부가 같아 생긴 구간이며, 새 질문에서도 동등하다는 증명은 아니다. 반복 3회를 독립 표본으로 세지 않았다.

**선택 효과 분리:** 단일 범위에도 4:1 RRF를 고정하면 A0/A1/A2/AO 적중은 **${['A0','A1','A2','AO'].map(k=>fixed[k].hits).join(' / ')}개**다. 전체 범위의 입력 순서만 정렬한 AC는 **${d.canonicalAll.hits}/80**이다. A1의 AC 대비 신규 적중은 ${d.comparisons.A1.vsCanonical.gains.length}개, 손실은 ${d.comparisons.A1.vsCanonical.losses.length}개다. 선택기가 목록을 정렬한 효과를 범위 축소 효과와 혼동하지 않는다.

A1의 MRR 하락은 R070의 **1위→4위**에서 발생했다. 이 요청은 전체 검색으로 보류했고, 동점 후보 4개의 순서가 바뀌었다. AC에서도 4위가 재현돼 이번 하락은 목록 정렬 효과로 확인했다.

**범위를 정답으로 지정한 진단:** AO 적중은 hybrid ${m.AO.hits}/80, vector ${d.vector.AO.hits}/80이다. 전체 vector는 ${d.vector.A0.hits}/80이다. AO는 정답을 사용하므로 배포할 선택기나 보장된 성능 상한이 아니다.

## 어디서 실패했나

누락된 **필수 근거 묶음 수**를 관측되는 탈락 단계로 분류했다. 한 복수 질문에서 2개 근거가 빠지면 2건이므로 질문 실패 수와 다르다. 범위별 반환 풀과 최종 top5를 따로 관측했다. hybrid는 범위별로 보통 50개를 반환하므로 최종 top5 탈락에는 **단일 범위 안에서 6위 이하인 경우도 포함**된다. 이 수를 전부 범위 간 경쟁 탓으로 돌릴 수 없다.

| 탈락 단계 | A0 | A1 | A2 | AO |
|---|---:|---:|---:|---:|
${stageRows}

범위가 맞아도 남는 후보·융합·전역 병합 문제를 별도 과제로 남긴다. 이는 검색 단계의 진단이며 최종 답변 사실성이나 에이전트 전체 안전성 평가는 아니다.

## 안정성·지연·채택 기준

A0 입력 순서 검사 불일치 **${d.methods.order.methods.A0.mismatches}/200**, A1 **${d.methods.order.methods.A1.mismatches}/200**. 주 시험 A1 ${m.A1.stable}/100문항이 3회 같은 결과를 반환했다. 주 시험 A1 오류 ${m.A1.errors}회, 재확대 ${m.A1.expanded}회, 선택 계산 p95 ${f(m.A1.latency.selectorComputeP95,2)}ms다.

| 동시 요청 | A0 전체 p95 | A1 전체 p95 | 사전 허용선 |
|---|---:|---:|---:|
${latencyRows}

로컬 고정 엔진 내부 측정이다. 운영 HTTP·API 캐시·서버 간 통신 지연은 포함하지 않았다. 동시성 측정 432회의 오류 ${Object.values(d.methods.concurrency.levels).reduce((n,l)=>n+l.A0.errors+l.A1.errors,0)}건, 결과 혼선 ${Object.values(d.methods.concurrency.levels).reduce((n,l)=>n+l.A0.mismatch+l.A1.mismatch,0)}건이다.

| 사전 기준 | 결과 |
|---|---|
${gateRows}

시험 후 기준을 완화하지 않았다. 운영 API/MCP의 auto 연결·실사용 관찰은 채택 기준 통과 후 단계이며 이번에는 수행하지 않았다. 기존 요청 계약을 바꾸지 않은 오프라인 구현·평가 결과다.

## 데이터·실행 수와 해석의 한계

- 개발 200개 = 학습 150 + 검증 50. 과거 질문 72개 재사용, 128개 새로 작성. 학습의 복수 질문은 근거 사실을 조합한 합성 문항이다.
- 시험 **100개 모두 신규 작성**: 단일 60(10범위 각각 6), 복수 20, 모호 10, 범위 밖 10. 실사용 로그 100개로 부르지 않는다. 적중 분모는 답이 있는 80개이고 보류 20개는 별도 채점한다.
- 단일 문항 중 범위·버전 명시 ${d.testSampling.singletonExplicitContext}개, 암묵적 ${d.testSampling.singletonImplicitContext}개. 근거 가족 ${d.data.splits.test.uniqueFamilies}개, 재사용 가족 ${d.data.splits.test.repeatedFamilies}개, 최대 재사용 ${d.data.splits.test.maxFamilyQuestionReuse}문항이다. 공유 근거로 연결한 재표집 묶음은 ${d.testSampling.questionClusters}개다.
- **ML 라벨 한계:** 클래스당 확정 음성은 범위 밖 5개뿐이고 나머지 미판정은 학습에서 제외했다. 유사한 코드 범위끼리 구별하는 음성 학습 근거가 부족하다. 이번 A2의 실패를 ML 방식 전체의 한계로 일반화하지 않는다.
- 독립 에이전트가 원문과 100문항을 대조해 검색 전에 27개 질문 표현을 수정했다. 정답 대상은 유지했으며 사람이 검토한 라벨은 아니다. 동결 후 삭제·교체 없이 모두 실행했다. 인덱스 사본은 고정했지만 현재 원본 소스의 최신성까지 검증한 시험은 아니다.
- 시험 검색 **${d.executed.testTotal.toLocaleString('en-US')}회** = 주 행렬 2,400 + 순서 400 + 동시성 432 + vector 200 + 정렬 대조 100. 개발 검증 450회·비채점 스모크 17회는 별도다. 범위별 내부 검색과 재확대 작업량도 원시 기록에 보관했다.

## 남긴 구현과 다음 판단

구현 커밋은 **${d.implementationCommit}**다. 선택·보류·카탈로그 변경 검사를 담은 오프라인 모듈, 마스킹 학습기, 고정 런타임 비교 하네스와 수치·추론 동등성 테스트를 저장했다. 빌드, 선택기·융합 회귀·관측 코드 검사 및 공개 수치·식별자 검사를 통과했다. 모델 가중치·카드·질문·실제 함수·경로는 공개하지 않는다.

다음 실험은 **유사한 범위 사이의 확정 음성 라벨 보강**과 **워크스페이스 간 점수 병합 진단**을 분리한다. 모델을 LLM으로 바꾸거나 임베더를 재학습해야 한다는 결론은 아직 없다. 다시 튜닝하면 이번 100개는 개발 진단으로만 쓰고 새 시험군을 준비한다.

[사전 계획](2026-09-11-workspace-routing-plan.md) · [익명 100문항 결과·해시](results/2026-09-11-workspace-routing.json) · [누적 이력](README.md)
`;
if(process.argv.includes('--check'))assert.equal(fs.readFileSync(reportUrl,'utf8').replace(/\r\n/g,'\n'),text,'T12 report differs from public data');
else fs.writeFileSync(reportUrl,text);
console.log('T12: 100 anonymous cases, matrix totals, hit/MRR/group counts, comparisons and report reconciled.');
