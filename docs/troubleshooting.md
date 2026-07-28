# Troubleshooting

## GUI apps and NVM

GUI-launched hosts such as Cursor often do not inherit your shell PATH. Symptoms: `spawn npx ENOENT`, or `env: node: No such file or directory`. Fix by running absolute `node` against npm's `npx-cli.js`, and set `PATH` explicitly.

Find paths:

```bash
command -v node
echo "$(npm prefix -g)/lib/node_modules/npm/bin/npx-cli.js"
```

Cursor config with NVM and npm-policy workarounds:

```json
{
  "mcpServers": {
    "jambavan": {
      "command": "/abs/path/to/node",
      "args": [
        "/abs/path/to/npm/bin/npx-cli.js",
        "-y",
        "--registry=https://registry.npmjs.org",
        "--before=",
        "jambavan@latest"
      ],
      "env": { "PATH": "/abs/path/to/node/dir:/usr/bin:/bin" }
    }
  }
}
```

Claude Code `.claude.json` uses the same shape. Put npm policy overrides and the project root in `env` so reconnects do not fall back to an empty environment:

```json
{
  "mcpServers": {
    "jambavan": {
      "command": "/abs/path/to/node",
      "args": ["/abs/path/to/npm/bin/npx-cli.js", "-y", "jambavan@latest"],
      "env": {
        "PATH": "/abs/path/to/node/dir:/usr/bin:/bin",
        "npm_config_registry": "https://registry.npmjs.org",
        "npm_config_min_release_age": "0",
        "JAMBAVAN_ROOT": "/abs/path/to/one/repo"
      }
    }
  }
}
```

In Claude Code this can show up as `-32000` / `failed to reconnect` because the MCP server process never started cleanly. Check MCP logs for the npm/PATH error.

## Root confusion

At startup, `JAMBAVAN_ROOT` wins. Otherwise Jambavan walks up from the server process cwd, and a supported single file-URI MCP `roots/list` result may replace that cwd result. When the resulting source is `cwd-fallback`, memory tools remain available against the global archive while repository-bound tools fail closed. `jambavan_awaken.root` or `jambavan_index.root` may then bind an existing absolute directory inside the current fallback root; use `JAMBAVAN_ROOT` and reconnect when the repository is outside it. Root rebinding never moves or changes the memory archive.

Run `jambavan_doctor` or `npx jambavan doctor`. Healthy MCP output should show the target repo with `source: env`, `source: client-roots`, `source: tool-input`, or `source: cwd-project`.

### One server, many workspaces

Some hosts — Cursor among them — run a single MCP server process for every open window, so the root is shared rather than per-workspace. A root bound through `jambavan_awaken.root` or `jambavan_index.root` can therefore be re-pointed to another directory inside the same fallback root, which lets a second workspace claim the server; rebinding stops the watcher and closes the open index first. A root from `JAMBAVAN_ROOT`, `roots/list`, or the server's own cwd is a real signal and stays fixed, so `root is already fixed by ...` means the answer is `JAMBAVAN_ROOT` on a per-project MCP entry (giving each repo its own server), not a retry.

## Degraded parsers

`jambavan_doctor` reports each language as `tree-sitter` or `regex fallback`. A regex fallback that carries an error means a native binding failed to load (usually an ABI mismatch after a Node upgrade) and AST accuracy is reduced. Run `npm rebuild`, then re-check.

## Reporting a bug

```text
jambavan_doctor { "issue_report": true }
```

That returns a copy-ready, redacted GitHub issue body and a prefilled URL. It posts nothing and makes no network request; review the body before sharing, since redaction is best-effort.
