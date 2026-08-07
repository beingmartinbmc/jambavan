# Claude Code + Jambavan

Register Jambavan as a local MCP server:

```bash
claude mcp add jambavan -- npx -y jambavan
```

Restart Claude Code after registration and run `/mcp` to confirm Jambavan is active. Recommended first prompt in a repository session:

```text
Call jambavan_doctor {} first. If it reports source: cwd-fallback, call jambavan_awaken { "root": "/absolute/path/to/repository" }; otherwise call jambavan_awaken {}. Then call jambavan_index {}, jambavan_watch { "action": "start" }, and jambavan_context { "query": "<task-specific identifier or focused question>" }. Store durable decisions with jambavan_memory_store { "title": "...", "body": "..." } and failed approaches with jambavan_failure_store.
```

The root-bearing `jambavan_awaken` both binds and awakens. A `tool-input` root can later be re-pointed inside the original fallback boundary; roots fixed by environment, MCP roots, or project cwd cannot.

Source-mutating and shell tools are off by default. Jambavan still writes the code index under `<repo>/.jambavan/` and memories/failure records under `~/.jambavan/memory/`. Enable source mutation or shell execution only for trusted local sessions:

```bash
JAMBAVAN_ALLOW_WRITE=1 JAMBAVAN_ALLOW_BASH=1 claude
```

Check the published version with `npm view jambavan version`; register `jambavan@<version>` instead when you need a pin. Uninstall with `claude mcp remove jambavan`.
