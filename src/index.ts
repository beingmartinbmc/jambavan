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
 *   npx -y jambavan doctor    → one-shot environment/config health check
 *   npx -y jambavan badges    → print local Benchmark/Rin Ledger/Failure Immunity README badges
 *   npx -y jambavan review-pack [--base <branch>] [--format json|markdown]  → review pack for the current branch
 *   npx -y jambavan html-handoff [--out <file>] [--scope <scope>]  → write interactive HTML handoff report
 *   npx -y jambavan bridge    → convert memories to/from a MemPalace-shaped markdown tree
 *   npx -y jambavan handoff --write-pr-template  → inject the session handoff card into a local PR template
 *   npx -y jambavan daemon start|stop|status  → run the file watcher standalone in a detached background process
 *   npx -y jambavan gui [--port <n>] [--no-open]  → local dependency-free graph/rin/failure visualizer
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { startServer } from './mcp/server';
import { loadConfig } from './config/jambavan.config';
import { doctorReport } from './tools/doctor';
import { JambavanIndex } from './index/indexer';
import { harvestRin } from './tools/vibhishana-niti';
import { MemoryStore } from './memory/store';
import { projectScope } from './tools/jambavan';
import type { BenchmarkReport } from './benchmark';
import { exportToMemPalace, importFromMemPalace } from './tools/memory-bridge';
import { buildSessionHandoffHandlers } from './tools/session-handoff';
import { injectHandoffBlock } from './tools/pr-handoff';
import { startDaemon, stopDaemon, formatDaemonStatus } from './tools/daemon';
import { startGuiServer, openBrowser } from './tools/gui';
import { buildReviewPackJson } from './tools/review-pack-json';
import { buildHtmlHandoff } from './tools/html-handoff';

const args = process.argv.slice(2);

if (args[0] === 'review-pack') {
  const config = loadConfig();
  const flagVal = (name: string): string | undefined => {
    const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined;
  };
  const base      = flagVal('--base');
  const maxFiles  = flagVal('--max-files') ? Number(flagVal('--max-files')) : undefined;
  const format    = flagVal('--format') ?? 'markdown';

  const index = new JambavanIndex(config);
  void index.index().then(() => {
    if (format === 'json') {
      try {
        const pack = buildReviewPackJson(config, index, base, maxFiles);
        process.stdout.write(JSON.stringify(pack, null, 2) + '\n');
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
        process.exit(1);
      }
    } else {
      // markdown — reuse existing MCP handler
      const { buildReviewPackHandlers } = require('./tools/review-pack') as typeof import('./tools/review-pack');
      const handlers = buildReviewPackHandlers(config, () => index);
      const input: Record<string, unknown> = {};
      if (base)     input['base']      = base;
      if (maxFiles) input['max_files'] = maxFiles;
      process.stdout.write(handlers.jambavan_review_pack(input) + '\n');
    }
    index.close();
    process.exit(0);
  });
}

if (args[0] === 'html-handoff') {
  const config = loadConfig();
  const flagVal = (name: string): string | undefined => {
    const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined;
  };
  const outFile = flagVal('--out') ?? path.join(config.projectRoot, 'jambavan-handoff.html');
  const scope   = flagVal('--scope');

  const index = new JambavanIndex(config);
  void index.index().then(() => {
    const html = buildHtmlHandoff(config, index, { scope });
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, html, 'utf-8');
    console.log(`Wrote interactive handoff to ${outFile}`);
    index.close();
    process.exit(0);
  });
}

if (args[0] === 'gui') {
  const config = loadConfig();
  const portFlagIdx = args.indexOf('--port');
  const port = portFlagIdx >= 0 ? Number(args[portFlagIdx + 1]) : 4173;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`Invalid --port value: ${args[portFlagIdx + 1]}`);
    process.exit(1);
  }

  const index = new JambavanIndex(config);
  void index.index().then((stats) => {
    console.log(`Indexed ${stats.indexedFiles}/${stats.totalFiles} files before starting the GUI.`);
    const server = startGuiServer(config, index, port);
    server.on('error', (err) => {
      console.error(`Failed to start GUI server: ${err.message}`);
      process.exit(1);
    });
    server.on('listening', () => {
      const url = `http://127.0.0.1:${port}`;
      console.log(`Jambavan GUI running at ${url} (Ctrl+C to stop)`);
      if (!args.includes('--no-open')) openBrowser(url);
    });
  });
}

