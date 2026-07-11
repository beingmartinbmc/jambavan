---
name: using-jambavan
description: Use when Jambavan MCP tools (jambavan_index, jambavan_context, jambavan_memory_*) are available in the current session, or when you see .jambavan/ in the project root
---

# Using Jambavan

## Overview

Jambavan is an MCP server that provides AST-aware code indexing, token-budgeted context, durable memory, an inferred code graph, and guarded file/shell tools. It does not call an LLM — it gives *you* the ground to reason from.

**Core principle:** Index first, context before reading, memory before repeating, failures before retrying.

## Session Protocol

Use this sequence for a new project session:

1. **`jambavan_awaken {}`** — loads the protocol and recent project memories.
2. **`jambavan_doctor {}`** — confirms the project root, gates, storage, and index/watcher status.
3. **`jambavan_index {}`** — builds or refreshes the AST-aware code index.
4. **`jambavan_watch { "action": "start" }`** — keeps the index live while you edit (skip for one-shot tasks).
5. **`jambavan_context { "query": "<task-specific query>" }`** — pulls ranked, token-budgeted context before reading unfamiliar code.

## Quick Reference

| Need | Tool | Key options |
|------|------|-------------|
| Understand unfamiliar code | `jambavan_context` | `query`, `compress_prose`, `include_diff`, `include_tests` |
| Trace callers/callees | `jambavan_graph_query` | `query`, `direction` |
| Find path between symbols | `jambavan_graph_path` | `from`, `to` |
| Graph overview / hotspots | `jambavan_graph_report` | — |
| Persist a decision | `jambavan_memory_store` | `title`, `body`, optional `scope` |
| Search past decisions | `jambavan_memory_search` | `query`, optional `scope` |
| Wake up with all memories | `jambavan_memory_recall` | optional `scope` |
| Distill session into memories | `jambavan_memory_mine_session` | `text`, optional `scope` |
| Record a dead end | `jambavan_failure_store` | `command`, `symptom`, optional `root_cause` |
| Check before retrying | `jambavan_failure_search` | `query`, optional `scope` |
| Hand off to next session | `jambavan_session_export` | optional `scope`, `share_safe` |
| Resume from handoff | `jambavan_session_import` | `text`, optional `scope` |
| Prepare review context | `jambavan_review_pack` | `base`, `max_files` |
| Compress verbose prose | `compress_prompt` (`jambavan_sankshipta`) | `path`, optional `in_place`, `backup` |
| Audit shortcut debt | `debt_ledger` (`jambavan_rin_mochan`) | — |
| Investigate bug/failure root cause | `root_cause` (`jambavan_mool_kaaran`) | `symptom`, `context`, `attempts_so_far` |
| Verification gate before completion | `verify_gate` (`jambavan_praman`) | `claim`, `type` |
| Sequence multi-step task strategy | `strategy_plan` (`jambavan_yukti`) | `task`, `constraints`, `scale` |
| Decompose task to parallel units | `decompose_task` (`jambavan_vibhaajan`) | `task`, `units`, `constraints` |

## When to Use Each Power

### Context (not raw file reads)

**Before reading whole files**, ask `jambavan_context` with a query. It returns ranked snippets under the configured approximate `cl100k_base` token budget. Measure any savings on the target repository with the benchmark; do not assume a universal percentage.

```text
jambavan_context { "query": "auth middleware", "include_diff": true }
```

Use `include_diff` when you need to understand recent changes. Use `include_tests` when you need test associations. Both share the same total token budget.

### Graph (trace relationships)

Before refactoring a symbol, use `jambavan_graph_query` to inspect a bounded neighborhood of candidate callers and callees. Before assuming two modules are unrelated, use `jambavan_graph_path`.

**Caveat:** The graph is not full type or scope resolution. Structural AST/import evidence produces `EXTRACTED` edges. Ambiguous same-name candidates are labelled `INFERRED` and excluded unless `include_inferred=true`; body-token mentions do not create graph edges. Results are bounded by the selected symbol and token limits, so verify important paths before large refactors.

### Memory (decisions survive sessions)

Store decisions, architectural choices, and resolved ambiguities as memories. They persist as markdown files under `.jambavan/memory/` by default — human-readable, no memory database.

- Use `jambavan_memory_store` after making a non-obvious decision. Pass the project scope reported by `jambavan_awaken`; the tool otherwise defaults to `general`.
- Use `jambavan_memory_mine_session` at session end to distill durable facts, with the same explicit project scope.
- Use `jambavan_memory_recall` at session start (or rely on `jambavan_awaken`).

### Failure Memory (check prior dead ends)

Before retrying a failing approach, call `jambavan_failure_search`. A matching record may contain a prior root cause, resolution, or do-not-retry note.

After hitting a dead end: `jambavan_failure_store` with command, symptom, root cause, and do-not-retry advice.

### Discipline Protocols (counsel)

Use the 4 counsel tools to avoid thrashing, enforce verification, and maintain rigorous planning:

- **Root Cause Protocol (`root_cause`, canonical `jambavan_mool_kaaran`)**: Use before proposing a fix for a test failure or unexpected behavior. Focuses on Observe → Compare → Hypothesize → Fix and recommends reassessment after 3+ failed attempts.
- **Verification Gate (`verify_gate`, canonical `jambavan_praman`)**: Use before asserting that work is done. It asks for fresh evidence appropriate to the claim.
- **Approach Strategy (`strategy_plan`, canonical `jambavan_yukti`)**: Use before writing non-trivial code. Returns scaled structures (small/medium/large) for executing the task safely.
- **Parallel Decomposition (`decompose_task`, canonical `jambavan_vibhaajan`)**: Use for complex multi-component tasks that have independent units and clear contracts.

### Session Handoff

Ending a session? `jambavan_session_export` produces a single portable document (memories, rin debt, git status). Paste it into the next session or pass it to a colleague via `jambavan_session_import`.

For human handoff outside the MCP host, `npx jambavan html-handoff --out <file>` writes a self-contained browser report with memories, failure records, rin debt, index stats, and git status.

### Review Pack

Before opening or updating a PR, call `jambavan_review_pack` after indexing. It maps touched files to symbols, extracted caller candidates, associated tests, touched rin debt, and past failure records within configured limits. Outside the MCP host, use `npx jambavan review-pack --base origin/main --format json` for CI or PR-comment automation.

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
| Reading whole files without context query first | Use `jambavan_context` to retrieve bounded relevant spans |
| Calling `jambavan_context` without indexing first | Always `jambavan_index` before `jambavan_context` |
| Retrying a command that failed last session | `jambavan_failure_search` before retrying |
| Forgetting decisions between sessions | `jambavan_memory_store` after non-obvious decisions |
| Assuming graph edges are ground truth | Check `EXTRACTED` vs `INFERRED` confidence |
| Skipping `jambavan_watch start` in a continuing session | Later edits are not incrementally re-indexed |

## Practices to avoid

- Skip `jambavan_index` and go straight to `jambavan_context`
- Ignore failure search results and retry the same approach
- Treat `INFERRED` graph edges as definitive for refactoring
- Read 10+ whole files when a context query would suffice

## Default session practices

- Run the session protocol (awaken → doctor → index → watch → context)
- Store decisions that future sessions need
- Record dead ends as failures
- Use `include_diff` when investigating recent regressions
- Export the session before ending if work is incomplete
