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
jambavan_awaken {}
jambavan_doctor {}
jambavan_index {}
jambavan_watch { "action": "start" }
jambavan_context { "query": "<task-specific query>" }
```

If `jambavan_awaken` or `jambavan_doctor` reports an unresolved `cwd-fallback`, bind an eligible repository before any stateful call:

```text
jambavan_awaken { "root": "/absolute/path/to/repository" }
```

The same optional `root` is accepted by `jambavan_index`. It must be an existing absolute directory inside the current fallback root and cannot override an already fixed `env`, `client-roots`, `cwd-project`, or `tool-input` binding. Otherwise set `JAMBAVAN_ROOT` and restart Cursor. Jambavan blocks stateful tools until the root is resolved.

Check the published version with `npm view jambavan version`; use `jambavan@<version>` as the final argument to pin it. To uninstall, remove the `jambavan` key from `mcpServers` and restart Cursor.
