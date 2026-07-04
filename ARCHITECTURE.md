# जाम्बवान् (Jambavan) — Architecture

> Jambavan is a **Model Context Protocol (MCP) server**.
> It does not call any LLM. It provides *power* — index-aware tools and
> persistent memory — to whichever host model registers it.

---

## What Jambavan is

```
 ┌─────────────────────┐        MCP (stdio / SSE)       ┌──────────────────────┐
 │  Host model /        │ ──────────────────────────────▶ │   Jambavan MCP         │
 │  agent runtime       │                                 │   Server             │
 │                      │ ◀────────── tool results ─────  │                      │
 │  • Claude Code       │                                 │  jambavan_index        │
 │  • Codex CLI         │                                 │  jambavan_context      │
 │  • Cursor            │                                 │  jambavan_memory_store │
 │  • Continue          │                                 │  jambavan_memory_search│
 └─────────────────────┘                                  │  read_file           │
                                                          │  search / list_files │
                                                          │  write_file  (opt-in)│
                                                          │  patch_file  (opt-in)│
                                                          │  bash        (opt-in)│
                                                          └──────────────────────┘
```

The host model decides *what* to do.
Jambavan provides the *capability* to do it, with codebase awareness and persistent memory baked in.

---

## Tools exposed via MCP

### Code index

| Tool | Purpose |
|---|---|
| `jambavan_index` | Build / refresh AST-aware codebase index (incremental) |
| `jambavan_context` | Search index, return ranked token-budgeted context block |
| `jambavan_watch` | Start / stop live file watcher (incremental per-file re-index) |
| `jambavan_diagnostics` | Show tree-sitter vs regex parser backends + index stats |

### Knowledge graph & compression

| Tool | Purpose |
|---|---|
| `jambavan_graph_report` | Summarize the lightweight inferred code graph (symbols, edges, hotspots) |
| `jambavan_graph_query` | Traverse callers/callees/imports/mentions from a symbol (BFS, token-budgeted) |
| `jambavan_graph_path` | Shortest relationship path between two symbols |
| `jambavan_sankshipta` | Compress prose/prompts to fewer tokens, preserving code & facts |

> **Graph scope.** This is a **lightweight inferred graph**, not resolver-backed
> program analysis. The AST extracts references (`call` / `import` / `implements`)
> per symbol, but edges are resolved **by matching the reference name to every
> symbol with that name** — there is no scope/type resolution, so a call to an
> overloaded or shadowed name links to *all* same-named symbols. Body-token
> mentions add `INFERRED` edges. Edges carry a confidence: `EXTRACTED` (from the
> AST) or `INFERRED` (name mention). Treat it as a navigation aid, not ground
> truth — verify before large refactors. Real resolver-backed call/import
> analysis would replace the name-matching step.

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

### Awaken

| Tool | Purpose |
|---|---|
| `jambavan_awaken` | Reminds the host model of every power above and the session protocol |

### Dev workflow

| Tool | Purpose |
|---|---|
| `jambavan_vibhishana_niti` | Serve the Vibhishana Niti efficient-dev ruleset (lite / full / ultra) |
| `jambavan_rin_mochan` | Harvest `rin:` comments into a tracked debt ledger |

### File system & shell

