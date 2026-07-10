# Claude Code + Jambavan

Register Jambavan as a local MCP server:

```bash
claude mcp add jambavan -- npx -y jambavan
```

Recommended first prompt in a new Claude Code session:

```text
Call jambavan_awaken, then jambavan_index, then jambavan_watch start. Before editing unfamiliar code, call jambavan_context with the task-specific query. Store durable decisions with jambavan_memory_store and failed approaches with jambavan_failure_store.
```

Optional write/shell tools are off by default. Enable only for trusted local sessions:

```bash
JAMBAVAN_ALLOW_WRITE=1 JAMBAVAN_ALLOW_BASH=1 claude
```
