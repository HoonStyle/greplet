# Changelog

형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를 따르고, 버전은 [Semantic Versioning](https://semver.org/lang/ko/)을 따른다. 릴리스 산출물(`.mcpb`, OS 별 Extractor 바이너리)은 각 버전의 [GitHub Release](https://github.com/HoonStyle/greplet/releases)에 첨부된다.

## [Unreleased]

### Changed
- 관리 UI 레이아웃 개편: 2열(워크스페이스·업로드 / 검색·진행 로그), 상태 배지형 헤더, 워크스페이스 카드에 파일·청크·임베딩 지표, 잡 목록과 로그 패널 나란히 배치, 1024px 이하 1열 반응형.
- 관리 UI 에 `?q=검색어&mode=fts&topN=10` 딥링크. 열면 바로 검색한다.
- 관리 UI 의 모든 서버 문자열을 HTML 이스케이프해 출력.

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

[Unreleased]: https://github.com/HoonStyle/greplet/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/HoonStyle/greplet/compare/3a3e05b...v0.5.0
[0.0.0]: https://github.com/HoonStyle/greplet/commit/3a3e05b
