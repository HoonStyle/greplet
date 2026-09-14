// Reconcile the anonymous T13 artifact and render its accuracy-first report; no searches.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const resultFile=new URL('../docs/tuning/results/2026-09-14-reranker.json',import.meta.url);
const reportFile=new URL('../docs/tuning/2026-09-14-reranker.md',import.meta.url);
const d=JSON.parse(fs.readFileSync(resultFile,'utf8'));
assert.equal(d.experiment,'T13');
const dev=d.cohorts.development,reg=d.cohorts.regression,pilot=d.cohorts.pilot;
assert.equal(dev.totalCases,100);assert.equal(dev.scoredCases,80);
assert.equal(reg.totalCases,40);assert.equal(pilot.totalCases,20);
for(const cohort of [dev,reg,pilot]){
  assert.equal(cohort.cases.length,cohort.totalCases*cohort.rounds.length);
  for(const round of cohort.rounds)for(const method of ['B0','BC','R1']){
    const cases=cohort.cases.filter(c=>c.round===round.round&&c.requiredGroups>0);
    const m=round.metrics[method];
    assert.equal(cases.length,m.scoredCases);
    const sum=field=>cases.reduce((s,c)=>s+c.methods[method][field],0);
    assert(Math.abs(sum('hitAt5')/cases.length-m.hitAt5)<1e-9);
    assert(Math.abs(sum('reciprocalRankAt5')/cases.length-m.mrrAt5)<1e-9);
  }
}
assert.equal(d.newTest.executed,0);assert.equal(d.newTest.target,100);
assert.equal(d.judgmentAudit.confirmedHitLosses,3);
const p=dev.rounds[0],r=reg.rounds[0],a=d.judgmentAudit;
const num=(v,n=4)=>Number(v).toFixed(n);
const count=m=>`${Math.round(m.hitAt5*m.scoredCases)}/${m.scoredCases}`;
const group=m=>`${Math.round(m.multiGroup.completeAt5*m.multiGroup.cases)}/${m.multiGroup.cases}`;
const delta=p.paired.R1_vs_B0;
const known=p.metrics.B0.knownGroups;
const union=p.optionalUnionDiagnostic;
assert.equal(union.status,'available');
const md=`# T13 — 내용 기반 재정렬의 정확도 비교

**결과: 기존 정답셋 기준 전체 검색 적중이 ${count(p.metrics.B0)}→${count(p.metrics.R1)}(+${num((p.metrics.R1.hitAt5-p.metrics.B0.hitAt5)*100,2)}%p)로 개선됐다.** 기존 100문항 전체와 별도 회귀 40문항을 실행했다. 지정 범위 회귀군은 **${count(r.metrics.B0)}→${count(r.metrics.R1)}**로, 신규 적중 3개와 손실 3개가 상쇄됐다. 방법·순위를 숨긴 원문 검토에서도 손실 3개가 남아 사전 기준인 **기존 적중 손실 0**을 충족하지 못했다. **이번 설정의 운영 채택과 새 독립 시험 진입은 보류한다.**

아래 전체 수치는 **기존 qrels에 등록된 근거의 적중·순위**다. 새 대체 근거를 모두 판정한 정확도나 최종 LLM 답변 정확도가 아니다. 원문 검토는 회귀 9문항에 한정했고 나머지 미판정을 음성으로 바꾸지 않았다. [사전 계획](2026-09-14-reranker-experiment-plan.md) · [익명 집계](results/2026-09-14-reranker.json) · [튜닝 히스토리](README.md)

## 무엇을 어떻게 바꿨나

| 항목 | 실행한 설정 |
|---|---|
| 기준 | 운영 0.11.2, 고정 검색 구현 \`f95eb05\`, 계획 시 저장소 \`d141443\`. T12 고정 인덱스·질문 재사용 |
| B0 | 현재 후보 C와 기존 순위 그대로 |
| BC | 같은 C와 점수, 최종 동점만 고정 후보 키로 정렬 |
| R1 | **같은 C 전부**를 질문·내용 관련성 점수로 재정렬. 별도 후보 축소 없음 |
| 모델 | \`BAAI/bge-reranker-v2-m3\`, revision \`${d.model.revision}\`, 추가 학습 없음 |
| 입력 | 원문 질의 + 상대 파일 경로·심볼·청크 본문. 쌍 길이 512토큰, 문서 오른쪽 절단, 질문 유지 |
| 추론 | RTX 5070 Laptop, FP16, batch 8, eager attention, 결정성 설정. 원점수 사용, RRF와 점수 혼합 없음 |
| 보호 경로 | 정확한 정의 조회 8개는 재정렬 우회. 자연어 단일 범위에서는 기존 벡터 상위 3개도 순위가 바뀔 수 있음 |

검색→cross-encoder 재정렬 구조는 [Sentence Transformers 공식 문서](https://sbert.net/examples/cross_encoder/applications/README.html), 다국어 모델·입력 방식은 [BAAI 모델 카드](https://huggingface.co/BAAI/bge-reranker-v2-m3)를 참고했다. 해당 자료의 성능을 Greplet에서 재현했다고 주장하지 않는다.

## 같은 조건의 전후 결과

| 평가군·방법 | 적중@5 | MRR@5 | 복수 근거 완성@5 |
|---|---:|---:|---:|
| 개발 100 — B0 현재 순위 | ${count(p.metrics.B0)} | ${num(p.metrics.B0.mrrAt5)} | ${group(p.metrics.B0)} |
| 개발 100 — BC 동점 대조군 | ${count(p.metrics.BC)} | ${num(p.metrics.BC.mrrAt5)} | ${group(p.metrics.BC)} |
| 개발 100 — R1 내용 재정렬 | **${count(p.metrics.R1)}** | **${num(p.metrics.R1.mrrAt5)}** | **${group(p.metrics.R1)}** |
| 회귀 40 — B0 현재 순위 | ${count(r.metrics.B0)} | ${num(r.metrics.B0.mrrAt5)} | 해당 없음 |
| 회귀 40 — BC 동점 대조군 | ${count(r.metrics.BC)} | ${num(r.metrics.BC.mrrAt5)} | 해당 없음 |
| 회귀 40 — R1 내용 재정렬 | **${count(r.metrics.R1)}** | **${num(r.metrics.R1.mrrAt5)}** | 해당 없음 |

개발 100개는 단일 근거 60·복수 근거 20·모호 10·범위 밖 10이며 **100개 모두 실행, 답이 있는 80개 채점**이다. R1−B0 신규 적중 **${delta.hitAt5.gains}**, 손실 **${delta.hitAt5.losses}**, 유지된 적중의 순위 하락 **${delta.retainedHits.rankDrops}**건이다. 회귀군은 원래 지정 범위로 실행했으며 현재 고정 기준선과 비교했다. 과거 다른 설정의 40문항 수치를 기준선으로 가져오지 않았다.

개발군 58개 관련 질문군을 재표집한 적중 차이의 95% 구간은 **[${num(delta.bootstrap.hitAt5.ci95[0]*100,2)}, ${num(delta.bootstrap.hitAt5.ci95[1]*100,2)}]%p**다. 회귀군은 공유 근거를 기준으로 묶은 23개 질문군을 사용했다. 예전 범위·유형 묶음에 따른 불확실성 계산은 비공개 이력으로 보존하고, 공개 결과에는 근거 단위 계산을 사용한다. 이미 사용한 개발·회귀 자료이며 새 질문의 성능을 보장하지 않는다.

## 후보 부족과 순위 문제를 분리하면

등록된 정답 근거 **96개는 모두 고정 인덱스에서 확인**했다. 개발군의 필수 근거군 ${known.total}개 중 원래 후보 합집합 U에서 ${known.total-known.representedInU}개가 미포착됐고, U→C에서 ${known.representedInU-known.representedInC}개, C→B0 top5에서 ${known.representedInC-known.representedInTop5}개가 탈락했다. 이는 **근거군 수**이며 질문 수와 다르다. 이 자료의 후보 미포착은 인덱스 부재와 구별할 수 있다.

| 후보·정렬 | 적중@5 | MRR@5 | 복수 근거 완성@5 |
|---|---:|---:|---:|
| C + 현재 순위 B0 | ${count(p.metrics.B0)} | ${num(p.metrics.B0.mrrAt5)} | ${group(p.metrics.B0)} |
| C + 재정렬 R1 | ${count(p.metrics.R1)} | ${num(p.metrics.R1.mrrAt5)} | ${group(p.metrics.R1)} |
| U + 현재 융합 U0 | ${count(union.U0)} | ${num(union.U0.mrrAt5)} | ${group(union.U0)} |
| U + 재정렬 U1 | ${count(union.U1)} | ${num(union.U1.mrrAt5)} | ${group(union.U1)} |

C는 총 **49,500개**, U는 **75,658개** 후보다. U는 같은 검색에서 이미 관측된 vector·FTS 합집합이며 검색 깊이를 늘려 새로 수집한 풀이 아니다. U1은 pointwise C 점수를 재사용하고 U에만 있는 **26,158쌍**을 추가 추론했다. U1−B0 전체 차이를 순수 재정렬 효과로 합산하지 않는다. U에서 미포착한 근거는 이번 재정렬로 복구할 수 없다.

## 회귀 원문 검토와 입력 절단

회귀군에서 적중이 바뀌거나 순위가 하락한 **${a.reviewedCases}문항·${a.reviewedCandidates}후보**를 방법·순위·점수 없이 섞어 판정했다. 두 \`gpt-5.6-sol\` 에이전트가 나눠 검토했으며 같은 사례를 두 번 독립 판정한 것은 아니다. 사람 검토는 없고, 주 에이전트가 핵심 손실 사례와 추가 대체 근거를 원문으로 확인했다. 직접 근거 ${a.grades['2']}·부분 근거 ${a.grades['1']}·무관 ${a.grades['0']}·판정 보류 ${a.grades.unknown}개였다.

| 회귀 문항 별칭 | 기존 등록 근거 순위 B0→R1 | 해당 근거 입력 절단 | 원문 검토 |
|---|---:|---|---|
| Q017 | 2→6 | 있음 | 상위 5개가 필요한 검증 로직을 대신하지 못함 |
| Q031 | 1→6 | **없음** | 관련 설정·부분 구성이 통합 결과를 대신하지 못함 |
| Q036 | 1→13 | 있음 | 주변 기능이 요청한 주기 제어 근거를 대신하지 못함 |

대체 직접 근거 대응 1개를 확인했으나 위 손실 3건은 해소되지 않았고, 검토한 9문항의 첫 직접 근거 순위도 바뀌지 않았다. **나머지 31문항과 개발 100문항 전체의 후보 판정은 완료하지 않았다.** 전체 결과 표는 기존 qrels 수치로 유지하며 부분 검토를 전체 정확도로 일반화하지 않는다. Q 번호는 회귀군 안의 익명 질문 ID다.

예비 20문항에서는 9,900쌍 중 **6,565쌍(66.3%)**이 절단됐다. 절단 여부만으로 실패 원인을 확정하지 않는다. Q017에서는 필요한 후반 검증 내용이 입력 밖으로 잘렸고, Q031은 본문 전체가 입력에 있었는데도 밀렸다. 긴 입력 처리와 재정렬 자체의 순위 회귀를 각각 검증할 필요가 있다.

## 실행 범위·비용·재현성

| 구분 | 실제 실행 |
|---|---|
| 후보 수집 | 개발 100 + 회귀 40 = 성공 140회. 후보 식별·본문 복원 준비 실패에 따른 재실행 200회 별도, 총 340회 |
| 예비 | 기존 개발군의 20개, 1회. 개발 N에 다시 더하지 않음 |
| 개발 | 기존 100개 전부, B0/BC/R1 및 U0/U1, 1회 |
| 회귀 | 기존 40개 전부, B0/BC/R1, 1회. 8개 정의 조회는 추론 우회 |
| 새 독립 시험 | **목표 100개 유지, 확보·실행 0개**. 회귀 기준 미달로 진입 보류 |
| 실제 평가 추론 | 예비·개발·회귀 합계 **${d.execution.evaluationPairs.toLocaleString('en-US')} query-document 쌍**. 합성 검사 4쌍·세션별 warmup ${d.execution.warmupPairs}쌍 별도 |

질문 수·검색 호출·모델 평가 쌍·순위 결과를 구별한다. 새 100개×3회 확인은 실행하지 않았으며, 개발 1회 결과를 3회 검증으로 표기하지 않는다. 예비와 개발에서 겹치는 20개는 ${d.repeatability.equalTop5}/20개 top5가 같고, ${d.repeatability.equalScores}/20개 원점수가 일치했다.

| 로컬 재정렬 비용 | 중앙값 | p95 |
|---|---:|---:|
| 개발 — C 전체 재정렬 | ${num(d.timing.development.medianMs/1000,3)}초 | ${num(d.timing.development.p95Ms/1000,3)}초 |
| 회귀 — 추론한 32개 요청 | ${num(d.timing.regression.medianMs/1000,3)}초 | ${num(d.timing.regression.p95Ms/1000,3)}초 |

위 시간은 후보 생성·HTTP를 제외한 고정 후보 처리다. 개발 C 시간에서는 U 추가 진단을 제외했다. 품질 기준을 통과하지 못해 운영 HTTP·동시 요청 4/8 검증으로 진행하지 않았다. 전체 후보 재정렬의 비용은 관측상 크며, 정확도 판단과 별도로 운영 적용에 해결할 조건이다.

기존 trace는 최종 5개와 집계만 저장했으므로 고정 인덱스에서 전체 후보를 다시 수집했다. B0 top5·순위는 이전 T12와 모두 일치했다. 후보 ID 중복 3건은 파일·줄 범위를 포함한 실험용 키로 구분했고, 공개 함수·프로젝트·질문·경로는 익명화했다. 원문·모델 입력·판정 대응표는 비공개 자료에 보존한다.

모델·토크나이저 파일 해시, 고정 인덱스 버전, 후보·코드·출력 해시를 기록했다. 초기 개발 후보 exporter 원본 스크립트 사본은 남아 있지 않으며 해당 해시·관측 런타임·후보 팩을 보존했다. 회귀 exporter 및 추론 스크립트 사본은 보존했다. 이 차이를 완전한 소스 보존으로 표시하지 않는다.

## 결정과 후속 조건

**현재 설정은 적용하지 않는다.** 단순히 질문 수가 적어서만 내린 판단이 아니라 원문으로 확인한 기존 정답 손실이 남아 있기 때문이다. 입력 절단을 줄이는 변경, 기존 적중을 보존하는 재정렬 결합, 원문을 유지한 보조 질의는 각각 별도 가설로 비교한다. 이번 결과만으로 모든 reranker가 효과 없거나 임베더 재학습이 필요하다고 결론 내리지 않는다.

운영 검색은 기존 0.11.2 동작을 유지하며, 이번 재정렬 모델은 오프라인 평가에만 사용했다. 후속 설정이 개발·회귀 기준을 통과한 뒤 새 100문항을 준비하고 설정을 동결한다.

집계·보고서 검사는 검색이나 모델 추론을 실행하지 않는다.

\`\`\`sh
node scripts/report-reranker-results.mjs --check
node scripts/test-reranker-eval.mjs
\`\`\`

재현 도구: [고정 후보 수집](../../scripts/export-reranker-pools.mjs) · [모델 고정·검증](../../scripts/prepare-reranker-model.py) · [로컬 추론](../../scripts/score-reranker-pools.py) · [채점·무결성](../../scripts/analyze-reranker-eval.mjs) · [판정 풀](../../scripts/pool-reranker-judgments.mjs) · [판정 집계](../../scripts/summarize-reranker-judgments.mjs). 실제 재실행은 별도의 비공개 입력과 모델 환경이 필요하다.
`;
const rendered=md;
if(process.argv.includes('--check')) assert.equal(fs.readFileSync(reportFile,'utf8').replaceAll('\r\n','\n'),rendered,'T13 report differs from anonymous results');
else fs.writeFileSync(reportFile,rendered);
console.log('T13 anonymous cohorts and report reconciled; no searches or inference.');
