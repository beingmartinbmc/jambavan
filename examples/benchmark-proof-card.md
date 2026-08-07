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

Run from a clean location and pin both Jambavan and the target repository. For example, this reproduces the React proof-card inputs with Jambavan `v2.0.0`:

```bash
WORKDIR="$(mktemp -d)"
git clone --branch v2.0.0 --depth 1 https://github.com/beingmartinbmc/jambavan.git "$WORKDIR/jambavan"
git init "$WORKDIR/react"
git -C "$WORKDIR/react" remote add origin https://github.com/react/react.git
git -C "$WORKDIR/react" fetch --depth 1 origin 9ceb1e7
git -C "$WORKDIR/react" checkout --detach FETCH_HEAD
cd "$WORKDIR/jambavan"
npm ci
npm run build
JAMBAVAN_ROOT="$WORKDIR/react" node dist/benchmark.js --json > benchmark.private.json
```

For a new card, replace `v2.0.0` with the exact current release tag or commit you intend to report and replace the React fetch with an exact target commit. Record that pin in `Jambavan:`; do not label an unpinned `latest` run reproducible. `npm view jambavan version` can tell you the current published version, but it does not pin a source checkout by itself.

The benchmark uses a temporary index and memory directory. It makes no LLM, embedding, telemetry, or external-service calls. Context queries are derived from the repository's most common symbol names. The retrieval baseline counts `cl100k_base` tokens in every complete matching file; Jambavan counts the ranked snippets assembled within the configured token budget. Cold and unchanged warm indexing run consecutively. Tool timings use a generated temporary fixture over the real stdio MCP transport.

## Privacy review before sharing

Do not publish `benchmark.private.json` without reviewing it. It contains the absolute project path, derived symbol-query names, per-query details, and short tool-result notes. Copy only the aggregate fields used by the card:

- package version or commit, Node major, OS/architecture, and UTC date
- `index.totalFiles`, `index.totalSymbols`, `index.coldMs`, and `index.warmMs`
- number of `context.queries` and `context.savedPct`
- `graph.nodes` and `graph.edges`

Round timing values when comparing different machines, and state any non-default token budget or ignored-file configuration. Do not present one repository's result as a universal speedup. The canonical project and methodology live at [beingmartinbmc/jambavan](https://github.com/beingmartinbmc/jambavan).
