# greplet

<p align="center">
  <a href="README.md"><img alt="Language: English" src="https://img.shields.io/badge/lang-English-blue"></a>
  <a href="README.ko.md"><img alt="Language: Korean" src="https://img.shields.io/badge/lang-%ED%95%9C%EA%B5%AD%EC%96%B4-blue"></a>
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green">
  <a href="https://github.com/HoonStyle/greplet/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/HoonStyle/greplet/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Node 22+" src="https://img.shields.io/badge/Node-22%2B-339933?logo=nodedotjs&logoColor=white">
  <img alt=".NET 8" src="https://img.shields.io/badge/.NET-8.0-512BD4?logo=dotnet&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white">
  <img alt="C# / Roslyn" src="https://img.shields.io/badge/C%23-Roslyn-239120?logo=csharp&logoColor=white">
  <br>
  <img alt="LanceDB" src="https://img.shields.io/badge/LanceDB-vector%20%2B%20FTS-EF6A3C">
  <img alt="Ollama bge-m3" src="https://img.shields.io/badge/Ollama-bge--m3-000000?logo=ollama&logoColor=white">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-stdio%20%C2%B7%20HTTP-6E56CF">
  <img alt="Claude Code" src="https://img.shields.io/badge/Claude%20Code-skill%20%2B%20MCP-D97757?logo=claude&logoColor=white">
  <img alt="Codex" src="https://img.shields.io/badge/Codex-MCP%20%2B%20skill-000000?logo=openai&logoColor=white">
  <br>
  <img alt="Windows" src="https://img.shields.io/badge/Windows-CI-0078D4?logo=windows&logoColor=white">
  <img alt="macOS" src="https://img.shields.io/badge/macOS-CI%20%C2%B7%20Intel%20%C2%B7%20Apple%20Silicon-000000?logo=apple&logoColor=white">
  <img alt="Linux" src="https://img.shields.io/badge/Linux-CI-FCC624?logo=linux&logoColor=black">
</p>

> A local search server that indexes several legacy codebases, the current code, and spec PDFs at once and answers with **file · symbol · line range**. Built for AI coding agents to use instead of grep.

