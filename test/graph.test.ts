import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildGraphNeighborhood,
  buildSymbolGraph,
  extractedStructuralNeighbors,
  graphQuery,
  graphPath,
  graphReport,
} from '../src/knowledge/graph';
import type { Symbol } from '../src/index/ast-parser';
import { mkTempConfig } from '../test-support/config';
import { JambavanIndex } from '../src/index/indexer';

function sym(name: string, file: string, content: string, references: Symbol['references'] = []): Symbol {
  return { name, type: 'function', filePath: file, startLine: 1, endLine: 1, content, references };
}

test('buildSymbolGraph: file->symbol contains edges are EXTRACTED', () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    const g = buildSymbolGraph([sym('alpha', path.join(root, 'a.ts'), 'function alpha() {}')], config);
    const contains = g.edges.filter(e => e.type === 'contains');
    assert.equal(contains.length, 1);
    assert.equal(contains[0].confidence, 'EXTRACTED');
    assert.match(contains[0].reason, /alpha defined at a\.ts:1/);
  } finally { cleanup(); }
});

test('buildSymbolGraph: every edge carries a non-empty reason', () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    const g = buildSymbolGraph([
      sym('alpha', path.join(root, 'a.ts'), 'function alpha() { return beta() + gamma; }', [{ name: 'beta', type: 'call' }]),
      sym('beta', path.join(root, 'b.ts'), 'function beta() { return 1; }'),
      sym('gamma', path.join(root, 'g.ts'), 'function gamma() { return 1; }'),
    ], config);
    assert.ok(g.edges.length > 0);
    for (const e of g.edges) assert.ok(e.reason && e.reason.length > 0, `edge ${e.type}/${e.confidence} missing reason`);
  } finally { cleanup(); }
});

test('buildSymbolGraph: reason explains ambiguous-name fan-out and import resolution', () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    const g = buildSymbolGraph([
      sym('run', path.join(root, 'main.ts'), 'run calls handler', [
        { name: 'handler', type: 'call' },
        { name: 'handler', type: 'import', specifier: './moduleA' },
      ]),
      sym('handler', path.join(root, 'moduleA.ts'), 'a'),
      sym('handler', path.join(root, 'moduleB.ts'), 'b'),
    ], config);
    const callEdge = g.edges.find(e => e.type === 'call')!;
    assert.match(callEdge.reason, /resolved via import specifier '\.\/moduleA'/);
  } finally { cleanup(); }
});

test('buildSymbolGraph: explicit call reference becomes an EXTRACTED call edge', () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    const g = buildSymbolGraph([
      sym('alpha', path.join(root, 'a.ts'), 'function alpha() { return beta(); }', [{ name: 'beta', type: 'call' }]),
      sym('beta', path.join(root, 'b.ts'), 'function beta() { return 1; }'),
    ], config);
    assert.ok(g.edges.some(e => e.type === 'call' && e.confidence === 'EXTRACTED'));
  } finally { cleanup(); }
});

test('buildSymbolGraph: ambiguous name-only call fan-out is marked INFERRED', () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    const g = buildSymbolGraph([
      sym('alpha', path.join(root, 'a.ts'), 'alpha calls beta', [{ name: 'beta', type: 'call' }]),
      sym('beta', path.join(root, 'b.ts'), 'b'),
      sym('beta', path.join(root, 'c.ts'), 'c'),
    ], config);
    const callEdges = g.edges.filter(e => e.type === 'call');
    assert.equal(callEdges.length, 2, 'name-only match fans out to both betas');
    assert.ok(callEdges.every(edge => edge.confidence === 'INFERRED'));
  } finally { cleanup(); }
});

test('buildSymbolGraph: body token mentions do not create edges', () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    const g = buildSymbolGraph([
      sym('alpha', path.join(root, 'a.ts'), 'function alpha() { return 1; }'),
      sym('gamma', path.join(root, 'g.ts'), 'function gamma() { return alpha + 2; }'),
    ], config);
    assert.equal(g.edges.filter(e => e.type !== 'contains').length, 0);
  } finally { cleanup(); }
});

test('buildSymbolGraph: duplicate edges are deduped', () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    const g = buildSymbolGraph([
      sym('alpha', path.join(root, 'a.ts'), 'beta beta beta', [{ name: 'beta', type: 'call' }]),
      sym('beta', path.join(root, 'b.ts'), 'b'),
    ], config);
    const calls = g.edges.filter(e => e.type === 'call');
    assert.equal(calls.length, 1);
  } finally { cleanup(); }
});

test('graphReport: labels inferred edge count and confidence semantics', () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    const g = buildSymbolGraph([
      sym('alpha', path.join(root, 'a.ts'), 'alpha calls beta', [{ name: 'beta', type: 'call' }]),
      sym('beta', path.join(root, 'b.ts'), 'b'),
      sym('beta', path.join(root, 'c.ts'), 'c'),
    ], config);
    const report = graphReport(g);
    assert.match(report, /0 inferred/);
    assert.match(report, /inferred edges excluded by default/);
    assert.match(report, /EXTRACTED edges are structural/);
    assert.match(graphReport(g, 10, true), /2 inferred/);
  } finally { cleanup(); }
});

