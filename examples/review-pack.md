# Review pack example

Before opening or updating a PR, ask the host model to call:

```text
jambavan_index
jambavan_review_pack { "base": "main" }
```

Representative output shape:

```text
# Jambavan Review Pack
Base: main
Touched files: src/mcp/server.ts, src/mcp/tool-aliases.ts

src/mcp/server.ts
- touched symbols: startServer, handleToolCall
- callers: dist/index.js -> startServer
- associated tests: test/tool-aliases.test.ts
- risk flags: write-gated alias; verify disabled-tool listing
```

Use it to seed a PR description or review checklist with touched symbols, likely callers, tests, and risk flags.

Outside an MCP host, run the same analysis from the CLI:

```bash
npx jambavan review-pack --base origin/main --format markdown
npx jambavan review-pack --base origin/main --format json --max-files 30
```

The JSON shape is intended for automation:

```json
{
  "base": "origin/main",
  "touchedCount": 2,
  "files": [
    {
      "status": "M",
      "path": "src/mcp/server.ts",
      "symbols": [
        {
          "name": "startServer",
          "type": "function",
          "startLine": 450,
          "callers": ["main"],
          "tests": ["test/tool-aliases.test.ts"]
        }
      ],
      "risks": ["has open rin debt marker(s)"]
    }
  ],
  "rinMarkers": [
    {
      "file": "./src/mcp/server.ts",
      "line": 500,
      "comment": "temporary guard, remove when aliases are generated",
      "hasUpgrade": true
    }
  ],
  "failures": []
}
```

`rinMarkers` only includes rin debt in touched files. The bundled [Jambavan PR Review workflow](../.github/workflows/jambavan-review.yml) runs the JSON form on pull requests and updates one idempotent PR comment marked with `<!-- jambavan-review -->`.
