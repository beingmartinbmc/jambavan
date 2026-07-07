---
name: using-jambavan
description: Use when Jambavan MCP tools (jambavan_index, jambavan_context, jambavan_memory_*) are available in the current session, or when you see .jambavan/ in the project root
---

# Using Jambavan

## Overview

Jambavan is an MCP server that provides AST-aware code indexing, token-budgeted context, durable memory, an inferred code graph, and guarded file/shell tools. It does not call an LLM — it gives *you* the ground to reason from.

**Core principle:** Index first, context before reading, memory before repeating, failures before retrying.

## Session Protocol

Every session follows this sequence:

1. **`jambavan_awaken`** — loads the protocol and recent project memories.
2. **`jambavan_index`** — builds or refreshes the AST-aware code index (incremental — only changed files re-parse).
3. **`jambavan_watch start`** — keeps the index live while you edit (skip for one-shot tasks).
4. **`jambavan_context`** — pull ranked, token-budgeted context *before* reading unfamiliar code.

## Quick Reference

| Need | Tool | Key options |
|------|------|-------------|
| Understand unfamiliar code | `jambavan_context` | `query`, `compress_prose`, `include_diff`, `include_tests` |
| Trace callers/callees | `jambavan_graph_query` | symbol name, direction |
| Find path between symbols | `jambavan_graph_path` | from, to |
| Graph overview / hotspots | `jambavan_graph_report` | — |
| Persist a decision | `jambavan_memory_store` | scope, title, content |
| Search past decisions | `jambavan_memory_search` | query |
| Wake up with all memories | `jambavan_memory_recall` | scope |
| Distill session into memories | `jambavan_memory_mine_session` | transcript |
| Record a dead end | `jambavan_failure_store` | command, symptom, root cause |
| Check before retrying | `jambavan_failure_search` | query |
| Hand off to next session | `jambavan_session_export` | — |
| Resume from handoff | `jambavan_session_import` | document |
| Compress verbose prose | `jambavan_sankshipta` | file path |
| Audit shortcut debt | `jambavan_rin_mochan` | — |
| Investigate bug/failure root cause | `jambavan_mool_kaaran` | `symptom`, `context`, `attempts_so_far` |
| Verification gate before completion | `jambavan_praman` | `claim`, `type` |
| Sequence multi-step task strategy | `jambavan_yukti` | `task`, `constraints`, `scale` |
| Decompose task to parallel units | `jambavan_vibhaajan` | `task`, `units`, `constraints` |

## When to Use Each Power

### Context (not raw file reads)

**Before reading whole files**, ask `jambavan_context` with a query. It returns ranked, token-budgeted snippets — often 44–87% fewer tokens than reading full files.

```
jambavan_context(query="auth middleware", include_diff=true)
```

Use `include_diff` when you need to understand recent changes. Use `include_tests` when you need to understand test coverage. Both share the token budget — they don't bloat the response.

### Graph (trace relationships)

Before refactoring a symbol, use `jambavan_graph_query` to find all callers and callees. Before assuming two modules are unrelated, use `jambavan_graph_path`.

**Caveat:** The graph is inferred from AST + name matching (not full type resolution). Edges are labelled `EXTRACTED` (from AST) or `INFERRED` (name mention). Verify before large refactors.

### Memory (decisions survive sessions)

Store decisions, architectural choices, and resolved ambiguities as memories. They persist as markdown files under `.jambavan/memory/` — human-readable, no database.

- Use `jambavan_memory_store` after making a non-obvious decision.
- Use `jambavan_memory_mine_session` at session end to distill durable facts.
- Use `jambavan_memory_recall` at session start (or rely on `jambavan_awaken`).

### Failure Memory (don't repeat dead ends)

Before retrying a failing approach, call `jambavan_failure_search`. If a prior session already diagnosed the root cause, you'll get the answer without re-investigating.

After hitting a dead end: `jambavan_failure_store` with command, symptom, root cause, and do-not-retry advice.

### Discipline Protocols (counsel)

Use the 4 counsel tools to avoid thrashing, enforce verification, and maintain rigorous planning:

- **Root Cause Protocol (`jambavan_mool_kaaran`)**: Call BEFORE debugging any test failure or unexpected behavior. Focuses on Observe → Compare → Hypothesize → Fix. Escalates at 3+ attempts.
- **Verification Gate (`jambavan_praman`)**: Call BEFORE asserting that your work is done. Forces execution of fresh, complete commands and pasting of exact output text.
- **Approach Strategy (`jambavan_yukti`)**: Call BEFORE writing any non-trivial code. Returns scaled structures (small/medium/large) for executing the task safely.
- **Parallel Decomposition (`jambavan_vibhaajan`)**: Call BEFORE undertaking complex multi-component tasks. Breaks work into independent units with clear contracts.

### Session Handoff

Ending a session? `jambavan_session_export` produces a single portable document (memories, rin debt, git status). Paste it into the next session or pass it to a colleague via `jambavan_session_import`.

## Token Discipline

Jambavan bakes token efficiency into its design. Follow these patterns:

- **`jambavan_context` over whole-file reads** — ranked snippets, not dumps.
- **Line ranges in `read_file`** — if you know the span, request only that.
- **`max_results` on `search`** — cap results when scanning.
- **`git --stat` / `--name-only`** in `bash` — summaries before full diffs.
- **`jq`/`yq`/`awk`/`cut`/`head`** — structured projections in `bash`.
- **Quiet/no-color flags** — `bash` already exports `NO_COLOR=1`.
- **Hash/mtime polling** — check if a file changed before re-reading it.
- **`jambavan_sankshipta`** — compress verbose docs/prompts in place.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Reading whole files without context query first | Use `jambavan_context` — it's faster and smaller |
| Calling `jambavan_context` without indexing first | Always `jambavan_index` before `jambavan_context` |
| Retrying a command that failed last session | `jambavan_failure_search` before retrying |
| Forgetting decisions between sessions | `jambavan_memory_store` after non-obvious decisions |
| Assuming graph edges are ground truth | Check `EXTRACTED` vs `INFERRED` confidence |
| Skipping `jambavan_watch start` in long sessions | Index goes stale — edits won't appear in context |

## Red Flags

**Never:**
- Skip `jambavan_index` and go straight to `jambavan_context`
- Ignore failure search results and retry the same approach
- Treat `INFERRED` graph edges as definitive for refactoring
- Read 10+ whole files when a context query would suffice

**Always:**
- Run the session protocol (awaken → index → watch → context)
- Store decisions that future sessions need
- Record dead ends as failures
- Use `include_diff` when investigating recent regressions
- Export the session before ending if work is incomplete
