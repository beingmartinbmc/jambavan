# Measured proof card — react/react

This card preserves the reported aggregate from a real `node dist/benchmark.js --json` run against a large public repository. It does **not** publish the raw JSON in full: the aggregate says five auto-derived queries, while only four per-query rows were retained. The missing row cannot be reconstructed without inventing data. Follow [benchmark-proof-card.md](https://github.com/beingmartinbmc/jambavan/blob/main/examples/benchmark-proof-card.md) to run the pinned code and inputs yourself.

```text
Jambavan proof card
Repository: react/react (public), commit 9ceb1e7
Jambavan: 2.0.0
Runtime: Node 24, macOS/arm64
Run: 2026-07-28 UTC, cold then warm in one process
Scope: 4615 files discovered, 20595 symbols extracted, 5 auto-derived queries
Context: 96% fewer estimated cl100k_base tokens than full matching files
Index: 8485 ms cold, 1233 ms unchanged re-index
Graph: 24532 nodes, 243724 edges (33315 extracted / 210409 inferred)
Method: https://github.com/beingmartinbmc/jambavan/blob/main/examples/benchmark-proof-card.md
```

## Reproduce it

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
JAMBAVAN_ROOT="$WORKDIR/react" node dist/benchmark.js
```

This starts clean and pins the benchmark implementation and target commit. Exact timings depend on the machine and current dependency/platform behavior, so a rerun is a reproducibility check of the method and inputs, not a promise of byte-identical output.

## Per-query detail

Queries are auto-derived from the repository's most common symbol names, so they are not hand-picked. `baseline` is what an agent spends opening every complete file that contains a match; `jambavan` is the ranked snippet set assembled within the 8000-token budget. The four surviving rows below are historical evidence, but they are incomplete: they sum to 113 file matches, 6,906 Jambavan tokens, and 195,362 baseline tokens, not the published five-query totals of 141, 9,207, and 261,816.

| Query | Files matched | Jambavan tokens | Baseline tokens | Saved |
|---|---|---|---|---|
| `State` | 25 | 1,075 | 100,443 | 99% |
| `Component` | 28 | 2,301 | 66,454 | 97% |
| `useFoo` | 30 | 1,807 | 25,497 | 93% |
| `FIXTURE_ENTRYPOINT` | 30 | 1,723 | 2,968 | 42% |
| **Four retained rows subtotal** | **113** | **6,906** | **195,362** | **96%** |

The historical aggregate reports **five queries total**: **141** file matches, **9,207** Jambavan tokens, **261,816** baseline tokens, and **96%** saved after rounding. The raw fifth row and its identity are unavailable. Although subtracting the subtotal would produce an aggregate remainder, this card does not present that remainder as recovered raw evidence.

## What the numbers do not say

`FIXTURE_ENTRYPOINT` saved only 42%, and that case matters more than the 99% one. Its matches live in small test-fixture files, so reading them whole was already cheap. Savings scale with the size of the files a query lands in; a repository of small modules will see far less benefit than React's larger source files.

Of the 243,724 graph edges, only 33,315 are `EXTRACTED` from the AST. The other 210,409 are `INFERRED` from same-name matching, which is noisy in a codebase with thousands of similarly named `render` and `Component` symbols. Inferred edges are excluded from graph results unless `include_inferred=true`, so React's usable graph is the extracted subset — not the headline edge count.

This is a retrieval benchmark. It measures index speed, context selection, `cl100k_base` token estimates, and graph extraction. It does not measure task correctness or completion; see [outcome-evaluation.md](https://github.com/beingmartinbmc/jambavan/blob/main/examples/outcome-evaluation.md) for that.
