# greplet

[English](README.md) · [한국어](README.ko.md)

[![CI](https://github.com/HoonStyle/greplet/actions/workflows/ci.yml/badge.svg)](https://github.com/HoonStyle/greplet/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
![Node 22+](https://img.shields.io/badge/Node-22%2B-339933)
![.NET 8](https://img.shields.io/badge/.NET-8-512BD4)

**Local hybrid search for code and documents, with source locations an agent can open.**

greplet combines Ollama `bge-m3` vector search with BM25 full-text search. It searches one or several workspaces and returns source chunks with file paths, symbols, and line or page locations. It retrieves content; it does not generate answers.

- **Code and documents together:** C# type/member chunks with Roslyn, PDF pages with PdfPig, and text chunks for other supported formats.
- **An index you can update:** file hashes track additions, edits, and deletions during indexing. Run it from the UI, CLI, API, or an installed commit hook.
- **Several ways to search:** admin UI, Node/PowerShell CLI, local or remote MCP, and Claude Code/Codex plugins.

The default indexer and embedding setup runs locally. Installing dependencies/models and using optional remote integrations require network access. For exact file paths or every occurrence of a string, filesystem search remains useful.

**Start:** [Install and run](#install-and-run) · [Search](#usage) · [Connect an agent](#clients) · [Tuning history](#tuning-history)

<p align="center"><img src="docs/images/dashboard.png" alt="greplet admin UI with workspace status, search testing, and live activity" width="900"></p>

## Install and run

### 1. Prepare the runtime

| Requirement | When needed |
|---|---|
| Node.js 22+ and npm | Indexer and Node/MCP clients |
| .NET 8 SDK and runtime | Building and running the source-built Extractor |
| Ollama with `bge-m3` | Vector and hybrid search; optional for BM25-only use |
| PowerShell 7+ | Windows startup script and PowerShell CLI |
| Bash and curl | macOS/Linux startup script |

To use embeddings, start Ollama and download the model:

```sh
ollama pull bge-m3
```

Without Ollama, indexing can run without embeddings and searches fall back to `fts`. Once Ollama and the model are available, run indexing again to fill the vectors.

<details>
<summary>macOS setup and Intel Mac compatibility</summary>

If you use Homebrew's `dotnet@8`, set its runtime path before building:

```sh
brew install dotnet@8
export DOTNET_ROOT="$(brew --prefix dotnet@8)/libexec"
export PATH="$DOTNET_ROOT:$PATH"
```

Intel Macs need a LanceDB compatibility installation. In the build step below, replace `npm --prefix indexer ci` with:

```sh
npm --prefix indexer install @lancedb/lancedb@0.22.3
```

This changes the local dependency version. Apple Silicon, Windows, and Linux use the normal lockfile installation. The startup script also detects the usual Homebrew .NET 8 locations.

</details>

### 2. Clone and build

Run these commands from the repository root after cloning. Subsequent examples also use that directory.

```sh
git clone https://github.com/HoonStyle/greplet.git
cd greplet
dotnet build Extractor -c Release
npm --prefix indexer ci
npm --prefix indexer run build
```

To use a self-contained Extractor from [Releases](https://github.com/HoonStyle/greplet/releases), unpack the artifact for your OS and set `GREPLET_EXTRACTOR` to its executable. You can then skip the .NET SDK/runtime requirement and the `dotnet build` command. The indexer still needs Node and its build step.

### 3. Choose your workspaces

On first setup, copy the example configuration:

```sh
cp indexer/workspaces.example.json indexer/workspaces.json
```

Edit `indexer/workspaces.json` **before starting**: replace the example roots with existing local paths, remove unused workspaces, and update or remove the optional PDF password-file path. Keep an existing configuration when upgrading. See [Configuration](#configuration) for a minimal example.

### 4. Start and index

Windows:

```powershell
pwsh -File indexer/start-indexer.ps1
```

macOS/Linux:

```sh
bash indexer/start-indexer.sh
```

The script starts the indexer in the background, checks its health, and opens [the admin UI](http://localhost:7802). Choose **Full reindex** for your workspace to create its first index, then use the search box or CLI.

Use `-NoOpenUI` (PowerShell), `--no-open` (Bash), or `GREPLET_OPEN_UI=0` to skip opening the browser. Startup logs are in `indexer/logs/server.log` and `server.log.err`. Session startup automation is available through the [Claude Code hook example](examples/claude-code-skill/hooks.settings.json).

## Usage

Run from the repository root; replace `code` and `docs` with your configured workspace slugs.

```sh
node greplet.mjs "retry backoff logic" -w code
node greplet.mjs "0x0A03" --mode fts
node greplet.mjs "configuration schema" -w docs --top-n 8
node greplet.mjs "error handling" --all --full
node greplet.mjs "retry" --file "Lib/**/*.cs" --json

node greplet.mjs status
node greplet.mjs workspaces
node greplet.mjs index code --wait
node greplet.mjs index docs --force
```

`--full` returns full chunks; `--json` preserves the server response; `--file` filters by a relative-path glob. Without `-w` or `--all`, the CLI uses `GREPLET_DEFAULT_WORKSPACE` or the first workspace in its configuration. Use `node greplet.mjs --help` for all options. Human-readable CLI labels are Korean.

The Windows CLI also supports ordinary search:

```powershell
pwsh -File greplet.ps1 -Query "retry backoff logic" -Workspace code
pwsh -File greplet.ps1 -Query "0x0A03" -Mode fts -All
```

### Search modes

| Mode | Behavior | Typical use |
|---|---|---|
| `hybrid` (default) | Qualified `Type.Member` definition lookup, otherwise vector + BM25 fusion | Definitions and content search |
| `vector` | Embedding similarity | Natural-language descriptions and differently worded content |
| `fts` | BM25, without embedding calls | Constants, error codes, and exact terms |

A hybrid query consisting only of a case-sensitive `Type.Member` checks matching definitions without embedding the query. If no definition is found in a workspace, normal hybrid search runs there. Use a prose query when looking for usages.

For one workspace, hybrid places the top three vector candidates first and fills the remainder using vector:FTS **4:1 weighted RRF (k=60)**. Multiple workspaces use weighted RRF throughout. Fusion scores indicate ordering, not confidence or a common probability across workspaces. [Measured effects and scope](docs/tuning/2026-09-11-vector-prefix.md).

Ordinary search caches eligible responses for 10 minutes, with index changes invalidating entries. Cached responses carry `cached: true`; responses with warnings are not cached. Embedding/search failures can cause a fallback reported in `warnings`.

### Evidence retrieval

Use the optional evidence flow when you need a version-bound reference and the exact indexed chunk:

```sh
node greplet.mjs evidence-search "retry backoff logic" --all
node greplet.mjs evidence-get --ref-file evidence-ref.json
```

Save only a search hit's `evidenceRef` object in `evidence-ref.json`. Evidence search reports per-workspace results from the index (`unchecked`). Detail retrieval checks the current source file hash before returning the stored chunk (`verified`). That verifies freshness at retrieval time, not semantic correctness. Stale, deleted, indexing, or ambiguous sources are reported instead of silently substituting another source. See the [evidence interface](docs/greplet-evidence-v1.md) and [migration pilot](docs/migration-pilot.md); a real migration pilot is a separate validation step.

## Clients

Configure and start the indexer first. Agent plugins connect to it; they do not install the Extractor, start the service, or create indexes.

| Client | Setup |
|---|---|
| Claude Code / Codex plugin | [Self-hosted marketplace installation](docs/plugin-install.md); MCP connection and skill included |
| Codex, manual MCP setup | [Configuration and skill example](examples/codex/README.md) |
| Claude Code, manual skill setup | [Skill](examples/claude-code-skill/SKILL.md) and [rules snippet](examples/claude-code-skill/CLAUDE.md.snippet) |
| Claude Desktop / Cowork | Install the `.mcpb` artifact from [Releases](https://github.com/HoonStyle/greplet/releases) |
| Remote MCP | [Bearer-authenticated HTTP server](mcp-server/README.md), exposed through a tunnel |
| Git hook | Set `git config greplet.slug <slug>` in the source repository and install [post-commit](git-hooks/post-commit) |

The marketplace is provided by this repository; it is not a central-directory listing. Its first MCP launch may need npm registry access to install connector dependencies. Avoid enabling both the plugin and a duplicate manual MCP connection.

Both MCP transports expose four read-only tools:

| Tool | Purpose |
|---|---|
| `greplet` | Ranked content search |
| `greplet_workspaces` | Workspace listing |
| `greplet_search_evidence` | Per-workspace excerpts and version-bound references |
| `greplet_get_evidence` | Retrieve a referenced chunk after source-hash checks |

`readOnlyHint` describes tool behavior; the client controls approval policy. Use an LSP tool such as [Serena](https://github.com/oraios/serena) for callers, references, and inheritance, and [legacy-spec-agent](https://github.com/HoonStyle/legacy-spec-agent) for specification work. The agent coordinates these tools; greplet does not call them automatically.

## Configuration

Workspaces are defined in `indexer/workspaces.json` or the file selected by `GREPLET_WORKSPACES`. Paths below are examples; use paths on the machine running the indexer.

```json
[
  { "slug": "code", "label": "Main solution", "kind": "code",
    "roots": ["C:/work/my-solution"] },
  { "slug": "docs", "label": "Specifications", "kind": "docs",
    "roots": ["C:/work/specs"], "includeExt": [".pdf", ".html", ".md"] }
]
```

Use `/home/me/work/...` or `/Users/me/work/...` for Linux/macOS. Windows JSON paths can use forward slashes as above or escaped backslashes (`\\`). Separate code versions or products into workspaces when their source identity matters.

| Field | Meaning |
|---|---|
| `slug` / `label` | API identifier / display name |
| `kind` | `code` or `docs`; selects default extensions and exclusions |
| `roots` | Folders to index |
| `includeExt` | Extensions to include; defaults to C# project/text formats for `code`, `.pdf` for `docs` |
| `excludeDirs` / `excludeFiles` | Override the default directory/file exclusions |
| `pdfPasswordFile` | Optional password-list file for encrypted PDFs |

### Exclude by name

Prefix a file or folder name with `!`: `!draft.pdf` excludes one file and `!reference/` its subtree, including uploads and explicit roots inside excluded folders. A `!` in the middle or a leading `#` has no special meaning. Run indexing after renaming; old chunks are removed on the next successful run. Remove the prefix and reindex to include them again. Use exclusion settings when source paths must keep their names.

### Data and environment

Index data, manifests, uploads, and activity logs use `GREPLET_DATA_DIR`:

| OS | Default data directory |
|---|---|
| Windows | `%LOCALAPPDATA%\greplet` |
| macOS | `~/Library/Application Support/greplet` |
| Linux | `$XDG_DATA_HOME/greplet`, or `~/.local/share/greplet` |

<details>
<summary>Environment variable reference</summary>

| Variable | Default / purpose |
|---|---|
| `GREPLET_PORT` | `7802`; indexer port |
| `GREPLET_BASE_URL` | `http://localhost:7802`; CLI/MCP target |
| `GREPLET_WORKSPACES` | `indexer/workspaces.json`; set consistently for the indexer and local CLI |
| `GREPLET_DATA_DIR` | OS-specific directory above |
| `GREPLET_EXTRACTOR` | `Extractor/bin/Release/net8.0/Extractor` (`.exe` on Windows) |
| `GREPLET_DEFAULT_WORKSPACE` | Default CLI/MCP workspace; otherwise the first configured workspace |
| `OLLAMA_URL` | `http://localhost:11434` |
| `OLLAMA_KEEP_ALIVE` | `30m`; model retention after embedding requests |
| `GREPLET_OPEN_UI` | `1`; set `0` to skip opening the browser at startup |
| `GREPLET_CLIENT_NAME` | Client label in activity records; format `^[a-z0-9:_-]{1,32}$` |
| `GREPLET_SESSION` | Explicit session identifier for activity grouping |
| `GREPLET_ACTIVITY_QUERY` | Set `hidden` to replace query text in activity records |
| `GREPLET_ACTIVITY_LOG` | Set `off` to disable persistent activity logging |
| `GREPLET_ACTIVITY_RETENTION_DAYS` | `90`; activity log retention |

Longer model retention uses memory; the first model load can still add latency. For custom ports, point both the startup health-check URL and clients at the configured indexer port.

</details>

## HTTP API

The indexer binds to **`127.0.0.1:7802` without authentication**. Use the separate Bearer-authenticated MCP server and a tunnel for remote access.

| Endpoint | Purpose |
|---|---|
| `GET /healthz` · `GET /api/status` | Health and component status |
| `GET /api/workspaces` | Workspaces, index statistics, and `complete`/`partial`/`unknown` coverage |
| `POST /api/search` | `{ query, workspaces: string[] \| "all", topN, mode, fileGlob? }` |
| `POST /api/evidence/search` · `POST /api/evidence/get` | Evidence search and reference retrieval |
| `POST /api/index/:slug` | Incremental indexing; `{ force: true }` for a full run |
| `GET /api/jobs` · `GET /api/jobs/:id/events` | Jobs and their SSE logs |
| `GET /api/events` · `GET /api/activity` · `GET /api/usage` | Live activity, recent searches, and usage summaries |
| `POST /api/upload/:slug` | Upload and index files |
| `DELETE /api/workspaces/:slug/files?file=` | Delete an uploaded file |

Search hits include an absolute `abs` path. `fileGlob` uses file-relative `*`, `**`, and `?` patterns. See the [design reference](docs/design.md) and [evidence contract](docs/greplet-evidence-v1.md) for details.

## Tuning history

The [tuning history](docs/tuning/README.md) records the problem, implementation, fixed comparison conditions, before/after results, and adoption decision for each experiment. Benchmark functions, projects, and questions use anonymous identifiers.

| Status | Record |
|---|---|
| In use | Shared request embeddings, 30-minute model retention, qualified-definition lookup, and scope-dependent hybrid fusion: [0.11.2 changes](CHANGELOG.md#0112---2026-09-11) |
| Validated under recorded conditions | [T10 fusion comparison](docs/tuning/2026-09-11-vector-prefix.md) and [T11 usage/concurrency checks](docs/tuning/2026-09-11-release-validation.md) |
| Deferred | [T12 automatic workspace selection](docs/tuning/2026-09-11-workspace-routing.md); offline candidates did not meet adoption criteria |
| Research for later experiments | [ReSLLM, MKP-QA, and RAGRoute comparison](docs/tuning/2026-09-11-workspace-routing-research.md); these are published results, not Greplet measurements |

Automatic workspace selection is not part of the production search API. Choose a workspace explicitly or search all. Evaluation samples and denominators differ across reports; improvements are not cumulative percentages.

## Architecture and development

```text
UI / CLI / MCP / hooks
        | HTTP, localhost:7802
        v
Node/TypeScript indexer
  +-- Extractor: Roslyn (C#), PdfPig (PDF), text extraction
  +-- Ollama: bge-m3 embeddings
  +-- LanceDB: vectors + BM25, hybrid ranking
```

Source: [Extractor](Extractor/) · [Indexer](indexer/) · [Local MCP](greplet-mcpb/) · [Remote MCP](mcp-server/). Detailed chunking and configuration: [Design](docs/design.md) (Korean).

C# uses type/member chunks and splitting/merging for large/small members; PDF uses pages. Other supported text uses windows. UTF-8 input has CP949 fallback. OCR is not included, and other programming languages use text chunks rather than C# symbol extraction. The current vector path uses a flat scan, so increasing the corpus increases search work.

After the setup above, these local checks do not require a running production indexer:

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

See [CI](.github/workflows/ci.yml) for the full Windows/macOS/Linux test matrix, including evidence, MCP, and CLI checks. Development servers use `npm run dev` in `indexer/` or `mcp-server/` after installing their dependencies. Protocol smoke tests may have additional setup; use each component's instructions.

## License

[MIT](LICENSE)
