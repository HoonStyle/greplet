---
name: greplet
description: 이 프로젝트의 소스코드·레거시 소스·사양서/매뉴얼(PDF)에서 내용을 찾을 때 사용. 폴더를 grep/read 로 통째로 뒤지기 전에 먼저 이 skill 로 greplet 인덱서(LanceDB 하이브리드 검색)를 조회해 관련 청크만 ~2초에 뽑는다. "코드에서 ~찾아줘", "사양서에 ~어떻게 정의됐어", "~구현이 어디 있어", "레거시에서 ~" 같이 코드나 문서 내용을 조회하는 요청에서 트리거. 순수 파일명/경로 찾기나 방금 편집한 파일 확인에는 쓰지 않는다(그건 Glob/Grep).
---

# greplet — 코드/문서 하이브리드 검색

<!-- 이 파일은 예제다. <GREPLET> 를 greplet 체크아웃 경로로, 워크스페이스 목록을 내 workspaces.json 에 맞게 채워 .claude/skills/greplet/SKILL.md 로 복사한다. -->

## 목적
코드(신규+레거시)와 문서(PDF/매뉴얼)는 폴더로 방대하다. 통째로 grep/read 하면 느리고 토큰을 많이 쓴다. 대신 greplet 인덱서(Roslyn/PdfPig 로 멤버·페이지 단위 청킹 + Ollama bge-m3 임베딩 + LanceDB 하이브리드(벡터+FTS, RRF) 검색, **LLM 생성 없음**)로 관련 청크만 ~2초에 뽑아 그것만 읽고 정리한다.

## 언제 쓰나
- **코드/문서 내용**을 찾는 요청일 때 (구현 위치, 사양서 정의, 프로토콜/상수/에러코드 등).
- grep/read 로 여러 파일을 뒤져야 할 것 같으면 **먼저 이걸 돌린다.**

## 언제 안 쓰나
- 단순 파일명/경로 찾기 → Glob
- 방금 편집한/열려 있는 파일 확인 → Read/Grep
- 호출 체인·참조·상속 같은 **구조** 질의 → LSP 심볼 도구(Serena 등). greplet 는 참조 관계를 모른다.
- 정확 문자열의 완전한 출현 목록 → `-Mode fts` 로 후보를 좁힌 뒤 최종 확인은 Grep

## 사용법
```bash
# 기본 워크스페이스 검색
pwsh <GREPLET>/greplet.ps1 -Query "검색어"

# 모든 워크스페이스 통합(코드+문서 동시), 점수순
pwsh <GREPLET>/greplet.ps1 -Query "검색어" -All

# 청크 전문(스니펫 대신 전체)
pwsh <GREPLET>/greplet.ps1 -Query "검색어" -All -Full

# 결과 개수 조절
pwsh <GREPLET>/greplet.ps1 -Query "검색어" -Workspace docs -TopN 10

# 정확 토큰 검색(상수·에러 코드·메서드명 등 의미 검색이 약한 대상)
pwsh <GREPLET>/greplet.ps1 -Query "0x0A03" -Mode fts
```

macOS/Linux 또는 pwsh 없는 환경에서는 동일한 CLI 를 `greplet.mjs` (Node, 크로스플랫폼)로 대신 쓴다:
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
```

`-Mode` / `--mode`: `hybrid`(기본, 벡터+FTS RRF 병합) · `vector`(의미 기반만) · `fts`(정확 토큰만, 임베딩 호출 없음).

추가 옵션(`greplet.mjs`): `--file "Lib/**/*.cs"` 로 파일 경로 글롭 필터, `--json` 으로 원본 JSON. 인덱서 상태·재인덱스는 `node <GREPLET>/greplet.mjs status` / `workspaces` / `index <slug> --wait` 로 curl 없이 처리한다.

워크스페이스 slug (`<GREPLET>/indexer/workspaces.json` 이 단일 소스):
- `code` — 이 리포 소스 (기본값)
- `code-legacy` — 레거시 소스 (리포 밖)
- `docs` — 사양서/매뉴얼/설계 문서

`-All` 은 전체를 뒤져 결과가 길다. 같은 계열 레거시가 여러 벌이면 유사 청크가 중복되니 대상이 분명하면 `-Workspace` 로 하나만 지정할 것.

## 결과 해석 후 동작
1. 반환된 `[워크스페이스] 파일명 :: symbol (L시작-끝)` 청크에서 관련 파일/위치를 파악한다.
2. 청크만으로 답이 되면 그대로 정리해 답한다.
3. 더 필요하면 **그 파일만** Read/Grep 으로 열어 확인한다(전체 폴더 스캔 금지).

## 전제 / 폴백
- 인덱서 서버가 `http://localhost:7802` 에 떠 있어야 한다(무인증, 로컬 전용). 안 떠 있으면 `bash <GREPLET>/indexer/start-indexer.sh` (macOS/Linux) 또는 `pwsh <GREPLET>/indexer/start-indexer.ps1` (Windows) 로 기동.
- 인덱서는 Ollama(`http://localhost:11434`, 모델 `bge-m3`)가 떠 있어야 임베딩할 수 있다(`-Mode fts` 는 Ollama 없이도 동작).
- 서버가 없거나 결과가 비면(신규 파일이 아직 인덱싱 안 됐을 수 있음) → 그때만 Glob/Grep 으로 폴백한다.
- 벡터 검색은 **의미 기반**이라 정확 일치를 보장하지 않는다. 완전성이 중요한 작업은 Grep 으로 교차 확인.
- 관리 UI(워크스페이스 상태·재인덱스·검색 테스트·로그)는 `http://localhost:7802`.
- 사용자가 "greplet 대시보드(관리 UI) 열어줘" 라고 하면 별도 툴 없이 셸로 연다: macOS `open http://localhost:7802`, Linux `xdg-open http://localhost:7802`, Windows `Start-Process http://localhost:7802`. 인덱서가 안 떠 있으면 먼저 기동 스크립트를 `--open`(bash) / `-OpenUI`(pwsh) 로 실행하면 기동과 열기가 한 번에 된다.
