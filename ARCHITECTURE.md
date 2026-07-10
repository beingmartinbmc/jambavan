# जाम्बवान् (Jambavan) — Architecture

> Jambavan is a **Model Context Protocol (MCP) server**.
> It does not call any LLM. It provides *power* — index-aware tools and
> persistent memory — to whichever host model registers it.

---

## What Jambavan is

```
 ┌─────────────────────┐        MCP (stdio / SSE)       ┌──────────────────────────────┐
 │  Host model /        │ ──────────────────────────────▶ │   Jambavan MCP Server          │
 │  agent runtime       │                                 │                              │
 │                      │ ◀────────── tool results ─────  │  ── Code index ──            │
 │  • Claude Code       │                                 │  jambavan_index              │
 │  • Codex CLI         │                                 │  jambavan_context            │
 │  • Cursor            │                                 │  jambavan_watch              │
 │  • Continue          │                                 │  jambavan_diagnostics        │
 └─────────────────────┘                                  │  jambavan_doctor             │
                                                          │                              │
                                                          │  ── Graph & compression ──   │
                                                          │  jambavan_graph_report       │
                                                          │  jambavan_graph_query        │
                                                          │  jambavan_graph_path         │
                                                          │  jambavan_sankshipta (opt-in)│
                                                          │                              │
                                                          │  ── Memory ──                │
                                                          │  jambavan_memory_store       │
                                                          │  jambavan_memory_search      │
                                                          │  jambavan_memory_recall      │
                                                          │  jambavan_memory_mine_session│
                                                          │  jambavan_memory_invalidate  │
                                                          │  jambavan_memory_delete      │
                                                          │  jambavan_memory_status      │
                                                          │                              │
                                                          │  ── Session continuity ──    │
                                                          │  jambavan_failure_store      │
                                                          │  jambavan_failure_search     │
                                                          │  jambavan_session_export     │
                                                          │  jambavan_session_import     │
                                                          │  jambavan_review_pack        │
                                                          │                              │
                                                          │  ── Counsel ──               │
                                                          │  jambavan_mool_kaaran        │
                                                          │  jambavan_praman             │
                                                          │  jambavan_yukti              │
                                                          │  jambavan_vibhaajan          │
                                                          │                              │
                                                          │  ── Dev workflow ──          │
                                                          │  jambavan_vibhishana_niti    │
                                                          │  jambavan_rin_mochan         │
                                                          │  jambavan_awaken             │
                                                          │                              │
                                                          │  ── File system & shell ──   │
                                                          │  read_file                   │
                                                          │  search / list_files         │
                                                          │  write_file  (opt-in)        │
                                                          │  patch_file  (opt-in)        │
                                                          │  bash        (opt-in)        │
                                                          └──────────────────────────────┘
```

The host model decides *what* to do.
Jambavan provides the *capability* to do it, with codebase awareness and persistent memory baked in.

---

## Tools exposed via MCP

### Code index

| Tool | Purpose |
|---|---|
| `jambavan_index` | Build / refresh AST-aware codebase index (incremental) |
| `jambavan_context` | Search index, return ranked token-budgeted context block. Optional `compress_prose` (denser comments), `include_diff` (recent git changes per symbol), `include_tests` (associated test files) — enrichments share the same token budget rather than being appended on top |
| `jambavan_watch` | Start / stop live file watcher (incremental per-file re-index) |
| `jambavan_diagnostics` | Show tree-sitter vs regex parser backends + index stats |
| `jambavan_doctor` | One-shot environment health check: root source, parser backends, write/bash gates, token budget, memory dir, `.gitignore`/CI, and index/watcher status |

### Knowledge graph & compression

| Tool | Purpose |
|---|---|
| `jambavan_graph_report` | Summarize the lightweight inferred code graph (symbols, edges, hotspots) |
| `jambavan_graph_query` | Traverse callers/callees/imports/mentions from a symbol (BFS, token-budgeted) |
| `jambavan_graph_path` | Shortest relationship path between two symbols |
| `jambavan_sankshipta` | Compress prose/prompts to fewer tokens, preserving code & facts |

