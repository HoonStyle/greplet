---
name: "greplet"
description: "이 프로젝트의 소스코드·레거시 소스·사양서/매뉴얼(PDF)에서 내용을 찾을 때 사용. greplet 인덱서의 하이브리드 검색으로 관련 후보와 위치를 좁힌다. \"코드에서 ~찾아줘\", \"사양서에 ~어떻게 정의됐어\", \"~구현이 어디 있어\", \"레거시에서 ~\" 같이 코드나 문서 내용을 조회하는 요청에서 트리거. 순수 파일명/경로 찾기나 방금 편집한 파일 확인에는 쓰지 않는다."
---

# greplet — 코드/문서 하이브리드 검색

<!-- 이 파일은 예제다. <GREPLET> 를 greplet 체크아웃 경로로, 워크스페이스 목록을 실제 workspaces.json 에 맞게 채워 ~/.codex/skills/greplet/SKILL.md 로 복사한다. -->

## 목적
greplet 인덱서로 코드·문서의 관련 후보를 좁힌다(**LLM 생성 없음**). Roslyn/PdfPig 청킹, Ollama bge-m3, LanceDB 하이브리드(벡터+FTS, RRF)는 예시 구성이며 실제 설치 설정을 따른다. 지연·토큰 사용은 인덱스·워밍·조회 조건에 따라 달라지므로 일정한 속도나 절감을 보장하지 않는다.

## 언제 쓰나
- **코드/문서 내용**을 찾는 요청일 때 (구현 위치, 사양서 정의, 프로토콜/상수/에러코드 등).
- 여러 파일에서 관련 위치를 좁힐 때 탐색 수단으로 사용한다. 결과가 충분한지는 아래 근거 확인 기준으로 판단한다.

## 언제 안 쓰나
- 단순 파일명/경로 찾기 → 파일 탐색(find 등)
- 방금 편집한/열려 있는 파일 확인 → 파일 읽기 / rg
- 호출 체인·참조·상속 같은 **구조** 질의 → 별도 코드 인텔리전스 도구(LSP 등). greplet 는 참조 관계를 모른다.
- 정확 문자열의 완전한 출현 목록 → `--mode fts` 로 후보를 좁힌 뒤 최종 확인은 rg

## 사용법
```bash
# 기본 워크스페이스 검색
node <GREPLET>/greplet.mjs "검색어"

# 모든 워크스페이스 통합(코드+문서 동시), 점수순
node <GREPLET>/greplet.mjs "검색어" --all

# 청크 전문(스니펫 대신 전체)
node <GREPLET>/greplet.mjs "검색어" --all --full

# 결과 개수 조절
node <GREPLET>/greplet.mjs "검색어" --workspace docs --top-n 10

# 정확 토큰 검색(상수·에러 코드·메서드명 등 의미 검색이 약한 대상)
node <GREPLET>/greplet.mjs "0x0A03" --mode fts

# 자주 쓰는 조합
node <GREPLET>/greplet.mjs "검색어" --full --workspace docs --top-n 10 --mode fts
```

`--mode`: `hybrid`(기본, 벡터+FTS RRF 병합) · `vector`(의미 기반만) · `fts`(정확 토큰만, 임베딩 호출 없음).

추가 옵션(`greplet.mjs`): `--file "Lib/**/*.cs"` 로 파일 경로 글롭 필터, `--json` 으로 원본 JSON. 상태·목록 조회는 `node <GREPLET>/greplet.mjs status` / `workspaces` 로 처리한다. `index <slug> --wait` 는 재인덱싱 작업이며 조회 요청의 허가에 포함되지 않는다.

근거 참조가 필요하면 Node CLI의 `evidence-search "검색어" --workspace docs` 로 검색하고, 반환된 evidenceRef 객체를 담은 JSON 파일을 `evidence-get --ref-file <EVIDENCE_REF_JSON>` 에 전달한다. MCP에서는 `greplet_search_evidence` / `greplet_get_evidence` 를 사용한다. MCP evidence 검색의 `workspaces` 기본값은 `"all"` 이므로 대상이 정해졌으면 목록을 명시한다.