test('graph query/path require explicit opt-in for inferred edges', () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    const g = buildSymbolGraph([
      sym('alpha', path.join(root, 'a.ts'), 'alpha calls beta', [{ name: 'beta', type: 'call' }]),
      sym('beta', path.join(root, 'b.ts'), 'b'),
      sym('beta', path.join(root, 'c.ts'), 'c'),
    ], config);
    assert.doesNotMatch(graphQuery(g, 'alpha'), /call\/INFERRED/);
    assert.match(graphQuery(g, 'alpha', 2000, 'both', true), /call\/INFERRED/);
    assert.match(graphPath(g, 'alpha', 'beta'), /No path found/);
    assert.match(graphPath(g, 'alpha', 'beta', true), /via call\/INFERRED/);
  } finally { cleanup(); }
});

test('graphQuery: finds a node and returns connected edges', () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    const g = buildSymbolGraph([
      sym('alpha', path.join(root, 'a.ts'), 'function alpha() { return beta(); }', [{ name: 'beta', type: 'call' }]),
      sym('beta', path.join(root, 'b.ts'), 'function beta() {}'),
    ], config);
    const out = graphQuery(g, 'alpha');
    assert.match(out, /call\/EXTRACTED/);
  } finally { cleanup(); }
});

test('graphQuery: direction distinguishes callers from callees', () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    const g = buildSymbolGraph([
      sym('alpha', path.join(root, 'a.ts'), 'function alpha() { return beta(); }', [{ name: 'beta', type: 'call' }]),
      sym('beta', path.join(root, 'b.ts'), 'function beta() {}'),
    ], config);
    assert.match(graphQuery(g, 'beta', 2000, 'inbound'), /alpha/);
    assert.doesNotMatch(graphQuery(g, 'beta', 2000, 'outbound'), /alpha/);
  } finally { cleanup(); }
});

test('buildGraphNeighborhood: seeds from the query instead of alphabetical symbol order', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'z-target.ts'), 'export function rareTarget() { return 1; }\n');
    fs.writeFileSync(
      path.join(root, 'src', 'y-caller.ts'),
      'import { rareTarget } from "./z-target"; export function invokeRare() { return rareTarget(); }\n',
    );
    const index = new JambavanIndex(config);
    await index.index();

    const result = buildGraphNeighborhood(index, config, ['rareTarget'], 100);

    assert.ok(result.graph.nodes.some(node => node.label === 'rareTarget'));
    assert.ok(result.graph.nodes.some(node => node.label === 'invokeRare'));
    index.close();
  } finally { cleanup(); }
});

test('extractedStructuralNeighbors: adds resolver-backed callers outside lexical seeds', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'target.ts'), 'export function rareTarget() { return 1; }\n');
    fs.writeFileSync(
      path.join(root, 'src', 'caller.ts'),
      'import { rareTarget } from "./target"; export function invokeRare() { return rareTarget(); }\n',
    );
    const index = new JambavanIndex(config);
    await index.index();
    const seed = index.search('rareTarget', 1)[0].symbol;

    const neighbors = extractedStructuralNeighbors(index, config, [seed]);

    assert.deepEqual(neighbors.map(symbol => symbol.name), ['invokeRare']);
    index.close();
  } finally { cleanup(); }
});

test('graphQuery: unknown symbol returns a clear miss', () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    const g = buildSymbolGraph([sym('alpha', path.join(root, 'a.ts'), 'x')], config);
    assert.match(graphQuery(g, 'nonexistent'), /No graph nodes found/);
  } finally { cleanup(); }
});

test('graphPath: finds a path and labels edge confidence; reports misses', () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    const g = buildSymbolGraph([
      sym('alpha', path.join(root, 'a.ts'), 'function alpha() { return beta(); }', [{ name: 'beta', type: 'call' }]),
      sym('beta', path.join(root, 'b.ts'), 'function beta() {}'),
    ], config);
    assert.match(graphPath(g, 'alpha', 'beta'), /via call\/EXTRACTED — call site/);
    assert.match(graphPath(g, 'ghost', 'beta'), /No graph node found for from/);
    assert.match(graphPath(g, 'alpha', 'ghost'), /No graph node found for to/);
  } finally { cleanup(); }
});

test('graphReport: empty graph reports no hubs', () => {
  assert.match(graphReport({ nodes: [], edges: [] }), /No nodes yet/);
});

test('graphQuery: token budget truncates large output', () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    const symbols = [sym('alpha', path.join(root, 'alpha.ts'), 'alpha hub')];
    for (let i = 0; i < 20; i++) {
      symbols.push(sym(`target${i}`, path.join(root, `target${i}.ts`), 'alpha mention'));
    }
    const out = graphQuery(buildSymbolGraph(symbols, config), 'alpha', 20);
    assert.match(out, /tokens truncated/);
  } finally { cleanup(); }
});

test('graphPath: reports disconnected nodes', () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    const g = buildSymbolGraph([
      sym('alpha', path.join(root, 'a.ts'), 'alpha'),
      sym('omega', path.join(root, 'o.ts'), 'omega'),
    ], config);
    assert.match(graphPath(g, 'alpha', 'omega'), /No path found/);
  } finally { cleanup(); }
});