> **Graph scope.** This is a **lightweight inferred graph**, not full resolver-backed
> program analysis. The AST extracts references (`call` / `import` / `implements`)
> per symbol; when a reference name matches exactly one symbol, that edge is
> unambiguous. When it matches several (e.g. two files each export a same-named
> function), a `call`/`implements` reference whose enclosing symbol has a
> module-level `import` for that name is resolved to the file the import
> specifier actually points to — everything else still fans out to *all*
> same-named symbols, since there is no full scope/type resolution. Body-token
> mentions add capped `INFERRED` edges; very common names are skipped to avoid
> graph blowups. Edges carry a confidence: `EXTRACTED` (from the
> AST) or `INFERRED` (name mention). Treat it as a navigation aid, not ground
> truth — verify before large refactors.

### Functional aliases

The mythological tool names are the canonical API. These English aliases are also advertised as real MCP tools for easier discovery and model recall:

| Alias | Canonical tool |
|---|---|
| `root_cause` | `jambavan_mool_kaaran` |
| `verify_gate` | `jambavan_praman` |
| `strategy_plan` | `jambavan_yukti` |
| `decompose_task` | `jambavan_vibhaajan` |
| `dev_rules` | `jambavan_vibhishana_niti` |
| `debt_ledger` | `jambavan_rin_mochan` |
| `compress_prompt` | `jambavan_sankshipta` |

### Memory

| Tool | Purpose |
|---|---|
| `jambavan_memory_store` | Persist a memory as an OKF markdown document |
| `jambavan_memory_search` | BM25 full-text search across stored memories |
| `jambavan_memory_recall` | Load all memories for a scope — session wake-up |
| `jambavan_memory_mine_session` | Distill durable facts from a session transcript |
| `jambavan_memory_invalidate` | Mark a memory superseded without deleting history |
| `jambavan_memory_delete` | Remove a memory by ID or wipe an entire scope |
| `jambavan_memory_status` | Bundle statistics (total count, by scope) |

### Failure memory & session handoff

Session-continuity tools — the goal is that a fresh session (or a different host model) doesn't repeat a dead end and doesn't have to re-derive context that already existed.

| Tool | Purpose |
|---|---|
| `jambavan_failure_store` | Record a structured failure (command, symptom, attempted fix, root cause, resolution, status, do-not-retry advice) in the memory store |
| `jambavan_failure_search` | Search past failure records before retrying a failing command or approach |
| `jambavan_session_export` | Produce a single portable markdown handoff document: recent memories, `rin:` debt markers, and git status |
| `jambavan_session_import` | Parse a handoff document back into memories in the target scope; tolerant of light rewording of the memory heading, idempotent on exact re-import |

Both are built on `MemoryStore` — a failure record is just a memory with `type: 'FailureRecord'` and a title that includes a content hash of `command + symptom`, so two different failures never collide on the same stored title.

### Review pack

| Tool | Purpose |
|---|---|
| `jambavan_review_pack` | Diff the current branch vs a base ref (auto-detects `main`/`master`), then per touched file: list its symbols, callers via `buildSymbolGraph`, associated tests via `buildTestMap`, and risk flags (touched `rin:` debt via `harvestRin`, no matching test, or past `FailureRecord`s mentioning the file) |

Pure composition — no new subsystem. Requires `jambavan_index` to have run at least once; without an index it still returns the raw touched-file list. The CLI wrapper `jambavan review-pack --format json` reuses the same primitives and emits `{ base, touchedCount, files, rinMarkers, failures }` for CI/PR comments; `rinMarkers` is filtered to touched files only.

### Awaken

| Tool | Purpose |
|---|---|
| `jambavan_awaken` | Reminds the host model of every power above and the session protocol |

### Dev workflow

| Tool | Purpose |
|---|---|
| `jambavan_vibhishana_niti` | Serve the Vibhishana Niti efficient-dev ruleset (lite / full / ultra) |
| `jambavan_rin_mochan` | Harvest `rin:` comments into a tracked debt ledger |

### Counsel (discipline protocols)

| Tool | Purpose |
|---|---|
| `jambavan_mool_kaaran` | Root-cause investigation protocol — observe/compare/hypothesize/fix. Escalates at 3+ failed attempts |
| `jambavan_praman` | Verification gate — demands fresh evidence before any completion claim (tests/build/fix/requirements/general) |
| `jambavan_yukti` | Approach strategy — phased instructions scaled to task size (small/medium/large) |
| `jambavan_vibhaajan` | Parallel work decomposition — boundary identification, independence verification, contracts, merge sequencing |

### File system & shell

