# Greplet M1 안정화 개발 계획

- 기준선: `368b301e331349b6feda355805cb7fbc7ff3e0ff`
- 작성일: 2026-09-09
- 상태: **제안됨 / 미구현**. 아래 항목은 완료 사실이나 릴리스 약속이 아니다.
- 상위 기준: [마이그레이션 로드맵](docs/migration-roadmap.md), [실제 파일럿 기록](docs/migration-pilot.md)

## 1. 목표와 범위

목표는 M1 근거 검색에서 누락·출처 혼동을 막고 실패를 복구 가능하게 만드는 것이다.

1. 부분 추출 실패를 구조화해 Windows에서도 실패 파일을 정확히 식별한다.
2. 실패 파일을 성공 매니페스트로 기록하지 않고 다음 증분 실행에서 재시도한다.
3. 부분 성공 잡을 조용히 `done` 처리하지 않는다.
4. `fileGlob`을 고정 후보 풀 뒤에서 거르지 않고 완전성을 보장한다.
5. 다중 루트 충돌 검사의 전체 트리 반복 열거를 제거하되 신선도와 충돌 차단을 유지한다.
6. 외부 Ollama 없이 실제 hybrid·vector·fallback 분기를 자동 검증한다.
7. 자동 검증과 실제 마이그레이션 파일럿의 완료 상태를 분리한다.

## 2. 비범위

- M2 Serena 연결, M3 Tierwork 조율, M4 모델 정책, 비교 UI는 구현하지 않는다.
- 신규 저장소 형식이나 공개 API의 대규모 재설계는 하지 않는다.
- DOCX/XLSX/PPTX 등 광범위한 Office 문서 지원을 추가하거나 약속하지 않는다.
- 실제 5세트 선정·정답 작성·유료 모델 실행은 코드 변경과 별도인 파일럿 단계다.
- 토큰 절감률은 측정하되 M1 필수 통과 기준으로 삼지 않는다.

## 3. 문제와 코드 근거

### P0-1. Windows 부분 실패가 재시도되지 않을 수 있음

- 기존 행은 추출 전에 삭제된다: [`indexer/src/indexJob.ts`](indexer/src/indexJob.ts) 256–268행.
- Extractor는 `[실패] <절대경로>: <메시지>`를 쓰고 종료 코드 2를 반환한다: [`Extractor/Program.cs`](Extractor/Program.cs) 112–131행.
- 인덱서는 첫 `:`에서 경로를 잘라 `C:\...`를 `C`로 오인한다: [`indexer/src/indexJob.ts`](indexer/src/indexJob.ts) 284–289행.
- 오인된 파일은 새 해시와 `chunks: 0`으로 기록될 수 있다: [`indexer/src/indexJob.ts`](indexer/src/indexJob.ts) 342–349행.
- 다음 diff는 같은 해시를 변경 없음으로 보아 재시도를 건너뛴다: [`indexer/src/scan.ts`](indexer/src/scan.ts) 135–150행.

### P0-2. 부분 실패가 정상 완료로 노출됨

- Node 래퍼는 종료 코드 2를 정상 반환한다: [`indexer/src/extract.ts`](indexer/src/extract.ts) 101–106행.
- `doIndex`가 반환하면 잡은 `done`이다: [`indexer/src/indexJob.ts`](indexer/src/indexJob.ts) 180–185행.
- 증분 테스트에는 부분 실패 후 상태·매니페스트·재시도 검증이 없다: [`indexer/tests/incremental.mjs`](indexer/tests/incremental.mjs) 92–154행.

### P0-3. `fileGlob` 후처리가 정답을 누락할 수 있음

- 글롭은 검색 뒤 적용되고 후보는 `topN * 10`으로 제한된다: [`indexer/src/search.ts`](indexer/src/search.ts) 87–88행, 153–159행.
- FTS와 fallback도 제한 뒤 필터링한다: [`indexer/src/search.ts`](indexer/src/search.ts) 173–190행, 219–225행.
- hybrid도 후보를 자른 뒤 글롭을 적용한다: [`indexer/src/search.ts`](indexer/src/search.ts) 194–204행.
- 따라서 일치 파일이 고득점 비일치 후보 뒤에 있으면 히트가 있어도 `no_hits`가 가능하다.

### P1-1. 다중 루트 검사가 요청마다 전체 트리를 열거함

- `sourceIssue`는 다중 루트 전체 파일을 열거한다: [`indexer/src/evidence.ts`](indexer/src/evidence.ts) 108–125행.
- 검색과 상세 조회가 각각 이를 호출한다: [`indexer/src/evidence.ts`](indexer/src/evidence.ts) 136–148행, 170–176행.
- 열거기는 모든 루트를 재귀 순회한다: [`indexer/src/scan.ts`](indexer/src/scan.ts) 50–92행.
- 매니페스트 시각만으로 캐시하면 인덱싱 전 새 충돌을 놓치므로 허용하지 않는다.

