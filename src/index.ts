#!/usr/bin/env node
/**
 * Jambavan — MCP server entrypoint.
 *
 * Jambavan is a Model Context Protocol server.
 * It provides index-aware code tools to any MCP host:
 *   • Claude Code  (claude mcp add)
 *   • Codex CLI    (MCP config)
 *   • Cursor       (.cursor/mcp.json)
 *   • Continue     (config.json mcpServers)
 *
 * Jambavan does NOT call any LLM itself.
 * The host model thinks. Jambavan acts.
 *
 * Usage:
 *   npx -y jambavan → starts MCP server over stdio
 *   npx -y jambavan --help    → show registration instructions
 */

import { startServer } from './mcp/server';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
jambavan — MCP server for Claude Code, Codex, and Cursor
=======================================================

Jambavan exposes these MCP tools to the host model:

  jambavan_awaken        Return Jambavan startup protocol + recent project memories
  jambavan_index         Build / refresh the codebase index (tree-sitter, incremental)
  jambavan_context       Search index and return ranked, token-budgeted code context
  jambavan_watch         Start / stop live file watcher (incremental re-index on save)
  jambavan_graph_report  Report lightweight symbol/file graph hubs and confidence notes
  jambavan_graph_query   Query graph nodes + nearby edges
  jambavan_graph_path    Shortest path between two graph nodes
  jambavan_sankshipta    Compress markdown/prose into fewer prompt tokens
  jambavan_vibhishana_niti  Activate efficient senior-dev mode (lite / full / ultra)
  jambavan_rin_mochan    Harvest rin comments into a tracked debt ledger
  jambavan_diagnostics   Show parser backends (tree-sitter vs regex) and index stats

  jambavan_memory_store  Persist a memory as an OKF markdown document
  jambavan_memory_search BM25 search across stored memories
  jambavan_memory_recall Load all memories for a scope (session wake-up)
  jambavan_memory_mine_session  Mine durable facts from pasted transcript/log text
  jambavan_memory_invalidate Mark a memory superseded/obsolete
  jambavan_memory_delete Remove a memory by ID or wipe a scope
  jambavan_memory_status Bundle statistics (total count, by scope)

  read_file            Read a file (with optional line range)
  write_file           Write or overwrite a file
  patch_file           Find-and-replace patch on an existing file
  bash                 Execute a shell command
  search               Ripgrep-powered code search
  list_files           List directory contents

Typical workflow
----------------
  1. jambavan_awaken             ← recall protocol + recent project memories
  2. jambavan_index              ← index the project once
  3. jambavan_watch start        ← keep index live while you edit
  4. jambavan_context            ← get relevant context on demand
  5. jambavan_memory_store       ← persist key decisions / facts
  6. jambavan_memory_recall      ← restore context at session start

Registration
------------
Claude Code:
  claude mcp add jambavan -- npx -y jambavan

Cursor (.cursor/mcp.json):
  {
    "mcpServers": {
      "jambavan": { "command": "npx", "args": ["-y", "jambavan"] }
    }
  }

Codex (~/.codex/config.yaml):
  mcpServers:
    - name: jambavan
      command: npx -y jambavan

Continue (~/.continue/config.json):
  "mcpServers": [{ "name": "jambavan", "command": "npx -y jambavan" }]

Environment:
  JAMBAVAN_ROOT=<path>         Override project root (default: auto-detected)
  JAMBAVAN_TOKEN_BUDGET=<n>    Max tokens in jambavan_context results (default: 8000)
  JAMBAVAN_MEMORY_HOME=<path>  Shared memory palace path (default: .jambavan/memory)
  JAMBAVAN_DEV_MODE=<level>    Default Vibhishana Niti level: lite | full | ultra (default: full)
  JAMBAVAN_ALLOW_OUTSIDE_ROOT=1  Disable project-root sandbox for local trusted use only
`);
  process.exit(0);
}

startServer().catch(err => {
  process.stderr.write(`[jambavan] Fatal: ${err}\n`);
  process.exit(1);
});
