<h1 align="center">Jambavan</h1>

<p align="center"><em>Your coding agent forgets your repo every session. This is the fix.</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/jambavan"><img src="https://img.shields.io/npm/v/jambavan.svg" alt="npm version"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/jambavan.svg" alt="node version"></a>
  <a href="https://github.com/beingmartinbmc/jambavan/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/beingmartinbmc/jambavan/ci.yml?branch=main" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/jambavan"><img src="https://img.shields.io/npm/dm/jambavan.svg" alt="downloads"></a>
  <a href="https://github.com/beingmartinbmc/jambavan/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/jambavan.svg" alt="license"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/beingmartinbmc/jambavan/main/assets/jambavan.png" alt="Ramayana-inspired Jambavan and Hanuman hero image showing local memory, codebase awareness, review packs, compact context, and privacy for MCP coding agents" width="820">
</p>

Jambavan is a local-first [Model Context Protocol](https://modelcontextprotocol.io) server. It gives Claude Code, Cursor, Codex, Continue, and any other MCP host a persistent memory of your repository: an AST-backed symbol index, durable project decisions, a ledger of dead ends already tried, and branch review context.

**No LLM calls. No telemetry. No code upload.** Source-mutating and shell tools are off unless you turn them on.

```bash
claude mcp add jambavan -- npx -y jambavan
```

## Measured, not claimed

Run against [react/react](https://github.com/react/react) at commit `9ceb1e7` — 4,615 files, 20,595 symbols, Node 24 on macOS arm64:

| | Result |
|---|---|
| Context tokens vs reading every matching file | **9,207 instead of 261,816 — 96% less** |
| Cold index | 8.5 s (552 files/s) |
| Unchanged re-index | 1.2 s (7.2x faster) |
| Context retrieval | 1.2–3.6 ms per query |
| Tool schema your host pays for every request | 20 tools, 3,423 tokens (down from 38 tools / 5,680 in 1.x) |

Reproduce it in three commands:

```bash
git clone --depth 1 https://github.com/react/react.git /tmp/react
npm run build
JAMBAVAN_ROOT=/tmp/react node dist/benchmark.js
```

The savings are not uniform, and the [full proof card](https://github.com/beingmartinbmc/jambavan/blob/main/examples/proof-card-react.md) publishes the weak cases too: one query saved 99%, another only 42% because its matches lived in tiny fixture files. Savings scale with how large the files a query lands in are. This is a retrieval benchmark — it measures token cost and latency, not task correctness.

<p align="center">
  <img src="https://raw.githubusercontent.com/beingmartinbmc/jambavan/main/assets/30-second-demo.gif" alt="Under-30-second Jambavan storyboard showing connection, indexing, context retrieval, repeat-failure guard, impact analysis, and review pack" width="820">
  <br>
  <sub>Illustrative storyboard; exact output depends on the repository, host, and enabled tools.</sub>
</p>

## Why it exists

Without an index or saved memory, rediscovering a project costs work proportional to the area searched: O(n) files opened, every session, forever. Jambavan persists that work. Index refresh still discovers and hashes candidate files in O(n files), but reparses only files whose content changed.

In the Ramayana, before Hanuman's leap to Lanka, Jambavan reminds him of the strength he already possesses. This project borrows that metaphor narrowly: it restores access to knowledge that was already indexed or stored. It does not make a model smarter.

## Quick start

```bash
claude mcp add jambavan -- npx -y jambavan
npx jambavan doctor
```

Then ask your host model to run:

```text
jambavan_awaken {}
jambavan_index {}
jambavan_watch { "action": "start" }
jambavan_context { "query": "where is auth handled?" }
```

`jambavan_doctor` checks project-root detection, parser backends, gates, archive state, CI hints, and index/watcher status. When root resolution stays at `cwd-fallback`, memory tools still work; repository-bound tools fail closed. See [troubleshooting](https://github.com/beingmartinbmc/jambavan/blob/main/docs/troubleshooting.md) if that happens.

## Install

One command. Finds Claude Code, Codex CLI, Cursor, and Continue on your machine and registers Jambavan for each one it finds.

On macOS, Linux, WSL, or Git Bash:

```bash
curl -fsSL https://raw.githubusercontent.com/beingmartinbmc/jambavan/main/install.sh | bash
```

On Windows, in PowerShell 5.1+:

```powershell
irm https://raw.githubusercontent.com/beingmartinbmc/jambavan/main/install.ps1 | iex
```

Needs Node >=20.19.0 <27. Safe to re-run; it skips agents you do not have and does not remove other MCP servers. As with any internet shell script, read it before piping it into a shell.

### Manual registration

Same MCP command everywhere: `npx -y jambavan`.

| Host | Setup |
|---|---|
| Claude Code | `claude mcp add jambavan -- npx -y jambavan` |
| Codex CLI | `codex mcp add jambavan -- npx -y jambavan` |
| Cursor | add to `.cursor/mcp.json` |
| Continue | add to `~/.continue/config.yaml` |
| Any MCP client | command: `npx -y jambavan` |

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

Restart the host after any config change, then run `jambavan_awaken` and `jambavan_doctor` to confirm. Continue exposes MCP tools only in Agent mode.

Check installed and published versions:

```bash
npx jambavan --version
npm view jambavan version
```

To uninstall, run `claude mcp remove jambavan` or `codex mcp remove jambavan`; for Cursor and Continue, delete the `jambavan` entry. Local `.jambavan/` indexes and memories are left intact.

## The tools

Twenty tools, deliberately. Every advertised tool costs your host model tokens on every request whether or not it is ever called, so the surface is kept small on purpose.

| Group | Tools | What the agent gets |
|---|---|---|
| **Sight** | `jambavan_index`, `jambavan_context`, `jambavan_watch`, `jambavan_doctor` | AST-backed symbol index, token-budgeted context with bounded extracted call neighbors, optional tests and recent diff, live watching, and root health. |
| **Bridge** | `jambavan_graph`, `jambavan_impact` | Code-graph report, query, and shortest path in one tool, plus changed-symbol inbound impact and test analysis. |
| **Memory** | `jambavan_memory_store`, `jambavan_memory_read`, `jambavan_memory_forget`, `jambavan_memory_mine_session`, `jambavan_memory_status` | Rootless local Markdown memory, logical collections, and explicit read-only MemPalace federation. |
| **Failure memory** | `jambavan_failure_store`, `jambavan_failure_search` | Structured failure records plus an exact-command repeat guard in the opt-in `bash` tool. |
| **Review** | `jambavan_review_pack` | Bounded branch review context: touched symbols, extracted caller candidates, tests, `rin` debt, and past failures. |
| **Debt** | `jambavan_debt_ledger` | Harvests every deliberate-shortcut `// rin:` marker and flags the ones with no upgrade trigger. |
| **Compression** | `jambavan_compress_prompt` | Deterministic prose shortening with protected spans for code, URLs, paths, versions, and env vars. Write-gated. |
| **Awakening** | `jambavan_awaken` | Session protocol: what exists, when to use it, and this project's recent memories. |
| **Hands** | `read_file`, `search`, `list_files`; opt-in `write_file`, `patch_file`, `bash` | Guarded project-root file, search, and shell tools. Mutating and shell tools are disabled unless enabled. |

### Prompts

The discipline protocols are static text with no repository access, so they ship as MCP **prompts** rather than tools — they cost nothing per request and appear as slash commands in hosts that support them.

| Prompt | Use it |
|---|---|
| `root_cause` | Before debugging. Enforces observe → compare → hypothesize → fix; escalates at 3+ failed attempts. |
| `verify_gate` | Before claiming tests pass, a build succeeds, or a bug is fixed. Demands fresh evidence. |
| `strategy_plan` | Before multi-step work. Scales the plan to task size. |
| `decompose_task` | When sub-units are genuinely independent. |
| `dev_rules` | Vibhishana Niti: YAGNI first, stdlib before dependencies, shortest working diff. |

## Recommended workflow

1. `jambavan_awaken {}` — read the protocol and recent project memories.
2. `jambavan_doctor {}` — confirm project root, gates, storage, and index status.
3. `jambavan_index {}` then `jambavan_watch { "action": "start" }`.
4. `jambavan_context { "query": "<identifier or question>" }` before touching unfamiliar code.
5. `root_cause` / `verify_gate` / `strategy_plan` when debugging, claiming completion, or planning.
6. Run the smallest relevant check.
7. `jambavan_memory_store { "title": "...", "body": "...", "collection": "decisions" }` to persist durable context.
8. `jambavan_failure_store` to record dead ends with root cause and do-not-retry advice.
9. `jambavan_session_handoff {}` to hand off; pass `text` to import one back.

## What the output looks like

`jambavan_context` returns focused spans instead of whole files:

```text
# Jambavan Context: "review pack"
Symbols: 12 included, 18 dropped (budget: 8000 tokens)

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

`jambavan_failure_search { "query": "timeout" }` surfaces a prior dead end before another retry:

```text
FailureRecord: flaky auth test timeout
Root cause: unawaited promise in token refresh mock.
Do not retry: increasing the test timeout; it hid the race.
Next check: run the focused auth test with fake timers enabled.
```

## Privacy and safety

Code indexes and caches stay in the active repository's `.jambavan/`; memory and failure documents live in `~/.jambavan/memory` by default. Both generated-state roots get a nested `.gitignore` with `*`. These operational writes still happen when source mutation is disabled.

Source-mutating and shell tools are not advertised unless you opt in:

| Tool(s) | Enable with |
|---|---|
| `write_file`, `patch_file`, `jambavan_compress_prompt` | `JAMBAVAN_ALLOW_WRITE=1` |
| `bash` | `JAMBAVAN_ALLOW_BASH=1` |

Direct path arguments to file, search, and list tools, plus the `bash` working directory, are confined to `JAMBAVAN_ROOT` or the detected project root. The same guard refuses known secret-file basenames, extensions, and immediate parent directories unless `JAMBAVAN_ALLOW_SECRETS=1`. This is a direct-path guard, not content scanning, and it does not stop an enabled shell command from reading files.

`bash` uses a minimal no-color environment and blocks a few obvious footguns such as `rm -rf /`, `git reset --hard`, `git clean -fx`, and blind `curl | sh`. It redacts and stores failed-command records locally; once the same unresolved command fails unchanged again, a do-not-retry record can block another exact retry unless `retry_known_failure=true`. **These checks are not a security boundary.** Treat the tool like a local shell and sandbox the workspace if you need isolation.

MemPalace is never contacted during ordinary recall, context enrichment, or awakening — only when a memory read explicitly sets `provider`. See [memory docs](https://github.com/beingmartinbmc/jambavan/blob/main/docs/memory.md).

## Configuration

| Env var | Default | Description |
|---|---|---|
| `JAMBAVAN_ROOT` | auto-detect | Project root to index and serve |
| `JAMBAVAN_SCOPE` | Git-derived | Validated clone-independent scope override |
| `JAMBAVAN_MEMORY_HOME` | `~/.jambavan/memory` | Override for the root-independent OKF archive |
| `JAMBAVAN_MEMPALACE_COMMAND` | `mempalace-mcp` | Executable for explicit read-only MemPalace calls |
| `JAMBAVAN_TOKEN_BUDGET` | `8000` | Max approximate `cl100k_base` tokens in `jambavan_context` |
| `JAMBAVAN_DEV_MODE` | `full` | Default `dev_rules` level (`lite`, `full`, `ultra`) |
| `JAMBAVAN_ALLOW_WRITE` | off | Registers `write_file`, `patch_file`, `jambavan_compress_prompt` |
| `JAMBAVAN_ALLOW_BASH` | off | Registers `bash` |
| `JAMBAVAN_ALLOW_OUTSIDE_ROOT` | off | Disables direct-path project-root containment |
| `JAMBAVAN_ALLOW_SECRETS` | off | Allows direct paths matching the secret-file guard |
| `JAMBAVAN_BASH_INHERIT_ENV` | off | Passes full host env to `bash` |
| `JAMBAVAN_MAX_OUTPUT_CHARS` | `100000` | Global cap on tool output |
| `JAMBAVAN_MAX_READ_BYTES` | `5242880` | Max file size `read_file` loads |

## Upgrading from 1.x

2.0 renamed the Sanskrit tool names to English and merged near-duplicate tools, cutting the advertised surface from 38 tools to 20 and the `tools/list` schema your host pays for on every request from 5,680 tokens to 3,423. **Every old name still works** — retired names are resolved internally, they are just no longer advertised, and `tool-check` fails the build if any of them stops dispatching.

| Was | Now |
|---|---|
| `jambavan_mool_kaaran`, `root_cause` | `root_cause` prompt |
| `jambavan_praman`, `verify_gate` | `verify_gate` prompt |
| `jambavan_yukti`, `strategy_plan` | `strategy_plan` prompt |
| `jambavan_vibhaajan`, `decompose_task` | `decompose_task` prompt |
| `jambavan_vibhishana_niti`, `dev_rules` | `dev_rules` prompt |
| `jambavan_rin_mochan` | `jambavan_debt_ledger` |
| `jambavan_sankshipta` | `jambavan_compress_prompt` |
| `jambavan_graph_report`, `_query`, `_path` | `jambavan_graph` |
| `jambavan_diagnostics` | `jambavan_doctor` |
| `jambavan_memory_get`, `_search`, `_recall` | `jambavan_memory_read` |
| `jambavan_memory_invalidate`, `_delete` | `jambavan_memory_forget` |
| `jambavan_session_export`, `_import` | `jambavan_session_handoff` |

## Claude Code plugin

This repo is also a Claude Code [plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces):

```shell
/plugin marketplace add beingmartinbmc/jambavan
/plugin install jambavan@jambavan
```

## Documentation

- [Architecture and internals](https://github.com/beingmartinbmc/jambavan/blob/main/ARCHITECTURE.md)
- [CLI reference — review packs, GUI, handoffs, badges](https://github.com/beingmartinbmc/jambavan/blob/main/docs/cli.md)
- [Memory, scopes, and MemPalace](https://github.com/beingmartinbmc/jambavan/blob/main/docs/memory.md)
- [Troubleshooting](https://github.com/beingmartinbmc/jambavan/blob/main/docs/troubleshooting.md)
- [Measured proof card (react/react)](https://github.com/beingmartinbmc/jambavan/blob/main/examples/proof-card-react.md)
- Host setup: [Claude Code](https://github.com/beingmartinbmc/jambavan/blob/main/examples/claude-code.md) · [Cursor](https://github.com/beingmartinbmc/jambavan/blob/main/examples/cursor.md) · [Codex CLI](https://github.com/beingmartinbmc/jambavan/blob/main/examples/codex.md) · [Continue](https://github.com/beingmartinbmc/jambavan/blob/main/examples/continue.md)

## Contributing

Read [CONTRIBUTING.md](https://github.com/beingmartinbmc/jambavan/blob/main/CONTRIBUTING.md) before proposing a change. Use the issue forms for bugs and focused feature requests, and report vulnerabilities privately through [SECURITY.md](https://github.com/beingmartinbmc/jambavan/blob/main/SECURITY.md).

```bash
npm run docs-check && npm run lint && npm test && npm run coverage
```

---

<p align="center"><sub>If local project context helps your agent start with less rediscovery, star the repo so more MCP users find it.</sub></p>
