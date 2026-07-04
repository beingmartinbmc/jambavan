<p align="center">
  <img src="https://raw.githubusercontent.com/beingmartinbmc/jambavan/main/assets/jambavan.png" alt="Jambavan — the wise elder awakening latent power" width="640">
</p>

<h1 align="center">Jambavan</h1>

<p align="center"><em>The mentor that reminds your model of powers it already has.</em></p>

---

In the Ramayana, when the army despaired at the ocean's edge, it was **Jambavan** — the ancient, wise bear-king — who turned to Hanuman and reminded him of his own forgotten, immeasurable strength. Hanuman had the power all along. He only needed to be reminded. Then he crossed the ocean in a single leap.

A large language model is Hanuman. It can already reason, plan, and write code. What it lacks is not intelligence — it is *awareness of the ground it stands on*: which files exist, what calls what, what was decided last week, what it already tried.

**Jambavan is the voice at the ocean's edge.** It is a [Model Context Protocol](https://modelcontextprotocol.io) server that gives any coding model a live map of the codebase, a durable memory, and a set of surgical tools — so the model's existing power actually lands.

Jambavan does not call an LLM and is not an agent. **The host model thinks. Jambavan gives it the ground to leap from.**

## The powers it hands over

| Power | Tools | What it does |
|---|---|---|
| **Sight** | `jambavan_index`, `jambavan_context`, `jambavan_watch`, `jambavan_diagnostics` | AST-aware code index (tree-sitter, incremental, live-watched). Retrieve ranked, token-budgeted context instead of re-reading whole files. |
| **The bridge** | `jambavan_graph_report`, `jambavan_graph_query`, `jambavan_graph_path` | A **lightweight inferred code graph** — callers, callees, imports, mentions — built from AST-extracted references matched **by symbol name** (not scope-resolved). Traverse relationships and find the shortest path between two symbols. Edges are labelled `EXTRACTED` (from the AST) or `INFERRED` (name mention); verify before large refactors. |
| **Memory** | `jambavan_memory_store`, `_search`, `_recall`, `_mine_session`, `_invalidate`, `_delete`, `_status` | Durable, human-readable memory as markdown files under `.jambavan/memory/`. BM25 search, no database, no embeddings, no external service. Decisions survive across sessions and models. |
| **Sankshipta** *(brevity)* | `jambavan_sankshipta` | Deterministically compress prose and prompts to fewer tokens while preserving code, paths, versions, and facts. |
| **Vibhishana Niti** *(wise counsel)* | `jambavan_vibhishana_niti`, `jambavan_rin_mochan` | Activate an efficient-dev discipline mid-session, and audit deliberate shortcuts (`// rin:` markers) into a tracked debt ledger. |
| **The hands** | `read_file`, `search`, `list_files` (default) · `write_file`, `patch_file`, `bash` (opt-in) | Guarded file, search, and shell tools — confined to the project root. Read-only tools are on by default; **mutating and shell tools are OFF unless you opt in** (see [Safety](#safety)). `bash` has a best-effort footgun filter (not a security boundary). |
| **The reminder** | `jambavan_awaken` | Reminds the model of every power above, plus the session protocol and recent project memories. Call it first. |

## Install / run

```bash
npm install
npm run build
node dist/index.js --help
node dist/index.js
```

Set `JAMBAVAN_ROOT=/path/to/project` when launching from outside the target repo.

## Register with your model

**Claude Code**

```bash
claude mcp add jambavan -- npx -y jambavan
```

**Cursor** (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "jambavan": { "command": "npx", "args": ["-y", "jambavan"] }
  }
}
```

**Codex / Continue** use the same command shape: `npx -y jambavan`.

## The leap (recommended workflow)

1. `jambavan_awaken` — read the protocol and recent project memories.
2. `jambavan_index` — build the local SQLite code index.
3. `jambavan_watch start` — keep the index live while editing.
4. `jambavan_context` — pull ranked, token-budgeted context *before* touching unfamiliar code.
5. `patch_file` over `write_file` — surgical edits, cheaper tokens. *(needs `JAMBAVAN_ALLOW_WRITE=1`)*
6. `bash` — run the smallest relevant check. *(needs `JAMBAVAN_ALLOW_BASH=1`)*
7. `jambavan_memory_store` / `jambavan_memory_mine_session` — persist what was decided, so the next session starts awake.

## Safety

**Read-only by default.** `read_file`, `search`, and `list_files` are always available. The mutating and shell tools are **off unless you explicitly opt in**, because an autonomous host model should not get write/exec access by accident:

| Tool(s) | Enable with |
|---|---|
| `write_file`, `patch_file` | `JAMBAVAN_ALLOW_WRITE=1` |
| `bash` | `JAMBAVAN_ALLOW_BASH=1` |

When disabled, these tools are not registered at all — the host never sees them.

File, search, list, and `bash` working directories are confined to `JAMBAVAN_ROOT` (or the detected project root). Set `JAMBAVAN_ALLOW_OUTSIDE_ROOT=1` only for trusted local use. Files that look like secrets (`.env*`, `*.pem`, `*.key`, `id_rsa`, `.npmrc`, …) are refused by all file tools unless `JAMBAVAN_ALLOW_SECRETS=1`.

`bash` runs with a minimal environment (host secrets are not inherited unless `JAMBAVAN_BASH_INHERIT_ENV=1`) and catches a few obvious footguns (`rm -rf /`, `rm -rf /*`, home/project wipes, `git reset --hard`, `git clean -fx`, blind `curl | sh`, and similar). This is **not** a security boundary — it is trivially bypassed by encoding, aliases, scripts, shell expansion, or unlisted commands like `find . -delete`. Treat `bash` as a local shell: review tool calls before approving them, and run the server inside a sandboxed workspace (container / microVM) if you need real isolation.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `JAMBAVAN_ROOT` | auto-detect | Project root to index and serve |
| `JAMBAVAN_TOKEN_BUDGET` | `8000` | Max tokens in `jambavan_context` output |
| `JAMBAVAN_DEV_MODE` | `full` | Default Vibhishana Niti level (`lite` / `full` / `ultra`) |
| `JAMBAVAN_ALLOW_WRITE` | off | `1` registers `write_file` + `patch_file` |
| `JAMBAVAN_ALLOW_BASH` | off | `1` registers `bash` |
| `JAMBAVAN_ALLOW_OUTSIDE_ROOT` | off | `1` lets tools escape the project root (trusted local use only) |
| `JAMBAVAN_ALLOW_SECRETS` | off | `1` lets file tools touch secret-looking files |
| `JAMBAVAN_BASH_INHERIT_ENV` | off | `1` passes the full host env to `bash` (default: minimal env) |
| `JAMBAVAN_MAX_OUTPUT_CHARS` | `100000` | Global cap on any tool's returned output |
| `JAMBAVAN_MAX_READ_BYTES` | `5242880` | Max file size `read_file` will load |

## Benchmark

`npm run bench` dogfoods the real pipeline — no LLM calls, no external services, fully deterministic. It auto-derives queries from the repo's most common symbols, then measures index speed, context tokens vs. the naive "open every matched file" baseline, and compression ratio. Point it at any repo with `JAMBAVAN_ROOT`.

| repo | files | symbols | cold index | warm re-index | context tokens saved |
|---|---|---|---|---|---|
| this repo (TypeScript) | 31 | 116 | 149 ms | 42 ms (**3.5×**) | **53%** |
| a mid-size Java service | 63 | 614 | 283 ms | 22 ms (**12.9×**) | **62%** |

**The larger the codebase, the bigger the win.** Incremental re-index stays roughly flat (only changed files are re-parsed) while a from-scratch read grows with the repo. Prose compression (`jambavan_sankshipta`) holds steady around **24%**.

Baseline = the full contents of every file containing a match, which is what an agent reads today without an index. It's a conservative comparison, and per-query results vary — occasionally a query whose matches sit in tiny files reads cheaper whole than as ranked snippets. Run it on yours:

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
