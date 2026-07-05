#!/usr/bin/env node
/**
 * Jambavan benchmark — dogfoods the real pipeline on the current project.
 *
 * No LLM calls, no external services, deterministic. It measures the claims
 * Jambavan makes, on more than one axis (not just tokens):
 *
 *   1. Index      — cold build time, incremental (warm) re-index, throughput.
 *   2. Context    — tokens shipped by jambavan_context vs. the naive baseline
 *                   (open every matching file), plus files-to-read, chunk count,
 *                   and assemble latency.
 *   3. Graph      — nodes/edges extracted from the AST, provenance split
 *                   (EXTRACTED vs INFERRED), build/query/path latency.
 *   4. Sankshipta — prose/prompt compression ratio.
 *   5. Tool latency — every MCP tool the server advertises, called over the
 *                     real stdio transport (same path a host model uses).
 *
 * Runs against a throwaway index dir and a throwaway fixture project, so it
 * never touches your real .jambavan/ index or memory.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig, type JambavanConfig } from './config/jambavan.config';
import { JambavanIndex } from './index/indexer';
import { ContextAssembler, type ContextChunk } from './context/assembler';
import { countTokens } from './context/token-counter';
import { sankshiptaText } from './tools/sankshipta';
import { buildSymbolGraph, graphQuery, graphPath } from './knowledge/graph';

/**
 * Auto-derive queries from the repo's own most common symbol names, so the
 * context benchmark is meaningful on any codebase (not just this one).
 */
