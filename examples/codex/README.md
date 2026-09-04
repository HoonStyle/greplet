# OpenAI Codex 에서 greplet 사용하기

greplet 은 코드(신규+레거시)와 문서(PDF/매뉴얼)를 Roslyn/PdfPig 로 멤버·페이지 단위 청킹하고 Ollama(bge-m3) 임베딩 + LanceDB 하이브리드(벡터+FTS, RRF) 검색으로 관련 청크만 뽑아주는 로컬 인덱서다(LLM 생성 없음). 이 문서는 OpenAI Codex CLI 에서 greplet 을 MCP 서버로 등록하고, 검색을 우선 활용하도록 skill 을 설치하는 방법을 안내한다.

## 전제조건

1. MCP 서버 의존성 설치:
   ```bash
   cd greplet-mcpb && npm install
   ```
2. 인덱서 기동 (`http://localhost:7802`, 무인증, 로컬 전용):
   ```bash
   # macOS / Linux
   bash indexer/start-indexer.sh

   # Windows
   pwsh indexer/start-indexer.ps1
   ```
   인덱서는 임베딩을 위해 Ollama(`http://localhost:11434`, 모델 `bge-m3`)가 떠 있어야 한다(`--mode fts` 는 Ollama 없이도 동작).

## MCP 서버 등록

`~/.codex/config.toml` 에 아래 블록을 추가한다. `<GREPLET>` 은 greplet 리포를 체크아웃한 절대경로로 바꾼다 (예: macOS/Linux `/Users/me/git/greplet`, Windows `C:\Users\me\git\greplet` — Windows 경로는 TOML 문자열이므로 백슬래시를 `\\` 로 이스케이프하거나 슬래시 `/` 를 사용할 것).

```toml
[mcp_servers.greplet]
command = "node"
args = ["<GREPLET>/greplet-mcpb/server/index.js"]

[mcp_servers.greplet.env]
GREPLET_BASE_URL = "http://localhost:7802"
GREPLET_DEFAULT_WORKSPACE = ""
GREPLET_CLIENT_NAME = "mcp:codex"
```

- `GREPLET_BASE_URL`: 인덱서 주소. 같은 PC 에서 기본값(`http://localhost:7802`)을 그대로 쓰면 된다.
- `GREPLET_DEFAULT_WORKSPACE`: workspace 를 지정하지 않았을 때 검색할 기본 워크스페이스 slug. 비워두면 서버에 정의된 첫 워크스페이스를 쓴다.
- `GREPLET_CLIENT_NAME`: 대시보드 활동 피드에 표시할 호출자 이름.

등록 후 Codex 를 재시작하면 `greplet`, `greplet_workspaces` 두 도구를 사용할 수 있다.

## Skill 설치 (선택, 권장)

Codex 가 파일을 통째로 grep/read 하기 전에 먼저 greplet 을 조회하도록 skill 을 설치한다.

```bash
mkdir -p ~/.codex/skills/greplet
cp examples/codex/skills/greplet/SKILL.md ~/.codex/skills/greplet/SKILL.md
```

복사한 `~/.codex/skills/greplet/SKILL.md` 안의 `<GREPLET>` 을 실제 체크아웃 경로로 치환한다.

```bash
sed -i '' 's#<GREPLET>#/Users/me/git/greplet#g' ~/.codex/skills/greplet/SKILL.md   # macOS
# Linux: sed -i 's#<GREPLET>#/Users/me/git/greplet#g' ~/.codex/skills/greplet/SKILL.md
```

## 참고

- 세션 구분: Codex 의 셸 툴에서 `greplet.mjs`/`greplet.ps1` 을 실행하면 `CODEX_THREAD_ID` 를 자동 감지해 대시보드에 `cli:codex` + 세션으로 기록된다(확인: codex-cli 0.152.1). MCP 서버 경로에는 Codex 가 세션 환경변수를 넘기지 않으므로 세션 필터가 필요하면 `[mcp_servers.greplet.env]` 에 `GREPLET_SESSION` 을 지정한다.
- CLI 스크립트: 리포 루트의 `greplet.mjs` (Node, 크로스플랫폼). 인자: 위치인자 `query`, `--workspace/-w`, `--all`, `--top-n`, `--full`, `--mode hybrid|vector|fts`, `--base-url`.
- 워크스페이스 목록의 단일 소스는 `indexer/workspaces.json`.
- 자세한 사용 패턴은 `examples/codex/skills/greplet/SKILL.md` 참고.