### P1-2. 기본 hybrid 경로의 결정론적 CI 보장이 없음

- evidence API 기본 모드는 `hybrid`다: [`indexer/src/evidence.ts`](indexer/src/evidence.ts) 57–60행.
- evidence 테스트는 임베딩 없는 hybrid→FTS만 검증한다: [`indexer/tests/evidence.mjs`](indexer/tests/evidence.mjs) 382–390행.
- 실제 hybrid 검증은 로컬 Ollama 유무에 조건부다: [`indexer/tests/incremental.mjs`](indexer/tests/incremental.mjs) 136–153행.

### P1-3. 실제 파일럿은 미실행

- 5개 과제의 대상과 정답 근거가 아직 비어 있다: [`docs/migration-pilot.md`](docs/migration-pilot.md) 1–19행.
- M1 완료에는 자동 회귀 검증과 실제 파일럿이 모두 필요하다: [`docs/migration-roadmap.md`](docs/migration-roadmap.md) 15–23행.

## 4. 작업 패키지

### WP1. 부분 실패 계약과 재시도

설계:

- Extractor에 선택 옵션 `--failed-out <jsonl>`을 추가하고 실패마다 `abs`, `message`, 선택적 `kind`를 기록한다.
- `runExtractor`는 `failedFiles`를 반환하고 `indexJob`은 stderr 경로 파서를 제거한다.
- 성공 파일만 저장·매니페스트 반영한 뒤 실패가 있으면 typed error로 잡을 `failed` 처리한다.
- 새 `JobState`를 추가하지 않아 UI·SSE·MCP 열거형 호환성을 지킨다.
- 잡 상태와 별도로 마지막 인덱싱의 성공·실패·건너뜀 파일/페이지 수, 실패 상대키, 재시도 대상을 영속화한다. 재시작해도 부분 인덱스임을 알 수 있어야 한다.
- evidence search/get은 해당 인덱스의 coverage 상태를 반환한다. 기존 status를 유지한다면 추가 `coverage` 필드와 `warnings`를 사용해 무조건적인 `ok`/`no_hits`로 오해하지 않게 한다. 원본 해시 검증과 전체 인덱스 coverage는 다른 보장이다.

변경: `Extractor/Program.cs`, `indexer/src/extract.ts`, `indexer/src/indexJob.ts`, `indexer/tests/incremental.mjs`.

수용 기준:

- Windows 드라이브 경로가 축약되지 않으며 로그 문구 변경이 판정에 영향을 주지 않는다.
- 실패한 추가/변경 파일은 새 해시나 `chunks: 0` 성공 항목으로 기록되지 않는다.
- 성공 파일은 부분 실패 중에도 보존되고, 잡은 `done` 대신 `failed`와 실패 수를 남긴다.
- 원인을 고친 뒤 비강제 실행이 실패 파일을 재추출한다.
- 정상 0청크 파일은 실패와 구분해 기록한다.
- 서버 재시작 후에도 실패·스캔 페이지 누락이 있는 인덱스는 coverage 경고를 반환한다. 실패 파일 복구 및 성공적인 재인덱싱 뒤에만 경고를 해제한다.
- 구버전 매니페스트에 coverage가 없으면 `unknown`으로 표시하며 완전 성공으로 추정하지 않는다.

### WP2. `fileGlob` 완전성

설계:

- 현재 LanceDB/DataFusion 버전에서 필터 선적용과 검색 모드 조합을 먼저 검증한 뒤, 의미가 보존되는 글롭을 안전한 질의 조건으로 변환한다.
- 현재 `*`, `**`, `?`, 구분자 정규화, 대소문자 무시 의미를 보존한다.
- pushdown 불가 시 후보를 단계적으로 추가 조회해 기존 문법을 보존한다. 작업 한도에 도달하면 불완전 검색임을 반환하고 `no_hits`로 단정하지 않는다. 고정 배수 폴백으로 조용히 누락시키지 않는다.
- 사용자 문자열은 직접 SQL에 연결하지 않고 중앙 escaping 함수로 검증한다.

변경: `indexer/src/search.ts`, 필요 시 `indexer/src/db.ts`, `indexer/tests/evidence.mjs`.

수용 기준:

