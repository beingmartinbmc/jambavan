import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { mkTempConfig } from '../test-support/config';
import { JambavanIndex } from '../src/index/indexer';
import { MemoryStore } from '../src/memory/store';
import { projectScope } from '../src/tools/jambavan';
import { buildGuiData, startGuiServer, openBrowser, type GuiData } from '../src/tools/gui';

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

test('buildGuiData: aggregates graph nodes/edges, rin markers, and failure records', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    fs.writeFileSync(path.join(root, 'a.ts'), [
      'export function foo() { return bar(); }',
      'export function bar() { return 1; }',
      '// rin: quick hack, revisit if usage grows',
    ].join('\n'));

    const index = new JambavanIndex(config);
    await index.index();

    new MemoryStore(config.memoryDir).store({
      title: 'Failure: npm test [abc123]',
      body: '**Command:** `npm test`\n**Status:** unresolved',
      scope: projectScope(config),
      type: 'FailureRecord',
      description: 'unresolved: exit code 1',
      tags: ['failure', 'unresolved'],
    });

    const data = buildGuiData(config, index);

    assert.ok(data.graph.nodes.some(n => n.label === 'foo'));
    assert.ok(data.graph.nodes.some(n => n.label === 'bar'));
    assert.ok(data.graph.edges.length > 0);
    assert.equal(data.rin.length, 1);
    assert.match(data.rin[0].comment, /quick hack/);
    assert.equal(data.failures.length, 1);
    assert.equal(data.failures[0].status, 'unresolved');
    assert.equal(data.truncatedNodes, false);
    assert.equal(data.projectRoot, root);
  } finally { cleanup(); }
});

test('startGuiServer: serves the static page at / and JSON data at /api/data, loopback only', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    fs.writeFileSync(path.join(root, 'a.ts'), 'export function alone() { return 1; }\n');
    const index = new JambavanIndex(config);
    await index.index();

    const server = startGuiServer(config, index, 0); // port 0 -> OS picks a free port
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const page = await get(`http://127.0.0.1:${port}/`);
      assert.equal(page.status, 200);
      assert.match(page.body, /<title>Jambavan GUI<\/title>/);

      const api = await get(`http://127.0.0.1:${port}/api/data`);
      assert.equal(api.status, 200);
      const data = JSON.parse(api.body) as GuiData;
      assert.ok(data.graph.nodes.some(n => n.label === 'alone'));
    } finally {
      server.close();
    }
  } finally { cleanup(); }
});

test('startGuiServer: /api/node/:id returns detail for a known node and 404 for unknown', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    fs.writeFileSync(path.join(root, 'b.ts'), [
      'export function caller() { return callee(); }',
      'export function callee() { return 42; }',
    ].join('\n'));
    const index = new JambavanIndex(config);
    await index.index();

    const server = startGuiServer(config, index, 0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;

    try {
      // First fetch /api/data to populate the cache
      const apiRes = await get(`http://127.0.0.1:${port}/api/data`);
      const data = JSON.parse(apiRes.body) as GuiData;
      const node = data.graph.nodes.find(n => n.label === 'callee');
      assert.ok(node, 'callee node must be in graph');

      const detailRes = await get(`http://127.0.0.1:${port}/api/node/${encodeURIComponent(node!.id)}`);
      assert.equal(detailRes.status, 200);
      const detail = JSON.parse(detailRes.body);
      assert.equal(detail.label, 'callee');
      assert.ok(Array.isArray(detail.callers));
      assert.ok(Array.isArray(detail.callees));
      assert.ok(typeof detail.rinCount === 'number');
      assert.ok(typeof detail.failureCount === 'number');

      // Unknown node id → 404
      const miss = await get(`http://127.0.0.1:${port}/api/node/no-such-node-id`);
      assert.equal(miss.status, 404);
    } finally {
      server.close();
    }
  } finally { cleanup(); }
});

test('buildGuiData: rinByNode is populated for nodes in a file with rin markers', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    fs.writeFileSync(path.join(root, 'c.ts'), [
      'export function withDebt() { return 1; }',
      '// rin: ceiling exceeded, upgrade when refactored',
    ].join('\n'));

    const index = new JambavanIndex(config);
    await index.index();

    const data = buildGuiData(config, index);
    const debtNode = data.graph.nodes.find(n => n.label === 'withDebt');
    assert.ok(debtNode, 'withDebt must be a graph node');
    assert.ok((data.rinByNode[debtNode!.id] ?? 0) > 0, 'rinByNode must count the rin marker');
  } finally { cleanup(); }
});

test('buildGuiData: failuresByNode is populated when a failure record mentions a file', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    fs.writeFileSync(path.join(root, 'd.ts'), 'export function hot() { return 1; }\n');

    const index = new JambavanIndex(config);
    await index.index();

    new MemoryStore(config.memoryDir).store({
      title: 'Failure: hot path crashed',
      body: 'Crash in d.ts during load.',
      scope: projectScope(config),
      type: 'FailureRecord',
      description: 'unresolved',
      tags: ['failure', 'unresolved'],
    });

    const data = buildGuiData(config, index);
    // At least one node whose filePath ends with d.ts should have a failure count
    const hotNode = data.graph.nodes.find(n => n.filePath?.endsWith('d.ts'));
    assert.ok(hotNode, 'must have a node for d.ts');
    assert.ok((data.failuresByNode[hotNode!.id] ?? 0) > 0, 'failuresByNode must count the failure record');
  } finally { cleanup(); }
});

test('openBrowser: does not throw in headless env (smoke)', () => {
  // openBrowser is best-effort; it swallows errors internally.
  // Just assert it does not throw or propagate.
  assert.doesNotThrow(() => openBrowser('http://127.0.0.1:9999'));
});
