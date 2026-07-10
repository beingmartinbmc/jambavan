# Codex CLI + Jambavan

Register Jambavan:

```bash
codex mcp add jambavan -- npx -y jambavan
```

If you need a manual config, use the same server command:

```yaml
mcpServers:
  - name: jambavan
    command: npx -y jambavan
```

Suggested session rule: call `jambavan_context` before editing unfamiliar code and `jambavan_failure_search` before retrying a failed fix.