- 일치 파일이 `topN * 10 + 1`개 고득점 비일치 파일 뒤에 있어도 반환된다.
- 필터된 집합 안에서 기존 점수 순서와 `topN`을 지킨다.
- `*.cs`, `Lib/**`, `a/?/x.cs`, Windows 구분자 입력이 기존 의미와 같다.
- 따옴표·백슬래시·SQL 유사 입력이 조건을 탈출하지 않는다.
- FTS, hybrid, hybrid→vector, vector→FTS가 같은 완전성 규칙을 만족한다.
- 여기서 완전성은 파일 필터 때문에 후보가 유실되지 않는다는 뜻이다. 벡터 검색의 의미적 recall 100%를 보장하지 않는다.

### WP3. 출처 충돌 검사 최적화

설계:

- 테이블 이름 충돌 검사는 설정 수준에서 계속 전체 차단한다.
- 인덱싱 시 루트별 상대키 목록과 충돌 정보를 저장하고 설정·인덱스 버전 및 관측한 파일시스템 변경에 따라 무효화한다.
- 감시 누락·overflow·재시작·확인 불가 상태에서는 기존 전체 스캔으로 재검증한다. 신선도 근거 없이 캐시를 신뢰하지 않는다.
- 반환 후보만 검사하면 충돌 때문에 이미 누락된 후보나 `no_hits`를 검증할 수 없으므로, 그 방식만으로 기존 전역 충돌 차단을 대체하지 않는다.
- 원본 해시·허용 루트·`relativeFileKey` 일치 검증은 유지한다.
- 신뢰 가능한 무효화 경로가 없는 환경은 전체 스캔을 유지한다. 성능 수치를 위해 충돌 차단 계약을 바꾸지 않는다.

변경: `indexer/src/evidence.ts`, 필요 시 `indexer/src/scan.ts`, `indexer/tests/evidence.mjs`.

수용 기준:

- 같은 상대키를 두 번째 루트에 만들면 재인덱싱 없이 다음 search/get이 `ambiguous_source`를 반환한다.
- 기존 전역 `ambiguous_source` 동작을 보존한다. 충돌이 검색 상위 후보 밖에 있어도 정상 인덱스로 취급하지 않는다.
- 검증된 warm 상태의 반복 조회에서 전체 열거 횟수를 줄였음을 계측한다. cold/무효화/관측 불가 시 재검증 횟수는 별도 보고한다.
- stale, source_unavailable, 루트 이탈, 심볼릭 링크 회귀가 모두 통과한다.

### WP4. 결정론적 hybrid 하니스

설계:

- loopback 가짜 서버가 `/api/tags`, `/api/embed`와 고정 1024차원 벡터를 제공한다.
- 정상, HTTP 실패, 벡터 개수 불일치를 선택할 수 있게 한다.
- 제품 코드는 테스트 분기 없이 기존 `ollamaUrl`만 사용한다.

변경: 신규 `indexer/tests/fake-ollama.mjs`, `indexer/tests/evidence.mjs`, `indexer/tests/incremental.mjs`, 필요 시 `indexer/tests/activity.mjs`.

수용 기준:

- CI에서 `effectiveMode === "hybrid"`가 조건문 없이 실행된다.
- vector와 FTS 후보가 다를 때 RRF 결과가 결정론적이다.
- embed 실패→FTS, rerank 실패→vector, vector 실패→FTS와 각 경고를 검증한다.
- Ollama 미설치 강등 테스트도 별도로 유지한다.

### WP5. 상태 문서와 실제 파일럿

- 자동 검증 뒤 로드맵은 **M1 구현·자동 검증 완료 / 실제 파일럿 대기**로만 갱신하고 개선 SHA와 테스트 증거를 기록한다.
- 별도 파일럿에서 5과제의 대상·필수 근거·차이를 사람이 먼저 고정하며, 그전에는 M1 완료로 쓰지 않는다.
- 기존 기준 `220fbdd5a82948bb89f9423a80293f7789d69eb1`과 개선 SHA를 별도 데이터 디렉터리에서 조건별 3회 비교한다.
- 같은 소스·Serena·모델·effort·프롬프트·출력 한도를 사용한다.

## 5. 회귀 테스트와 실행 게이트

| 영역 | 회귀 시나리오 | 기대 결과 |
|---|---|---|
| 부분 추출 | Windows 경로 1개 실패, 1개 성공 | 잡 failed, 성공 저장, 실패 미기록 |
| coverage | 부분 실패 후 서버 재시작 | search/get에 지속적인 coverage 경고 |
| 재시도 | 실패 원인 수정 후 증분 실행 | 실패 파일 자동 재추출 |
| 0청크 | 정상 빈 파일 | 실패와 구분해 성공 기록 |
| 글롭 | 일치 파일이 후보 배수 밖 | FTS/hybrid/fallback 모두 반환 |
| 충돌 | 요청 사이 두 번째 루트에 같은 키 생성 | 즉시 ambiguous_source |
| 상세 조회 | 원본 수정·삭제·루트 이탈 | 기존 409 의미 유지 |
| hybrid | mode 생략 + 가짜 임베딩 | 실제 hybrid와 RRF 실행 |
| 독립성 | Ollama·고객 데이터 없음 | 전체 자동 테스트 재현 가능 |