Read-only tools are always registered. Mutating and shell tools are **opt-in** (see [Safety](#safety)) — when disabled they are not registered, so the host never sees them.

| Tool | Default | Purpose |
|---|---|---|
| `read_file` | on | Read a file, optionally a line range (refuses files > `JAMBAVAN_MAX_READ_BYTES`) |
| `search` | on | Ripgrep-powered regex search across the codebase |
| `list_files` | on | Explore directory structure |
| `write_file` | `JAMBAVAN_ALLOW_WRITE=1` | Write or overwrite a file |
| `patch_file` | `JAMBAVAN_ALLOW_WRITE=1` | Surgical find-and-replace (token-efficient) |
| `jambavan_sankshipta` | `JAMBAVAN_ALLOW_WRITE=1` | Compress prose in place (writes the file — hence gated) |
| `bash` | `JAMBAVAN_ALLOW_BASH=1` | Run shell commands (build, test, git, install) |

---

## CLI subcommands

Local, no-server helpers run as `npx jambavan <subcommand>` — none call an LLM or an external service.

| Subcommand | Purpose |
|---|---|
| `jambavan doctor` | Thin CLI wrapper around `jambavan_doctor` (see above) — root source, parser backends, gates, index stats |
| `jambavan badges` | Print three local markdown lines for a README: benchmark card (context tokens saved, via `node dist/benchmark.js --json`), Rin Ledger, Failure Immunity count |
| `jambavan bridge --to mempalace` / `--from mempalace` | Convert Jambavan memories to/from a MemPalace-shaped `wing/room/drawer.md` folder tree (see `src/tools/memory-bridge.ts`). MemPalace's real store is a Chroma vector index, not files, so this produces/consumes a portable interchange tree for a host model to walk with its own `mempalace_*` tools — Jambavan never calls MemPalace directly |
| `jambavan handoff --write-pr-template [--post]` | Runs the `jambavan_session_export` handoff card and injects it as an HTML-comment-bounded block into `.github/pull_request_template.md` (see `src/tools/pr-handoff.ts` for the pure inject/replace transform); idempotent re-injection, no duplication. `--post` additionally shells to the caller's own authenticated `gh pr comment` — off by default, never automatic, same trust boundary as the `bash` tool |
| `jambavan review-pack [--base <ref>] [--format markdown\|json] [--max-files <n>]` | Indexes the project, then writes a branch review pack to stdout. Markdown delegates to `jambavan_review_pack`; JSON uses `src/tools/review-pack-json.ts` for `{ touchedCount, files[], rinMarkers[], failures[] }`, which is what the GitHub Action consumes |
| `jambavan html-handoff [--out <file>] [--scope <scope>]` | Indexes the project and writes a self-contained HTML handoff report (`src/tools/html-handoff.ts`) with memory timeline, rin debt, indexed-symbol stats, git dirty files/recent commits, collapsible sections, and copy-to-clipboard. No external assets or network calls |
| `jambavan daemon start\|stop\|status` | Spawns/stops/inspects a detached background process (`src/daemon-worker.ts`, managed by `src/tools/daemon.ts`) that runs the same `FileWatcher` as `jambavan_watch`, standalone. PID file at `.jambavan/daemon.pid`, log at `.jambavan/daemon.log`, liveness checked via `process.kill(pid, 0)`. `jambavan_watch`/`jambavan_diagnostics`/`jambavan_awaken` all check this PID file first to avoid starting a redundant in-process watcher |
| `jambavan gui [--port <n>] [--no-open]` | Indexes the project, then serves a dependency-free static page (`src/tools/gui.ts`) over Node's `http` module bound to `127.0.0.1` only — a force-directed graph view (from `buildSymbolGraph`, capped to the 400 highest-degree nodes), rin debt (`harvestRin`), and failure records (`MemoryStore`). `/api/data` serves the graph/sidebar data; `/api/node/:id` serves click-through source snippets, callers, callees, and heat counts. Opens the default browser unless `--no-open` is passed |

`node dist/benchmark.js --json` (not a `jambavan` subcommand, run directly) emits the same benchmark data as `npm run bench` as one JSON object instead of tables.

---

## Registration

`install.sh` / `install.ps1` (see README) auto-detect and register all four below. Manual equivalents:

**Claude Code**
```bash
claude mcp add jambavan -- npx -y jambavan
```

**Codex CLI**
```bash
codex mcp add jambavan -- npx -y jambavan
```
Persists to `~/.codex/config.toml` as `[mcp_servers.jambavan]` (top-level key is `mcp_servers`, not `mcpServers`).

**Cursor** (`~/.cursor/mcp.json` global, or `.cursor/mcp.json` per-project)
```json
{
  "mcpServers": {
    "jambavan": { "command": "npx", "args": ["-y", "jambavan"] }
  }
}
```

**Continue** — drop a single-server JSON file into `~/.continue/mcpServers/jambavan.json` (or add a `mcpServers:` entry to `~/.continue/config.yaml`, which replaced the now-deprecated `config.json`):
```json
{ "command": "npx", "args": ["-y", "jambavan"] }
```

**Claude Code plugin** — this repo is also a plugin marketplace (`.claude-plugin/marketplace.json` + `plugins/jambavan/`). The plugin's `plugin.json` declares the same MCP server and ships five skills, each auto-discovered from `plugins/jambavan/skills/<name>/SKILL.md` — no listing in `plugin.json` needed:

| Skill | Invoke as | Purpose |
|---|---|---|
| Vibhishana Niti | `/jambavan:vibhishana-niti` | Efficient-dev discipline (the ladder, non-negotiable rules) |
| Using Jambavan | `/jambavan:using-jambavan` | Tool session protocol (index → context → memory) |
| Root Cause Debugger | `/jambavan:root-cause-debugger` | Observe/compare/hypothesize/fix before any bug fix — same protocol as `jambavan_mool_kaaran` |
| Release Checker | `/jambavan:release-checker` | Evidence gate before claiming tests/build/fix/requirements/release are done — same protocol as `jambavan_praman` |
| Strict Reviewer | `/jambavan:strict-reviewer` | Severe-senior-engineer review checklist built on `jambavan_review_pack` |

So `/plugin install jambavan@jambavan` wires up the server and all five skills without manual config:
```shell
/plugin marketplace add beingmartinbmc/jambavan
/plugin install jambavan@jambavan
```

---

## Source layout

```
src/
├── index.ts                  # Entrypoint — starts MCP server, shows --help, CLI subcommands
├── daemon-worker.ts          # Standalone process spawned by `jambavan daemon start` (see tools/daemon.ts)
│
├── mcp/
│   └── server.ts             # MCP Server (stdio transport): tools/list + tools/call,
│                             # opt-in gating of write/bash tools
│
├── index/
│   ├── indexer.ts            # Orchestrates full / incremental indexing
│   ├── ast-parser.ts         # Symbol extractor (tree-sitter + regex fallback)
│   ├── file-cache.ts         # SQLite: file hash → indexed state (incremental)
│   ├── watcher.ts            # chokidar: watch for changes
│   └── test-map.ts           # Associates symbols with the test files that exercise them
│
├── knowledge/
│   └── graph.ts              # Lightweight inferred code graph (nodes/edges,
│                             # EXTRACTED vs INFERRED), import-path resolution,
│                             # report / query / shortest-path
│
├── memory/
│   └── store.ts              # OKF bundle manager: read/write/search concept docs
│                             # BM25 search, no vectors, no external services
│
├── context/
│   ├── assembler.ts          # Ranks + packs symbols within token budget
│   ├── token-counter.ts      # js-tiktoken: exact token counts
│   └── diff-enricher.ts      # Recent git history per symbol line range (execFileSync, no shell)
│
├── tools/
│   ├── registry.ts           # Tool registry + dispatcher (central output cap)
│   ├── path-guard.ts         # resolveInsideRoot containment + secret-file guard
│   ├── read-file.ts          # read_file (line ranges, size cap)
│   ├── write-file.ts         # write_file + patch_file
│   ├── search.ts             # ripgrep / grep wrapper + list_files
│   ├── bash.ts               # Shell execution with footgun blocks + no-color env
│   ├── sankshipta.ts         # Deterministic prose/prompt compression
│   ├── memory.ts             # jambavan_memory_* descriptors + handlers
│   ├── failure-memory.ts     # jambavan_failure_store/_search — structured failure records
│   ├── session-handoff.ts    # jambavan_session_export/_import — portable handoff document
│   ├── jambavan.ts           # Core jambavan_* handlers + awaken protocol text
│   ├── vibhishana-niti.ts    # jambavan_vibhishana_niti + jambavan_rin_mochan ledger
│   ├── mool-kaaran.ts       # jambavan_mool_kaaran — root-cause investigation protocol
│   ├── praman.ts            # jambavan_praman — verification gate protocol
│   ├── yukti.ts             # jambavan_yukti — approach strategy protocol
│   ├── vibhaajan.ts         # jambavan_vibhaajan — parallel decomposition protocol
│   ├── doctor.ts            # jambavan_doctor — environment/config health check
│   ├── review-pack.ts       # jambavan_review_pack — touched symbols/callers/tests/failures/risk
│   ├── review-pack-json.ts  # `jambavan review-pack --format json` — CI/PR-comment schema
│   ├── html-handoff.ts      # `jambavan html-handoff` — self-contained browser handoff report
│   ├── memory-bridge.ts     # `jambavan bridge` CLI — Jambavan <-> MemPalace markdown conversion
│   ├── pr-handoff.ts        # `jambavan handoff` CLI — inject handoff card into a PR template
│   ├── daemon.ts            # `jambavan daemon` CLI — spawn/stop/inspect the background watcher process
│   └── gui.ts               # `jambavan gui` CLI — local dependency-free graph/rin/failure visualizer
│
├── config/
│   └── jambavan.config.ts    # Runtime config (project root, token budget, ignore list)
│
├── benchmark.ts              # `npm run bench` — index / context / graph / tools
├── self-check.ts             # `npm run self-check` — end-to-end smoke
└── tool-check.ts             # `npm run tool-check` — every advertised tool over stdio

test/                         # node:test unit suites (*.test.ts)
test-support/                 # shared test helpers (temp config, env sandbox)
```

---

## How `jambavan_context` works

```
Host model calls jambavan_context(query="auth middleware")
         │
         ▼
  JambavanIndex.search(query, limit=30)
  ├─ SQLite LIKE match on symbol names + content (memory search uses BM25)
  └─ Returns ranked (symbol, score) pairs
         │
         ▼
  ContextAssembler.assemble(chunks, { budgetOverride? })
  ├─ Sort by relevance score descending
  ├─ Greedily pack into token budget (default: 8 000 tokens;
  │  reserved down to 80% if include_diff/include_tests requested)
  └─ Format: ### file.ts:10-45 [function]\n```\n...\n```
         │
         ▼
  Optional enrichment (share the remaining ~20% of the budget, never on top of it)
  ├─ include_diff  → diff-enricher.ts: recent git history per symbol line range
  └─ include_tests → test-map.ts: associated test files per symbol
         │
         ▼
  MCP text result returned to host model
  → Host model has precise, cheap, relevant context
    without reading whole files
```

---

## How `jambavan_memory_*` works

Memories are stored as [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) concept documents — markdown files with YAML frontmatter — inside `.jambavan/memory/`. No database, no embeddings, no external services.

```
jambavan_memory_store(title="Why we use GraphQL", body="...", scope="my-project")
         │
         ▼
  MemoryStore.store()
  ├─ slugify title → scope/why-we-use-graphql.md
  ├─ Serialize YAML frontmatter (type, title, tags, timestamp, …)
  ├─ Write markdown file
  ├─ Append to log.md
  └─ Rebuild scope index.md
         │
         ▼
  .jambavan/memory/my-project/why-we-use-graphql.md
  → Human-readable, git-diffable, portable

jambavan_memory_search(query="graphql rationale")
         │
         ▼
  MemoryStore.search()
  ├─ Load all docs for scope (or all scopes)
  ├─ Build BM25 corpus (title x3, tags x2, description x2, body x1)
  └─ Rank and return top-k
```

### OKF bundle layout

```
.jambavan/memory/
├── log.md                     # Chronological update history
├── general/
│   ├── index.md               # Auto-generated directory listing
│   └── <slug>.md              # One concept doc per memory
└── my-project/
    ├── index.md
    └── <slug>.md
```

Each concept doc:

```markdown
---
type: Memory
title: "Why we use GraphQL"
description: "Why we use GraphQL"
tags: ["architecture", "api"]
scope: my-project
timestamp: 2026-06-01T12:00:00.000Z
---

We evaluated REST vs GraphQL in Q1 2026. GraphQL won because ...
```

---

## Why no LLM in Jambavan?

Every existing AI coding tool (Cline, Cursor Agent, Aider, Claude Code)
bundles its own agent loop. That means:

- You're locked to one model
- You can't compose tools across agents
- Token strategies are opaque

Jambavan takes the opposite approach:
**Your model of choice orchestrates. Jambavan provides the infrastructure.**

Register Jambavan in Claude Code → Claude reasons, Jambavan's index + tools execute.  
Register Jambavan in Codex → same tools, different model.  
The index, the context budgeting, the memory, the surgical patch — all reusable.

---

## Configuration

| Env var | Default | Description |
|---|---|---|
| `JAMBAVAN_ROOT` | auto-detect | Project root to index and serve |
| `JAMBAVAN_MEMORY_HOME` | `<indexDir>/memory` | Where OKF memory docs live; point at a shared palace to reuse memory across projects |
| `JAMBAVAN_TOKEN_BUDGET` | `8000` | Max tokens in `jambavan_context` output |
| `JAMBAVAN_DEV_MODE` | `full` | Default Vibhishana Niti level (`lite` / `full` / `ultra`) |
| `JAMBAVAN_ALLOW_WRITE` | off | `1` registers `write_file` + `patch_file` + `jambavan_sankshipta` |
| `JAMBAVAN_ALLOW_BASH` | off | `1` registers `bash` |
| `JAMBAVAN_ALLOW_OUTSIDE_ROOT` | off | `1` lets tools escape the project root |
| `JAMBAVAN_ALLOW_SECRETS` | off | `1` lets file tools touch secret-looking files |
| `JAMBAVAN_BASH_INHERIT_ENV` | off | `1` passes the full host env to `bash` |
| `JAMBAVAN_MAX_OUTPUT_CHARS` | `100000` | Global cap on any tool's returned output |
| `JAMBAVAN_MAX_READ_BYTES` | `5242880` | Max file size `read_file` will load |

---

## Sankshipta tool discipline

Jambavan bakes token-efficient computer use into its startup protocol and Vibhishana Niti: avoid unnecessary calls; prefer indexed context, `max_results`, line ranges, git summaries, structured projections (`jq`/`yq`/`awk`/`cut`), quiet/no-color commands, and hash/mtime polling over dump-and-read loops. The `bash` tool also exports `NO_COLOR=1` and `FORCE_COLOR=0` by default so checks return less ANSI noise.

---

## Safety model

Jambavan is driven by an autonomous host model, so capability is granted, not assumed:

- **Read-only by default.** Only `read_file`, `search`, and `list_files` register unless `JAMBAVAN_ALLOW_WRITE=1` (adds `write_file`, `patch_file`, and `jambavan_sankshipta` — which rewrites files in place) or `JAMBAVAN_ALLOW_BASH=1` (adds `bash`). Disabled tools are never advertised to the host.
- **Path containment.** All file/shell paths resolve inside `JAMBAVAN_ROOT`; symlinks are checked via `realpath`. `JAMBAVAN_ALLOW_OUTSIDE_ROOT=1` disables this for trusted local use.
- **Secret-file guard.** `.env*`, `*.pem`, `*.key`, `id_rsa`, `.npmrc`, and similar are refused by all file tools unless `JAMBAVAN_ALLOW_SECRETS=1`.
- **`bash` isolation.** Runs with a minimal no-color env (no inherited host secrets unless `JAMBAVAN_BASH_INHERIT_ENV=1`) and a best-effort footgun blocklist for obvious root/home/project wipes, destructive git resets/cleans, fork bombs, and blind remote shell pipes. The blocklist is **not** a security boundary — run inside a container/microVM for real isolation.
- **Output caps.** Every tool result is truncated at `JAMBAVAN_MAX_OUTPUT_CHARS`; `read_file` refuses files over `JAMBAVAN_MAX_READ_BYTES` before loading them. Host-supplied numeric params (line ranges, `max_results`, `limit`) are clamped to safe ranges.

---

## Testing

No test framework dependency — tests use Node's built-in `node:test` runner via the already-installed `ts-node`.

| Command | What it covers |
|---|---|
| `npm run unit` | `test/*.test.ts` — registry caps/dispatch, path-guard containment & secret blocking, file-tool behavior, `bash` footguns & env isolation, graph confidence semantics (incl. import-resolved edges), sankshipta compression, project-scope hashing, failure-record collision handling, session export/import round-trips, test-map association |
| `npm run self-check` | End-to-end smoke of read/memory/graph/rin/sankshipta against a temp project |
| `npm run tool-check` | Asserts every advertised MCP tool is exercised |
| `npm test` | Runs all three |

---

## Incremental index

```
First run (jambavan_index):
  Parse all source files → extract symbols → store in SQLite
  Time: O(n files)

Every subsequent call (jambavan_index):
  Hash each file → compare to cache → skip unchanged
  Re-parse only stale/new files
  Time: O(changed files) ≈ O(1) for a normal dev session
```
