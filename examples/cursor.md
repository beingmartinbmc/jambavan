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

Check the published version with `npm view jambavan version`; use `jambavan@<version>` as the final argument to pin it. To uninstall, remove the `jambavan` key from `mcpServers` and restart Cursor.