greplet indexes repositories, folders, and PDFs as **workspaces**. Given a natural-language or keyword query, it returns only the relevant **chunks** (C# members, PDF pages, and so on), ranked by score. Vector search (Ollama `bge-m3`) and full-text search (BM25) are fused with RRF. There is no LLM generation and no outbound network call.

Three things set it apart from a generic RAG setup:

1. **The index follows the code.** A file-hash manifest applies additions, changes, and deletions incrementally. A post-commit hook drives it, so chunks of deleted files do not linger in search results.
2. **It answers with locations.** C# is chunked by type and member with Roslyn; PDFs by page. Results come back as `file :: symbol (Lstart-end)`, so the agent opens only that spot.
3. **It only finds.** No summarizing, interpreting, or verifying. Structure belongs to an LSP tool (Serena), and spec writing with citation checks belongs to legacy-spec-agent. That [division of labor](#division-of-labor-among-agent-tools) is a design assumption. If search is wrong, the next stage catches it.

It plugs in as a Claude Code skill, a Codex MCP server, a Claude Desktop MCP bundle, a remote MCP server, a CLI (PowerShell or Node), and a git hook. The goal is one thing: let an agent answer "where is this feature implemented?" or "how does the spec define this value?" without reading the whole folder.

<p align="center"><img src="docs/images/dashboard.png" alt="greplet admin UI" width="900"><br><sub>Admin UI: workspace status, upload, search test, job logs</sub></p>

## Table of contents

- [Why](#why)
- [Features](#features)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Install and run](#install-and-run)
- [Usage](#usage)
- [Configuration](#configuration)
- [Clients](#clients)
- [HTTP API](#http-api)
- [Division of labor among agent tools](#division-of-labor-among-agent-tools)
- [Chunking rules](#chunking-rules)
- [Development and verification](#development-and-verification)
- [Known limitations](#known-limitations)
- [License](#license)

## Why

| Situation | Limit of existing tools | greplet |
|---|---|---|
| Several legacy codebases, plus current code and spec PDFs kept elsewhere | IDE and agent built-in search sees only the open repo. Serena sees only the active project | Any roots anywhere become workspaces. `--all` compares across codebases in one query |
| Searching by constant, error code, or method name | Pure vector search is weak on exact tokens | Vector + BM25 hybrid. `fts` mode works without Ollama |
| The result must point at a place to open | Fixed-length chunking cuts methods in half and gives no location | Roslyn member-level and PDF page-level chunks. Every hit has file, symbol, and line range |
| The code keeps changing | Upload-style RAG never sees deletions, so stale chunks pile up | Hash manifest applies adds, changes, and deletes incrementally. Hooked into commits |
| Source cannot leave the machine | Cloud search assumes upload | Fully local. The indexer binds to `127.0.0.1` only. External exposure goes through the Bearer-authenticated MCP server |

Conversely, with one repo and a handful of documents there is little reason to use greplet. Built-in search or grep is enough.

## Features

- **Hybrid search** — three modes: `hybrid` (default), `vector`, `fts`.
- **Works without Ollama** — if Ollama is absent, indexing fills zero vectors and search is downgraded to `fts`. Once Ollama appears, the next index job is promoted to a full reindex that fills the vectors.
- **Syntax-aware chunking** — C# by member, PDF by page, other text by line windows. Encrypted PDFs supported.
- **Incremental indexing** — only changed files are reindexed, triggered by the commit hook or the API.
- **Multiple workspaces** — keep code, legacy, and docs separate; search one or all.
- **Admin UI** — workspace status, file upload, reindex, search test, live logs.
- **Agent integration** — Claude Code skill, Codex, MCP (stdio and remote), CLI, git hook.

## Architecture

```
[Claude Code skill / Codex / MCP / greplet.ps1 / greplet.mjs / post-commit]
                 │  HTTP (127.0.0.1:7802)
                 ▼
        indexer (Node/TS, Express)
      ┌──────────┼──────────────┐
  Extractor    Ollama         LanceDB
  (C#/Roslyn   bge-m3        vector + FTS
   PdfPig)     embeddings    RRF hybrid
```

| Folder | Role |
|---|---|
| `Extractor/` | C# console. Turns files into chunk JSONL with Roslyn and PdfPig |
| `indexer/` | Node/TS service. Scan, embed, store in LanceDB, search API, admin UI |
| `greplet.ps1` | PowerShell CLI client (Windows) |
| `greplet.mjs` | Node CLI client (all OSes) |
| `greplet-mcpb/` | Local stdio MCP bundle for Claude Desktop/Cowork. Codex uses this server too |
| `mcp-server/` | Remote MCP server with Bearer auth |
| `git-hooks/` | post-commit hook that triggers an incremental index |
| `examples/claude-code-skill/` | Claude Code skill example, CLAUDE.md rule snippet, SessionStart hook example |
| `examples/codex/` | Codex MCP registration and skill example |
| `docs/design.md` | Detailed design document (Korean) |

## Requirements

| Item | Value |
|---|---|
| Node | 22+ |
| .NET SDK | 8.0+ |
| Ollama | Optional. `bge-m3` model (`ollama pull bge-m3`). Without it, `fts` only |
| PowerShell | 7+. Only for `greplet.ps1` and `start-indexer.ps1` on Windows. Other OSes use `greplet.mjs` and `start-indexer.sh` |
| OS | Windows · macOS · Linux. Intel Macs have a LanceDB version constraint ([Known limitations](#known-limitations)) |

## Install and run

The order is the same on every OS: build the Extractor → build the indexer → define workspaces → start.

To skip the .NET SDK, download a self-contained Extractor for your OS (`greplet-extractor-<version>-<rid>`) from [Releases](https://github.com/HoonStyle/greplet/releases), unpack it, and point `GREPLET_EXTRACTOR` at the binary. Then skip the `dotnet build` step below. The `.mcpb` for Claude Desktop is in the same place. Per-version changes are in [CHANGELOG.md](CHANGELOG.md).

**Windows (PowerShell)**

```powershell
dotnet build Extractor -c Release

cd indexer
npm install
npm run build
cp workspaces.example.json workspaces.json     # set roots to real paths
pwsh start-indexer.ps1                         # background start, waits for healthz
```

**macOS / Linux (bash)**

```bash
# macOS without .NET 8: dotnet@8 is keg-only and not on PATH
brew install dotnet@8
export DOTNET_ROOT=/usr/local/opt/dotnet@8/libexec     # Apple Silicon: /opt/homebrew/opt/dotnet@8/libexec
export PATH="$DOTNET_ROOT:$PATH"                        # start-indexer.sh auto-detects this keg

dotnet build Extractor -c Release

cd indexer
npm install
npm i @lancedb/lancedb@0.22.3                  # Intel Mac only. Not needed on Apple Silicon or Linux
npm run build
cp workspaces.example.json workspaces.json     # set roots to real paths
bash start-indexer.sh                          # background start, waits for healthz
```

Open the admin UI at `http://localhost:7802` and press **[Full reindex]** to run the first indexing. Pass `--open` (bash) or `-OpenUI` (PowerShell) to the start script to open the admin UI in the default browser right after the health check. The environment variable `GREPLET_OPEN_UI=1` does the same.

To start the indexer and open the UI every time a Claude Code session begins, register that command as a SessionStart hook. Example: [`examples/claude-code-skill/hooks.settings.json`](examples/claude-code-skill/hooks.settings.json).

Data (LanceDB, manifests, uploads, logs) lives in `GREPLET_DATA_DIR`. The default depends on the OS.

| OS | Default path |
|---|---|
| Windows | `%LOCALAPPDATA%\greplet` |
| macOS | `~/Library/Application Support/greplet` |
| Linux | `$XDG_DATA_HOME/greplet` (default `~/.local/share/greplet`) |

For start at logon, register `pwsh -File <path>\indexer\start-indexer.ps1` in Task Scheduler on Windows, or `node indexer/dist/server.js` as a launchd agent on macOS or a systemd user service on Linux.

## Usage

**Windows (PowerShell)**

```powershell
pwsh greplet.ps1 -Query "retry backoff logic"                   # semantic search in the default workspace
pwsh greplet.ps1 -Query "0x0A03" -Mode fts                      # exact token (constants, error codes, method names)
pwsh greplet.ps1 -Query "config file schema" -Workspace docs -TopN 8
pwsh greplet.ps1 -Query "error codes" -All -Full                # all workspaces, full chunk text
```

**All OSes (Node)**

```bash
node greplet.mjs "retry backoff logic"
node greplet.mjs "0x0A03" --mode fts
node greplet.mjs "config file schema" -w docs --top-n 8
node greplet.mjs "error codes" --all --full
```

Example output:

```
[code] "retry backoff logic" -> 6 hits (by score)
======================================================================
#1  score 0.0328  |  Lib/Retry/RetryPolicy.cs :: RetryPolicy.Execute (L120-161)
// Lib/Retry/RetryPolicy.cs // namespace My.Lib.Retry // class RetryPolicy : IRetryPolicy public bool Execute(...
----------------------------------------------------------------------
```

The CLI prints its labels in Korean. The layout above is what to expect.

### Search modes

| mode | Behavior | Use for |
|---|---|---|
| `hybrid` (default) | vector + FTS → RRF fusion | Most content searches |
| `vector` | Semantic only | Similar code written differently |
| `fts` | BM25 only, no embedding call | Exact tokens. Works without Ollama |

Requesting `hybrid` or `vector` on a workspace indexed without embeddings makes the server fall back to `fts` and say so in the response `warnings`.

## Configuration

### Workspaces (`indexer/workspaces.json`)

The single source of truth for the workspace list. Every client reads it from this file or from the server's `GET /api/workspaces`.

```json
[
  { "slug": "code", "label": "Main solution", "kind": "code",
    "roots": ["C:\\work\\my-solution"] },
  { "slug": "docs", "label": "Specs and manuals", "kind": "docs",
    "roots": ["/Users/me/work/specs"],
    "includeExt": [".pdf", ".html", ".md"],
    "pdfPasswordFile": "/Users/me/work/specs/passwords.txt" }
]
```

`roots` accepts paths from any OS. Windows paths inside JSON strings need backslashes escaped as `\\`.

| Field | Description |
|---|---|
| `slug` | Identifier used by search and the API |
| `label` | Display name in the admin UI |
| `kind` | `code` or `docs`. Changes the default extensions and exclusion rules |
| `roots` | Root folders to index |
| `includeExt` | Target extensions. `code` default: `.cs .csproj .sln .xaml .proto .config .settings .manifest .md`; `docs` default: `.pdf` |
| `excludeDirs` / `excludeFiles` | Replace the defaults when given |
| `pdfPasswordFile` | Password list for encrypted PDFs |

Full rules in [docs/design.md §3](docs/design.md) (Korean).

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `GREPLET_PORT` | `7802` | Indexer port |
| `GREPLET_DATA_DIR` | Per-OS default (table above) | Location of DB, manifests, uploads, logs |
| `GREPLET_WORKSPACES` | `indexer/workspaces.json` | Workspace definition file. The CLIs (`greplet.ps1`, `greplet.mjs`) also read the default workspace from here, so pass the same value to the CLI if you gave the server a different path |
| `GREPLET_EXTRACTOR` | `Extractor/bin/Release/net8.0/Extractor.exe` (Windows) / `…/Extractor` (macOS, Linux) | Extractor executable |
| `GREPLET_DEFAULT_WORKSPACE` | First workspace | Default when no workspace is given (CLI, MCP) |
| `GREPLET_OPEN_UI` | unset | `1` makes the start scripts open the admin UI in the browser after the health check (same as `--open` / `-OpenUI`) |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama address |

## Clients

| Client | Location | Notes |
|---|---|---|
| PowerShell CLI | `greplet.ps1` | `-Query -Workspace -All -TopN -Full -Mode -BaseUrl`. Windows |
| Node CLI | `greplet.mjs` | `<query> -w --all --top-n --full --mode --base-url`. All OSes |
| Claude Code skill | `examples/claude-code-skill/SKILL.md` | Copy into `.claude/skills/greplet/` and fill in the workspace list |
| Claude Desktop / Cowork | `greplet-mcpb/` | `npm run pack` → install the `.mcpb`. stdio, no auth |
| Codex | `examples/codex/` | Register `greplet-mcpb/server/index.js` as a stdio MCP server in `config.toml`. Skill example included |
| Remote MCP | `mcp-server/` | Streamable HTTP + Bearer, `127.0.0.1:7801`. Expose only through a tunnel. [README](mcp-server/README.md) (Korean) |
| git hook | `git-hooks/post-commit` | `git config greplet.slug <slug>`, then copy into `.git/hooks/` |

The MCP tools are `greplet` (search) and `greplet_workspaces` (list). Both carry `readOnlyHint`, so clients call them without an approval prompt.

## HTTP API

The indexer listens on `127.0.0.1:7802` without authentication. Put `mcp-server` in front of it to expose it externally.

| Method · path | Purpose |
|---|---|
| `GET /healthz` | Liveness |
| `GET /api/status` | Ollama, Extractor, and queue status |
| `GET /api/workspaces` | Workspace list with index statistics |
| `POST /api/search` | `{ query, workspaces: string[] \| "all", topN, mode }` |
| `POST /api/index/:slug` | Enqueue an incremental index job. `{ force: true }` for a full reindex |
| `GET /api/jobs` · `GET /api/jobs/:id/events` | Job list, SSE log stream |
| `POST /api/upload/:slug` | Upload files, then incremental index |
| `DELETE /api/workspaces/:slug/files?file=` | Delete an uploaded file |

Full request and response formats in [docs/design.md §5.5](docs/design.md) (Korean).

## Division of labor among agent tools

greplet answers "where is what". Everything else goes to other tools.

| Question | Tool | Why |
|---|---|---|
| Where is this feature implemented, how does the doc define it | **greplet** | Faster and far cheaper in tokens than grep/read over whole folders |
| Who calls this method, inheritance and reference chains | **LSP symbol tool** ([Serena](https://github.com/oraios/serena) etc.) | greplet only knows chunk text, not references |
| Write a citation-backed spec for undocumented legacy code | **[legacy-spec-agent](https://github.com/HoonStyle/legacy-spec-agent)** | greplet does not interpret, summarize, or verify |
| Find a file by name or path, check a file just edited | **Glob / Grep / Read** | The index may not have caught up yet |
| Every occurrence of an exact string | **Grep** | Hybrid returns only topN. Narrow with `fts`, then confirm with Grep |

Rule for the agent's rules file (CLAUDE.md etc.): content search goes to greplet first, structure to LSP, paths to Glob/Grep. Fall back to folder scanning only when greplet returns nothing or the server is down. Example: [`examples/claude-code-skill/CLAUDE.md.snippet`](examples/claude-code-skill/CLAUDE.md.snippet) (Korean).

### greplet + Serena + legacy-spec-agent

The combination for environments with several legacy codebases, a current project, and spec PDFs. The three tools never call each other. The agent combines their results.

| Tool | Setup | Owns |
|---|---|---|
| greplet | Separate workspaces for each legacy codebase, the current project, and docs (`code`, `code-legacy`, `docs`) | Content search. "Where is this value defined", "how does the spec describe this protocol" |
| Serena | Register every legacy codebase and the current project as Serena projects. Do not pin one. Switch with `activate_project` to whichever the request points at | Structure. References, call chains, inheritance, symbol-level read and edit |
| legacy-spec-agent | Install the Claude Code / Codex plugin | Reverse-generate SPEC/ARCHITECTURE with `path:line` citations, then drift-check after code changes |

If Serena is started with `--project`, the `activate_project` tool is disabled in the `claude-code` and `ide` contexts. Start it without a project to switch freely ([Serena docs](https://oraios.github.io/serena/02-usage/040_workflow.html)).

A typical flow for "port a legacy feature into the current project":

1. **greplet** `-Workspace code-legacy` finds the files and locations holding the feature, constants, and error codes. Use `-Mode fts` for exact tokens.
2. **Serena** follows references and call chains from those symbols to fix the real scope.
3. **legacy-spec-agent** writes the spec for that scope. Claims without a citation stay Unverified.
4. **greplet** `-Workspace docs` cross-checks the definition in the spec PDFs.
5. **greplet** `-Workspace code` and **Serena** locate the counterpart in the current project and apply the change.
6. The commit hook runs an incremental greplet index, so the next search reflects the new code.

When roles overlap:

- Unknown file location → greplet. Known symbol name → Serena.
- How the same feature differs across legacy codebases → greplet `--all`. Serena sees one active project at a time, so it needs a switch per codebase.
- The result must become a document → legacy-spec-agent. greplet output locates evidence; it is not a deliverable.

## Chunking rules

- **C#**: type declarations, members (method/constructor/property/event/operator), and field groups each become a chunk. Every chunk starts with three header lines: `// file`, `// namespace`, `// class X : Base`. Members over 6000 chars use a 4000/400 window; consecutive members under 300 chars are merged up to 1200 chars.
- **PDF**: one page = one chunk. Encrypted PDFs supported. Scanned image pages are skipped.
- **HTML/Markdown/XAML/other**: 3000/300 line windows. HTML is flattened after removing script and style.
- **Encoding**: UTF-8, falling back to CP949.

Full specification in [docs/design.md](docs/design.md) (Korean).

## Development and verification

```bash
dotnet build Extractor -c Release
cd indexer && npm run build && npm run test:incremental
cd ../mcp-server && npm run build && MCP_AUTH_TOKEN=<token> npm run smoke
cd ../greplet-mcpb && npm install && npm run smoke
```

In PowerShell, set `$env:MCP_AUTH_TOKEN = "<token>"` first instead of the inline `MCP_AUTH_TOKEN=<token>`. During development, `npm run dev` (tsx) in `indexer/` and `mcp-server/` runs without a build.

## Known limitations

- The chunker is specialized for C#. Other languages fall into text windows (add the extension to `includeExt`).
- No vector index is built (flat scan). Beyond a few hundred thousand chunks per workspace, search slows down.
- The indexer HTTP API has no authentication, so it binds to `127.0.0.1` only.
- The last `@lancedb/lancedb` native binary for Intel Macs (darwin-x64) is 0.22.3 (0.23.0 lists it as a dependency but the package was never published). Run `npm i @lancedb/lancedb@0.22.3` after `npm install`. Not needed on Apple Silicon, Linux, or Windows.
- A workspace indexed without Ollama has empty vectors, so only `fts` is meaningful. Once Ollama is available, the next index job is automatically promoted to a full reindex.

## License

[MIT](LICENSE)
