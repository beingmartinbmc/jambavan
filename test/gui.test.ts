import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { mkTempConfig } from '../test-support/config';
import { JambavanIndex } from '../src/index/indexer';
import { MemoryStore } from '../src/memory/store';
import { projectScope } from '../src/tools/jambavan';
import { buildGuiData, startGuiServer, type GuiData } from '../src/tools/gui';

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
