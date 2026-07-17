<h1 align="center">Jambavan</h1>

<p align="center"><em>Awaken your coding agent's memory, repo awareness, and review judgment.</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/jambavan"><img src="https://img.shields.io/npm/v/jambavan.svg" alt="npm version"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/jambavan.svg" alt="node version"></a>
  <a href="https://github.com/beingmartinbmc/jambavan/commits/main"><img src="https://img.shields.io/github/last-commit/beingmartinbmc/jambavan.svg" alt="last commit"></a>
  <a href="https://github.com/beingmartinbmc/jambavan/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/beingmartinbmc/jambavan/ci.yml?branch=main" alt="CI status"></a>
  <a href="https://bundlephobia.com/package/jambavan"><img src="https://img.shields.io/bundlephobia/minzip/jambavan" alt="bundle size"></a>
  <a href="https://www.npmjs.com/package/jambavan"><img src="https://img.shields.io/npm/dm/jambavan.svg" alt="downloads"></a>
  <a href="https://github.com/beingmartinbmc/jambavan/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/jambavan.svg" alt="license"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/beingmartinbmc/jambavan/main/assets/jambavan.png" alt="Ramayana-inspired Jambavan and Hanuman hero image showing local memory, codebase awareness, review packs, compact context, and privacy for MCP coding agents" width="920">
</p>

