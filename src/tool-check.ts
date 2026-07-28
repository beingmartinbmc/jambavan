#!/usr/bin/env node
/**
 * MCP tool check — drives the real Jambavan server over stdio (via the MCP SDK
 * client) and calls every advertised tool with valid arguments, timing each.
 *
 * Runs against a throwaway fixture project (JAMBAVAN_ROOT=tempdir) so writes,
 * bash, and memory deletes are harmless. Exits non-zero if any call fails.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { performance } from 'perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DEPRECATED_TOOLS } from './mcp/tool-aliases';

interface Row { tool: string; ok: boolean; ms: number; note: string; }

const HELLO = `export function greet(name: string): string {
  // rin: naive concat, switch to a template if this grows
  return 'hi ' + name;
}

export function main(): string {
  return greet('world');
}
`;

const NOTES = `In order to make sure that the reader is able to fully understand, please note
that this document is intentionally quite verbose, due to the fact that we want
to be able to demonstrate the compression capabilities in a clear manner.
`;

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'jambavan-toolcheck-'));
  fs.writeFileSync(path.join(proj, 'hello.ts'), HELLO);
  fs.writeFileSync(path.join(proj, 'notes.md'), NOTES);

  // Real git history so jambavan_review_pack has something to diff.
  const git = (args: string[]) => execFileSync('git', args, { cwd: proj });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'toolcheck@example.com']);
  git(['config', 'user.name', 'Tool Check']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'initial']);
  git(['checkout', '-q', '-b', 'feature']);
  fs.appendFileSync(path.join(proj, 'hello.ts'), '\nexport function farewell(name: string): string {\n  return "bye " + name;\n}\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'add farewell']);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v != null) env[k] = v;
  delete env.JAMBAVAN_ROOT;
  // tool-check exercises the mutating tools, which are off by default now.
  env.JAMBAVAN_ALLOW_WRITE = '1';
  env.JAMBAVAN_ALLOW_BASH  = '1';
  env.JAMBAVAN_MEMORY_HOME = path.join(proj, 'global-memory');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args:    [path.join(repoRoot, 'dist', 'index.js')],
    cwd:     path.dirname(proj),
    env,
  });
  const client = new Client({ name: 'jambavan-tool-check', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);

  const advertised = (await client.listTools()).tools.map(t => t.name).sort();

  const rows: Row[] = [];
  async function call(tool: string, args: Record<string, unknown>): Promise<string> {
    const t0 = performance.now();
    try {
      const res = await client.callTool({ name: tool, arguments: args }) as {
        isError?: boolean; content?: { text?: string }[];
      };
      const ms   = Math.round(performance.now() - t0);
      const text = String(res.content?.[0]?.text ?? '');
      const note = (text.split('\n').find(l => l.trim()) ?? '').slice(0, 58);
      rows.push({ tool, ok: !res.isError, ms, note });
      return text;
    } catch (err) {
      rows.push({ tool, ok: false, ms: Math.round(performance.now() - t0), note: String(err).slice(0, 58) });
      return '';
    }
  }

  // Ordered so dependencies are satisfied (index before context/graph, etc.)
  const awakened = await call('jambavan_awaken', { root: proj });
  if (!awakened.includes(proj)) throw new Error('jambavan_awaken did not bind the requested root');
  const doctor = await call('jambavan_doctor', {});
  if (!doctor.includes(`Tools available:  ${advertised.length}`)) {
    throw new Error('jambavan_doctor tool count does not match tools/list');
  }
  await call('jambavan_index', {});
  const warmIndex = await call('jambavan_index', {});
  if (!/Symbols extracted this run: 0/.test(warmIndex) || !/Total indexed symbols: [1-9]/.test(warmIndex)) {
    throw new Error('warm index output did not separate per-run and total symbol counts');
  }
  await call('jambavan_context', { query: 'greet' });
  await call('jambavan_graph', { action: 'report' });
  await call('jambavan_graph', { action: 'query', query: 'greet' });
  await call('jambavan_graph', { action: 'path', from: 'main', to: 'greet' });
  await call('jambavan_watch', { action: 'start' });
  const watcherStatus = await call('jambavan_watch', { action: 'status' });
  if (!/In-process watcher running: true/.test(watcherStatus) || !/Indexed state:\s+1 files, [1-9]/.test(watcherStatus)) {
    throw new Error('watcher status did not report the in-process watcher and persistent index totals');
  }
  await call('jambavan_watch', { action: 'stop' });
  await call('jambavan_debt_ledger', {});
  await call('jambavan_compress_prompt', { path: 'notes.md', in_place: false });

  const stored = await call('jambavan_memory_store', { title: 'Test fact', body: 'The sky is blue.', scope: 'toolcheck' });
  const id = stored.match(/ID:\s*(\S+)/)?.[1] ?? 'toolcheck/test-fact';
  await call('jambavan_memory_read', { id });
  await call('jambavan_memory_status', {});
  await call('jambavan_memory_read', { query: 'sky' });
  await call('jambavan_memory_read', { scope: 'toolcheck' });
  await call('jambavan_memory_mine_session', { text: 'Decision: use template strings.\nTODO: add a test.', scope: 'toolcheck' });
  await call('jambavan_memory_forget', { id, mode: 'invalidate' });
  await call('jambavan_memory_forget', { id, mode: 'delete' });

  // ── Failure memory tools ──
  const failStored = await call('jambavan_failure_store', {
    command: 'npm run build',
    symptom: 'Cannot find module better-sqlite3',
    attempted_fix: 'Reinstalled node_modules',
    status: 'resolved',
    resolution: 'Rebuilt native deps with npm rebuild',
    scope: 'toolcheck',
  });
  await call('jambavan_failure_search', { query: 'better-sqlite3', scope: 'toolcheck' });

  // ── Session handoff tool (export without `text`, import with it) ──
  const exported = await call('jambavan_session_handoff', { scope: 'toolcheck', max_memories: 5 });
  await call('jambavan_session_handoff', { text: exported || '# Empty handoff\n', scope: 'toolcheck' });

  // ── Review pack tool ──
  await call('jambavan_review_pack', { base: 'main' });
  await call('jambavan_impact', { base: 'main', max_depth: 2 });

  await call('read_file', { path: 'hello.ts' });
  await call('write_file', { path: 'scratch.txt', content: 'hi' });
  await call('patch_file', { path: 'scratch.txt', old_text: 'hi', new_text: 'bye' });
  await call('search', { pattern: 'greet' });
  await call('list_files', { path: '.' });
  await call('bash', { command: 'echo ok' });

  // ── Prompts (discipline protocols moved off the tool surface in 2.0) ────────
  const promptArgs: Record<string, Record<string, string>> = {
    root_cause:     { symptom: 'TypeError: Cannot read property of undefined', context: 'greet function', attempts_so_far: '0' },
    verify_gate:    { claim: 'all tests pass', type: 'tests' },
    strategy_plan:  { task: 'add input validation to greet function', scale: 'small' },
    decompose_task: { task: 'add auth module and notification service', units: '2' },
    dev_rules:      { mode: 'full' },
  };
  const advertisedPrompts = (await client.listPrompts()).prompts.map(p => p.name).sort();
  for (const name of advertisedPrompts) {
    const t0 = performance.now();
    try {
      const res = await client.getPrompt({ name, arguments: promptArgs[name] ?? {} });
      const content = res.messages?.[0]?.content;
      const text = content?.type === 'text' ? content.text : '';
      if (!text.trim()) throw new Error('empty prompt body');
      rows.push({ tool: `prompt:${name}`, ok: true, ms: Math.round(performance.now() - t0), note: text.split('\n')[0].slice(0, 58) });
    } catch (err) {
      rows.push({ tool: `prompt:${name}`, ok: false, ms: Math.round(performance.now() - t0), note: String(err).slice(0, 58) });
    }
  }
  const missingPrompts = Object.keys(promptArgs).filter(p => !advertisedPrompts.includes(p));
  if (missingPrompts.length) throw new Error(`prompts/list is missing: ${missingPrompts.join(', ')}`);

  // ── Back-compat: every retired pre-2.0 name must still dispatch ─────────────
  // Args are omitted deliberately; a retired name that no longer resolves fails
  // with "Unknown tool", which is what this is checking for.
  const retiredFailures: string[] = [];
  for (const retired of Object.keys(DEPRECATED_TOOLS)) {
    const res = await client.callTool({ name: retired, arguments: {} }) as {
      isError?: boolean; content?: { text?: string }[];
    };
    if (res.isError && /unknown tool/i.test(String(res.content?.[0]?.text ?? ''))) retiredFailures.push(retired);
  }
  if (retiredFailures.length) throw new Error(`retired tool names no longer resolve: ${retiredFailures.join(', ')}`);
  rows.push({ tool: `back-compat (${Object.keys(DEPRECATED_TOOLS).length} retired names)`, ok: true, ms: 0, note: 'all still dispatch' });

  // ── Report ──────────────────────────────────────────────────────────────────
  const pad = (s: string, n: number) => s.padEnd(n);
  const okCount = rows.filter(r => r.ok).length;
  console.log(`Jambavan MCP tool check — ${okCount}/${rows.length} calls ok\n`);
  console.log(`  ${pad('tool', 30)} ${pad('status', 6)} ${pad('ms', 5)} note`);
  console.log(`  ${'-'.repeat(30)} ${'-'.repeat(6)} ${'-'.repeat(5)} ${'-'.repeat(40)}`);
  for (const r of rows) {
    console.log(`  ${pad(r.tool, 30)} ${pad(r.ok ? 'ok' : 'FAIL', 6)} ${pad(String(r.ms), 5)} ${r.note}`);
  }

  const tested  = new Set(rows.map(r => r.tool));
  const missing = advertised.filter(t => !tested.has(t));
  console.log(`\n  advertised: ${advertised.length}  ·  exercised: ${tested.size}` +
    (missing.length ? `  ·  NOT tested: ${missing.join(', ')}` : '  ·  full coverage'));

  await client.close();
  fs.rmSync(proj, { recursive: true, force: true });
  if (rows.some(r => !r.ok) || missing.length > 0) process.exitCode = 1;
}

main().catch(err => { console.error(err); process.exit(1); });
