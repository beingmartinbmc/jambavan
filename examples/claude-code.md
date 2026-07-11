# Claude Code + Jambavan

Register Jambavan as a local MCP server:

```bash
claude mcp add jambavan -- npx -y jambavan
```

Recommended first prompt in a new Claude Code session:

```text
Call jambavan_awaken {}, jambavan_doctor {}, jambavan_index {}, and jambavan_watch { "action": "start" }, in that order. Before editing unfamiliar code, call jambavan_context { "query": "<task-specific query>" }. Store durable decisions with jambavan_memory_store { "title": "...", "body": "..." } and failed approaches with jambavan_failure_store.
```

Source-mutating and shell tools are off by default; Jambavan still writes its own index, memory, and failure state under `.jambavan/`. Enable source mutation or shell execution only for trusted local sessions:

```bash
JAMBAVAN_ALLOW_WRITE=1 JAMBAVAN_ALLOW_BASH=1 claude
```

Restart Claude Code after registration and run `/mcp` to confirm Jambavan is active. Check the published version with `npm view jambavan version`; register `jambavan@<version>` instead when you need a pin. Uninstall with `claude mcp remove jambavan`.