Jambavan is a local-first [Model Context Protocol](https://modelcontextprotocol.io) server. It gives Claude Code, Cursor, Codex, Continue, and other MCP hosts:

- ranked code-symbol context with bounded extracted callers/callees
- durable project memories and portable session handoffs
- failure records plus a repeat-failure guard for the opt-in shell tool
- branch review context with explicit limits

It makes no LLM calls, sends no telemetry, and uploads no code. Code indexes stay in each repository's `.jambavan/`; the rootless memory archive defaults to `~/.jambavan/memory`. Source-mutating and shell MCP tools are off by default.

## Quick start

```bash
claude mcp add jambavan -- npx -y jambavan
npx jambavan doctor
```

Then ask the MCP host to call:

```text
jambavan_awaken {}
jambavan_doctor {}
jambavan_index {}
jambavan_watch { "action": "start" }
jambavan_context { "query": "where is auth handled?" }
```

<p align="center">
  <img src="https://raw.githubusercontent.com/beingmartinbmc/jambavan/main/assets/30-second-demo.gif" alt="Illustrative under-30-second Jambavan storyboard showing connection, indexing, context retrieval, repeat-failure guard, impact analysis, and review pack" width="820">
  <br>
  <sub>Illustrative storyboard; exact output depends on the repository, host, and enabled tools.</sub>
</p>

## Why the name

In the Ramayana, before Hanuman's leap across the ocean to Lanka, Jambavan reminds him of the strength he already possesses. This project borrows that reminder metaphor narrowly: it restores access to project knowledge that was already indexed or stored. It does not increase a model's intelligence or grant new reasoning ability.

## What It Is

Jambavan gives a host model a local project state layer:

- **Codebase awareness** - AST-aware symbols, FTS5/BM25-ranked context with a LIKE fallback, optional tests/recent diff, and a lightweight code graph.
- **Durable memory** - human-readable OKF Markdown under the rootless `~/.jambavan/memory` archive, organized as scope → collection → memory.
- **Failure memory** - searchable failure records; the opt-in `bash` tool records redacted failures and can guard an exact unresolved repeat.
- **Review packs** - branch-aware review context: touched files, symbols, callers, tests, `rin` debt, and past failures.
- **Prompt compression** - deterministic prose shortening that protects fenced/inline code, URLs, paths, versions, and environment-variable tokens.
- **Local GUI** - browser graph view for symbols, relationships, debt, and failure hotspots.

<p align="center">
  <img src="https://raw.githubusercontent.com/beingmartinbmc/jambavan/main/assets/usage-screenshot.svg" alt="Terminal screenshot showing Jambavan install, doctor, index, context, and badges usage" width="820">
</p>

Without an index or saved memory, manually rediscovering a project requires examining a number of files or symbols proportional to the area searched: O(n). Jambavan persists that work. Index refresh still discovers and hashes candidate files in O(n files), but reparses only files whose content changed.

## Works With

| Host | Setup |
|---|---|
| Claude Code | `claude mcp add jambavan -- npx -y jambavan` |
| Cursor | `.cursor/mcp.json` |
| Codex CLI | `codex mcp add jambavan -- npx -y jambavan` |
| Continue | `~/.continue/config.yaml` |
| Any MCP client | command: `npx -y jambavan` |

## Install

One command. Finds Claude Code, Codex CLI, Cursor, and Continue on your machine. Registers Jambavan as an MCP server for each one it finds.

```bash
# macOS, Linux, WSL, Git Bash
curl -fsSL https://raw.githubusercontent.com/beingmartinbmc/jambavan/main/install.sh | bash
```

```powershell
# Windows, PowerShell 5.1+
irm https://raw.githubusercontent.com/beingmartinbmc/jambavan/main/install.ps1 | iex
```

Needs Node >=20.19.0 <27. Safe to re-run. It skips agents you do not have and does not remove other MCP servers from your config. As with any internet shell script, read it before piping it into a shell.

## Manual Registration

Same MCP command everywhere: `npx -y jambavan`.

**Claude Code**

```bash
claude mcp add jambavan -- npx -y jambavan
```

**Codex CLI**

```bash
codex mcp add jambavan -- npx -y jambavan
```

**Cursor** (`~/.cursor/mcp.json` global, or `.cursor/mcp.json` per project)

```json
{
  "mcpServers": {
    "jambavan": { "command": "npx", "args": ["-y", "jambavan"] }
  }
}
```

**Continue** (`~/.continue/config.yaml`)

```yaml
name: Local config
version: 1.0.0
schema: v1
mcpServers:
  - name: Jambavan
    command: npx
    args:
      - -y
      - jambavan
```

## First Run

After registering, ask your host model to run:

```text
jambavan_awaken {}
jambavan_doctor {}
jambavan_index {}
jambavan_watch { "action": "start" }
jambavan_context { "query": "<task-specific identifier or question>" }
```

`jambavan_doctor` checks project-root detection, parser backends, gates, archive/legacy-memory state, CI hints, and index/watcher status. When root resolution remains at `cwd-fallback`, all `jambavan_memory_*` tools still work; repository-bound index, graph, impact, file, failure-record, shell, and handoff operations fail closed. `jambavan_awaken.root` or `jambavan_index.root` can bind an existing absolute directory inside that fallback root.

## Activate, Update, And Uninstall

Restart the host after registration or configuration changes, then run `jambavan_awaken` and `jambavan_doctor` to confirm the server is active. Continue exposes MCP tools only in Agent mode.

Check the installed CLI version and the current published package version:

```bash
npx jambavan --version
npm view jambavan version
```

To pin or update deliberately, change the MCP argument from `jambavan` to `jambavan@<version>` or `jambavan@latest`, then restart the host.

To uninstall, run `claude mcp remove jambavan` or `codex mcp remove jambavan`; for Cursor, delete the `jambavan` key from `mcpServers`; for Continue, remove its `mcpServers` entry (or the standalone Jambavan file created by the installer). This leaves local `.jambavan/` indexes and memories intact. Delete that directory separately only if you no longer need its contents.

## The Powers

| Power | Tools | What it gives the agent |
|---|---|---|
| **Sight** | `jambavan_index`, `jambavan_context`, `jambavan_watch`, `jambavan_diagnostics`, `jambavan_doctor` | AST-backed symbol index, token-budgeted context, bounded extracted call neighbors, tests, recent diff, root health, and live watching. |
| **Bridge** | `jambavan_graph_report`, `jambavan_graph_query`, `jambavan_graph_path`, `jambavan_impact` | Focused code graph navigation plus changed-symbol inbound impact and test analysis. |
| **Memory** | `jambavan_memory_store`, `jambavan_memory_get`, `jambavan_memory_search`, `jambavan_memory_recall`, `jambavan_memory_mine_session`, `jambavan_memory_invalidate`, `jambavan_memory_delete`, `jambavan_memory_status` | Rootless local Markdown memory, logical collections, and explicit read-only MemPalace federation. |
| **Failure memory** | `jambavan_failure_store`, `jambavan_failure_search` | Structured failure records plus an exact-command repeat guard in the opt-in `bash` tool. |
| **Session continuity** | `jambavan_session_export`, `jambavan_session_import` | Portable handoff docs for new chats, new tools, or teammates. |
| **Review pack** | `jambavan_review_pack` | Bounded branch review context: touched symbols, extracted caller candidates, tests, `rin` debt, and past failures. |
| **Sankshipta** | `jambavan_sankshipta` | Deterministic prompt/prose compression with protected lexical spans for code, URLs, paths, versions, and environment variables. |
| **Vibhishana Niti** | `jambavan_vibhishana_niti`, `jambavan_rin_mochan` | Efficient senior-dev discipline and deliberate shortcut debt ledger. |
| **Counsel** | `jambavan_mool_kaaran`, `jambavan_praman`, `jambavan_yukti`, `jambavan_vibhaajan` | Root-cause investigation, verification gates, planning, and task decomposition. |
| **Hands** | `read_file`, `search`, `list_files`; opt-in `write_file`, `patch_file`, `bash` | Guarded project-root file/search/shell tools. Mutating and shell tools are disabled by default. |
| **Awakening** | `jambavan_awaken` | A session protocol that reminds the model what powers exist and when to use them. |

### Functional Aliases

The Ramayana names remain stable, but Jambavan also exposes English aliases for model recall and searchability:

| Alias | Canonical tool |
|---|---|
| `root_cause` | `jambavan_mool_kaaran` |
| `verify_gate` | `jambavan_praman` |
| `strategy_plan` | `jambavan_yukti` |
| `decompose_task` | `jambavan_vibhaajan` |
| `dev_rules` | `jambavan_vibhishana_niti` |
| `debt_ledger` | `jambavan_rin_mochan` |
| `compress_prompt` | `jambavan_sankshipta` |

## Representative output shapes

The examples below illustrate the current fields and layout; they are not measured results.

`jambavan_context { "query": "review pack" }` returns focused code spans instead of whole files:

```text
# Jambavan Context
query: review pack
budget: 8000 tokens

## src/tools/review-pack.ts: buildReviewPack
kind: function · score: 0.92
Uses git diff to list touched files, maps symbols from the index, adds callers via graph,
associated tests via test-map, and risk flags for rin debt / missing tests / failures.
```

`jambavan_review_pack { "base": "main" }` turns a branch into reviewer-oriented context:

```text
# Jambavan Review Pack
Base: main
Touched files: src/mcp/server.ts, src/mcp/tool-aliases.ts

src/mcp/server.ts
- touched symbols: startServer, handleToolCall
- callers: dist/index.js -> startServer
- associated tests: test/tool-aliases.test.ts
- risk flags: write-gated tool alias; verify disabled-tool listing
```

CLI form for CI and PR comments:

```bash
npx jambavan review-pack --base origin/main --format json --max-files 200
npx jambavan review-pack --base origin/main --include-worktree
```

JSON includes `touchedCount`, `analyzedCount`, `truncated`, `files[]`, `rinMarkers[]`, and `failures[]`. The bundled [`.github/workflows/jambavan-review.yml`](https://github.com/beingmartinbmc/jambavan/blob/main/.github/workflows/jambavan-review.yml) renders it into one idempotent PR comment.

`jambavan_failure_search { "query": "timeout" }` can surface a prior dead end before another retry:

```text
FailureRecord: flaky auth test timeout
Root cause: unawaited promise in token refresh mock.
Do not retry: increasing the test timeout; it hid the race.
Next check: run the focused auth test with fake timers enabled.
```

## Recommended Workflow

1. `jambavan_awaken {}` - read the protocol and recent project memories.
2. `jambavan_doctor {}` - confirm project root, gates, storage, and index/watcher status.
3. `jambavan_index {}` - build or refresh the local AST-backed index.
4. `jambavan_watch { "action": "start" }` - keep the index live while editing.
5. `jambavan_context { "query": "<task-specific query>" }` - pull ranked, token-budgeted context before touching unfamiliar code.
6. `root_cause` / `verify_gate` / `strategy_plan` when debugging, claiming completion, or planning multi-step work.
7. Run the smallest relevant check.
8. `jambavan_memory_store { "title": "...", "body": "...", "collection": "decisions" }` - persist durable context. Scope defaults to the active Git-derived project scope, or `global` in a rootless session.
9. `jambavan_failure_store` - record dead ends with root cause and do-not-retry advice.
10. `jambavan_session_export {}` - hand off; import with `jambavan_session_import { "text": "..." }`.

## Privacy And Safety

**No LLM calls. No telemetry. No code upload.** Jambavan stores code indexes and caches in the active repository's `.jambavan/`, and stores memory/failure documents in `~/.jambavan/memory` by default. Both generated-state roots receive a nested `.gitignore` with `*`. These operational writes still occur when source mutation is disabled.

MemPalace is never contacted during ordinary Jambavan recall, automatic context enrichment, or awakening. It is started only when a memory read explicitly sets `provider: "mempalace"` or `provider: "all"`. Jambavan exposes only five validated MemPalace read capabilities, filters the child environment, and never installs MemPalace, initializes a palace, downloads a model, or exposes its write/update/delete tools. MemPalace itself remains separately installed software with its own local configuration.

Source-mutating and shell MCP tools are not advertised unless you opt in:

| Tool(s) | Enable with |
|---|---|
| `write_file`, `patch_file`, `jambavan_sankshipta` | `JAMBAVAN_ALLOW_WRITE=1` |
| `bash` | `JAMBAVAN_ALLOW_BASH=1` |

Direct path arguments to file, search, and list tools, plus the `bash` working directory, are confined to `JAMBAVAN_ROOT` or the detected project root. The same path guard refuses known secret-file basenames, extensions, and immediate parent directories unless `JAMBAVAN_ALLOW_SECRETS=1`. This is a direct-path guard, not content scanning, and it does not prevent an enabled shell command from reading files; enable `bash` only in a sandbox you trust. Set `JAMBAVAN_ALLOW_OUTSIDE_ROOT=1` only for trusted local use.

`bash` uses a minimal no-color environment and blocks a few obvious footguns such as `rm -rf /`, `git reset --hard`, `git clean -fx`, and blind `curl | sh`. It redacts and stores failed-command records locally; once the same unresolved command fails unchanged again, a do-not-retry record can block another exact retry unless `retry_known_failure=true`. These checks are not a security boundary. Treat the tool like a local shell and sandbox the workspace if you need isolation.

## Troubleshooting

### GUI Apps And NVM

GUI-launched hosts such as Cursor often do not inherit your shell PATH. Symptoms: `spawn npx ENOENT`, or `env: node: No such file or directory`. Fix by running absolute `node` against npm's `npx-cli.js`, and set `PATH` explicitly.

Find paths:

```bash
command -v node
echo "$(npm prefix -g)/lib/node_modules/npm/bin/npx-cli.js"
```

Cursor config with NVM and npm-policy workarounds:

```json
{
  "mcpServers": {
    "jambavan": {
      "command": "/abs/path/to/node",
      "args": [
        "/abs/path/to/npm/bin/npx-cli.js",
        "-y",
        "--registry=https://registry.npmjs.org",
        "--before=",
        "jambavan@latest"
      ],
      "env": { "PATH": "/abs/path/to/node/dir:/usr/bin:/bin" }
    }
  }
}
```

Claude Code `.claude.json` uses the same shape. Put npm policy overrides and the project root in `env` so reconnects do not fall back to an empty environment:

```json
{
  "mcpServers": {
    "jambavan": {
      "command": "/abs/path/to/node",
      "args": ["/abs/path/to/npm/bin/npx-cli.js", "-y", "jambavan@latest"],
      "env": {
        "PATH": "/abs/path/to/node/dir:/usr/bin:/bin",
        "npm_config_registry": "https://registry.npmjs.org",
        "npm_config_min_release_age": "0",
        "JAMBAVAN_ROOT": "/abs/path/to/one/repo"
      }
    }
  }
}
```

In Claude Code this can show up as `-32000` / `failed to reconnect` because the MCP server process never started cleanly. Check MCP logs for the npm/PATH error.

### Root Confusion

At startup, `JAMBAVAN_ROOT` wins. Otherwise Jambavan walks up from the server process cwd, and a supported single file-URI MCP `roots/list` result may replace that cwd result. When the resulting source is `cwd-fallback`, memory tools remain available against the global archive while repository-bound tools fail closed. `jambavan_awaken.root` or `jambavan_index.root` may then bind an existing absolute directory inside the current fallback root; use `JAMBAVAN_ROOT` and reconnect when the repository is outside it. Root rebinding never moves or changes the memory archive.

Run `jambavan_doctor` or `npx jambavan doctor`. Healthy MCP output should show the target repo with `source: env`, `source: client-roots`, `source: tool-input`, or `source: cwd-project`.

## Claude Code Plugin

This repo is also a Claude Code [plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces). Add it and install with two commands:

```shell
/plugin marketplace add beingmartinbmc/jambavan
/plugin install jambavan@jambavan
```

The plugin registers the same `npx -y jambavan` MCP server and bundles skills for using Jambavan, Vibhishana Niti, root-cause debugging, release checks, and strict review.

## Examples

- [Claude Code setup](https://github.com/beingmartinbmc/jambavan/blob/main/examples/claude-code.md)
- [Cursor setup](https://github.com/beingmartinbmc/jambavan/blob/main/examples/cursor.md)
- [Codex CLI setup](https://github.com/beingmartinbmc/jambavan/blob/main/examples/codex.md)
- [Continue setup](https://github.com/beingmartinbmc/jambavan/blob/main/examples/continue.md)
- [Review pack output](https://github.com/beingmartinbmc/jambavan/blob/main/examples/review-pack.md)

## Direct CLI Commands

```bash
npm install
npm run build
node dist/index.js --help
node dist/index.js
```

Set `JAMBAVAN_ROOT=/path/to/project` when launching outside the target repo.

Useful one-shot commands:

```bash
npx jambavan doctor
npx jambavan review-pack --base origin/main --format json --max-files 200
npx jambavan html-handoff --out /tmp/handoff.html --share-safe
npx jambavan gui
npx jambavan badges
npx jambavan memory migrate --root /path/to/repository
```

## Badges Command

`npx jambavan badges` prints three local markdown lines you can paste into a README:

```bash
npx jambavan badges
```

The lines summarize context-token savings for the current repo, Rin Ledger debt markers (`// rin:` comments), and Failure Memory (`FailureRecord` memories in the default project scope). The command makes no network calls. If you want rendered badge images, use a [shields.io static badge](https://shields.io/badges/static-badge) URL explicitly; README renders will then fetch from shields.io's CDN.

## Rootless Memory And MemPalace

The default archive is `~/.jambavan/memory/<scope>/<slug>.md`. `scope` identifies a project or topic; `collection` is frontmatter used as a logical room without changing the physical `scope/slug` ID layout. Missing collections in older documents are inferred as `decisions` for `Decision`, `failures` for `FailureRecord`, and `general` otherwise.

With a repository root, the default scope is derived without exposing its raw remote or path: validated `JAMBAVAN_SCOPE`, otherwise normalized Git remote path plus the repository's initial commit, otherwise initial commit plus basename, otherwise a path hash for non-Git directories. Without a root, writes default to `global`.

Pre-global archives remain readable at `<repo>/.jambavan/memory` when the default archive is active. Legacy `general` and old path-derived project scopes appear under the active Git-derived scope, results are labelled `storage: legacy`, global duplicates win, and the legacy documents are never edited. Migrate explicitly and non-destructively:

```bash
# Preview only
npx jambavan memory migrate --root /path/to/repository

# Copy after a conflict-free preview; the legacy store is retained
npx jambavan memory migrate --root /path/to/repository --apply
```

For direct MemPalace reads, install the official package separately (Jambavan does not install it):

```bash
uv tool install mempalace==3.5.0
```

Then opt in per call. Jambavan maps `scope → wing` and `collection → room`; `provider: "all"` keeps BM25 and vector results in separate sections rather than comparing their scores.

```text
jambavan_memory_search { "query": "release decision", "provider": "mempalace", "scope": "project", "collection": "decisions" }
jambavan_memory_get { "id": "drawer-id", "provider": "mempalace" }
jambavan_memory_status { "provider": "all" }
```

The older portable bridge remains available for offline interchange and makes no network call:

```bash
npx jambavan bridge --to mempalace [--out <dir>] [--scope <scope>]
npx jambavan bridge --from mempalace [--in <dir>]
```

`--to mempalace` writes one file per memory under `<dir>/<wing>/<room>/<title>.md`, mapping collection to room. `--from mempalace` imports the same shape back into Jambavan.

## PR And Session Handoffs

`npx jambavan handoff --write-pr-template` injects the same handoff card as `jambavan_session_export` into `.github/pull_request_template.md`, creating the file if needed. Re-running replaces the old block in place.

```bash
npx jambavan handoff --write-pr-template [--scope <scope>] [--share-safe]
npx jambavan handoff --write-pr-template --post
```

`--post` shells out to your authenticated `gh pr comment`, so it is opt-in and has the same trust boundary as the `bash` tool.

`npx jambavan html-handoff` writes a self-contained HTML report for humans: memory timeline, rin debt, indexed-symbol stats, dirty files, recent commits, collapsible sections, and copy buttons.

## Live Index Watching

Use the `jambavan_watch` tool (`action: start|stop|status`) to keep the index live within an MCP session: supported source-file changes incrementally update the index while the session runs. Most MCP hosts restart the server per session, so there is nothing to manage between sessions.

> **Removed in 1.0:** the standalone background daemon (`jambavan daemon start|stop|status`). A PID file is discovery metadata, not proof of identity, so it could never be signalled safely. If a pre-1.0 daemon left a `.jambavan/daemon.pid` behind, `jambavan_watch` and awaken print a one-line notice telling you to stop that process manually and delete the file — Jambavan never signals it.

## GUI Visualizer

`npx jambavan gui` indexes the project and serves a dependency-free local page over Node's built-in `http`, bound to `127.0.0.1` only.

```bash
npx jambavan gui
npx jambavan gui --port 5000
npx jambavan gui --no-open
```

The page has three tabs: code graph, Rin Debt, and Failures. It includes search, pan/zoom, heat markers, and click-through source/caller/callee details. All data comes from local JSON endpoints.

<p align="center">
  <img src="https://raw.githubusercontent.com/beingmartinbmc/jambavan/main/assets/gui-screenshot.svg" alt="Local Jambavan GUI showing graph, Rin Debt, and Failures tabs" width="820">
</p>

## Configuration

| Env var | Default | Description |
|---|---|---|
| `JAMBAVAN_ROOT` | auto-detect | Project root to index and serve |
| `JAMBAVAN_SCOPE` | Git-derived scope | Validated clone-independent override; otherwise remote path + initial commit, initial commit + basename, or a non-Git path hash |
| `JAMBAVAN_MEMORY_HOME` | `~/.jambavan/memory` | Complete override for the root-independent OKF archive |
| `JAMBAVAN_MEMPALACE_COMMAND` | `mempalace-mcp` | Executable used only for explicit read-only MemPalace provider calls |
| `JAMBAVAN_TOKEN_BUDGET` | `8000` | Max approximate `cl100k_base` tokens in `jambavan_context` output |
| `JAMBAVAN_DEV_MODE` | `full` | Default Vibhishana Niti level (`lite`, `full`, `ultra`) |
| `JAMBAVAN_ALLOW_WRITE` | off | Registers `write_file`, `patch_file`, and `jambavan_sankshipta` |
| `JAMBAVAN_ALLOW_BASH` | off | Registers `bash` |
| `JAMBAVAN_ALLOW_OUTSIDE_ROOT` | off | Disables direct-path project-root containment |
| `JAMBAVAN_ALLOW_SECRETS` | off | Allows direct paths that match the secret-file guard |
| `JAMBAVAN_BASH_INHERIT_ENV` | off | Passes full host env to `bash` |
| `JAMBAVAN_MAX_OUTPUT_CHARS` | `100000` | Global cap on tool output |
| `JAMBAVAN_MAX_READ_BYTES` | `5242880` | Max file size `read_file` loads |

`JAMBAVAN_SCOPE` controls the active project scope used by awakening, automatic context enrichment, failure memory, handoffs, and default memory writes. In a rootless session, default writes use `global`. Any explicit tool-level `scope` wins.

## Community

Read [CONTRIBUTING.md](https://github.com/beingmartinbmc/jambavan/blob/main/CONTRIBUTING.md) before proposing a change. Use the issue forms for bugs and focused feature requests, and report vulnerabilities privately through [SECURITY.md](https://github.com/beingmartinbmc/jambavan/blob/main/SECURITY.md).

## Checks

```bash
npm run docs-check
npm run lint
npm run unit
npm run self-check
npm run tool-check
npm run coverage
npm run build
npm pack --dry-run
```

## Social Preview

This repo includes [`.github/social-preview.png`](https://github.com/beingmartinbmc/jambavan/blob/main/.github/social-preview.png). Set it as the GitHub repository social preview under **Settings -> Social preview** so shares explain the project before anyone opens the README.

See [ARCHITECTURE.md](https://github.com/beingmartinbmc/jambavan/blob/main/ARCHITECTURE.md) for internals.

---

<p align="center"><sub>If local project context helps your agent start with less rediscovery, star the repo so more MCP users find the project.</sub></p>
