<h1 align="center">Jambavan</h1>

<p align="center"><em>Stop your coding agent from forgetting your repo.</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/jambavan"><img src="https://img.shields.io/npm/v/jambavan.svg" alt="npm version"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/jambavan.svg" alt="node version"></a>
  <a href="https://github.com/beingmartinbmc/jambavan/commits/main"><img src="https://img.shields.io/github/last-commit/beingmartinbmc/jambavan.svg" alt="last commit"></a>
  <a href="https://github.com/beingmartinbmc/jambavan/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/beingmartinbmc/jambavan/ci.yml?branch=main" alt="CI status"></a>
  <a href="https://bundlephobia.com/package/jambavan"><img src="https://img.shields.io/bundlephobia/minzip/jambavan" alt="bundle size"></a>
  <a href="https://www.npmjs.com/package/jambavan"><img src="https://img.shields.io/npm/dm/jambavan.svg" alt="downloads"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/jambavan.svg" alt="license"></a>
</p>

---

<p align="center">
  <img src="./assets/30-second-demo.gif" alt="30-second Jambavan demo showing registration, doctor, indexing, context retrieval, and failure recall" width="820">
</p>

Jambavan is a local-first [Model Context Protocol](https://modelcontextprotocol.io) server for Claude Code, Cursor, Codex, Continue, and any MCP client. It gives coding agents the missing state layer: precise code context, durable memory, failure history, review packs, and a lightweight symbol graph.

Use it when the agent keeps forgetting what was decided, rereads whole files for every question, repeats dead-end fixes, or starts a review without knowing touched symbols, callers, and tests.

## 30-second demo

```bash
claude mcp add jambavan -- npx -y jambavan
npx jambavan doctor
# In your MCP host: jambavan_awaken → jambavan_index → jambavan_context "where is auth handled?"
```

The model now has local repo context, previous decisions, and searchable failure history before it edits.

<p align="center">
  <img src="./assets/usage-screenshot.svg" alt="Terminal screenshot showing Jambavan install, doctor, index, context, and badges usage" width="820">
</p>

## Privacy first

**No LLM calls. No telemetry. No code upload.** Jambavan stores indexes, cache, and memories locally under `.jambavan/` by default. Read/search/list tools are on by default; file writes and shell execution are not advertised unless you opt in with `JAMBAVAN_ALLOW_WRITE=1` or `JAMBAVAN_ALLOW_BASH=1`.

## Before / after

| Without Jambavan | With Jambavan |
|---|---|
| Agent rereads whole files and burns tokens. | Agent retrieves ranked symbols, callers, tests, and recent diff. |
| Decisions vanish between sessions. | Durable markdown memory survives across hosts and models. |
| Failed fixes get retried. | Failure records say what failed, why, and what not to retry. |
| PR review starts from raw changed files. | Review pack maps touched files to symbols, callers, tests, and risk. |

## Works with

| Host | Status | Setup |
|---|---|---|
| Claude Code | supported | `claude mcp add jambavan -- npx -y jambavan` |
| Cursor | supported | `.cursor/mcp.json` |
| Codex CLI | supported | `codex mcp add jambavan -- npx -y jambavan` |
| Continue | supported | `~/.continue/mcpServers/jambavan.json` |
| Any MCP client | supported | command: `npx -y jambavan` |

What it gives the model:

- **Indexed context** — ranked symbols, callers, tests, and recent diff without dumping whole files.
- **Durable memory** — decisions and handoffs stored as local markdown under `.jambavan/memory/`.
- **Failure immunity** — prior failed commands and root causes are searchable before the next retry.
- **Review intelligence** — MCP and CLI review packs map touched files to symbols, graph callers, tests, touched rin debt, and past failures.
- **Local graph and GUI** — searchable code relationships, rin debt, failure hotspots, and node details served from localhost.

## Why not just grep?

Grep finds text. Jambavan gives the model indexed symbols, token-budgeted snippets, callers, tests, recent diffs, durable memory, failure history, and review risk flags — without uploading code or running embeddings.

## Killer use case

You are three sessions into a refactor. Claude forgot the design decision, retries the same failed test fix, and wants to reread half the repo. Jambavan recalls the decision, finds the previous failure record, retrieves only the relevant symbols/callers/tests, and exports a handoff when the session ends.

## The Name

In the Ramayana, when the army despaired at the ocean's edge, **Jambavan** reminded Hanuman of his forgotten strength. Large language models already know how to reason and write code; what they lack is awareness of the ground they stand on: which files exist, what calls what, what was decided last week, and what already failed.

## The powers it hands over

| Power | Tools | What it does |
|---|---|---|
| **Sight** | `jambavan_index`, `jambavan_context`, `jambavan_watch`, `jambavan_diagnostics`, `jambavan_doctor` | AST-aware code index: tree-sitter extracts symbols/references, SQLite stores them under `.jambavan/`, and the watcher keeps it incremental. Retrieve ranked, token-budgeted context instead of re-reading whole files. `jambavan_context` also takes `compress_prose`, `include_diff` (recent git changes per symbol), and `include_tests` (associated test files) — enrichments share the same token budget, not added on top. `jambavan_doctor` is the one-shot health check for root detection, parser backends, gates, memory dir, CI, and index/watcher status. `npx jambavan daemon start\|stop\|status` runs the same watcher standalone in a detached background process (PID file at `.jambavan/daemon.pid`), so the index stays live even between MCP sessions. |
| **The bridge** | `jambavan_graph_report`, `jambavan_graph_query`, `jambavan_graph_path` | A **lightweight inferred code graph** — callers, callees, imports, mentions — built from AST-extracted references matched **by symbol name** (not scope-resolved). Direct `import` statements are resolved to their actual source file, so an ambiguous call between two same-named symbols links to the one actually imported; unresolved calls still fan out by name. Edges are labelled `EXTRACTED` (from the AST) or `INFERRED` (name mention); verify before large refactors. `npx jambavan gui` renders the same graph, plus rin debt and failure records, as a local, dependency-free force-directed view in your browser. |
| **Memory** | `jambavan_memory_store`, `jambavan_memory_search`, `jambavan_memory_recall`, `jambavan_memory_mine_session`, `jambavan_memory_invalidate`, `jambavan_memory_delete`, `jambavan_memory_status` | Durable, human-readable memory as markdown files under `.jambavan/memory/`. BM25 search, no database, no embeddings, no external service. Decisions survive across sessions and models. |
| **Session continuity** | `jambavan_failure_store`, `jambavan_failure_search`, `jambavan_session_export`, `jambavan_session_import` | Structured failure records (command, symptom, root cause, do-not-retry advice) so a fresh session doesn't repeat a dead end. `jambavan_session_export` produces a single portable handoff document (decisions, open/resolved failures, dirty files, next command, git status) to resume work in a new session, host, or with a colleague. `npx jambavan handoff --write-pr-template` injects the same card into a local PR template; `npx jambavan html-handoff` writes a self-contained browser report. |
| **Review pack** | `jambavan_review_pack` | Diffs the current branch against a base (auto-detects `main`/`master`), then for each touched file lists its symbols, callers (via the graph), associated tests, and risk flags — touched rin debt, no matching test, or past failures. `npx jambavan review-pack --format json` emits the same analysis as structured JSON for CI/PR comments. |
| **Sankshipta** *(brevity)* | `jambavan_sankshipta` | Deterministically compress prose and prompts to fewer tokens while preserving code, paths, versions, and facts. |
| **Vibhishana Niti** *(wise counsel)* | `jambavan_vibhishana_niti`, `jambavan_rin_mochan` | Activate an efficient-dev discipline mid-session, and audit deliberate shortcuts (`// rin:` markers) into a tracked debt ledger. |
| **Counsel** *(discipline protocols)* | `jambavan_mool_kaaran`, `jambavan_praman`, `jambavan_yukti`, `jambavan_vibhaajan` | Four discipline protocols: root-cause investigation before debugging, verification gates before claiming completion, approach strategy before multi-step tasks, and parallel decomposition for independent sub-units. |
| **The hands** | `read_file`, `search`, `list_files` (default) · `write_file`, `patch_file`, `bash` (opt-in) | Guarded file, search, and shell tools — confined to the project root. Read-only tools are on by default; **mutating and shell tools are OFF unless you opt in** (see [Safety](#safety)). `bash` has a best-effort footgun filter (not a security boundary). |
| **The reminder** | `jambavan_awaken` | Reminds the model of every power above, plus the session protocol and recent project memories. Call it first. |

### Functional aliases

The Sanskrit/Ramayana names remain stable, but Jambavan also exposes English aliases for model recall and searchability: `root_cause` (`jambavan_mool_kaaran`), `verify_gate` (`jambavan_praman`), `strategy_plan` (`jambavan_yukti`), `decompose_task` (`jambavan_vibhaajan`), `dev_rules` (`jambavan_vibhishana_niti`), `debt_ledger` (`jambavan_rin_mochan`), and `compress_prompt` (`jambavan_sankshipta`, write-gated).

## Real outputs

`jambavan_context "review pack"` returns focused code spans instead of whole files:

```text
# Jambavan Context
query: review pack
budget: 8000 tokens

## src/tools/review-pack.ts: buildReviewPack
kind: function · score: 0.92
Uses git diff to list touched files, maps symbols from the index, adds callers via graph,
associated tests via test-map, and risk flags for rin debt / missing tests / failures.
```

`jambavan_review_pack` turns a branch into reviewer-ready context:

```text
# Jambavan Review Pack
Base: main
Touched files: src/mcp/server.ts, src/mcp/tool-aliases.ts

src/mcp/server.ts
- touched symbols: startServer, handleToolCall
- callers: dist/index.js → startServer
- associated tests: test/tool-aliases.test.ts
- risk flags: write-gated tool alias; verify disabled-tool listing
```

The CLI form is useful outside an MCP host and in CI:

```bash
npx jambavan review-pack --base origin/main --format json --max-files 30
```

JSON output uses `touchedCount`, `files[]`, `rinMarkers[]` for rin debt in touched files only, and `failures[]` for prior failure records mentioning touched paths. The sample workflow in [`.github/workflows/jambavan-review.yml`](.github/workflows/jambavan-review.yml) renders that JSON into an idempotent PR comment.

`jambavan_failure_search "timeout"` prevents repeat dead ends:

```text
FailureRecord: flaky auth test timeout
Root cause: unawaited promise in token refresh mock.
Do not retry: increasing the test timeout; it hid the race.
Next check: run the focused auth test with fake timers enabled.
```

`jambavan_awaken` gives the host a session protocol plus recent memories:

```text
1. Recall durable memories for this project.
2. Run jambavan_index, then jambavan_watch start.
3. Use jambavan_context before edits.
4. Store durable decisions and failures before handoff.
```

## Install

One command. Finds every coding agent on your machine (Claude Code, Codex CLI, Cursor, Continue). Registers Jambavan as an MCP server for each one it finds.

```bash
# macOS · Linux · WSL · Git Bash
curl -fsSL https://raw.githubusercontent.com/beingmartinbmc/jambavan/main/install.sh | bash
```

```powershell
# Windows · PowerShell 5.1+
irm https://raw.githubusercontent.com/beingmartinbmc/jambavan/main/install.ps1 | iex
```

~30 seconds. Needs Node ≥20. Skips agents you don't have. Safe to re-run. It never touches other MCP servers already in your config — read the script before piping it into a shell, as with anything on the internet.

## Register manually

Prefer to wire it up yourself, or use an agent the installer doesn't know about? Same command everywhere: `npx -y jambavan`.

**Claude Code**

```bash
claude mcp add jambavan -- npx -y jambavan
```

**Codex CLI**

```bash
codex mcp add jambavan -- npx -y jambavan
```

**Cursor** (`~/.cursor/mcp.json` global, or `.cursor/mcp.json` per-project)

```json
{
  "mcpServers": {
    "jambavan": { "command": "npx", "args": ["-y", "jambavan"] }
  }
}
```

**Continue** — drop a JSON file into `~/.continue/mcpServers/jambavan.json`:

```json
{ "command": "npx", "args": ["-y", "jambavan"] }
```

### Troubleshooting (NVM, GUI apps, corporate npm)

`npx -y jambavan` works when the MCP host inherits a shell PATH containing `node`/`npx` and npm can reach the public registry. Two setups break that:

**1. GUI-launched hosts (Cursor, etc.) don't see NVM.** You'll see `spawn npx ENOENT`, or — after switching to an absolute `npx` — `env: node: No such file or directory` (because `npx` is a script with `#!/usr/bin/env node`). GUI apps launched outside your shell don't inherit NVM's PATH. Fix: run an absolute `node` against npm's `npx-cli.js` and set `PATH` explicitly.

**2. Corporate npm registry / release-age policy.** You'll see `No versions available for jambavan` (npm pointed at an internal mirror that doesn't proxy it) or `No matching version found ... with a date before <date>` (an `--before` / release-age policy rejecting a freshly published version). Fix: force the public registry, clear `--before`, and pin the version.

In Claude Code this can surface as `-32000` / `failed to reconnect`, because the MCP server process never starts cleanly. Check the MCP server logs for the npm error, then apply the same npm/PATH fix in `.claude.json`.

Find your paths:

```bash
command -v node                                   # → /abs/path/to/node
echo "$(npm prefix -g)/lib/node_modules/npm/bin/npx-cli.js"   # → npx-cli.js
```

Cursor config with all workarounds applied:

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
        "jambavan@0.5.3"
      ],
      "env": { "PATH": "/abs/path/to/node/dir:/usr/bin:/bin" }
    }
  }
}
```

Apply only the pieces you need: the absolute `node` + `npx-cli.js` + `PATH` fixes NVM/GUI PATH; `--registry`/`--before`/pinned version fix corporate npm policy.

Claude Code `.claude.json` uses the same shape. Put npm policy overrides and the project root in `env` so reconnects do not fall back to an empty environment:

```json
{
  "mcpServers": {
    "jambavan": {
      "command": "/abs/path/to/node",
      "args": ["/abs/path/to/npm/bin/npx-cli.js", "-y", "jambavan@0.5.3"],
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

## Claude Code plugin

This repo is also a Claude Code [plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces). Add it and install with two commands — no manual MCP config:

```shell
/plugin marketplace add beingmartinbmc/jambavan
/plugin install jambavan@jambavan
```

The plugin registers the same `npx -y jambavan` MCP server (read-only tools by default) and bundles five skills in any Claude Code session: `/jambavan:vibhishana-niti` (efficient-dev discipline), `/jambavan:using-jambavan` (tool session protocol — index → context → memory), `/jambavan:root-cause-debugger` (observe/compare/hypothesize/fix before any bug fix), `/jambavan:release-checker` (evidence gate before claiming tests/build/fix/release are done), and `/jambavan:strict-reviewer` (severe-senior-engineer review checklist, built on `jambavan_review_pack`). Refresh later with `/plugin marketplace update jambavan`. The catalog lives in [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json); the plugin manifest in [`plugins/jambavan/.claude-plugin/plugin.json`](plugins/jambavan/.claude-plugin/plugin.json).

## Examples

- [Claude Code setup](examples/claude-code.md) — `claude mcp add jambavan -- npx -y jambavan`
- [Cursor setup](examples/cursor.md) — `.cursor/mcp.json`
- [Codex CLI setup](examples/codex.md) — `codex mcp add jambavan -- npx -y jambavan`
- [Continue setup](examples/continue.md) — `~/.continue/mcpServers/jambavan.json`
- [Review pack output](examples/review-pack.md) — MCP, CLI JSON, and GitHub Action review-pack shapes

## Run directly

```bash
npm install
npm run build
node dist/index.js --help
node dist/index.js
```

Set `JAMBAVAN_ROOT=/path/to/project` when launching from outside the target repo.

## Fix first-run root confusion

Jambavan resolves the project root in this order: explicit `JAMBAVAN_ROOT`, MCP `roots/list` from the host, then a walk up from the server process cwd. Some MCP hosts start servers with `cwd=$HOME`; if they also do not answer `roots/list`, Jambavan can treat your home directory as the project and index far too much.

Run `jambavan_doctor` or `npx jambavan doctor` first. If it reports `Project root: ... (source: cwd-fallback)` and the path is `$HOME` or a parent folder containing many repos, set `JAMBAVAN_ROOT` in that MCP server's config and reconnect. Point it at exactly one repo root, not `~/repositories`, `$HOME`, or a monorepo parent unless that whole tree is the project you want indexed.

For Claude Code, put it under the server's `.claude.json` `env` block:

```json
{
  "mcpServers": {
    "jambavan": {
      "env": { "JAMBAVAN_ROOT": "/abs/path/to/one/repo" }
    }
  }
}
```

After reconnecting, run doctor again. The healthy result is the target repo with `source: env` (explicit) or `source: client-roots` (host supplied).

## The leap (recommended workflow)

1. `jambavan_awaken` — read the protocol and recent project memories.
2. `jambavan_index` — build the local AST-backed index (tree-sitter parse, SQLite storage in `.jambavan/`).
3. `jambavan_watch start` — keep the index live while editing.
4. `jambavan_context` — pull ranked, token-budgeted context *before* touching unfamiliar code.
5. `patch_file` over `write_file` — surgical edits, cheaper tokens. *(needs `JAMBAVAN_ALLOW_WRITE=1`)*
6. Keep tool output Sankshipta: line ranges, `max_results`, `git --stat` / `--name-only`, `jq`/`yq`/`awk`/`cut`/`head`, quiet/no-color flags, and hash/mtime polling before full reads.
7. `bash` — run the smallest relevant check. *(needs `JAMBAVAN_ALLOW_BASH=1`)*
8. `jambavan_memory_store` / `jambavan_memory_mine_session` — persist what was decided, so the next session starts awake.
9. Hit a dead end? `jambavan_failure_store` it (symptom, root cause, what NOT to retry) — and `jambavan_failure_search` before repeating a failing approach.
10. Ending the session? `jambavan_session_export` — paste the handoff document into the next session, a different host, or a colleague.

## Safety

**Read-only by default.** `read_file`, `search`, and `list_files` are always available. The mutating and shell tools are **off unless you explicitly opt in**, because an autonomous host model should not get write/exec access by accident:

| Tool(s) | Enable with |
|---|---|
| `write_file`, `patch_file`, `jambavan_sankshipta` | `JAMBAVAN_ALLOW_WRITE=1` |
| `bash` | `JAMBAVAN_ALLOW_BASH=1` |

When disabled, these tools are not registered at all — the host never sees them. (`jambavan_sankshipta` rewrites files in place, so it counts as a write tool.)

File, search, list, and `bash` working directories are confined to `JAMBAVAN_ROOT` (or the detected project root). Set `JAMBAVAN_ALLOW_OUTSIDE_ROOT=1` only for trusted local use. Files that look like secrets (`.env*`, `*.pem`/`*.key`, `id_rsa`, `.npmrc`, `.aws/credentials`, `.git-credentials`, `service-account*.json`, and anything inside `.aws/`, `.docker/`, or `.ssh/`, …) are refused by all file tools unless `JAMBAVAN_ALLOW_SECRETS=1`. This list is deliberately non-exhaustive — it is not a substitute for keeping real secrets out of the repo.

`bash` runs with a minimal no-color environment (host secrets are not inherited unless `JAMBAVAN_BASH_INHERIT_ENV=1`) and catches a few obvious footguns (`rm -rf /`, `rm -rf /*`, home/project wipes, `git reset --hard`, `git clean -fx`, blind `curl | sh`, and similar). This is **not** a security boundary — it is trivially bypassed by encoding, aliases, scripts, shell expansion, or unlisted commands like `find . -delete`. Treat `bash` as a local shell: review tool calls before approving them, and run the server inside a sandboxed workspace (container / microVM) if you need real isolation.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `JAMBAVAN_ROOT` | auto-detect | Project root to index and serve; set this explicitly when the MCP host starts Jambavan outside the target repo |
| `JAMBAVAN_MEMORY_HOME` | `<indexDir>/memory` | Where OKF memory docs live; point at a shared palace to reuse memory across projects |
| `JAMBAVAN_TOKEN_BUDGET` | `8000` | Max tokens in `jambavan_context` output |
| `JAMBAVAN_DEV_MODE` | `full` | Default Vibhishana Niti level (`lite` / `full` / `ultra`) |
| `JAMBAVAN_ALLOW_WRITE` | off | `1` registers `write_file` + `patch_file` + `jambavan_sankshipta` |
| `JAMBAVAN_ALLOW_BASH` | off | `1` registers `bash` |
| `JAMBAVAN_ALLOW_OUTSIDE_ROOT` | off | `1` lets tools escape the project root (trusted local use only) |
| `JAMBAVAN_ALLOW_SECRETS` | off | `1` lets file tools touch secret-looking files |
| `JAMBAVAN_BASH_INHERIT_ENV` | off | `1` passes the full host env to `bash` (default: minimal env) |
| `JAMBAVAN_MAX_OUTPUT_CHARS` | `100000` | Global cap on any tool's returned output |
| `JAMBAVAN_MAX_READ_BYTES` | `5242880` | Max file size `read_file` will load |

## Benchmark

`npm run bench` dogfoods the real pipeline — no LLM calls, no external services, fully deterministic. It auto-derives queries from the repo's own most common symbols, so it's meaningful on any codebase. It measures **five** dimensions, not just token savings, and every number below is a fresh run against this repo (43 files, 181 symbols):

**1. Index** — build speed and throughput.

| metric | value |
|---|---|
| cold build | ~148 ms (43 files, 181 symbols) |
| warm re-index | ~27 ms (**~5.5× faster**, only changed files re-parsed) |
| throughput | ~291 files/s · ~1,223 symbols/s |

**2. Context** — not only tokens, but *how much the agent has to open*. Baseline = an agent reads the full contents of every file a query matches; jambavan ships ranked, budgeted snippets instead.

| metric | baseline | jambavan | win |
|---|---|---|---|
| files/snippets to read | 11 whole files | 23 focused chunks | targeted spans, not whole files |
| tokens (5 queries) | ~25,800 | ~14,900 | **~42% fewer** |
| assemble latency | (disk reads) | ~3 ms | below one check's runtime |

**3. Graph** — relationships extracted from the AST (a coverage metric, not tokens).

| metric | value |
|---|---|
| nodes / edges | 216 / 502 |
| edge provenance | 295 `EXTRACTED` (from AST) · 207 `INFERRED` (name mention) |
| build / query / path | ~2.6 ms / ~7.8 ms / ~0.1 ms |

**4. Sankshipta** — prose compression holds steady around **24%**.

**5. Tool latency** — every tool advertised by the benchmark server, with write and bash gates enabled, timed over the real stdio transport (the same request/response path a host model uses): min/median/max over 10 calls for read-only tools, single-shot for mutating ones. Representative medians:

| tool | median | tool | median |
|---|---|---|---|
| `jambavan_context` | 0.2 ms | `jambavan_memory_search` | 0.2 ms |
| `jambavan_graph_query` | 0.3 ms | `jambavan_awaken` | 2.0 ms |
| `jambavan_graph_path` | 0.2 ms | `jambavan_index` (1 file) | 12.6 ms |
| `read_file` | 0.2 ms | `search` (ripgrep) | 11.3 ms |
| `list_files` | 0.2 ms | `bash` (subprocess) | 14.5 ms |
| `jambavan_mool_kaaran` / `jambavan_praman` / `jambavan_yukti` / `jambavan_vibhaajan` | 0.1 ms | `jambavan_session_export` (2 git calls) | 50.4 ms |

Everything driven purely in-process is sub-millisecond — including the four counsel/discipline-protocol tools, which are pure string builders; the outliers (`index`, `search`, `bash`, `session_export`) are the ones that shell out or touch disk, exactly as expected. Every call succeeds — the benchmark exits non-zero if any tool errors, so it doubles as an end-to-end smoke test.

**The larger the codebase, the bigger the win.** The same benchmark run against a mid-size Java service (166 files, ~1,000 symbols) — every dimension scales in Jambavan's favour:

| dimension | this repo (38 files, 177 symbols) | a mid-size Java service (166 files, ~1,000 symbols) |
|---|---|---|
| cold index | ~164 ms | ~577 ms |
| incremental re-index | ~5.7× faster | ~8.4× faster |
| context tokens saved | ~44% | **~87%** |
| files→chunks (5 queries) | 6 files → 14 chunks | 80 files → 133 chunks |
| graph edges extracted | 564 | ~10,400 |

Incremental re-index and per-query context stay roughly flat while a from-scratch read grows with the repo, so the token savings widen as the codebase grows. Baseline is a conservative comparison — per-query results vary, and occasionally a query whose matches sit in tiny files reads cheaper whole than as ranked snippets. Run it on yours:

```bash
JAMBAVAN_ROOT=/path/to/your/repo npm run bench
```

Add `--json` (`node dist/benchmark.js --json`) for the same data as a single machine-readable object instead of tables — same run, same numbers, no extra instrumentation.

## Badges

`npx jambavan badges` prints three local markdown lines you can paste into a README:

```bash
npx jambavan badges
```

The lines summarize benchmark context-token savings for the current repo, Rin Ledger debt markers (`// rin:` comments), and Failure Immunity (`FailureRecord` memories in the default project scope). The command makes no network calls; it runs the local benchmark and reads local repo/memory state.

If you want rendered badge images instead of plain markdown text, use a [shields.io static badge](https://shields.io/badges/static-badge) URL explicitly. That makes README renders fetch from shields.io's CDN, so Jambavan leaves it as an opt-in choice.

## Memory Bridge (MemPalace)

`jambavan bridge` converts Jambavan memories to/from a portable markdown folder tree — no network call, ever. MemPalace's real store is a vector index, not plain files, so Jambavan can't write into it directly; instead:

```bash
npx jambavan bridge --to mempalace [--out <dir>] [--scope <scope>]   # default out: .jambavan/bridge/mempalace
npx jambavan bridge --from mempalace [--in <dir>]                    # default in:  .jambavan/bridge/mempalace
```

`--to mempalace` writes one file per memory under `<dir>/<wing>/<room>/<title>.md` (wing = Jambavan scope, room = decisions/problems/technical inferred from memory type) using Jambavan's own frontmatter format unchanged. Hand that tree to your host model and ask it to walk the files and call `mempalace_add_drawer(wing, room, title, content)` per file. `--from mempalace` is the reverse: point it at a tree written the same way (e.g. after the host model runs `mempalace_list_drawers` + `mempalace_get_drawer` and saves the results) to import every file into Jambavan's own store.

`--scope` is the memory namespace. By default Jambavan derives it from the repo folder plus a short hash of the absolute path, so two repos named `api` do not collide; override it only when you intentionally want to share or import a specific memory namespace.

## PR Handoff

`npx jambavan handoff --write-pr-template` runs the same handoff card as `jambavan_session_export` and injects it as a collapsible, HTML-comment-bounded block into `.github/pull_request_template.md` (creating the file if it doesn't exist). Re-running replaces the prior block in place — safe to run repeatedly as work continues. No network call.

```bash
npx jambavan handoff --write-pr-template [--scope <scope>]
npx jambavan handoff --write-pr-template --post   # also posts the handoff as a comment via your own `gh` CLI
```

`--post` is opt-in and off by default: it shells out to your already-authenticated `gh pr comment` (same trust boundary as the `bash` tool) so a reviewer sees session context without leaving GitHub. If you want this to run automatically, wire it into a local `.git/hooks/pre-push` hook yourself — Jambavan doesn't install one for you.

## HTML Handoff

`npx jambavan html-handoff` writes a self-contained HTML report for humans: memory timeline grouped into decisions/failures/other, rin debt, indexed symbol count, dirty files, recent commits, collapsible sections, and a copy-text button. It has no external CDN or telemetry.

```bash
npx jambavan html-handoff                         # writes jambavan-handoff.html in the project root
npx jambavan html-handoff --out /tmp/handoff.html # choose an output path
npx jambavan html-handoff --scope my-scope        # read a specific memory scope
```

## Background Daemon

`npx jambavan daemon start` runs the same `FileWatcher` used by `jambavan_watch` standalone, in a detached background process — the index keeps updating on save even when no MCP host is attached. It writes a PID file to `.jambavan/daemon.pid` and logs to `.jambavan/daemon.log`.

```bash
npx jambavan daemon start    # spawns a detached watcher, writes .jambavan/daemon.pid
npx jambavan daemon status   # reports pid + liveness (or "stale" if the process died without cleanup)
npx jambavan daemon stop     # SIGTERMs the daemon and removes the pid file
```

`jambavan_watch start`, `jambavan_watch status`, `jambavan_diagnostics`, and `jambavan_awaken` all check the PID file first and report the daemon as already active instead of starting a redundant in-process watcher.

**Caveat**: many MCP hosts restart the server process every session anyway, which narrows the daemon's practical benefit over just calling `jambavan_watch start` each session — it mainly helps long-lived terminal/CI workflows where nothing else keeps the index warm between tool calls.

## GUI Visualizer

`npx jambavan gui` indexes the project, then serves a small static page — vanilla JS, no D3/React/build step — over Node's built-in `http` module, bound to `127.0.0.1` only:

```bash
npx jambavan gui                 # indexes, serves on :4173, opens your default browser
npx jambavan gui --port 5000     # pick a different port
npx jambavan gui --no-open       # print the URL instead of opening a browser (CI/headless)
```

The page has three tabs: a force-directed **graph** view (same nodes/edges as `jambavan_graph_report`, capped to the 400 highest-degree nodes so large repos stay responsive), the **Rin Debt** ledger (`// rin:` markers), and **Failures** (stored `FailureRecord` memories). The graph view includes search, pan/zoom, rin/failure heat markers, and a click-through detail panel that fetches source snippets, callers, and callees from `/api/node/:id`. All data comes from local JSON endpoints — no external requests, no telemetry.

<p align="center">
  <img src="./assets/gui-screenshot.svg" alt="Local Jambavan GUI showing graph, Rin Debt, and Failures tabs" width="820">
</p>

## Checks

```bash
npm run lint
npm run docs-check  # docs mention the MCP tools and aliases advertised by the server
npm run build
npm run unit        # node:test unit suite (test/*.test.ts)
npm run self-check
npm run tool-check  # every advertised MCP tool over stdio
npm run bench
```

## Social preview

This repo includes [`.github/social-preview.png`](.github/social-preview.png). Set it as the GitHub repository social preview under **Settings → Social preview** so shares explain the project before anyone opens the README.

See [ARCHITECTURE.md](ARCHITECTURE.md) for internals.

---

<p align="center"><sub>If Jambavan saves your agent from rereading, forgetting, or retrying the same failed fix, star the repo — it helps MCP users find local-first tooling.</sub></p>
