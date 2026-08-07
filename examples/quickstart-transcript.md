# Reproducible quick-start transcript

This is a real CLI transcript you can generate from a clean Jambavan checkout. It uses the repository itself as the indexed project, makes no network calls after `npm ci`, and does not enable source mutation or shell tools.

```bash
git clone https://github.com/beingmartinbmc/jambavan.git
cd jambavan
npm ci
npm run build
npx jambavan doctor
JAMBAVAN_ROOT="$PWD" node dist/benchmark.js --json > /tmp/jambavan-benchmark.json
node -e 'const r=require("/tmp/jambavan-benchmark.json"); console.log({files:r.index?.totalFiles,symbols:r.index?.totalSymbols,coldMs:r.index?.coldMs,reindexMs:r.index?.reindexMs})'
```

`npx jambavan doctor` prints the detected project root, parser backends, write/bash gates, memory location, and index state. The benchmark command then builds the same AST-backed index used by the MCP server and emits machine-readable measured output.

For the MCP path, register the server, restart the host, and make these actual tool calls:

```text
jambavan_doctor {}
jambavan_awaken {}
jambavan_index {}
jambavan_watch { "action": "start" }
jambavan_context { "query": "buildReviewPackHandlers", "include_tests": true }
```

Expected facts, rather than byte-for-byte output:

- doctor reports this checkout as the project root;
- all seven parser backends report `tree-sitter` when native modules load;
- writes and shell remain disabled;
- index reports non-zero files and symbols;
- context returns the `buildReviewPackHandlers` symbol and heuristic test associations/references within the configured token budget.

Exact paths, counts, and timings vary by release, platform, Node version, and checkout state. This document deliberately avoids fabricated fixed output.
