# Greplet 근거 조회 첫 릴리스 세부 계획

상태: 계획 확정, 구현 예정. 관련 문서: [전체 로드맵](migration-roadmap.md).

## 1. 구현 순서

1. Node CLI·PowerShell·원격 MCP·stdio MCP의 파일 경로+앞 80자 기반 중복 제거를 폐지한다. 다른 출처는 본문이 같아도 모두 보존한다. 기존 정렬·옵션은 유지한다.
2. 기존 DB의 청크 ID·파일 해시·인덱싱 시각으로 버전이 포함된 근거 참조와 조회 API를 만든다.
3. MCP·CLI 연결, 사용 예제, 자동 회귀 테스트와 CI를 추가한다.
4. 실제 마이그레이션 파일럿까지 완료한 후 스킬의 기본 마이그레이션 검색 흐름을 새 도구로 변경한다.

기존 `/api/search`, `greplet` 도구와 기존 DB 스키마·저장 키는 유지한다. 새 기능은 선택적으로 도입한다. 자동 출처 병합, 비교 UI, OCR, Serena 자동 호출, Tierwork 실행 조율, 머신 간 근거 이식은 첫 릴리스에 포함하지 않는다.

## 2. 공개 인터페이스

| HTTP | MCP | Node CLI |
|---|---|---|
| `POST /api/evidence/search` | `greplet_search_evidence` | `evidence-search` |
| `POST /api/evidence/get` | `greplet_get_evidence` | `evidence-get` |

PowerShell의 새 근거 명령은 Node CLI에 위임한다. 기존 PowerShell 검색 호출은 유지한다.

검색 입력은 `{query, workspaces: string[] | "all", topN?, mode?, fileGlob?}`다. 기본 `topN=3`, 최대 20이며 워크스페이스별로 적용한다. 기본 mode는 hybrid다. 잘못된 입력과 미등록 워크스페이스는 명시적으로 거부한다.

검색 응답은 `{schemaVersion:1, query, mode, targets:[...]}`이며 각 대상에 `workspace`, `label`, `status`, `effectiveMode`, `warnings`, `hits`를 포함한다. 상태는 `ok`, `no_hits`, `not_indexed`, `indexing`, `search_error`, `ambiguous_source`로 구분한다. 빈 결과를 기능 부재로 표현하지 않는다. 검색의 최신성은 `unchecked`로 표시한다.

각 hit는 출처·파일·심볼·kind, 원문 위치 `{unit:"line"|"page", start, end}`, `fileHash`, `contentHash`, `indexedAt`, 최대 300자 `excerpt`, `evidenceRef`를 제공한다. 발췌 위치는 원래 청크의 범위로 표시한다(`locationScope:"chunk"`). 생성된 컨텍스트 헤더를 실제 원문 줄로 오인하지 않는다.

`evidenceRef={workspace,chunkId,fileHash,startLine,endLine,contentHash}`다. 파일 해시는 원본 바이트의 SHA-256, 청크 해시는 저장된 청크 텍스트 UTF-8의 SHA-256이다. 인덱싱 시각은 참조 동일성에 포함하지 않는다. 기존 청크 ID만으로 버전을 판단하지 않는다.

상세 조회 입력은 `{evidenceRef}`다. 응답은 `{schemaVersion:1,evidence:...}`이며 검색 hit의 발췌 대신 정확한 저장 청크 전문 `text`, 최신성을 확인한 시점 `checkedAt`, `freshness:"verified"`를 반환한다. 이 상태는 원본 해시 일치만 의미하며 의미적 정확성·테스트 통과를 의미하지 않는다.

없는 참조는 404, 오래된 참조와 인덱싱 중 대상은 409로 반환한다. 삭제·읽기 실패·모호한 출처를 정상 근거로 취급하지 않는다. 상세 조회가 최신 코드나 다른 출처로 자동 연결되면 안 된다. 원본 경로는 클라이언트 입력이 아닌 해당 워크스페이스에 저장된 행에서 얻는다.

새 MCP 도구는 JSON 결과를 반환하고 같은 전문을 별도의 설명에 중복해서 싣지 않는다. CLI는 기본 JSON 출력을 제공하고 `evidence-get --ref-file <파일>`로 저장한 참조를 읽는다.

## 3. 출처와 최신성

- 워크스페이스별 출처를 보존하며 결과가 없는 대상도 반환한다.
- 다중 루트에 같은 상대경로가 있으면 근거 모드를 사용하지 못하도록 `ambiguous_source`로 표시한다. 기존 인덱스에서 출처가 이미 합쳐졌을 수 있으므로 분리 후 재인덱싱이 필요하다.
- 변경 없는 재인덱싱은 같은 근거 참조를 유지한다. 파일·청크 내용·위치가 바뀌면 이전 참조를 정상 근거로 반환하지 않는다.
- 검색은 인덱스 기준이고 상세 조회는 현재 원본 파일 해시를 확인한다. 새 근거 흐름은 기존 검색 캐시로 상세 최신성 확인을 생략하지 않는다.
- 동일한 검색 캐시를 다시 반환하는 것은 모델 토큰 절감으로 계산하지 않는다.

## 4. 자동 검증

합성 레거시 5개, 현재 코드, 스펙 워크스페이스를 임시 경로·별도 DB에 만든다. 기존 사용자 인덱스를 변경하지 않는다.

- 같은 경로·앞 80자, 서로 다른 뒤쪽 동작이 모두 표시된다.
- 같은 본문도 출처가 다르면 모두 남는다. 표시 건수가 일치한다.
- 서로 다른 워크스페이스의 같은 심볼을 혼동하지 않는다.
- 변경 없는 재인덱싱, 동일 심볼의 본문 변경, 재인덱싱 전 변경, 삭제 및 오래된 참조를 검사한다.
- PDF 페이지와 분할 청크의 위치·본문을 정확히 다시 조회한다.
- 빈 결과·미인덱싱·FTS 강등·검색 실패·인덱싱 중·모호한 출처를 구분한다.
- HTTP·원격 MCP·stdio MCP·Node CLI·PowerShell이 같은 근거를 반환한다.
- Linux·Windows·macOS CI에서 기존 빌드·증분 인덱싱 및 새 회귀 테스트를 실행한다. 기본 CI는 Ollama 없이 실행하고 hybrid는 별도 환경에서 확인한다.

실제 파일럿의 과제·반복·완료 기준은 전체 로드맵을 따른다. 자동 테스트 통과와 실제 파일럿 완료를 별도로 기록한다.
