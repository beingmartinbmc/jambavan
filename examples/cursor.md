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

Start each repo session with `jambavan_doctor`, then `jambavan_awaken`, `jambavan_index`, and `jambavan_watch start`.
