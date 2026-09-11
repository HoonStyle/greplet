# greplet

[English](README.md) · [한국어](README.ko.md)

[![CI](https://github.com/HoonStyle/greplet/actions/workflows/ci.yml/badge.svg)](https://github.com/HoonStyle/greplet/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
![Node 22+](https://img.shields.io/badge/Node-22%2B-339933)
![.NET 8](https://img.shields.io/badge/.NET-8-512BD4)

**코드와 문서를 로컬에서 검색하고, 에이전트가 바로 열 수 있는 근거 위치를 반환합니다.**

greplet은 Ollama `bge-m3` 벡터 검색과 BM25 전문 검색을 결합합니다. 하나 또는 여러 워크스페이스에서 소스 청크를 찾아 파일 경로·심볼·줄 또는 페이지 위치를 반환합니다. 내용을 검색하며 답변을 생성하지 않습니다.

- **코드와 문서를 함께 검색:** C#은 Roslyn으로 타입·멤버 단위, PDF는 PdfPig로 페이지 단위, 그 외 지원 형식은 텍스트 단위로 나눕니다.
- **변경을 반영하는 인덱스:** 인덱싱할 때 파일 해시로 추가·수정·삭제를 반영합니다. UI·CLI·API 또는 설치한 커밋 훅으로 실행합니다.
- **여러 사용 방식:** 관리 UI, Node·PowerShell CLI, 로컬·원격 MCP, Claude Code·Codex 플러그인을 제공합니다.

기본 인덱서와 임베딩 구성은 로컬에서 실행됩니다. 의존성·모델 설치와 선택적 원격 연동에는 네트워크가 필요합니다. 정확한 파일 경로나 문자열의 모든 출현 위치는 파일 시스템 검색으로 확인할 수 있습니다.

**시작하기:** [설치와 실행](#설치와-실행) · [검색 사용법](#사용법) · [에이전트 연결](#클라이언트) · [튜닝 히스토리](#튜닝-히스토리)

<p align="center"><img src="docs/images/dashboard.png" alt="워크스페이스 상태·검색 테스트·실시간 활동을 보여 주는 greplet 관리 UI" width="900"></p>

## 설치와 실행

### 1. 실행 환경 준비

| 요구 환경 | 필요한 경우 |
|---|---|
| Node.js 22+와 npm | 인덱서와 Node·MCP 클라이언트 |
| .NET 8 SDK와 런타임 | 소스에서 Extractor를 빌드하고 실행할 때 |
| Ollama와 `bge-m3` | 벡터·하이브리드 검색. BM25만 사용하면 선택 사항 |
| PowerShell 7+ | Windows 기동 스크립트와 PowerShell CLI |
| Bash와 curl | macOS·Linux 기동 스크립트 |

임베딩을 사용하려면 Ollama를 실행하고 모델을 받습니다.

```sh
ollama pull bge-m3
```

Ollama가 없어도 임베딩 없이 인덱싱할 수 있으며 검색은 `fts`로 전환됩니다. Ollama와 모델이 준비되면 인덱싱을 다시 실행해 벡터를 채웁니다.

<details>
<summary>macOS 환경 설정과 Intel Mac 호환 설치</summary>

Homebrew의 `dotnet@8`을 사용한다면 빌드 전에 런타임 경로를 설정합니다.

```sh
brew install dotnet@8
export DOTNET_ROOT="$(brew --prefix dotnet@8)/libexec"
export PATH="$DOTNET_ROOT:$PATH"
```

Intel Mac은 LanceDB 호환 설치가 필요합니다. 아래 빌드 단계의 `npm --prefix indexer ci`를 다음 명령으로 대체합니다.

```sh
npm --prefix indexer install @lancedb/lancedb@0.22.3
```

이 명령은 로컬 의존성 버전을 변경합니다. Apple Silicon·Windows·Linux는 기본 잠금 파일로 설치합니다. 기동 스크립트도 일반적인 Homebrew .NET 8 경로를 자동으로 감지합니다.

</details>

### 2. 저장소 복제와 빌드

복제 후 저장소 루트에서 실행합니다. 이후 예제도 이 디렉터리를 기준으로 합니다.

```sh
git clone https://github.com/HoonStyle/greplet.git
cd greplet
dotnet build Extractor -c Release
npm --prefix indexer ci
npm --prefix indexer run build
```

[Releases](https://github.com/HoonStyle/greplet/releases)의 self-contained Extractor를 사용한다면 OS에 맞는 파일의 압축을 풀고 `GREPLET_EXTRACTOR`를 실행 파일 경로로 설정합니다. 이 경우 .NET SDK·런타임 설치와 `dotnet build` 명령을 생략할 수 있습니다. 인덱서의 Node 설치와 빌드 단계는 필요합니다.

### 3. 워크스페이스 선택

처음 설치할 때 예제 설정을 복사합니다.

```sh
cp indexer/workspaces.example.json indexer/workspaces.json
```

**기동 전에** `indexer/workspaces.json`을 편집합니다. 예제 루트를 실제 로컬 경로로 바꾸고, 사용하지 않는 워크스페이스는 제거하며, 선택 항목인 PDF 비밀번호 파일 경로도 수정하거나 제거합니다. 업그레이드할 때는 기존 설정을 유지합니다. 최소 예제는 [설정](#설정)을 참고하세요.

### 4. 기동과 첫 인덱싱

Windows:

```powershell
pwsh -File indexer/start-indexer.ps1
```

macOS·Linux:

```sh
bash indexer/start-indexer.sh
```

스크립트가 인덱서를 백그라운드로 기동하고 상태를 확인한 뒤 [관리 UI](http://localhost:7802)를 엽니다. 대상 워크스페이스의 **전체 재인덱스**를 눌러 첫 인덱스를 만든 다음 검색창이나 CLI를 사용합니다.

브라우저를 열지 않으려면 `-NoOpenUI`(PowerShell), `--no-open`(Bash), 또는 `GREPLET_OPEN_UI=0`을 사용합니다. 기동 로그는 `indexer/logs/server.log`와 `server.log.err`에 있습니다. 세션 시작 시 자동 기동하려면 [Claude Code 훅 예제](examples/claude-code-skill/hooks.settings.json)를 참고하세요.

## 사용법

저장소 루트에서 실행하며, `code`와 `docs`는 설정한 워크스페이스 slug로 바꿉니다.

```sh
node greplet.mjs "재시도 백오프 로직" -w code
node greplet.mjs "0x0A03" --mode fts
node greplet.mjs "설정 파일 스키마" -w docs --top-n 8
node greplet.mjs "에러 처리" --all --full
node greplet.mjs "재시도" --file "Lib/**/*.cs" --json

node greplet.mjs status
node greplet.mjs workspaces
node greplet.mjs index code --wait
node greplet.mjs index docs --force
```

`--full`은 청크 전문, `--json`은 서버 응답 그대로, `--file`은 상대경로 글롭 필터입니다. `-w`나 `--all`을 생략하면 CLI는 `GREPLET_DEFAULT_WORKSPACE` 또는 설정의 첫 워크스페이스를 사용합니다. 전체 옵션은 `node greplet.mjs --help`로 확인합니다. 일반 CLI 출력 문구는 한국어입니다.

Windows에서는 PowerShell CLI로도 일반 검색을 실행할 수 있습니다.

```powershell
pwsh -File greplet.ps1 -Query "재시도 백오프 로직" -Workspace code
pwsh -File greplet.ps1 -Query "0x0A03" -Mode fts -All
```

### 검색 모드

| 모드 | 동작 | 주요 용도 |
|---|---|---|
| `hybrid` (기본) | 정확한 `Type.Member`는 정의 조회, 그 외는 벡터 + BM25 융합 | 정의와 내용 검색 |
| `vector` | 임베딩 유사도 검색 | 자연어 설명과 표현이 다른 내용 |
| `fts` | BM25, 임베딩 호출 없음 | 상수·에러 코드·정확한 용어 |

hybrid에서 입력 전체가 대소문자를 구분하는 `Type.Member`이면 임베딩 호출 없이 정의를 조회합니다. 해당 워크스페이스에서 정의를 찾지 못하면 일반 하이브리드 검색으로 이어집니다. 사용처를 찾을 때는 설명이 포함된 질의를 사용합니다.

단일 워크스페이스는 벡터 상위 3개를 먼저 배치하고, 나머지를 벡터:FTS **4:1 가중 RRF(k=60)** 순서로 채웁니다. 여러 워크스페이스는 전체에 가중 RRF를 사용합니다. 융합 점수는 순서를 뜻하며 신뢰도나 워크스페이스 간 공통 확률이 아닙니다. [측정 결과와 적용 범위](docs/tuning/2026-09-11-vector-prefix.md).

일반 검색은 캐시 가능한 응답을 10분간 저장하고 인덱스 변경 시 무효화합니다. 캐시 응답은 `cached: true`로 표시하며, 경고가 있는 응답은 캐시하지 않습니다. 임베딩·검색 실패로 다른 모드로 전환되면 `warnings`에 알립니다.

### 근거 조회

버전이 포함된 참조와 정확한 인덱스 청크가 필요하면 선택 기능인 근거 조회를 사용합니다.

```sh
node greplet.mjs evidence-search "재시도 백오프 로직" --all
node greplet.mjs evidence-get --ref-file evidence-ref.json
```

`evidence-ref.json`에는 검색 hit의 `evidenceRef` 객체만 저장합니다. 근거 검색은 인덱스 기준의 워크스페이스별 결과(`unchecked`)를 반환합니다. 상세 조회는 현재 원본 파일 해시를 확인한 뒤 저장된 청크(`verified`)를 반환합니다. 이는 조회 시점의 최신성 확인이며 의미적 정확성 검증은 아닙니다. 오래되거나 삭제된 원본, 인덱싱 중인 대상, 모호한 출처는 다른 근거로 대체하지 않고 상태로 알립니다. [근거 인터페이스](docs/greplet-evidence-v1.md)와 [마이그레이션 파일럿](docs/migration-pilot.md)을 참고하세요. 실제 마이그레이션 파일럿은 별도의 검증 단계입니다.

## 클라이언트

인덱서를 먼저 설정하고 실행합니다. 에이전트 플러그인은 기존 인덱서에 연결하며 Extractor 설치·서비스 기동·인덱스 생성을 수행하지 않습니다.

| 클라이언트 | 설정 방법 |
|---|---|
| Claude Code·Codex 플러그인 | [자체 마켓 설치 안내](docs/plugin-install.md). MCP 연결과 스킬 포함 |
| Codex 수동 MCP 설정 | [설정과 스킬 예제](examples/codex/README.md) |
| Claude Code 수동 스킬 설정 | [스킬](examples/claude-code-skill/SKILL.md)과 [규칙 스니펫](examples/claude-code-skill/CLAUDE.md.snippet) |
| Claude Desktop·Cowork | [Releases](https://github.com/HoonStyle/greplet/releases)의 `.mcpb` 설치 |
| 원격 MCP | [Bearer 인증 HTTP 서버](mcp-server/README.md)를 터널로 연결 |
| Git 훅 | 소스 저장소에서 `git config greplet.slug <slug>` 설정 후 [post-commit](git-hooks/post-commit) 설치 |

마켓은 이 저장소에서 제공하며 공식 중앙 디렉터리 등재와는 별개입니다. 첫 MCP 실행에는 연결 도구의 의존성 설치를 위한 npm 레지스트리 접근이 필요할 수 있습니다. 플러그인과 동일한 수동 MCP 연결을 중복 활성화하지 않습니다.

두 MCP 전송 방식 모두 읽기 전용 도구 4개를 제공합니다.

| 도구 | 용도 |
|---|---|
| `greplet` | 순위가 있는 내용 검색 |
| `greplet_workspaces` | 워크스페이스 목록 |
| `greplet_search_evidence` | 워크스페이스별 발췌와 버전이 포함된 참조 |
| `greplet_get_evidence` | 원본 해시를 확인한 뒤 참조된 청크 조회 |

`readOnlyHint`는 도구 동작의 특성이며 승인 정책은 클라이언트가 결정합니다. 호출자·참조·상속은 [Serena](https://github.com/oraios/serena) 같은 LSP 도구, 사양 문서화는 [legacy-spec-agent](https://github.com/HoonStyle/legacy-spec-agent)를 활용할 수 있습니다. 에이전트가 결과를 조합하며 greplet이 이 도구들을 자동 호출하지는 않습니다.

## 설정

워크스페이스는 `indexer/workspaces.json` 또는 `GREPLET_WORKSPACES`로 지정한 파일에서 정의합니다. 아래 경로는 예시이며 인덱서가 실행되는 머신의 경로를 사용합니다.

```json
[
  { "slug": "code", "label": "메인 솔루션", "kind": "code",
    "roots": ["C:/work/my-solution"] },
  { "slug": "docs", "label": "사양서", "kind": "docs",
    "roots": ["C:/work/specs"], "includeExt": [".pdf", ".html", ".md"] }
]
```

Linux·macOS는 `/home/me/work/...` 또는 `/Users/me/work/...`를 사용합니다. Windows JSON 경로는 위처럼 슬래시를 쓰거나 백슬래시를 이스케이프(`\\`)합니다. 출처 구분이 중요한 코드 버전·제품은 워크스페이스를 분리합니다.

| 필드 | 의미 |
|---|---|
| `slug` / `label` | API 식별자 / 표시 이름 |
| `kind` | `code` 또는 `docs`. 기본 확장자와 제외 규칙 선택 |
| `roots` | 인덱싱할 폴더 |
| `includeExt` | 포함할 확장자. `code`는 C# 프로젝트·텍스트 형식, `docs`는 `.pdf`가 기본값 |
| `excludeDirs` / `excludeFiles` | 기본 폴더·파일 제외 규칙을 대체 |
| `pdfPasswordFile` | 암호 PDF용 비밀번호 목록 파일. 선택 항목 |

### 이름으로 인덱싱 제외

파일·폴더 이름 앞에 `!`를 붙입니다. `!draft.pdf`는 파일 하나, `!reference/`는 하위 트리 전체를 제외하며 업로드와 제외 폴더 내부의 명시적 루트에도 적용됩니다. 이름 중간의 `!`나 맨 앞의 `#`는 특별한 의미가 없습니다. 이름을 바꾼 뒤 인덱싱을 실행하면 다음 성공한 실행에서 기존 청크를 제거합니다. 접두사를 없애고 다시 인덱싱하면 포함됩니다. 원래 이름을 유지해야 하는 소스에는 제외 설정을 사용합니다.

### 데이터와 환경변수

인덱스 데이터·매니페스트·업로드·활동 로그는 `GREPLET_DATA_DIR`에 저장합니다.

| OS | 기본 데이터 경로 |
|---|---|
| Windows | `%LOCALAPPDATA%\greplet` |
| macOS | `~/Library/Application Support/greplet` |
| Linux | `$XDG_DATA_HOME/greplet`, 또는 `~/.local/share/greplet` |

<details>
<summary>환경변수 참고표</summary>

| 변수 | 기본값 / 용도 |
|---|---|
| `GREPLET_PORT` | `7802`. 인덱서 포트 |
| `GREPLET_BASE_URL` | `http://localhost:7802`. CLI·MCP 연결 대상 |
| `GREPLET_WORKSPACES` | `indexer/workspaces.json`. 인덱서와 로컬 CLI에 일관되게 지정 |
| `GREPLET_DATA_DIR` | 위 OS별 기본 경로 |
| `GREPLET_EXTRACTOR` | `Extractor/bin/Release/net8.0/Extractor` (Windows는 `.exe`) |
| `GREPLET_DEFAULT_WORKSPACE` | CLI·MCP 기본 워크스페이스. 생략하면 설정의 첫 항목 |
| `OLLAMA_URL` | `http://localhost:11434` |
| `OLLAMA_KEEP_ALIVE` | `30m`. 임베딩 요청 뒤 모델 유지 시간 |
| `GREPLET_OPEN_UI` | `1`. `0`이면 기동 시 브라우저를 열지 않음 |
| `GREPLET_CLIENT_NAME` | 활동 기록의 호출자 이름. 형식 `^[a-z0-9:_-]{1,32}$` |
| `GREPLET_SESSION` | 활동 그룹에 사용할 세션 식별자 지정 |
| `GREPLET_ACTIVITY_QUERY` | `hidden`이면 활동 기록의 질의 본문을 숨김 |
| `GREPLET_ACTIVITY_LOG` | `off`이면 활동 로그 영속화 중지 |
| `GREPLET_ACTIVITY_RETENTION_DAYS` | `90`. 활동 로그 보존 일수 |

모델 유지 시간이 길면 메모리를 점유하며 첫 모델 로딩 지연은 여전히 발생할 수 있습니다. 포트를 바꿀 때는 기동 스크립트의 상태 확인 URL과 클라이언트도 해당 인덱서 포트에 맞춥니다.

</details>

## HTTP API

인덱서는 **`127.0.0.1:7802`에 무인증으로 바인딩**합니다. 원격 접근에는 별도의 Bearer 인증 MCP 서버와 터널을 사용합니다.

| 엔드포인트 | 용도 |
|---|---|
| `GET /healthz` · `GET /api/status` | 가동과 구성 요소 상태 |
| `GET /api/workspaces` | 워크스페이스·인덱스 통계와 `complete`·`partial`·`unknown` 커버리지 |
| `POST /api/search` | `{ query, workspaces: string[] \| "all", topN, mode, fileGlob? }` |
| `POST /api/evidence/search` · `POST /api/evidence/get` | 근거 검색과 참조 조회 |
| `POST /api/index/:slug` | 증분 인덱싱. `{ force: true }`이면 전체 실행 |
| `GET /api/jobs` · `GET /api/jobs/:id/events` | 잡과 SSE 로그 |
| `GET /api/events` · `GET /api/activity` · `GET /api/usage` | 실시간 활동·최근 검색·사용량 요약 |
| `POST /api/upload/:slug` | 파일 업로드와 인덱싱 |
| `DELETE /api/workspaces/:slug/files?file=` | 업로드 파일 삭제 |

검색 hit에는 절대경로인 `abs`가 포함됩니다. `fileGlob`은 파일 상대경로의 `*`·`**`·`?` 패턴을 사용합니다. 세부 내용은 [설계 문서](docs/design.md)와 [근거 인터페이스](docs/greplet-evidence-v1.md)를 참고하세요.

## 튜닝 히스토리

[튜닝 히스토리](docs/tuning/README.md)에 실험별 문제·구현·고정 비교 조건·전후 결과·채택 결정을 기록합니다. 벤치마크의 함수·프로젝트·질문은 익명 식별자를 사용합니다.

| 상태 | 기록 |
|---|---|
| 운영 적용 | 요청 내 임베딩 공유, 모델 유지 30분, 정확한 정의 조회, 범위에 따른 하이브리드 융합: [0.11.2 변경 내역](CHANGELOG.md#0112---2026-09-11) |
| 기록된 조건에서 검증 | [T10 융합 비교](docs/tuning/2026-09-11-vector-prefix.md), [T11 실사용·동시 요청 검사](docs/tuning/2026-09-11-release-validation.md) |
| 채택 보류 | [T12 워크스페이스 자동 선택](docs/tuning/2026-09-11-workspace-routing.md). 오프라인 후보가 채택 기준 미달 |
| 후속 연구 검토 | [ReSLLM·MKP-QA·RAGRoute 비교](docs/tuning/2026-09-11-workspace-routing-research.md). 논문 결과이며 Greplet 측정값과 구분 |

워크스페이스 자동 선택은 운영 검색 API에 포함되지 않습니다. 범위를 직접 지정하거나 전체를 검색합니다. 보고서마다 표본·분모가 다르므로 개선율을 누적 합산하지 않습니다.

## 구조와 개발

```text
UI / CLI / MCP / hooks
        | HTTP, localhost:7802
        v
Node/TypeScript indexer
  +-- Extractor: Roslyn (C#), PdfPig (PDF), text extraction
  +-- Ollama: bge-m3 embeddings
  +-- LanceDB: vectors + BM25, hybrid ranking
```

소스: [Extractor](Extractor/) · [인덱서](indexer/) · [로컬 MCP](greplet-mcpb/) · [원격 MCP](mcp-server/). 자세한 청킹·설정 규칙은 [설계 문서](docs/design.md)에 있습니다.

C#은 타입·멤버 단위로 나누고 큰 멤버를 분할하거나 작은 멤버를 병합합니다. PDF는 페이지 단위, 그 외 지원 텍스트는 윈도우 단위입니다. 인코딩은 UTF-8에서 CP949로 폴백합니다. OCR은 포함하지 않으며 다른 프로그래밍 언어는 C# 심볼 추출 대신 텍스트 청크를 사용합니다. 현재 벡터 검색은 전체 스캔이므로 데이터가 커지면 검색 작업량도 늘어납니다.

설치 후 다음 로컬 검사는 운영 인덱서를 기동하지 않아도 실행할 수 있습니다.

```sh
npm --prefix indexer run build
npm --prefix indexer run test:incremental
npm --prefix indexer run test:hybrid
npm --prefix indexer run test:fusion-protection
npm --prefix indexer run test:workspace-routing
node scripts/report-retrieval-results.mjs --check
node scripts/report-workspace-routing.mjs --check
node scripts/check-plugin.mjs
```

근거 조회·MCP·CLI를 포함한 Windows·macOS·Linux 전체 검증 구성은 [CI](.github/workflows/ci.yml)를 참고하세요. 개발 서버는 각 의존성을 설치한 뒤 `indexer/` 또는 `mcp-server/`에서 `npm run dev`로 실행합니다. 프로토콜 스모크 테스트에 필요한 추가 설정은 해당 구성 요소의 안내를 따릅니다.

## 라이선스

[MIT](LICENSE)
