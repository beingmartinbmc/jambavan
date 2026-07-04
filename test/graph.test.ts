import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { buildSymbolGraph, graphQuery, graphPath, graphReport } from '../src/knowledge/graph';
import type { Symbol } from '../src/index/ast-parser';
import { mkTempConfig } from '../test-support/config';

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

test('buildSymbolGraph: name-only resolution links a call to EVERY same-named symbol', () => {
  // This is the documented limitation: edges are name-matched, not resolver-backed.
  // A call to "beta" links to both beta definitions because there is no scope resolution.
  const { config, root, cleanup } = mkTempConfig();
  try {
    const g = buildSymbolGraph([
      sym('alpha', path.join(root, 'a.ts'), 'alpha calls beta', [{ name: 'beta', type: 'call' }]),
      sym('beta', path.join(root, 'b.ts'), 'b'),
      sym('beta', path.join(root, 'c.ts'), 'c'),
    ], config);
    const callEdges = g.edges.filter(e => e.type === 'call');
    assert.equal(callEdges.length, 2, 'name-only match fans out to both betas');
  } finally { cleanup(); }
});

test('buildSymbolGraph: body token mention becomes an INFERRED edge', () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    const g = buildSymbolGraph([
      sym('alpha', path.join(root, 'a.ts'), 'function alpha() { return 1; }'),
      sym('gamma', path.join(root, 'g.ts'), 'function gamma() { return alpha + 2; }'),
    ], config);
    assert.ok(g.edges.some(e => e.type === 'mentions' && e.confidence === 'INFERRED'));
  } finally { cleanup(); }
});

test('buildSymbolGraph: short (<3 char) and self names do not create mention edges', () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    const g = buildSymbolGraph([
      sym('ab', path.join(root, 'a.ts'), 'function ab() { return ab; }'),
      sym('gamma', path.join(root, 'g.ts'), 'function gamma() { return ab; }'),
    ], config);
    // "ab" is 2 chars -> below the mention threshold -> no inferred edge to it.
    assert.ok(!g.edges.some(e => e.type === 'mentions'));
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
      sym('alpha', path.join(root, 'a.ts'), 'function alpha() { return 1; }'),
      sym('gamma', path.join(root, 'g.ts'), 'function gamma() { return alpha; }'),
    ], config);
    const report = graphReport(g);
    assert.match(report, /inferred/);
    assert.match(report, /EXTRACTED edges are structural/);
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
    assert.match(graphPath(g, 'alpha', 'beta'), /via call\/EXTRACTED/);
    assert.match(graphPath(g, 'alpha', 'ghost'), /No graph node found for to/);
  } finally { cleanup(); }
});
