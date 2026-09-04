# Changelog

형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를 따르고, 버전은 [Semantic Versioning](https://semver.org/lang/ko/)을 따른다. 릴리스 산출물(`.mcpb`, OS 별 Extractor 바이너리)은 각 버전의 [GitHub Release](https://github.com/HoonStyle/greplet/releases)에 첨부된다.

## [Unreleased]

## [0.7.0] - 2026-09-04

### Added
- 관리 UI 의 Live Pipeline: 검색·인덱싱 파이프라인, 요청 레인, KPI·스파크라인, 클라이언트별 활동 피드를 실시간으로 표시.
- `/api/events` SSE, `/api/activity` 요약 API, 검색·인덱싱 활동 이벤트와 `JobRecord.stage`·`progress`.
- `X-Greplet-Client` 및 `GREPLET_CLIENT_NAME` 기반 클라이언트별 활동 기록과 `GREPLET_ACTIVITY_QUERY=hidden` 질의 비공개 옵션.
- 관리 UI 세션 선택기: `X-Greplet-Session` 헤더(`GREPLET_SESSION` → `CLAUDE_CODE_SESSION_ID` 순으로 자동 설정)로 활동 레코드에 세션을 기록하고, Live Pipeline 의 요청 레인·활동 피드·KPI·스파크라인을 세션별로 필터한다.

### Changed
- 관리 UI 를 다크 테마와 `public/live.js`·`live.css` 분리 구조로 개편하고 5초 폴링과 SSE를 병행한다.
- `scripts/screenshot.sh` 를 Google Chrome 헤드리스 대신 Python Playwright 캡처로 변경하고 실시간 모의 트래픽을 포함한다.

## [0.6.0] - 2026-09-03

### Added
- `greplet.mjs` 관리 서브커맨드: `status`, `workspaces`, `index <slug> [--force] [--wait]`. `--wait` 는 잡 로그를 완료까지 스트리밍한다.
- `greplet.mjs --json`: 서버 응답 JSON 을 그대로 출력.
- `greplet.mjs --file <glob>` · API `fileGlob` · MCP 툴 `fileGlob` 파라미터: 파일 상대경로 글롭(`*`, `**`, `?`)으로 결과 필터.
- 검색 결과 캐시: 질의 파라미터 + 워크스페이스 매니페스트 `lastRun` 을 키로 10분간 LRU(200건). 인덱스가 바뀌면 자동 무효화. 경고가 있는 응답은 캐시하지 않는다. 응답에 `cached: true`.
- 검색 hit 에 `abs`(절대경로) 포함. 관리 UI 에서 결과 파일명을 클릭하면 VS Code / Cursor / VS Code Insiders 로 해당 줄을 연다(선택은 브라우저에 저장).
- 관리 UI 에 파일 글롭 필터 입력과 `?file=` 딥링크.

### Changed
- 관리 UI 레이아웃 개편: 2열(워크스페이스·업로드 / 검색·진행 로그), 상태 배지형 헤더, 워크스페이스 카드에 파일·청크·임베딩 지표, 잡 목록과 로그 패널 나란히 배치, 1024px 이하 1열 반응형.
- 관리 UI 에 `?q=검색어&mode=fts&topN=10` 딥링크. 열면 바로 검색한다.
- 관리 UI 의 모든 서버 문자열을 HTML 이스케이프해 출력.
- `scripts/screenshot.sh`: README 스크린샷을 모의 임베딩·샘플 워크스페이스로 재생성.

### Fixed
- SSE 잡 로그의 실시간 이벤트에 `[시각] LEVEL` 접두어가 두 번 붙던 문제.
- 인덱서가 SIGTERM/SIGINT 를 받아도 프로세스가 남던 문제. `server.close()` 뒤 명시적으로 종료한다.

## [0.5.0] - 2026-09-03

첫 태그 릴리스. 이전까지 컴포넌트별로 따로 가던 버전(indexer 0.1.0, mcp-server 0.2.0, greplet-mcpb 0.4.0)을 0.5.0 으로 통일했다.

### Added
- macOS/Linux 지원: `indexer/start-indexer.sh`, 크로스플랫폼 Node CLI `greplet.mjs`, OS 별 데이터 디렉터리 기본값.
- Codex 연동: `examples/codex/` 에 MCP 등록 스니펫과 스킬. greplet-mcpb 의 stdio 서버를 그대로 쓴다.
- Ollama 없이 인덱싱: 영벡터로 인덱싱하고 `hybrid`/`vector` 검색을 `fts` 로 자동 강등. Ollama 가 준비되면 다음 잡이 전체 재인덱스로 승격.
- 기동 스크립트의 관리 UI 자동 열기 옵션 `--open` / `-OpenUI` / `GREPLET_OPEN_UI=1`, Claude Code SessionStart 훅 예제.
- MCP 툴 `greplet`·`greplet_workspaces` 에 `readOnlyHint` 등 annotations. Codex 가 승인 프롬프트 없이 호출한다.
- CI: ubuntu/windows/macos 매트릭스에서 Extractor 빌드, 인덱서 빌드와 증분 테스트(fts 경로), mcp-server 빌드, mcpb tools/list, CLI 스모크.
- 릴리스 워크플로: 태그 푸시 시 `.mcpb` 와 win-x64 / linux-x64 / osx-x64 / osx-arm64 self-contained Extractor 를 GitHub Release 에 첨부.
- 영문 README(`README.md`), 한국어 README 는 `README.ko.md` 로 이동. Serena·legacy-spec-agent 와의 역할 분담 문서화.

### Changed
- `indexer/tests/incremental.mjs` 가 Ollama 유무 양쪽에서 통과하도록 분기. Homebrew dotnet@8 keg 자동 감지.
- Extractor 를 `InvariantGlobalization` 으로 빌드해 ICU 없는 Linux 러너에서도 동작.

### Known limitations
- Intel Mac 은 `@lancedb/lancedb` 0.22.3 이 마지막 darwin-x64 바이너리라 `npm install` 뒤 별도 설치가 필요하다.
- 청커는 C# 특화. 다른 언어는 텍스트 윈도우.

## [0.0.0] - 2026-09-02

Windows 에서 개발·검증된 초기 상태. Extractor(Roslyn/PdfPig), LanceDB 하이브리드 인덱서, PowerShell CLI, Claude Desktop `.mcpb`, 원격 MCP 서버, post-commit 훅, Claude Code 스킬 예제.

[Unreleased]: https://github.com/HoonStyle/greplet/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/HoonStyle/greplet/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/HoonStyle/greplet/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/HoonStyle/greplet/compare/3a3e05b...v0.5.0
[0.0.0]: https://github.com/HoonStyle/greplet/commit/3a3e05b
