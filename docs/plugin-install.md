# Agent plugin installation

This repository provides a **self-hosted plugin marketplace**, not a listing in an official central directory. The plugin connects to an existing greplet indexer; it does not install the extractor, start the indexer, or reindex workspaces.

Requirements: Node.js 22+, npm, a configured/running greplet indexer (default `http://localhost:7802`). On first MCP launch the bootstrap installs the connector's lockfile dependencies with `npm ci --ignore-scripts`; registry access and a writable plugin directory are required. Subsequent launches reuse installed dependencies. Dependency logs go to stderr to preserve the MCP protocol.

## Claude Code

```text
/plugin marketplace add HoonStyle/greplet
/plugin install greplet@greplet
```

Restart/reload the client if requested. The bundled skill and stdio MCP connection are included.

## Codex

Following the same repository-local marketplace layout used by Legacy Spec Agent:

```sh
git clone https://github.com/HoonStyle/greplet.git
cd greplet
codex plugin marketplace add "$(pwd)"
```

Install **greplet** from the Plugins Directory. On PowerShell pass the checkout's absolute path instead of `$(pwd)` if needed. Client/plugin support can vary by version; registration files alone do not prove installation in every client.

## Existing users

Keep the existing indexer and its workspace configuration. Avoid enabling both a manually configured greplet MCP server and the plugin connection. `GREPLET_BASE_URL`, `GREPLET_DEFAULT_WORKSPACE`, `GREPLET_CLIENT_NAME`, and `GREPLET_SESSION` retain the existing stdio connector behavior.

The `.mcpb` release remains the separate installation path for Claude Desktop/Cowork; this change does not register it in their official directory.

## Checks

```sh
node scripts/check-plugin.mjs
cd greplet-mcpb
npm ci --ignore-scripts
npm run smoke
```

Manifest checks and the stdio smoke test are not a substitute for checking installation in the target client. No production indexer changes are required for these checks.
