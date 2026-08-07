# Continue + Jambavan

Add Jambavan to `~/.continue/config.yaml`:

```yaml
name: Local config
version: 1.0.0
schema: v1
mcpServers:
  - name: Jambavan
    command: npx
    args:
      - -y
      - jambavan
```

Restart Continue, switch to Agent mode, and start each repo session with:

```text
jambavan_doctor {}
jambavan_awaken {}
jambavan_index {}
jambavan_watch { "action": "start" }
jambavan_context { "query": "<task-specific query>" }
```

If doctor reports `source: cwd-fallback`, replace the plain awaken call with `jambavan_awaken { "root": "/absolute/path/to/repository" }`. That call both binds and awakens. A `tool-input` root can later be re-pointed inside the original fallback boundary; stronger environment, MCP-roots, and project-cwd roots stay fixed.

Check the published version with `npm view jambavan version`; pin `jambavan@<version>` in `args` when needed.

To uninstall, remove the Jambavan entry from `mcpServers` and restart Continue. Jambavan stays local: it does not call an LLM or upload code.
