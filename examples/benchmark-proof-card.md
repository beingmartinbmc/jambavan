# Jambavan benchmark proof card

This is a retrieval benchmark: it measures index speed, context selection, `cl100k_base` token estimates, graph extraction, and tool latency. Those estimates are exact for that tokenizer, not for every host model. It does not measure task correctness or completion. Use the separate [offline outcome evaluation](outcome-evaluation.md) for paired baseline-versus-Jambavan evidence about first-pass success, repeated failures, completion, duration, and token use.

Use this compact card to share a reproducible result without publishing repository paths, symbol names, source, memory content, or raw tool output:

```text
Jambavan proof card
Repository: private / public (name omitted if private)
Jambavan: <package version or commit>
Runtime: Node <major>, <OS/architecture>
Run: <UTC date>, cold then warm in one process
Scope: <files discovered>, <symbols extracted>, <auto-derived queries>
Context: <savedPct>% fewer estimated cl100k_base tokens than full matching files
Index: <coldMs> ms cold, <warmMs> ms unchanged re-index
Graph: <nodes> nodes, <edges> edges
Method: https://github.com/beingmartinbmc/jambavan/blob/main/examples/benchmark-proof-card.md
```

## Produce the measurements

```bash
npm run build
JAMBAVAN_ROOT=/path/to/repo node dist/benchmark.js --json > benchmark.private.json
npm view jambavan version
```

The benchmark uses a temporary index and memory directory. It makes no LLM, embedding, telemetry, or external-service calls. Context queries are derived from the repository's most common symbol names. The retrieval baseline counts `cl100k_base` tokens in every complete matching file; Jambavan counts the ranked snippets assembled within the configured token budget. Cold and unchanged warm indexing run consecutively. Tool timings use a generated temporary fixture over the real stdio MCP transport.

## Privacy review before sharing

Do not publish `benchmark.private.json` without reviewing it. It contains the absolute project path, derived symbol-query names, per-query details, and short tool-result notes. Copy only the aggregate fields used by the card:

- package version or commit, Node major, OS/architecture, and UTC date
- `index.totalFiles`, `index.totalSymbols`, `index.coldMs`, and `index.warmMs`
- number of `context.queries` and `context.savedPct`
- `graph.nodes` and `graph.edges`

Round timing values when comparing different machines, and state any non-default token budget or ignored-file configuration. Do not present one repository's result as a universal speedup. The canonical project and methodology live at [beingmartinbmc/jambavan](https://github.com/beingmartinbmc/jambavan).
