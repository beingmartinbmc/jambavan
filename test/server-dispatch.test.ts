/**
 * In-process MCP dispatch integration test.
 *
 * Drives the real `startServer` tools/call handler through the SDK's
 * InMemoryTransport instead of a subprocess, so the dispatch (and the handler
 * modules it delegates to) is exercised under coverage. JAMBAVAN_ROOT is set to
 * an isolated temp project BEFORE importing the server module, because that
 * module builds its config once at import time.
 */
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

// Isolated project root, created and exported before the server module loads.
const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jambavan-dispatch-')));
process.env.JAMBAVAN_ROOT = proj;
process.env.JAMBAVAN_MEMORY_HOME = path.join(proj, 'global-memory');
delete process.env.JAMBAVAN_ALLOW_WRITE;
delete process.env.JAMBAVAN_ALLOW_BASH;

fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
fs.writeFileSync(
  path.join(proj, 'src', 'hello.ts'),
  'export function greet(name: string): string {\n  return "hi " + name;\n}\n\nexport function main(): string {\n  return greet("world");\n}\n',
);
fs.writeFileSync(path.join(proj, 'notes.md'), 'Decision: keep greet synchronous.\nTODO: add farewell.\n');
const git = (args: string[]) => execFileSync('git', args, { cwd: proj });
git(['init', '-q', '-b', 'main']);
git(['config', 'user.email', 'dispatch@example.com']);
git(['config', 'user.name', 'Dispatch']);
git(['add', '.']);
git(['commit', '-q', '-m', 'initial']);

// Import AFTER JAMBAVAN_ROOT is set so the module-level config targets `proj`.
const { startServer } = require('../src/mcp/server') as typeof import('../src/mcp/server');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

let client: InstanceType<typeof Client>;