function deriveQueries(index: JambavanIndex, n = 5): string[] {
  const freq = new Map<string, number>();
  for (const s of index.getAllSymbols(5000)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{4,}$/.test(s.name)) continue;
    freq.set(s.name, (freq.get(s.name) ?? 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(e => e[0]);
}

// A representative verbose instruction block — the kind of prose that pads prompts.
const PROSE_SAMPLE = `
Please make sure that you carefully go through the entire codebase in order to
understand how the authentication middleware actually works. It is really important
that we do not break any of the existing functionality. In the event that you find
a bug, please go ahead and fix the root cause rather than just patching the symptom.
Due to the fact that this service is used by a large number of downstream consumers,
we need to be absolutely certain that the changes are backwards compatible at all times.
`.trim();

const pad = (s: string, n: number) => s.padEnd(n);
const rpad = (s: string | number, n: number) => String(s).padStart(n);
const saved = (part: number, whole: number) =>
  whole === 0 ? '—' : `${Math.round((1 - part / whole) * 100)}%`;
const perSec = (count: number, ms: number) =>
  ms === 0 ? '—' : `${Math.round(count / (ms / 1000)).toLocaleString()}/s`;

/** Median wall-clock ms of `fn` over `runs` iterations — for sub-ms pure calls. */
function medianMs(fn: () => void, runs = 20): number {
  fn(); // warmup
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return stats(samples).median;
}

const HELLO_FIXTURE = `export function greet(name: string): string {
  return 'hi ' + name;
}

export function main(): string {
  return greet('world');
}
`;

interface ToolTiming { tool: string; n: number; minMs: number; medianMs: number; maxMs: number; note: string; }

function stats(samples: number[]): { min: number; median: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { min: sorted[0], median, max: sorted[sorted.length - 1] };
}

/**
 * Times every advertised MCP tool over the real stdio transport — the same
 * request/response path a host model uses, not an in-process shortcut.
 * Read-only/idempotent tools run REPEATS times to get a min/median/max;
 * mutating tools (store, write, patch, invalidate, …) run once since
 * repeating them changes state each call.
 */
async function benchTools(): Promise<ToolTiming[]> {
  const repoRoot = process.cwd();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'jambavan-bench-tools-'));
  fs.writeFileSync(path.join(proj, 'hello.ts'), HELLO_FIXTURE);
  fs.writeFileSync(path.join(proj, 'notes.md'), PROSE_SAMPLE);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v != null) env[k] = v;
  env.JAMBAVAN_ROOT = proj;
  env.JAMBAVAN_ALLOW_WRITE = '1';
  env.JAMBAVAN_ALLOW_BASH = '1';

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, 'dist', 'index.js')],
    cwd: repoRoot,
    env,
  });
  const client = new Client({ name: 'jambavan-bench', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);

  const rows: ToolTiming[] = [];
  const REPEATS = 10;

  async function callOnce(tool: string, args: Record<string, unknown>): Promise<{ ms: number; note: string }> {
    const t0 = performance.now();
    const res = await client.callTool({ name: tool, arguments: args }) as {
      isError?: boolean; content?: { text?: string }[];
    };
    const ms = performance.now() - t0;
    const text = String(res.content?.[0]?.text ?? '');
    const note = res.isError ? `FAIL: ${text.slice(0, 40)}` : (text.split('\n').find(l => l.trim()) ?? '').slice(0, 40);
    return { ms, note };
  }

  async function bench(tool: string, args: Record<string, unknown>, repeats = REPEATS): Promise<void> {
    await callOnce(tool, args); // warmup — first call may pay JIT/cache costs
    const samples: number[] = [];
    let note = '';
    for (let i = 0; i < repeats; i++) {
      const { ms, note: n } = await callOnce(tool, args);
      samples.push(ms);
      note = n;
    }
    const { min, median, max } = stats(samples);
    rows.push({ tool, n: repeats, minMs: min, medianMs: median, maxMs: max, note });
  }

  async function benchOnce(tool: string, args: Record<string, unknown>): Promise<string> {
    const { ms, note } = await callOnce(tool, args);
    rows.push({ tool, n: 1, minMs: ms, medianMs: ms, maxMs: ms, note });
    return note;
  }

  // Order matters: index before context/graph/watch; memory_store before the
  // reads/writes that depend on its ID.
  await benchOnce('jambavan_awaken', {});
  await bench('jambavan_diagnostics', {});
  await benchOnce('jambavan_index', {});
  await bench('jambavan_context', { query: 'greet' });
  await bench('jambavan_graph_report', {});
  await bench('jambavan_graph_query', { query: 'greet' });
  await bench('jambavan_graph_path', { from: 'main', to: 'greet' });
  await benchOnce('jambavan_watch', { action: 'start' });
  await bench('jambavan_watch', { action: 'status' });
  await benchOnce('jambavan_watch', { action: 'stop' });
  await bench('jambavan_vibhishana_niti', { mode: 'full' });
  await bench('jambavan_rin_mochan', {});
  await bench('jambavan_sankshipta', { path: 'notes.md', in_place: false });

  const stored = await benchOnce('jambavan_memory_store', { title: 'Bench fact', body: 'The sky is blue.', scope: 'bench' });
  const id = stored.match(/ID:\s*(\S+)/)?.[1] ?? 'bench/bench-fact';
  await bench('jambavan_memory_status', {});
  await bench('jambavan_memory_search', { query: 'sky' });
  await bench('jambavan_memory_recall', { scope: 'bench' });
  await benchOnce('jambavan_memory_mine_session', { text: 'Decision: use template strings.', scope: 'bench' });
  await benchOnce('jambavan_memory_invalidate', { id });
  await benchOnce('jambavan_memory_delete', { id });

  await benchOnce('jambavan_failure_store', {
    command: 'npm run build',
    symptom: "TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
    status: 'unresolved',
    do_not_retry: 'Re-running the same build without fixing the type mismatch.',
  });
  await bench('jambavan_failure_search', { query: 'npm run build' });

  // Fetch full handoff text (untimed) so session_import has a realistic document to parse.
  const handoffRes = await client.callTool({ name: 'jambavan_session_export', arguments: {} }) as {
    content?: { text?: string }[];
  };
  const handoffText = String(handoffRes.content?.[0]?.text ?? '');
  await bench('jambavan_session_export', {});
  await benchOnce('jambavan_session_import', { text: handoffText });

  await bench('jambavan_mool_kaaran', { symptom: 'TypeError: Cannot read property of undefined', attempts_so_far: 1 });
  await bench('jambavan_praman', { claim: 'all tests pass', type: 'tests' });
  await bench('jambavan_yukti', { task: 'add input validation to greet function' });
  await bench('jambavan_vibhaajan', { task: 'add auth module and notification service', units: 2 });

  await bench('read_file', { path: 'hello.ts' });
  await benchOnce('write_file', { path: 'scratch.txt', content: 'hi' });
  await benchOnce('patch_file', { path: 'scratch.txt', old_text: 'hi', new_text: 'bye' });
  await bench('search', { pattern: 'greet' });
  await bench('list_files', { path: '.' });
  await bench('bash', { command: 'echo ok' });

  await client.close();
  fs.rmSync(proj, { recursive: true, force: true });
  return rows;
}

