# greplet

> 로컬 코드·PDF·문서를 한 번에 뒤지는 하이브리드 검색 서버. AI 코딩 에이전트가 grep 대신 쓰도록 만들었다.

greplet 는 여러 리포지토리·폴더·PDF 를 **워크스페이스**로 묶어 인덱싱하고, 자연어나 키워드로 질의하면 관련 **청크**(메서드, PDF 페이지 등)만 점수순으로 돌려주는 로컬 서비스다. 벡터 검색(Ollama `bge-m3`)과 전문 검색(BM25)을 RRF 로 융합하며, LLM 생성이나 외부 네트워크 호출은 없다.

Claude Code 스킬, Claude Desktop MCP 번들, 원격 MCP 서버, PowerShell CLI, git 훅으로 붙여 쓴다. 에이전트가 "이 기능 어디 구현돼 있어?", "사양서에 이 값 어떻게 정의돼 있어?" 같은 질문에 폴더 전체를 읽지 않고 답하게 하는 것이 목적이다.

## 목차

- [왜 필요한가](#왜-필요한가)
- [주요 기능](#주요-기능)
- [구조](#구조)
- [요구 환경](#요구-환경)
- [설치와 실행](#설치와-실행)
- [사용법](#사용법)
- [설정](#설정)
- [클라이언트](#클라이언트)
- [HTTP API](#http-api)
- [에이전트에서의 역할 분담](#에이전트에서의-역할-분담)
- [청킹 규칙](#청킹-규칙)
- [개발과 검증](#개발과-검증)
- [알려진 제약](#알려진-제약)
- [라이선스](#라이선스)

## 왜 필요한가

| 기존 도구의 한계 | greplet 의 접근 |
|---|---|
| IDE·에이전트 내장 검색은 열려 있는 리포 하나만 본다 | 리포 밖 어디든 여러 루트를 워크스페이스로 묶어 인덱싱 |
| 순수 벡터 검색은 상수·에러 코드·메서드명 같은 정확 토큰에 약하다 | 벡터 + BM25 하이브리드. `fts` 단독 모드 제공 |
| 고정 길이 청킹은 메서드 중간에서 끊긴다 | C# 은 Roslyn 으로 타입·멤버 단위, PDF 는 페이지 단위 청킹 |
| 업로드형 RAG 도구는 삭제가 반영되지 않아 stale 청크가 쌓인다 | 파일 해시 매니페스트로 추가·변경·삭제를 전부 증분 반영 |
| 클라우드 검색은 소스를 외부로 보내야 한다 | 완전 로컬. 인덱서는 `127.0.0.1` 에만 바인딩 |

## 주요 기능

- **하이브리드 검색** — `hybrid`(기본) · `vector` · `fts` 세 모드. `fts` 는 Ollama 없이도 동작.
- **구문 단위 청킹** — C# 멤버 단위, PDF 페이지 단위, 그 외 텍스트는 줄 윈도우. 암호 PDF 지원.
- **증분 인덱싱** — 커밋 훅이나 API 호출로 변경분만 재인덱스.
- **다중 워크스페이스** — 코드·레거시·문서를 분리해 두고 개별 또는 통합 검색.
- **관리 UI** — 워크스페이스 상태, 파일 업로드, 재인덱스, 검색 테스트, 실시간 로그.
- **에이전트 연동** — Claude Code 스킬, MCP(stdio·원격), CLI, git 훅.

## 구조

```
[Claude Code skill / Codex / MCP / greplet.ps1 / greplet.mjs / post-commit]
                 │  HTTP (127.0.0.1:7802)
                 ▼
        indexer (Node/TS, Express)
      ┌──────────┼──────────────┐
  Extractor    Ollama         LanceDB
  (C#/Roslyn   bge-m3        벡터 + FTS
   PdfPig)     임베딩         RRF 하이브리드
```

| 폴더 | 역할 |
|---|---|
| `Extractor/` | C# 콘솔. Roslyn·PdfPig 로 파일을 청크 JSONL 로 변환 |
| `indexer/` | Node/TS 서비스. 스캔·임베딩·LanceDB 저장·검색 API·관리 UI |
| `greplet.ps1` | PowerShell CLI 클라이언트(Windows) |
| `greplet.mjs` | Node CLI 클라이언트(모든 OS) |
| `greplet-mcpb/` | Claude Desktop/Cowork 용 로컬 stdio MCP 번들 |
| `mcp-server/` | Bearer 인증 원격 MCP 서버 |
| `git-hooks/` | 커밋 후 증분 인덱스를 트리거하는 post-commit 훅 |
| `examples/claude-code-skill/` | Claude Code 스킬 예제 |
| `examples/codex/` | OpenAI Codex MCP 등록·스킬 예제 |
| `docs/design.md` | 상세 설계 문서 |

## 요구 환경

| 항목 | 값 |
|---|---|
| Node | 22+ |
| .NET SDK | 8.0+ |
| PowerShell | 7+ (Windows 의 greplet.ps1 용. 다른 OS 는 greplet.mjs 사용) |
| Ollama | `bge-m3` 모델 (`ollama pull bge-m3`) |
| OS | Windows · macOS · Linux (Intel Mac 은 LanceDB 0.22.3 필요, 아래 참고) |

## 설치와 실행

Windows (PowerShell):

```powershell
# 1. Extractor 빌드
dotnet build Extractor -c Release

# 2. 인덱서 빌드
cd indexer
npm install
npm run build

# 3. 워크스페이스 정의
cp workspaces.example.json workspaces.json     # roots 를 실제 경로로 수정

# 4. 기동 (백그라운드, healthz 확인)
pwsh start-indexer.ps1
```

macOS / Linux (bash):

```bash
# 0. (macOS) .NET 8 SDK 가 없다면. dotnet@8 은 keg-only 라 PATH 에 안 들어간다
brew install dotnet@8
export DOTNET_ROOT=/usr/local/opt/dotnet@8/libexec     # Apple Silicon 은 /opt/homebrew/opt/dotnet@8/libexec
export PATH="$DOTNET_ROOT:$PATH"                        # (start-indexer.sh 는 이 keg 를 자동 감지한다)

# 1. Extractor 빌드
dotnet build Extractor -c Release

# 2. 인덱서 빌드
cd indexer
npm install
npm run build

# 2-1. Intel Mac 은 @lancedb/lancedb 0.23+ 에 darwin-x64 바이너리가 없다. 아래 1회 필요(Apple Silicon 은 불필요)
npm i @lancedb/lancedb@0.22.3

# 3. 워크스페이스 정의
cd ..
cp indexer/workspaces.example.json indexer/workspaces.json   # roots 를 실제 경로로 수정

# 4. 기동 (백그라운드, healthz 확인)
bash indexer/start-indexer.sh
```

기동 후 `http://localhost:7802` 관리 UI 에서 **[전체 재인덱스]** 를 누르면 첫 인덱싱이 시작된다.

데이터(LanceDB·매니페스트·업로드·로그) 저장 위치(`GREPLET_DATA_DIR` 기본값)는 OS 별로 다르다.

| OS | 기본 경로 |
|---|---|
| Windows | `%LOCALAPPDATA%\greplet` |
| macOS | `~/Library/Application Support/greplet` |
| Linux | `$XDG_DATA_HOME/greplet` (기본 `~/.local/share/greplet`) |

로그온/부팅 시 자동 기동은 OS 별로 등록 방식이 다르다: Windows 는 작업 스케줄러에 `pwsh -File <경로>\indexer\start-indexer.ps1`, macOS 는 launchd, Linux 는 systemd user service 로 `node indexer/dist/server.js` 를 등록한다.

## 사용법

```powershell
# 기본 워크스페이스에서 의미 검색
pwsh greplet.ps1 -Query "재시도 백오프 로직"

# 정확 토큰 검색 (상수·에러 코드·메서드명)
pwsh greplet.ps1 -Query "0x0A03" -Mode fts

# 특정 워크스페이스, 결과 수 지정
pwsh greplet.ps1 -Query "설정 파일 스키마" -Workspace docs -TopN 8

# 모든 워크스페이스 통합 검색, 청크 전문 출력
pwsh greplet.ps1 -Query "에러 코드" -All -Full
```

macOS / Linux (또는 Windows 에서도 동작하는 Node CLI):

```bash
# 기본 워크스페이스에서 의미 검색
node greplet.mjs "재시도 백오프 로직"

# 정확 토큰 검색 (상수·에러 코드·메서드명)
node greplet.mjs "0x0A03" --mode fts

# 특정 워크스페이스, 결과 수 지정
node greplet.mjs "설정 파일 스키마" -w docs --top-n 8

# 모든 워크스페이스 통합 검색, 청크 전문 출력
node greplet.mjs "에러 코드" --all --full
```

출력 예:

```
[code] "재시도 백오프 로직" -> 총 6건 (점수순)
======================================================================
#1  score 0.0328  |  Lib/Retry/RetryPolicy.cs :: RetryPolicy.Execute (L120-161)
// Lib/Retry/RetryPolicy.cs // namespace My.Lib.Retry // class RetryPolicy : IRetryPolicy public bool Execute(...
----------------------------------------------------------------------
```

### 검색 모드

| mode | 동작 | 용도 |
|---|---|---|
| `hybrid` (기본) | 벡터 + FTS → RRF 융합 | 대부분의 내용 검색 |
| `vector` | 의미 검색만 | 표현이 다른 유사 코드 찾기 |
| `fts` | BM25 만, 임베딩 호출 없음 | 정확 토큰. Ollama 없이도 동작 |

## 설정

### 워크스페이스 (`indexer/workspaces.json`)

워크스페이스 목록의 단일 소스다. 모든 클라이언트는 이 파일 또는 서버 `GET /api/workspaces` 에서 목록을 읽는다.

```json
[
  { "slug": "code", "label": "메인 솔루션", "kind": "code",
    "roots": ["C:\\work\\my-solution"] },
  { "slug": "docs", "label": "사양서·매뉴얼", "kind": "docs",
    "roots": ["C:\\work\\specs"],
    "includeExt": [".pdf", ".html", ".md"],
    "pdfPasswordFile": "C:\\work\\specs\\passwords.txt" }
]
```

`roots` 는 macOS/Linux 경로(`/Users/me/work/my-solution`)도 그대로 쓸 수 있다. Windows 경로를 JSON 문자열에 넣을 때는 백슬래시를 `\\` 로 이스케이프해야 한다(위 예시 참고).

| 필드 | 설명 |
|---|---|
| `slug` | 검색·API 에서 쓰는 식별자 |
| `label` | 관리 UI 표시 이름 |
| `kind` | `code` 또는 `docs`. 기본 확장자·제외 규칙이 달라진다 |
| `roots` | 인덱스할 루트 폴더 목록 |
| `includeExt` | 대상 확장자. `code` 기본 `.cs .csproj .sln .xaml .proto .config .settings .manifest .md`, `docs` 기본 `.pdf` |
| `excludeDirs` / `excludeFiles` | 명시하면 기본값을 대체한다 |
| `pdfPasswordFile` | 암호 PDF 용 비밀번호 목록 파일 |

자세한 규칙은 [docs/design.md §3](docs/design.md).

### 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `GREPLET_PORT` | `7802` | 인덱서 포트 |
| `GREPLET_DATA_DIR` | OS 별 기본값(위 표 참고) | DB·매니페스트·업로드·로그 저장 위치 |
| `GREPLET_WORKSPACES` | `indexer/workspaces.json` | 워크스페이스 정의 파일. 인덱서뿐 아니라 `greplet.ps1`·`greplet.mjs` 도 기본 워크스페이스를 이 파일에서 읽으므로, 서버에 다른 경로를 줬다면 CLI 에도 같은 값을 넘긴다 |
| `GREPLET_EXTRACTOR` | `Extractor/bin/Release/net8.0/Extractor.exe`(Windows) / `Extractor/bin/Release/net8.0/Extractor`(macOS·Linux) | Extractor 실행 파일 |
| `GREPLET_DEFAULT_WORKSPACE` | 첫 워크스페이스 | 워크스페이스 미지정 시 기본값 (CLI·MCP) |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama 주소 |

## 클라이언트

| 클라이언트 | 위치 | 비고 |
|---|---|---|
| PowerShell CLI | `greplet.ps1` | `-Query -Workspace -All -TopN -Full -Mode -BaseUrl`. Windows 전용 |
| Node CLI | `greplet.mjs` | 모든 OS. `<query> -q -w --all --top-n --full --mode --base-url` |
| Claude Code 스킬 | `examples/claude-code-skill/SKILL.md` | `.claude/skills/greplet/` 에 복사하고 워크스페이스 목록만 채운다 |
| Claude Desktop / Cowork | `greplet-mcpb/` | `npm run pack` → `.mcpb` 설치. stdio, 인증 없음 |
| 원격 MCP | `mcp-server/` | Streamable HTTP + Bearer, `127.0.0.1:7801`. 외부 노출은 터널 경유. [README](mcp-server/README.md) |
| Codex | `examples/codex/` | MCP(stdio) + 스킬. `config.toml` 등록과 `skills/greplet/SKILL.md` 예제 |
| git 훅 | `git-hooks/post-commit` | `git config greplet.slug <slug>` 후 `.git/hooks/` 에 복사 |

MCP 툴은 `greplet`(검색)와 `greplet_workspaces`(목록) 두 개다.

## HTTP API

인덱서는 `127.0.0.1:7802` 에 무인증으로 뜬다. 외부에 열려면 `mcp-server` 를 앞에 둔다.

| 메서드·경로 | 용도 |
|---|---|
| `GET /healthz` | 가동 확인 |
| `GET /api/status` | Ollama·Extractor·큐 상태 |
| `GET /api/workspaces` | 워크스페이스 목록과 인덱스 통계 |
| `POST /api/search` | `{ query, workspaces: string[] \| "all", topN, mode }` |
| `POST /api/index/:slug` | 증분 인덱스 잡 등록. `{ force: true }` 로 전체 재인덱스 |
| `GET /api/jobs` · `GET /api/jobs/:id/events` | 잡 목록, SSE 로그 스트림 |
| `POST /api/upload/:slug` | 파일 업로드 후 증분 인덱스 |
| `DELETE /api/workspaces/:slug/files?file=` | 업로드 파일 삭제 |

전체 요청·응답 형식은 [docs/design.md §5.5](docs/design.md).

## 에이전트에서의 역할 분담

greplet 는 "어디에 무슨 내용이 있나"를 찾는 도구다. 다른 도구와 이렇게 나눠 쓴다.

| 질문 | 도구 | 이유 |
|---|---|---|
| 이 기능이 어디 구현돼 있나, 문서에 어떻게 정의돼 있나 | **greplet** | 폴더째 grep/read 보다 빠르고 토큰을 훨씬 덜 쓴다 |
| 이 메서드를 누가 호출하나, 상속·참조 체인 | **LSP 심볼 도구** | greplet 는 청크 텍스트만 알고 참조 관계는 모른다 |
| 파일명·경로 찾기, 방금 편집한 파일 확인 | **Glob / Grep / Read** | 인덱스가 아직 안 따라왔을 수 있다 |
| 정확 문자열의 완전한 출현 목록 | **Grep** | 하이브리드는 topN 만 돌려준다. `fts` 로 후보를 좁힌 뒤 Grep 으로 확인 |

에이전트 규칙 파일(CLAUDE.md 등)에 넣어 둘 원칙: 내용 검색은 greplet 먼저, 구조는 LSP, 경로는 Glob/Grep. greplet 결과가 비거나 서버가 꺼져 있을 때만 폴더 스캔으로 폴백.

## 청킹 규칙

- **C#**: 타입 선언·멤버(메서드/생성자/속성/이벤트/연산자)·필드 묶음을 각각 청크로. 모든 청크 앞에 `// file` `// namespace` `// class X : Base` 헤더 3줄. 6000자 초과 멤버는 4000/400 윈도우, 300자 미만 연속 멤버는 1200자까지 병합.
- **PDF**: 페이지 = 청크. 암호 PDF 지원. 스캔 이미지 페이지는 스킵.
- **HTML/Markdown/XAML/기타**: 3000/300 줄 윈도우. HTML 은 script·style 제거 후 평문화.
- **인코딩**: UTF-8 → CP949 폴백.

전체 사양은 [docs/design.md](docs/design.md).

## 개발과 검증

```powershell
dotnet build Extractor -c Release
cd indexer && npm run build && npm run test:incremental
cd ../mcp-server && npm run build && npm run smoke        # $env:MCP_AUTH_TOKEN 필요
cd ../greplet-mcpb && npm install && npm run smoke
```

macOS / Linux 동치:

```bash
dotnet build Extractor -c Release
cd indexer && npm run build && npm run test:incremental
cd ../mcp-server && npm run build && MCP_AUTH_TOKEN=<token> npm run smoke
cd ../greplet-mcpb && npm install && npm run smoke
```

개발 중에는 `indexer/` 와 `mcp-server/` 에서 `npm run dev`(tsx) 로 빌드 없이 실행할 수 있다.

## 알려진 제약

- 청커는 C# 에 특화돼 있다. 다른 언어는 텍스트 윈도우로 들어간다(확장자를 `includeExt` 에 추가).
- 벡터 인덱스를 만들지 않는다(flat 스캔). 워크스페이스당 수십만 청크를 넘기면 검색이 느려진다.
- 인덱서 HTTP API 는 무인증이라 `127.0.0.1` 에만 바인딩한다.
- Intel Mac(darwin-x64)은 `@lancedb/lancedb` 0.23 이상에 darwin-x64 네이티브 바이너리가 없다(0.23.0 은 목록에만 있고 실제 패키지가 배포되지 않음). `cd indexer && npm i @lancedb/lancedb@0.22.3` 을 `npm install` 뒤에 한 번 더 실행해야 한다(Apple Silicon 은 해당 없음).
- macOS 에서는 `fts` 모드만 검증됨(`hybrid`/`vector` 는 Ollama 필요).

## 라이선스

[MIT](LICENSE)