워크스페이스 slug (`<GREPLET>/indexer/workspaces.json` 이 단일 소스):
- `code` — 이 리포 소스 (기본값)
- `code-legacy` — 레거시 소스 (리포 밖)
- `docs` — 사양서/매뉴얼/설계 문서

`--all` 은 전체를 뒤져 결과가 길다. 같은 계열 레거시가 여러 벌이면 유사 청크가 중복되니 대상이 분명하면 `--workspace` 로 하나만 지정할 것.

## 결과 해석 후 동작
1. 검색 청크는 위치를 좁히는 후보다. 인용·판단·수정 근거로 쓸 때는 질문이 지정한 저장소·workspace·버전의 원문 또는 지원되는 evidence 조회로 확인하고, 내용이 주장을 뒷받침하는지 판단한다. 현재 상태는 현재 원문을, 과거 비교는 양쪽 버전을 확인하며 현재 HEAD로 대체하지 않는다.
2. evidence 조회는 제공된 참조와 지원 범위 안에서 사용한다. 해시 일치는 검증 대상의 동일성이지 최신성·의미 충족의 보증이 아니며, 임의 과거 버전 복구를 가정하지 않는다. 같은 근거를 이미 유효하게 확인했다면 불필요한 중복 조회를 강제하지 않는다.
3. 결과가 비어 있지 않아도 무관·불충분하거나 대상이 다르면, 허용된 범위의 사용 가능한 파일 읽기/rg/LSP 등으로 같은 저장소·버전임을 확인하며 필요한 정의·호출자·설정부터 보완하고 근거가 충족되면 멈춘다. 도구가 없거나 원격 인덱스와 로컬 파일의 대응이 불명확하면 확인 불가로 남긴다. 전체 탐색은 자동으로 하지 않으며, 확장 이유를 밝히는 것만으로 새 접근 권한이 생기지 않는다.
4. 404/409·일반 요청 실패는 반환된 설명과 문서화된 계약에 따라 구분한다. 실패만으로 원인을 단정하거나 서비스 기동·설정 변경·재인덱싱 권한을 추론하지 않는다.

## 전제 / 폴백
- 예시 인덱서 주소는 `http://localhost:7802` (무인증, 로컬 전용)이며 실제 설정을 따른다. 요청 실패만으로 미가동을 단정하지 않는다. 미가동을 확인하고 기존 운영 지침·허용 범위에 포함될 때만 `bash <GREPLET>/indexer/start-indexer.sh` (macOS/Linux) 또는 `pwsh <GREPLET>/indexer/start-indexer.ps1` (Windows) 로 기동한다.
- 예시 구성에서는 Ollama(`http://localhost:11434`, 모델 `bge-m3`)를 임베딩에 사용한다. 실제 설정을 확인한다(`--mode fts` 는 Ollama 없이도 동작).
- 서버를 사용할 수 없거나 결과가 비거나 불충분하면 위의 대상·버전·권한 조건 안에서 보완한다. 검색 결과 없음은 원문에 해당 내용이 없다는 증명이 아니다.
- 벡터 검색은 **의미 기반**이라 정확 일치를 보장하지 않는다. 완전성이 중요한 작업은 rg 로 교차 확인.
- 관리 UI(워크스페이스 상태·재인덱스·검색 테스트·로그)는 `http://localhost:7802`.
- 사용자가 "greplet 대시보드(관리 UI) 열어줘" 라고 하면 별도 툴 없이 셸로 연다: macOS `open http://localhost:7802`, Linux `xdg-open http://localhost:7802`, Windows `Start-Process http://localhost:7802`. 미가동이 확인되고 기동이 허용된 경우에만 스크립트의 `--open`(bash) / `-OpenUI`(pwsh) 를 사용한다. UI 열기 요청을 설정 변경·재인덱싱 허가로 확대하지 않는다.