if (args[0] === 'daemon') {
  const config = loadConfig();
  const sub = args[1];

  if (sub === 'start') {
    const result = startDaemon(config);
    console.log(result.message);
    process.exit(result.started ? 0 : 1);
  }
  if (sub === 'stop') {
    const result = stopDaemon(config);
    console.log(result.message);
    process.exit(result.stopped ? 0 : 1);
  }
  if (sub === 'status') {
    console.log(formatDaemonStatus(config));
    process.exit(0);
  }

  console.error('Usage: jambavan daemon start|stop|status');
  process.exit(1);
}

if (args[0] === 'handoff') {
  const config = loadConfig();
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  if (!args.includes('--write-pr-template')) {
    console.error('Usage: jambavan handoff --write-pr-template [--scope <scope>] [--post]');
    process.exit(1);
  }

  const handoffText = buildSessionHandoffHandlers(config).jambavan_session_export({ scope: flag('--scope') });
  const templatePath = path.join(config.projectRoot, '.github', 'pull_request_template.md');
  const existing = fs.existsSync(templatePath) ? fs.readFileSync(templatePath, 'utf-8') : '';

  fs.mkdirSync(path.dirname(templatePath), { recursive: true });
  fs.writeFileSync(templatePath, injectHandoffBlock(existing, handoffText), 'utf-8');
  console.log(`Wrote handoff block to ${templatePath}`);

  if (!args.includes('--post')) process.exit(0);

  const tmp = path.join(os.tmpdir(), `jambavan-handoff-${Date.now()}.md`);
  fs.writeFileSync(tmp, handoffText, 'utf-8');
  let posted = true;
  try {
    execFileSync('gh', ['pr', 'comment', '--body-file', tmp], { cwd: config.projectRoot, stdio: 'inherit' });
    console.log('Posted handoff as a PR comment via gh.');
  } catch (err) {
    posted = false;
    console.error(`gh pr comment failed: ${err instanceof Error ? err.message : err}`);
    console.error('Is gh installed, authenticated, and is there an open PR for this branch?');
  }
  fs.rmSync(tmp, { force: true });
  process.exit(posted ? 0 : 1);
}

if (args[0] === 'bridge') {
  const config = loadConfig();
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const defaultDir = path.join(config.indexDir, 'bridge', 'mempalace');

  if (flag('--to') === 'mempalace') {
    const outDir = flag('--out') ?? defaultDir;
    const { files, wings } = exportToMemPalace(config, outDir, flag('--scope'));
    console.log(`Exported ${files} memor${files === 1 ? 'y' : 'ies'} to ${outDir}`);
    console.log(`Wings: ${wings.join(', ') || '(none)'}`);
    console.log(`\nJambavan makes no network calls itself — have your host model walk this tree`);
    console.log(`and call mempalace_add_drawer(wing, room, title, content) once per file.`);
    process.exit(0);
  }

  if (flag('--from') === 'mempalace') {
    const inDir = flag('--in') ?? defaultDir;
    const { imported, skipped } = importFromMemPalace(config, inDir);
    console.log(`Imported ${imported} memor${imported === 1 ? 'y' : 'ies'} from ${inDir}` +
      (skipped ? ` (${skipped} file(s) skipped — no parseable frontmatter)` : ''));
    process.exit(0);
  }

  console.error('Usage: jambavan bridge --to mempalace [--out <dir>] [--scope <scope>]');
  console.error('       jambavan bridge --from mempalace [--in <dir>]');
  process.exit(1);
}

