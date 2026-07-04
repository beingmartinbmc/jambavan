<p align="center">
  <img src="https://raw.githubusercontent.com/beingmartinbmc/jambavan/main/assets/jambavan.png" alt="Jambavan — the wise elder awakening latent power" width="640">
</p>

<h1 align="center">Jambavan</h1>

<p align="center"><em>The mentor that reminds your model of powers it already has.</em></p>

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

In the Ramayana, when the army despaired at the ocean's edge, it was **Jambavan** — the ancient, wise bear-king — who turned to Hanuman and reminded him of his own forgotten, immeasurable strength. Hanuman had the power all along. He only needed to be reminded. Then he crossed the ocean in a single leap.

A large language model is Hanuman. It can already reason, plan, and write code. What it lacks is not intelligence — it is *awareness of the ground it stands on*: which files exist, what calls what, what was decided last week, what it already tried.

**Jambavan is the voice at the ocean's edge.** It is a [Model Context Protocol](https://modelcontextprotocol.io) server that gives any coding model a live map of the codebase, a durable memory, and a set of surgical tools — so the model's existing power actually lands.

Jambavan does not call an LLM and is not an agent. **The host model thinks. Jambavan gives it the ground to leap from.**

## The powers it hands over

| Power | Tools | What it does |
|---|---|---|
| **Sight** | `jambavan_index`, `jambavan_context`, `jambavan_watch`, `jambavan_diagnostics` | AST-aware code index (tree-sitter, incremental, live-watched). Retrieve ranked, token-budgeted context instead of re-reading whole files. `jambavan_context` also takes `compress_prose`, `include_diff` (recent git changes per symbol), and `include_tests` (associated test files) — enrichments share the same token budget, not added on top. |
| **The bridge** | `jambavan_graph_report`, `jambavan_graph_query`, `jambavan_graph_path` | A **lightweight inferred code graph** — callers, callees, imports, mentions — built from AST-extracted references matched **by symbol name** (not scope-resolved). Direct `import` statements are resolved to their actual source file, so an ambiguous call between two same-named symbols links to the one actually imported; unresolved calls still fan out by name. Edges are labelled `EXTRACTED` (from the AST) or `INFERRED` (name mention); verify before large refactors. |
| **Memory** | `jambavan_memory_store`, `_search`, `_recall`, `_mine_session`, `_invalidate`, `_delete`, `_status` | Durable, human-readable memory as markdown files under `.jambavan/memory/`. BM25 search, no database, no embeddings, no external service. Decisions survive across sessions and models. |
| **Session continuity** | `jambavan_failure_store`, `jambavan_failure_search`, `jambavan_session_export`, `jambavan_session_import` | Structured failure records (command, symptom, root cause, do-not-retry advice) so a fresh session doesn't repeat a dead end. `jambavan_session_export` produces a single portable handoff document (recent memories, rin debt, git status) to resume work in a new session, host, or with a colleague. |
| **Sankshipta** *(brevity)* | `jambavan_sankshipta` | Deterministically compress prose and prompts to fewer tokens while preserving code, paths, versions, and facts. |
| **Vibhishana Niti** *(wise counsel)* | `jambavan_vibhishana_niti`, `jambavan_rin_mochan` | Activate an efficient-dev discipline mid-session, and audit deliberate shortcuts (`// rin:` markers) into a tracked debt ledger. |
| **The hands** | `read_file`, `search`, `list_files` (default) · `write_file`, `patch_file`, `bash` (opt-in) | Guarded file, search, and shell tools — confined to the project root. Read-only tools are on by default; **mutating and shell tools are OFF unless you opt in** (see [Safety](#safety)). `bash` has a best-effort footgun filter (not a security boundary). |
| **The reminder** | `jambavan_awaken` | Reminds the model of every power above, plus the session protocol and recent project memories. Call it first. |

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
        "jambavan@0.3.0"
      ],
      "env": { "PATH": "/abs/path/to/node/dir:/usr/bin:/bin" }
    }
  }
}
```

Apply only the pieces you need: the absolute `node` + `npx-cli.js` + `PATH` fixes NVM/GUI PATH; `--registry`/`--before`/pinned version fix corporate npm policy.

## Claude Code plugin

This repo is also a Claude Code [plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces). Add it and install with two commands — no manual MCP config:

```shell
/plugin marketplace add beingmartinbmc/jambavan
/plugin install jambavan@jambavan
```

The plugin registers the same `npx -y jambavan` MCP server (read-only tools by default) and bundles a **Vibhishana Niti skill** — run `/jambavan:vibhishana-niti` to activate the efficient-dev discipline in any Claude Code session. Refresh later with `/plugin marketplace update jambavan`. The catalog lives in [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json); the plugin manifest in [`plugins/jambavan/.claude-plugin/plugin.json`](plugins/jambavan/.claude-plugin/plugin.json).

## Run directly

```bash
npm install
npm run build
node dist/index.js --help
node dist/index.js
```

Set `JAMBAVAN_ROOT=/path/to/project` when launching from outside the target repo.

## The leap (recommended workflow)

1. `jambavan_awaken` — read the protocol and recent project memories.
2. `jambavan_index` — build the local SQLite code index.
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
| `JAMBAVAN_ROOT` | auto-detect | Project root to index and serve |
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

`npm run bench` dogfoods the real pipeline — no LLM calls, no external services, fully deterministic. It auto-derives queries from the repo's own most common symbols, so it's meaningful on any codebase. It measures **five** dimensions, not just token savings, and every number below is a fresh run against this repo (38 files, 177 symbols):

**1. Index** — build speed and throughput.

| metric | value |
|---|---|
| cold build | ~164 ms (38 files, 177 symbols) |
| warm re-index | ~29 ms (**~5.7× faster**, only changed files re-parsed) |
| throughput | ~232 files/s · ~1,079 symbols/s |

**2. Context** — not only tokens, but *how much the agent has to open*. Baseline = an agent reads the full contents of every file a query matches; jambavan ships ranked, budgeted snippets instead.

| metric | baseline | jambavan | win |
|---|---|---|---|
| files/snippets to read | 6 whole files | 14 focused chunks | targeted spans, not whole files |
| tokens (5 queries) | ~21,500 | ~12,000 | **~44% fewer** |
| assemble latency | (disk reads) | ~2 ms | below one check's runtime |

**3. Graph** — relationships extracted from the AST (a coverage metric, not tokens).

| metric | value |
|---|---|
| nodes / edges | 209 / 564 |
| edge provenance | 314 `EXTRACTED` (from AST) · 250 `INFERRED` (name mention) |
| build / query / path | ~2.9 ms / ~7.3 ms / ~0.08 ms |

**4. Sankshipta** — prose compression holds steady around **24%**.

**5. Tool latency** — **all 28 tools the MCP server advertises**, timed over the real stdio transport (the same request/response path a host model uses): min/median/max over 10 calls for read-only tools, single-shot for mutating ones. Representative medians:

| tool | median | tool | median |
|---|---|---|---|
| `jambavan_context` | 0.3 ms | `jambavan_memory_search` | 0.2 ms |
| `jambavan_graph_query` | 0.3 ms | `jambavan_awaken` | 1.6 ms |
| `jambavan_graph_path` | 0.2 ms | `jambavan_index` (1 file) | 13.4 ms |
| `read_file` | 0.1 ms | `search` (ripgrep) | 10.3 ms |
| `list_files` | 0.3 ms | `bash` (subprocess) | 11.9 ms |
| `jambavan_failure_search` | 0.2 ms | `jambavan_session_export` (2 git calls) | 40.6 ms |

Everything driven purely in-process is sub-millisecond; the outliers (`index`, `search`, `bash`, `session_export`) are the ones that shell out or touch disk, exactly as expected. Every call succeeds — the benchmark exits non-zero if any tool errors, so it doubles as an end-to-end smoke test.

**The larger the codebase, the bigger the win.** The same benchmark run against a mid-size Java service (166 files, ~1,000 symbols) — every dimension scales in Jambavan's favour:

| dimension | this repo (38 files, 177 symbols) | a mid-size Java service (166 files, ~1,000 symbols) |
|---|---|---|
| cold index | ~164 ms | ~550 ms |
| incremental re-index | ~5.7× faster | ~10× faster |
| context tokens saved | ~44% | **~87%** |
| files→chunks (5 queries) | 6 files → 14 chunks | 80 files → 133 chunks |
| graph edges extracted | 564 | ~10,400 |

Incremental re-index and per-query context stay roughly flat while a from-scratch read grows with the repo, so the token savings widen as the codebase grows. Baseline is a conservative comparison — per-query results vary, and occasionally a query whose matches sit in tiny files reads cheaper whole than as ranked snippets. Run it on yours:

```bash
JAMBAVAN_ROOT=/path/to/your/repo npm run bench
```

## Checks

```bash
npm run lint
npm run build
npm run unit        # node:test unit suite (test/*.test.ts)
npm run self-check
npm run bench
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for internals.

---

<p align="center"><sub>You already have the power. Jambavan only reminds you.</sub></p>
