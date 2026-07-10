# Continue + Jambavan

Create `~/.continue/mcpServers/jambavan.json`:

```json
{
  "command": "npx",
  "args": ["-y", "jambavan"]
}
```

Then ask Continue to call `jambavan_awaken`, `jambavan_index`, and `jambavan_context` for the task. Jambavan stays local: it does not call an LLM or upload code.
