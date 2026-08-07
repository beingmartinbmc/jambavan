# Cursor + Jambavan

Add Jambavan to your global `~/.cursor/mcp.json` or project `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "jambavan": {
      "command": "npx",
      "args": ["-y", "jambavan"]
    }
  }
}
```

If Cursor was launched from the GUI and cannot find `node`/`npx`, use absolute paths and an explicit `PATH` as shown in the main README troubleshooting section.

Restart Cursor, confirm Jambavan is connected in MCP settings, then start each repo session with:

```text
jambavan_doctor {}
jambavan_awaken {}
jambavan_index {}
jambavan_watch { "action": "start" }
jambavan_context { "query": "<task-specific query>" }
```

If `jambavan_doctor` reports an unresolved `cwd-fallback`, replace the plain awaken call with:

```text
jambavan_awaken { "root": "/absolute/path/to/repository" }
```

The same optional `root` is accepted by `jambavan_index`. It must be an existing absolute directory inside the original fallback boundary. A previous `tool-input` root can be re-pointed within that boundary, which supports Cursor instances shared across workspaces. It cannot override a root fixed by `env`, `client-roots`, or `cwd-project`; set `JAMBAVAN_ROOT` in a per-project MCP entry and restart Cursor in that case. Repository-bound tools stay blocked until the root is resolved.

Check the published version with `npm view jambavan version`; use `jambavan@<version>` as the final argument to pin it. To uninstall, remove the `jambavan` key from `mcpServers` and restart Cursor.