if (args[0] === 'badges') {
  const config = loadConfig();

  let benchmarkCard = '📊 **Benchmark:** run `npx jambavan bench` to measure context savings on this repo.';
  try {
    // stdio must be explicit: the benchmark spawns a real MCP server subprocess
    // whose "[jambavan] MCP server ready" stderr line otherwise inherits all
    // the way up through this process's own stderr, printing before the
    // copy-paste badge lines below. Piping still preserves err.stderr on failure.
    const raw = execFileSync(process.execPath, [path.join(__dirname, 'benchmark.js'), '--json'], {
      cwd: config.projectRoot, encoding: 'utf-8', timeout: 120_000, maxBuffer: 10 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const report = JSON.parse(raw) as BenchmarkReport;
    benchmarkCard = `📊 **Benchmark:** Jambavan saved ${report.context.savedPct}% context tokens on this repo vs. reading whole files.`;
  } catch (err) {
    process.stderr.write(`[jambavan badges] benchmark run failed, using placeholder card: ${err instanceof Error ? err.message : err}\n`);
  }

  const { markers } = harvestRin(config);
  const noTrigger = markers.filter(m => !m.hasUpgrade).length;
  const rinLedger = markers.length === 0
    ? '🪶 **Rin Ledger:** clean — no tracked debt.'
    : `🪶 **Rin Ledger:** ${markers.length} debt marker${markers.length === 1 ? '' : 's'} tracked, ${noTrigger} with no upgrade trigger.`;

  const store = new MemoryStore(config.memoryDir);
  const failureCount = store.list(projectScope(config)).filter(d => d.frontmatter.type === 'FailureRecord').length;
  const failureImmunity = `🛡️ **Failure Immunity:** immune to ${failureCount} past loop trap${failureCount === 1 ? '' : 's'}.`;

  console.log([benchmarkCard, rinLedger, failureImmunity].join('\n'));
  console.error('\n(Paste the lines above into your README. Prefer a rendered badge? Use a shields.io static-badge URL instead — that pulls from an external CDN when the README renders, so it is opt-in, not default.)');
  process.exit(0);
}

if (args[0] === 'doctor') {
  const config = loadConfig();
  const dbPath = path.join(config.indexDir, 'symbols.db');
  let indexStats: { files: number; symbols: number } | undefined;
  if (fs.existsSync(dbPath)) {
    const idx = new JambavanIndex(config);
    const stats = idx.stats();
    indexStats = { files: stats.files.totalFiles, symbols: stats.symbols };
    idx.close();
  }
  console.log(doctorReport(config, {
    allowWrite: process.env.JAMBAVAN_ALLOW_WRITE === '1',
    allowBash: process.env.JAMBAVAN_ALLOW_BASH === '1',
    indexStats,
  }));
  process.exit(0);
}

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
  jambavan_doctor        One-shot health check: root source, parsers, gates, memory dir, CI
  jambavan_review_pack   Review pack for the current branch: touched symbols/callers/tests/failures/risk

  jambavan_memory_store  Persist a memory as an OKF markdown document
  jambavan_memory_search BM25 search across stored memories
  jambavan_memory_recall Load all memories for a scope (session wake-up)
  jambavan_memory_mine_session  Mine durable facts from pasted transcript/log text
  jambavan_memory_invalidate Mark a memory superseded/obsolete
  jambavan_memory_delete Remove a memory by ID or wipe a scope
  jambavan_memory_status Bundle statistics (total count, by scope)

  jambavan_failure_store Store a structured failure record (command, symptom, root cause)
  jambavan_failure_search Search past failures before retrying a failing command

  jambavan_session_export Export session context as a portable handoff document
  jambavan_session_import Import a handoff document into memory

  jambavan_mool_kaaran   Root-cause investigation protocol (call before debugging)
  jambavan_praman        Verification gate (call before claiming completion)
  jambavan_yukti         Approach strategy protocol (call before multi-step tasks)
  jambavan_vibhaajan     Parallel work decomposition (call when task has independent units)

  Functional aliases:
  root_cause       Alias for jambavan_mool_kaaran
  verify_gate      Alias for jambavan_praman
  strategy_plan    Alias for jambavan_yukti
  decompose_task   Alias for jambavan_vibhaajan
  dev_rules        Alias for jambavan_vibhishana_niti
  debt_ledger      Alias for jambavan_rin_mochan
  compress_prompt  Alias for jambavan_sankshipta (write-gated)

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

// All CLI sub-commands above schedule process.exit() before reaching here.
// Only start the MCP server when no sub-command matched.
const CLI_COMMANDS = new Set(['gui', 'review-pack', 'html-handoff', 'daemon', 'bridge', 'badges', 'doctor', '--help', '-h', '--version']);
if (!CLI_COMMANDS.has(args[0] ?? '')) {
  startServer().catch(err => {
    process.stderr.write(`[jambavan] Fatal: ${err}\n`);
    process.exit(1);
  });
}