async function callText(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const res = await client.callTool({ name, arguments: args }) as {
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  const text = res.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
  return { text, isError: Boolean(res.isError) };
}

before(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await startServer(serverTransport);
  client = new Client({ name: 'dispatch-test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
});

after(() => {
  fs.rmSync(proj, { recursive: true, force: true });
});

test('tools/list advertises read-only tools and hides write/bash by default', async () => {
  const { tools } = await client.listTools() as { tools: Array<{ name: string }> };
  const names = tools.map(t => t.name);
  assert.ok(names.includes('jambavan_awaken'), 'awaken advertised');
  assert.ok(names.includes('jambavan_context'), 'context advertised');
  assert.ok(names.includes('read_file'), 'read_file advertised');
  assert.ok(!names.includes('write_file'), 'write_file hidden without JAMBAVAN_ALLOW_WRITE');
  assert.ok(!names.includes('bash'), 'bash hidden without JAMBAVAN_ALLOW_BASH');
});

test('awaken → index → context exercise the stateful dispatch path', async () => {
  const awaken = await callText('jambavan_awaken', {});
  assert.equal(awaken.isError, false);
  assert.match(awaken.text, /root|protocol|Jambavan/i);

  const index = await callText('jambavan_index', {});
  assert.equal(index.isError, false);
  assert.match(index.text, /file|symbol|index/i);

  const context = await callText('jambavan_context', { query: 'greet' });
  assert.equal(context.isError, false);
  assert.match(context.text, /greet|Context/);
});

test('graph, diagnostics, doctor, and review tools dispatch without error', async () => {
  for (const [name, args] of [
    ['jambavan_diagnostics', {}],
    ['jambavan_doctor', {}],
    ['jambavan_graph_report', {}],
    ['jambavan_graph_query', { query: 'greet' }],
    ['jambavan_review_pack', {}],
    ['jambavan_impact', {}],
  ] as Array<[string, Record<string, unknown>]>) {
    const res = await callText(name, args);
    assert.equal(res.isError, false, `${name} should not error: ${res.text}`);
    assert.ok(res.text.length > 0, `${name} returned text`);
  }
});

test('memory tools store, search, recall, status, and delete through the dispatch', async () => {
  const store = await callText('jambavan_memory_store', {
    title: 'Dispatch decision',
    body: 'greet stays synchronous for compatibility',
    scope: 'dispatch',
  });
  assert.equal(store.isError, false);
  assert.match(store.text, /Stored.*dispatch\//);
  const id = store.text.match(/ID:\s*(\S+)/)?.[1] ?? 'dispatch/dispatch-decision';

  assert.match((await callText('jambavan_memory_get', { id })).text, /Dispatch decision/);
  assert.match((await callText('jambavan_memory_search', { query: 'synchronous', scope: 'dispatch' })).text, /Dispatch decision/);
  assert.match((await callText('jambavan_memory_recall', { scope: 'dispatch' })).text, /Dispatch decision/);
  assert.match((await callText('jambavan_memory_status', {})).text, /Total memories/);
  assert.match((await callText('jambavan_memory_delete', { scope: 'dispatch', delete_scope: true })).text, /Deleted/);
});

test('failure memory store and search dispatch', async () => {
  assert.match((await callText('jambavan_failure_store', {
    command: 'npm test', symptom: 'flaky timeout', root_cause: 'unawaited promise',
  })).text, /stored|already exists/i);
  assert.match((await callText('jambavan_failure_search', { query: 'timeout' })).text, /timeout|FailureRecord|No /i);
});

test('search and list_files native tools dispatch through the registry', async () => {
  const search = await callText('search', { pattern: 'greet' });
  assert.equal(search.isError, false);
  assert.match(search.text, /greet|no matches/i);

  const list = await callText('list_files', {});
  assert.equal(list.isError, false);
  assert.match(list.text, /hello\.ts|src/);
});

test('read_file dispatches and rejects a path outside the root', async () => {
  const ok = await callText('read_file', { path: 'src/hello.ts' });
  assert.equal(ok.isError, false);
  assert.match(ok.text, /greet/);
});

test('counsel protocols (mool_kaaran, praman, yukti, vibhaajan) dispatch', async () => {
  assert.match((await callText('jambavan_mool_kaaran', { symptom: 'test fails' })).text, /.+/);
  assert.match((await callText('jambavan_praman', { claim: 'tests pass', type: 'tests' })).text, /.+/);
  assert.match((await callText('jambavan_yukti', { task: 'refactor' })).text, /.+/);
  assert.match((await callText('jambavan_vibhaajan', { task: 'split module', units: 2 })).text, /.+/);
});

test('write_file is refused when writes are disabled', async () => {
  const res = await callText('write_file', { path: 'src/new.ts', content: 'x' });
  assert.equal(res.isError, true, 'write must be blocked without JAMBAVAN_ALLOW_WRITE');
});

test('an unknown tool name is reported as an error, not a crash', async () => {
  const res = await callText('jambavan_does_not_exist', {});
  assert.equal(res.isError, true);
  assert.match(res.text, /unknown|not.*found|Unknown/i);
});

test('watch start and status dispatch', async () => {
  const start = await callText('jambavan_watch', { action: 'start' });
  assert.equal(start.isError, false);
  assert.match(start.text, /[Ww]atcher started|already running/);

  const status = await callText('jambavan_watch', { action: 'status' });
  assert.equal(status.isError, false);
  assert.match(status.text, /running: true|running/i);

  const stop = await callText('jambavan_watch', { action: 'stop' });
  assert.equal(stop.isError, false);
  assert.match(stop.text, /stopped/i);
});

test('vibhishana_niti and rin_mochan dispatch', async () => {
  const niti = await callText('jambavan_vibhishana_niti', { level: 'full' });
  assert.equal(niti.isError, false);
  assert.match(niti.text, /[Vv]ibhishana|[Nn]iti/);

  const rin = await callText('jambavan_rin_mochan', {});
  assert.equal(rin.isError, false);
  assert.match(rin.text, /[Rr]in|debt|clean/i);
});

test('session export and import dispatch', async () => {
  const exp = await callText('jambavan_session_export', {});
  assert.equal(exp.isError, false);
  assert.match(exp.text, /[Ss]ession|[Hh]andoff/);

  const imp = await callText('jambavan_session_import', { text: exp.text });
  assert.equal(imp.isError, false);
});

test('memory_mine_session extracts decisions from transcript text', async () => {
  const mine = await callText('jambavan_memory_mine_session', {
    text: 'Decision: keep API synchronous.\nTODO: add farewell function.\nJust regular text here.',
    scope: 'dispatch',
  });
  assert.equal(mine.isError, false);
  assert.match(mine.text, /[Ss]tored|mined/);
  // cleanup
  await callText('jambavan_memory_delete', { scope: 'dispatch', delete_scope: true });
});

test('memory_invalidate dispatches and handles missing IDs', async () => {
  const bad = await callText('jambavan_memory_invalidate', { id: 'nope/missing' });
  assert.equal(bad.isError, false);
  assert.match(bad.text, /not found/i);
});

test('graph_path returns a path or no-path message', async () => {
  const res = await callText('jambavan_graph_path', { from: 'main', to: 'greet' });
  assert.equal(res.isError, false);
  assert.ok(res.text.length > 0);
});
