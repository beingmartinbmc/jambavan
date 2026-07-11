# Codex CLI + Jambavan

Register Jambavan:

```bash
codex mcp add jambavan -- npx -y jambavan
```

If you need a manual config, add this to `~/.codex/config.toml` (or a trusted project's `.codex/config.toml`):

```toml
[mcp_servers.jambavan]
command = "npx"
args = ["-y", "jambavan"]
```

Restart Codex and use `/mcp` to confirm Jambavan is active. Start each repo session with:

```text
jambavan_awaken {}
jambavan_doctor {}
jambavan_index {}
jambavan_watch { "action": "start" }
jambavan_context { "query": "<task-specific query>" }
```

Call `jambavan_failure_search { "query": "<command or symptom>" }` before retrying a failed fix. Check the published version with `npm view jambavan version`; pin `jambavan@<version>` in `args` when reproducibility matters. Remove it with `codex mcp remove jambavan`.
