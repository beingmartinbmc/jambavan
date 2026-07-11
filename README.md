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

It makes no LLM calls, sends no telemetry, and uploads no code. It does write its index, cache, memories, and failure records to local `.jambavan/` state. Source-mutating and shell MCP tools are off by default.

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
- **Durable memory** - human-readable project memories under `.jambavan/memory/`.
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

Needs Node >=20 <27. Safe to re-run. It skips agents you do not have and does not remove other MCP servers from your config. As with any internet shell script, read it before piping it into a shell.

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

`jambavan_doctor` checks project-root detection, parser backends, gates, memory paths, CI hints, and index/watcher status. If it reports a root such as `$HOME`, set `JAMBAVAN_ROOT` to one repo, reconnect, and run doctor again.

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
| **Memory** | `jambavan_memory_store`, `jambavan_memory_search`, `jambavan_memory_recall`, `jambavan_memory_mine_session`, `jambavan_memory_invalidate`, `jambavan_memory_delete`, `jambavan_memory_status` | Durable local markdown memory. Decisions survive across sessions and hosts. |
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

The examples below illustrate the current fields and layout. They are representative, not results from a claimed benchmark run.

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
8. `jambavan_memory_store { "title": "...", "body": "...", "scope": "<project scope>" }` or `jambavan_memory_mine_session { "text": "...", "scope": "<project scope>" }` - persist durable context under the scope reported by `jambavan_awaken`.
9. `jambavan_failure_store` - record dead ends with root cause and do-not-retry advice.
10. `jambavan_session_export {}` - hand off; import with `jambavan_session_import { "text": "..." }`.

## Privacy And Safety

**No LLM calls. No telemetry. No code upload.** Jambavan stores indexes, cache, memory, failure records, and daemon state under `.jambavan/` by default. Those operational writes still occur when source mutation is disabled.

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

Jambavan resolves the project root in this order: explicit `JAMBAVAN_ROOT`, MCP `roots/list` from the host, then a walk up from the server process cwd. Some hosts start MCP servers with `cwd=$HOME`; if they also do not answer `roots/list`, Jambavan can index too much.

Run `jambavan_doctor` or `npx jambavan doctor`. Healthy output should show the target repo with `source: env` or `source: client-roots`.

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
- [Shareable benchmark proof card](https://github.com/beingmartinbmc/jambavan/blob/main/examples/benchmark-proof-card.md)
- [Offline outcome evaluation](https://github.com/beingmartinbmc/jambavan/blob/main/examples/outcome-evaluation.md)

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
npx jambavan daemon start
npx jambavan gui
npx jambavan badges
npx jambavan evaluate --baseline baseline.json --jambavan jambavan.json --format markdown
```

## Badges Command

`npx jambavan badges` prints three local markdown lines you can paste into a README:

```bash
npx jambavan badges
```

The lines summarize benchmark context-token savings for the current repo, Rin Ledger debt markers (`// rin:` comments), and Failure Memory (`FailureRecord` memories in the default project scope). The command makes no network calls. If you want rendered badge images, use a [shields.io static badge](https://shields.io/badges/static-badge) URL explicitly; README renders will then fetch from shields.io's CDN.

## Memory Bridge

`jambavan bridge` converts Jambavan memories to or from a portable MemPalace-shaped markdown folder tree. The bridge itself makes no network call.

```bash
npx jambavan bridge --to mempalace [--out <dir>] [--scope <scope>]
npx jambavan bridge --from mempalace [--in <dir>]
```

`--to mempalace` writes one file per memory under `<dir>/<wing>/<room>/<title>.md`. Hand that tree to a host model and ask it to file drawers with MemPalace tools. `--from mempalace` imports the same shape back into Jambavan.

## PR And Session Handoffs

`npx jambavan handoff --write-pr-template` injects the same handoff card as `jambavan_session_export` into `.github/pull_request_template.md`, creating the file if needed. Re-running replaces the old block in place.

```bash
npx jambavan handoff --write-pr-template [--scope <scope>] [--share-safe]
npx jambavan handoff --write-pr-template --post
```

`--post` shells out to your authenticated `gh pr comment`, so it is opt-in and has the same trust boundary as the `bash` tool.

`npx jambavan html-handoff` writes a self-contained HTML report for humans: memory timeline, rin debt, indexed-symbol stats, dirty files, recent commits, collapsible sections, and copy buttons.

## Background Daemon

`npx jambavan daemon start` runs the same watcher used by `jambavan_watch` in a detached background process. It writes `.jambavan/daemon.pid` and `.jambavan/daemon.log`.

```bash
npx jambavan daemon start
npx jambavan daemon status
npx jambavan daemon stop
```

This mainly helps long-lived terminal or CI workflows where no MCP host keeps the index warm between tool calls.

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
| `JAMBAVAN_SCOPE` | path-derived slug + hash | Clone-independent memory scope; 1-80 lowercase letters, numbers, or hyphens |
| `JAMBAVAN_MEMORY_HOME` | `<indexDir>/memory` | Where memory docs live |
| `JAMBAVAN_TOKEN_BUDGET` | `8000` | Max approximate `cl100k_base` tokens in `jambavan_context` output |
| `JAMBAVAN_DEV_MODE` | `full` | Default Vibhishana Niti level (`lite`, `full`, `ultra`) |
| `JAMBAVAN_ALLOW_WRITE` | off | Registers `write_file`, `patch_file`, and `jambavan_sankshipta` |
| `JAMBAVAN_ALLOW_BASH` | off | Registers `bash` |
| `JAMBAVAN_ALLOW_OUTSIDE_ROOT` | off | Disables direct-path project-root containment |
| `JAMBAVAN_ALLOW_SECRETS` | off | Allows direct paths that match the secret-file guard |
| `JAMBAVAN_BASH_INHERIT_ENV` | off | Passes full host env to `bash` |
| `JAMBAVAN_MAX_OUTPUT_CHARS` | `100000` | Global cap on tool output |
| `JAMBAVAN_MAX_READ_BYTES` | `5242880` | Max file size `read_file` loads |

`JAMBAVAN_SCOPE` controls the project scope used by awakening, context-memory enrichment, failure memory, and handoffs. Manual `jambavan_memory_store` and `jambavan_memory_mine_session` calls default to `general`; pass the project scope explicitly when those memories should be recalled with the project.

## Benchmark

`npm run bench` is a retrieval benchmark. It dogfoods the real pipeline: deterministic, local-only, no LLM calls, no embeddings, no external services. It derives queries from the repo's own symbols and measures index speed, context token savings, graph extraction, prompt compression, and MCP tool latency. It does not measure task correctness or completion. Results depend on the repository, machine, Node version, and cache state; they are measurements, not universal performance claims.

Run it on your repo:

```bash
JAMBAVAN_ROOT=/path/to/your/repo npm run bench
node dist/benchmark.js --json
```

Token counts are `cl100k_base` estimates. They are exact for that tokenizer, not for every host model. To publish aggregate results without leaking paths, symbol names, or tool output, use the [benchmark proof-card template and methodology](https://github.com/beingmartinbmc/jambavan/blob/main/examples/benchmark-proof-card.md).

For outcome evidence, `jambavan evaluate` compares strict, paired JSON records from baseline and Jambavan runs. It reports completion, first-pass success, repeated failures, successful-task duration, and supplied input-token counts without calling an LLM or executing an agent. See the [input schema, metric definitions, and outcome proof card](https://github.com/beingmartinbmc/jambavan/blob/main/examples/outcome-evaluation.md).

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