```text
dotnet build Extractor -c Release
cd indexer
npm run build
npm run test:incremental
npm run test:evidence
npm run test:activity
npm run test:activity-log
```

## 6. 릴리스 게이트

Gate A — 구현 정합성:

- WP1–WP4 수용 기준이 자동화되고 위 빌드·테스트가 모두 통과한다.
- 매니페스트 재시도 불변식과 `fileGlob` 완전성에 미해결 P0가 없다.
- 통과 표기는 **M1 구현·자동 검증 완료**이며 실제 파일럿 완료를 뜻하지 않는다.

Gate B — 실제 파일럿:

- 사전 정답이 채워진 5과제를 조건별 3회 실행한다.
- 필수 근거 누락, 출처 오인용, 오래된 근거 정상 취급이 모두 0이다.
- 실패 원인과 호출·토큰·시간 기록을 남기고 실패 시 영향 과제를 다시 수행한다.
- Gate A와 B가 모두 통과해야 **M1 완료**로 표시한다.

## 7. 커밋 경계

1. `test(indexer): reproduce partial extraction retry loss`
2. `fix(extractor): emit structured failed file records`
3. `fix(indexer): fail partial jobs and preserve retry invariant`
4. `fix(search): apply file glob before candidate truncation`
5. `perf(evidence): replace full-tree collision scans with key checks`
6. `test(search): exercise deterministic hybrid and fallbacks`
7. `docs(migration): record implementation gate result`
8. `docs(migration): record real pilot result`

각 커밋은 빌드 가능해야 하며 문서 상태 커밋은 해당 게이트 증거보다 앞서면 안 된다.

## 8. 호환성·위험

- `--failed-out`은 선택 옵션으로 추가해 기존 직접 Extractor 호출을 유지한다.
- 부분 실패가 `done`에서 `failed`로 바뀌는 것은 의도된 관찰 동작 변경이며 변경 로그에 기록한다.
- evidence 응답 스키마와 `ambiguous_source`, `stale_evidence`, `source_unavailable` 코드는 유지한다.
- 기존 매니페스트는 계속 읽을 수 있어야 한다. 추가 coverage/충돌 메타데이터가 없으면 unknown 또는 재검증으로 처리하며 포맷 버전과 호환 규칙을 명시한다.
- 필터 SQL 방언/주입 위험은 지원 함수 프로브, 중앙 escaping, 공격성 fixture로 막는다.
- 상세 조회의 실경로·해시 재검증은 관측 시점의 변경 위험을 줄인다. 읽기 직후 변경까지 완전히 방지하는 보장은 아니며 `checkedAt` 시점의 검증으로 표현한다.
- 가짜 임베딩은 제어 흐름만 보장하며 실제 검색 품질은 파일럿에서 판정한다.
- 정확한 글롭이 비싸지면 먼저 계측하고, 후보 상한을 되살려 최적화하지 않는다.

## 9. 구현 전 결정

1. 실패한 변경 파일의 이전 행 처리.
   - 권장: 이전 행을 별도 `stale` 상태로 보존할 저장 계약이 없으므로 현재처럼 제거하되 실패 매니페스트를 남기지 않아 재시도를 보장한다.
   - 이전 행 보존을 택하면 검색에서 정상 후보로 노출하지 않는 명시적 stale 표식과 마이그레이션을 먼저 설계한다.
2. 충돌 차단 범위.
   - 권장: 현재의 전역 충돌 차단을 유지한다. 키별 차단으로 변경하려면 원본 인덱스가 출처를 잃지 않는 저장 계약과 재인덱싱 절차를 별도 설계한다.
3. 부분 실패 경로 노출.
   - 권장: 서버 로그에는 절대경로, API/SSE에는 개수와 상대키만 노출한다.
4. 글롭 미지원 문법.
   - 권장: 완전성을 보장할 수 없는 새 문법은 조용한 누락 대신 400으로 거부한다.

결정을 바꾸면 수용 기준과 호환성 설명을 같은 커밋에서 갱신한다.

## 10. 완료 정의

- 상태는 Gate A 전 **제안됨 / 미구현**, Gate A만 통과하면 **M1 구현·자동 검증 완료 / 실제 파일럿 대기**다.
- Gate A와 Gate B가 모두 통과해야 **M1 완료**다.
- 파일럿 기록이 비어 있으면 합성 테스트 성공을 고객 마이그레이션 성공으로 표현하지 않는다.
- Office 문서 확대, M2 이후 연결, 비용 절감 효과는 이 완료 정의에 포함하지 않는다.