async function main(): Promise<void> {
  const base = loadConfig();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jambavan-bench-'));
  const config: JambavanConfig = { ...base, indexDir: tmp, memoryDir: path.join(tmp, 'memory') };

  console.log(`Jambavan benchmark`);
  console.log(`project: ${config.projectRoot}\n`);

  const index = new JambavanIndex(config);
  const cold = await index.index();        // cold: parses everything
  const warm = await index.index();        // warm: nothing changed → all skipped

  console.log('## Index');
  console.log(`  files discovered  : ${cold.totalFiles}`);
  console.log(`  symbols extracted : ${cold.totalSymbols}`);
  console.log(`  cold build        : ${cold.durationMs} ms  (${cold.indexedFiles} files parsed)`);
  console.log(`  warm re-index     : ${warm.durationMs} ms  (${warm.skippedFiles} skipped)`);
  console.log(`  cold throughput   : ${perSec(cold.totalFiles, cold.durationMs)} files · ${perSec(cold.totalSymbols, cold.durationMs)} symbols`);
  if (warm.durationMs > 0) {
    console.log(`  incremental speedup: ${(cold.durationMs / Math.max(warm.durationMs, 1)).toFixed(1)}x`);
  }

  const assembler = new ContextAssembler(config);
  const queries = deriveQueries(index);
  console.log('\n## Context — what it takes to answer a query');
  console.log(`  queries  = the repo's most common symbols (auto-derived)`);
  console.log(`  baseline = an agent opens the full contents of every file containing a match`);
  console.log(`  jambavan = ranked, budgeted snippets instead`);
  console.log(`  files    = whole files the baseline agent must read for this query`);
  console.log(`  chunks   = focused snippets jambavan ships instead`);
  console.log(`  budget   = ${config.contextTokenBudget} tokens\n`);
  const cols = () => `  ${'-'.repeat(20)} ${'-'.repeat(5)} ${'-'.repeat(6)} ${'-'.repeat(9)} ${'-'.repeat(10)} ${'-'.repeat(6)} ${'-'.repeat(9)}`;
  console.log(`  ${pad('query', 20)} ${rpad('files', 5)} ${rpad('chunks', 6)} ${rpad('jambavan', 9)} ${rpad('baseline', 10)} ${rpad('saved', 6)} ${rpad('assemble', 9)}`);
  console.log(cols());

  let totJ = 0, totB = 0, totFiles = 0, totChunks = 0, answered = 0;
  for (const q of queries) {
    const results = index.search(q, 30);
    if (results.length === 0) {
      console.log(`  ${pad(q, 20)} ${rpad('(no hit)', 5)}`);
      continue;
    }
    const chunks: ContextChunk[] = results.map(r => ({
      filePath:  r.symbol.filePath,
      content:   r.symbol.content,
      score:     r.score,
      startLine: r.symbol.startLine,
      endLine:   r.symbol.endLine,
      type:      r.symbol.type,
    }));

    const assembled = assembler.assemble(chunks);
    const usedTokens = assembled.usedTokens;
    const asmMs = medianMs(() => assembler.assemble(chunks));

    const files = new Set(chunks.map(c => c.filePath));
    let baseline = 0;
    for (const f of files) if (fs.existsSync(f)) baseline += countTokens(fs.readFileSync(f, 'utf-8'));

    totJ += usedTokens; totB += baseline; totFiles += files.size; totChunks += assembled.includedChunks; answered++;
    console.log(`  ${pad(q, 20)} ${rpad(files.size, 5)} ${rpad(assembled.includedChunks, 6)} ${rpad(usedTokens, 9)} ${rpad(baseline, 10)} ${rpad(saved(usedTokens, baseline), 6)} ${rpad(asmMs.toFixed(2) + ' ms', 9)}`);
  }
  if (answered > 0) {
    console.log(cols());
    console.log(`  ${pad('TOTAL', 20)} ${rpad(totFiles, 5)} ${rpad(totChunks, 6)} ${rpad(totJ, 9)} ${rpad(totB, 10)} ${rpad(saved(totJ, totB), 6)}`);
  }

  console.log('\n## Graph — relationships extracted from the AST');
  const symbols = index.getAllSymbols(100000);
  const buildMs = medianMs(() => buildSymbolGraph(symbols, config), 5);
  const graph = buildSymbolGraph(symbols, config);
  const extracted = graph.edges.filter(e => e.confidence === 'EXTRACTED').length;
  const inferred = graph.edges.filter(e => e.confidence === 'INFERRED').length;
  console.log(`  nodes           : ${graph.nodes.length}  (files + symbols + memories)`);
  console.log(`  edges           : ${graph.edges.length}  (${extracted} EXTRACTED · ${inferred} INFERRED)`);
  console.log(`  build           : ${buildMs.toFixed(1)} ms  (${perSec(graph.edges.length, buildMs)} edges)`);
  if (queries.length) {
    const q = queries[0];
    console.log(`  query "${q}"`.padEnd(18) + `: ${medianMs(() => graphQuery(graph, q)).toFixed(2)} ms`);
    console.log(`  shortest path   : ${medianMs(() => graphPath(graph, queries[0], queries[Math.min(1, queries.length - 1)])).toFixed(2)} ms`);
  }

  console.log('\n## Sankshipta — prose compression');
  const before = countTokens(PROSE_SAMPLE);
  const compact = sankshiptaText(PROSE_SAMPLE);
  const after = countTokens(compact);
  console.log(`  before : ${before} tokens`);
  console.log(`  after  : ${after} tokens`);
  console.log(`  saved  : ${saved(after, before)}`);

  index.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('\n## Tool latency — every exposed MCP tool, over the real stdio transport');
  console.log(`  n=10 for read-only/idempotent tools (min/median/max shown); n=1 for mutating tools\n`);
  const toolRows = await benchTools();
  console.log(`  ${pad('tool', 26)} ${rpad('n', 3)} ${rpad('min ms', 7)} ${rpad('median ms', 10)} ${rpad('max ms', 7)}  note`);
  console.log(`  ${'-'.repeat(26)} ${'-'.repeat(3)} ${'-'.repeat(7)} ${'-'.repeat(10)} ${'-'.repeat(7)}  ${'-'.repeat(40)}`);
  for (const r of toolRows) {
    console.log(`  ${pad(r.tool, 26)} ${rpad(r.n, 3)} ${rpad(r.minMs.toFixed(1), 7)} ${rpad(r.medianMs.toFixed(1), 10)} ${rpad(r.maxMs.toFixed(1), 7)}  ${r.note}`);
  }
  const failed = toolRows.filter(r => r.note.startsWith('FAIL'));
  const uniqueTools = new Set(toolRows.map(r => r.tool)).size;
  console.log(`\n  ${uniqueTools} tools · ${toolRows.length} calls` + (failed.length ? `  ·  ${failed.length} FAILED: ${failed.map(r => r.tool).join(', ')}` : '  ·  all ok'));
  if (failed.length) process.exitCode = 1;
}

main().catch(err => { console.error(err); process.exit(1); });