Read-only tools are always registered. Mutating and shell tools are **opt-in** (see [Safety](#safety)) — when disabled they are not registered, so the host never sees them.

| Tool | Default | Purpose |
|---|---|---|
| `read_file` | on | Read a file, optionally a line range (refuses files > `JAMBAVAN_MAX_READ_BYTES`) |
| `search` | on | Ripgrep-powered regex search across the codebase |
| `list_files` | on | Explore directory structure |
| `write_file` | `JAMBAVAN_ALLOW_WRITE=1` | Write or overwrite a file |
| `patch_file` | `JAMBAVAN_ALLOW_WRITE=1` | Surgical find-and-replace (token-efficient) |
| `bash` | `JAMBAVAN_ALLOW_BASH=1` | Run shell commands (build, test, git, install) |

---

## Registration

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

**Codex** (`~/.codex/config.yaml`)
```yaml
mcpServers:
  - name: jambavan
    command: npx -y jambavan
```

**Continue** (`~/.continue/config.json`)
```json
"mcpServers": [{ "name": "jambavan", "command": "npx -y jambavan" }]
```

---

## Source layout

```
src/
├── index.ts                  # Entrypoint — starts MCP server, shows --help
│
├── mcp/
│   └── server.ts             # MCP Server (stdio transport)
│                             # Handles tools/list and tools/call
│
├── index/
│   ├── indexer.ts            # Orchestrates full / incremental indexing
│   ├── ast-parser.ts         # Symbol extractor (tree-sitter + regex fallback)
│   ├── file-cache.ts         # SQLite: file hash → indexed state (incremental)
│   └── watcher.ts            # chokidar: watch for changes
│
├── memory/
│   └── store.ts              # OKF bundle manager: read/write/search concept docs
│                             # BM25 search, no vectors, no external services
│
├── context/
│   ├── assembler.ts          # Ranks + packs symbols within token budget
│   └── token-counter.ts      # js-tiktoken: exact token counts
│
├── tools/
│   ├── registry.ts           # Tool registry + dispatcher
│   ├── read-file.ts
│   ├── write-file.ts         # write_file + patch_file
│   ├── bash.ts               # Shell execution with hard safety blocks
│   ├── search.ts             # ripgrep / grep wrapper + list_files
│   ├── memory.ts             # jambavan_memory_* tool descriptors + handlers
│   └── vibhishana-niti.ts    # jambavan_vibhishana_niti + jambavan_rin_mochan ledger
│
└── config/
    └── jambavan.config.ts      # Runtime config (project root, token budget, ignore list)

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
  ContextAssembler.assemble(chunks)
  ├─ Sort by relevance score descending
  ├─ Greedily pack into token budget (default: 8 000 tokens)
  └─ Format: ### file.ts:10-45 [function]\n```\n...\n```
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
| `JAMBAVAN_TOKEN_BUDGET` | `8000` | Max tokens in `jambavan_context` output |
| `JAMBAVAN_DEV_MODE` | `full` | Default Vibhishana Niti level (`lite` / `full` / `ultra`) |
| `JAMBAVAN_ALLOW_WRITE` | off | `1` registers `write_file` + `patch_file` |
| `JAMBAVAN_ALLOW_BASH` | off | `1` registers `bash` |
| `JAMBAVAN_ALLOW_OUTSIDE_ROOT` | off | `1` lets tools escape the project root |
| `JAMBAVAN_ALLOW_SECRETS` | off | `1` lets file tools touch secret-looking files |
| `JAMBAVAN_BASH_INHERIT_ENV` | off | `1` passes the full host env to `bash` |
| `JAMBAVAN_MAX_OUTPUT_CHARS` | `100000` | Global cap on any tool's returned output |
| `JAMBAVAN_MAX_READ_BYTES` | `5242880` | Max file size `read_file` will load |

---

## Safety model

Jambavan is driven by an autonomous host model, so capability is granted, not assumed:

- **Read-only by default.** Only `read_file`, `search`, and `list_files` register unless `JAMBAVAN_ALLOW_WRITE=1` (adds `write_file` + `patch_file`) or `JAMBAVAN_ALLOW_BASH=1` (adds `bash`). Disabled tools are never advertised to the host.
- **Path containment.** All file/shell paths resolve inside `JAMBAVAN_ROOT`; symlinks are checked via `realpath`. `JAMBAVAN_ALLOW_OUTSIDE_ROOT=1` disables this for trusted local use.
- **Secret-file guard.** `.env*`, `*.pem`, `*.key`, `id_rsa`, `.npmrc`, and similar are refused by all file tools unless `JAMBAVAN_ALLOW_SECRETS=1`.
- **`bash` isolation.** Runs with a minimal env (no inherited host secrets unless `JAMBAVAN_BASH_INHERIT_ENV=1`) and a best-effort footgun blocklist. The blocklist is **not** a security boundary — run inside a container/microVM for real isolation.
- **Output caps.** Every tool result is truncated at `JAMBAVAN_MAX_OUTPUT_CHARS`; `read_file` refuses files over `JAMBAVAN_MAX_READ_BYTES` before loading them. Host-supplied numeric params (line ranges, `max_results`, `limit`) are clamped to safe ranges.

---

## Testing

No test framework dependency — tests use Node's built-in `node:test` runner via the already-installed `ts-node`.

| Command | What it covers |
|---|---|
| `npm run unit` | `test/*.test.ts` — registry caps/dispatch, path-guard containment & secret blocking, file-tool behavior, `bash` footguns & env isolation, graph confidence semantics, sankshipta compression |
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
