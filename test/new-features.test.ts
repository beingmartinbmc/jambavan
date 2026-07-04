import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { mkTempConfig } from '../test-support/config';
import { buildFailureHandlers } from '../src/tools/failure-memory';
import { buildSessionHandoffHandlers } from '../src/tools/session-handoff';
import { buildTestMap, isTestFile, formatTestAssociations } from '../src/index/test-map';
import { projectScope } from '../src/tools/jambavan';
import { buildSymbolGraph } from '../src/knowledge/graph';
import type { JambavanConfig } from '../src/config/jambavan.config';
import type { Symbol } from '../src/index/ast-parser';

// ── projectScope ─────────────────────────────────────────────────────────────

test('projectScope: two repos with same basename get different scopes', () => {
  const configA: JambavanConfig = { projectRoot: '/home/user/work/api', indexDir: '', memoryDir: '', contextTokenBudget: 8000, ignore: [] };
  const configB: JambavanConfig = { projectRoot: '/home/user/side/api', indexDir: '', memoryDir: '', contextTokenBudget: 8000, ignore: [] };
  assert.notEqual(projectScope(configA), projectScope(configB));
  // Both start with "api-" (the basename)
  assert.match(projectScope(configA), /^api-/);
  assert.match(projectScope(configB), /^api-/);
});

test('projectScope: same path always produces the same scope (deterministic)', () => {
  const config: JambavanConfig = { projectRoot: '/home/user/work/api', indexDir: '', memoryDir: '', contextTokenBudget: 8000, ignore: [] };
  assert.equal(projectScope(config), projectScope(config));
});

// ── Failure Memory ───────────────────────────────────────────────────────────

test('jambavan_failure_store: stores and searches structured failure records', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const handlers = buildFailureHandlers(config);
    const storeResult = handlers.jambavan_failure_store({
      command: 'npm run build',
      symptom: 'TS2307 Cannot find module',
      root_cause: 'missing dependency in package.json',
      status: 'resolved',
      resolution: 'added the dependency',
      do_not_retry: 'do not try relative path hacks',
    });
    assert.match(storeResult, /Stored failure record/);
    assert.match(storeResult, /Status: resolved/);

    const searchResult = handlers.jambavan_failure_search({ query: 'TS2307 Cannot find module' });
    assert.match(searchResult, /npm run build/);
    assert.match(searchResult, /Do NOT retry/);
  } finally { cleanup(); }
});

test('jambavan_failure_search: returns empty for unknown errors', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const handlers = buildFailureHandlers(config);
    const result = handlers.jambavan_failure_search({ query: 'something random' });
    assert.match(result, /No failure records found/);
  } finally { cleanup(); }
});

test('jambavan_failure_store: distinct failures for same command are NOT overwritten', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const handlers = buildFailureHandlers(config);
    handlers.jambavan_failure_store({
      command: 'npm test',
      symptom: 'TypeError: cannot read property of undefined',
    });
    handlers.jambavan_failure_store({
      command: 'npm test',
      symptom: 'ECONNREFUSED redis connection refused',
    });
    // Both failures should be searchable
    const r1 = handlers.jambavan_failure_search({ query: 'TypeError undefined' });
    assert.match(r1, /TypeError/);
    const r2 = handlers.jambavan_failure_search({ query: 'ECONNREFUSED redis' });
    assert.match(r2, /redis connection refused/);
  } finally { cleanup(); }
});

test('jambavan_failure_search: does not return false positives from unrelated records', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const handlers = buildFailureHandlers(config);
    handlers.jambavan_failure_store({
      command: 'npm test',
      symptom: 'typescript compilation exploded',
    });
    // Searching for a completely unrelated term should NOT match
    const result = handlers.jambavan_failure_search({ query: 'redis connection refused' });
    assert.match(result, /No failure records found/);
  } finally { cleanup(); }
});

test('jambavan_failure_store: same command+symptom updates in place (true duplicate)', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const handlers = buildFailureHandlers(config);
    const r1 = handlers.jambavan_failure_store({
      command: 'npm test',
      symptom: 'ECONNREFUSED',
      status: 'unresolved',
    });
    const id1 = r1.match(/ID: (.+)$/m)?.[1];

    const r2 = handlers.jambavan_failure_store({
      command: 'npm test',
      symptom: 'ECONNREFUSED',
      status: 'resolved',
      resolution: 'started redis',
    });
    const id2 = r2.match(/ID: (.+)$/m)?.[1];

    // Same command+symptom → same content hash → same title → overwrite
    assert.equal(id1, id2);
    const search = handlers.jambavan_failure_search({ query: 'ECONNREFUSED' });
    assert.match(search, /resolved/);
    assert.match(search, /started redis/);
  } finally { cleanup(); }
});

// ── Session Handoff ──────────────────────────────────────────────────────────

test('jambavan_session_export: produces markdown with expected sections', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const handlers = buildSessionHandoffHandlers(config);
    const result = handlers.jambavan_session_export({ include_git: false, include_rin: false });
    assert.match(result, /# Jambavan Session Handoff/);
    assert.match(result, /## Memories/);
  } finally { cleanup(); }
});

test('jambavan_session_import: imports memories from handoff document', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const handlers = buildSessionHandoffHandlers(config);
    const handoff = [
      '# Jambavan Session Handoff',
      '## Memories (2)',
      '### Decision about GraphQL',
      '*2024-01-15*',
      '',
      'We chose GraphQL for the public API.',
      '',
      '### Redis caching strategy',
      '*2024-01-16*',
      '',
      'Use Redis with 60s TTL for hot paths.',
    ].join('\n');

    const result = handlers.jambavan_session_import({ text: handoff });
    assert.match(result, /Imported 2 memories/);
  } finally { cleanup(); }
});

test('jambavan_session_import: tolerates reworded memory heading', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const handlers = buildSessionHandoffHandlers(config);
    // A human or LLM might rephrase "## Memories (1)" to "## Prior Memories"
    const handoff = [
      '# Session context',
      '## Prior Memories',
      '### Key architecture decision',
      '*2024-02-01*',
      '',
      'We use event sourcing for the order service.',
      '',
      '---',
      '*Handoff tokens: 42*',
    ].join('\n');

    const result = handlers.jambavan_session_import({ text: handoff });
    assert.match(result, /Imported 1 memories/);
  } finally { cleanup(); }
});

test('jambavan_session_import: warns when no memory heading found and nothing imported', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const handlers = buildSessionHandoffHandlers(config);
    const result = handlers.jambavan_session_import({ text: '# Just a random doc\n\nSome text.\n' });
    assert.match(result, /Warning/);
    assert.match(result, /Imported 0 memories/);
  } finally { cleanup(); }
});

test('session handoff round-trip preserves FailureRecord type for failure_search', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    // Store a failure in the project scope
    const failHandlers = buildFailureHandlers(config);
    failHandlers.jambavan_failure_store({
      command: 'cargo build',
      symptom: 'linking error with openssl',
      status: 'resolved',
      resolution: 'brew install openssl && export OPENSSL_DIR',
      do_not_retry: 'do not use system openssl',
    });

    // Export handoff — should include the failure
    const sessionHandlers = buildSessionHandoffHandlers(config);
    const exported = sessionHandlers.jambavan_session_export({
      include_git: false,
      include_rin: false,
    });
    assert.match(exported, /FailureRecord/, 'export should contain type badge');
    assert.match(exported, /cargo build/);

    // Import into a fresh store (simulate new session)
    const { config: config2, cleanup: cleanup2 } = mkTempConfig();
    try {
      const session2 = buildSessionHandoffHandlers(config2);
      const importResult = session2.jambavan_session_import({ text: exported });
      assert.match(importResult, /Imported/);

      // Now failure_search in the new store should find it
      const fail2 = buildFailureHandlers(config2);
      const searchResult = fail2.jambavan_failure_search({ query: 'openssl' });
      assert.match(searchResult, /cargo build/, 'failure_search should find imported failure');
      assert.match(searchResult, /Do NOT retry/);
    } finally { cleanup2(); }
  } finally { cleanup(); }
});

// ── Test-Symbol Association ──────────────────────────────────────────────────

test('isTestFile: correctly identifies test files', () => {
  assert.equal(isTestFile('test/foo.test.ts'), true);
  assert.equal(isTestFile('src/__tests__/bar.ts'), true);
  assert.equal(isTestFile('foo.spec.js'), true);
  assert.equal(isTestFile('src/utils/helper.ts'), false);
  assert.equal(isTestFile('lib/main.js'), false);
});

function sym(name: string, file: string, content: string, refs: Symbol['references'] = []): Symbol {
  return { name, type: 'function', filePath: file, startLine: 1, endLine: 10, content, references: refs };
}

test('buildTestMap: associates test imports with source symbols', () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    // Create the test file on disk so buildTestMap can read it
    const testDir = path.join(root, 'test');
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, 'cart.test.ts'), 'import { calculateTotal } from "../src/cart";\n\ntest("totals", () => { calculateTotal(); });');

    const symbols: Symbol[] = [
      sym('calculateTotal', path.join(root, 'src/cart.ts'), 'function calculateTotal() {}'),
      // A symbol from the test file so buildTestMap knows the file exists
      sym('testCalc', path.join(root, 'test/cart.test.ts'), 'test("totals", () => {})'),
    ];
    const map = buildTestMap(symbols, config);
    const assocs = map.get('calculateTotal');
    assert.ok(assocs);
    assert.equal(assocs.length, 1);
    assert.equal(assocs[0].confidence, 'import');
    assert.match(assocs[0].testFile, /cart\.test\.ts/);
  } finally { cleanup(); }
});

test('buildTestMap: discovers symbol-less test files via filesystem scan', () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    // Create a test file with no exportable symbols (no indexed symbol will point here)
    const testDir = path.join(root, 'test');
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(
      path.join(testDir, 'utils.spec.ts'),
      'import { formatDate } from "../src/utils";\n\ntest("formats", () => { formatDate(new Date()); });',
    );

    // Only source symbols — NO symbol from the test file
    const symbols: Symbol[] = [
      sym('formatDate', path.join(root, 'src/utils.ts'), 'function formatDate(d: Date) {}'),
    ];
    const map = buildTestMap(symbols, config);
    const assocs = map.get('formatDate');
    assert.ok(assocs, 'should find test association for symbol-less test file');
    assert.equal(assocs.length, 1);
    assert.equal(assocs[0].confidence, 'import');
    assert.match(assocs[0].testFile, /utils\.spec\.ts/);
  } finally { cleanup(); }
});

test('formatTestAssociations: formats import-confidence associations', () => {
  const output = formatTestAssociations([
    { testFile: 'test/foo.test.ts', symbolName: 'foo', sourceFile: 'src/foo.ts', confidence: 'import' },
  ]);
  assert.match(output, /Tests:/);
  assert.match(output, /test\/foo\.test\.ts.*imports/);
});

// ── Graph: import-edge resolution ───────────────────────────────────────────

test('buildSymbolGraph: import specifier resolves ambiguous call to correct file', () => {
  // Simulates: moduleA.ts and moduleB.ts both export `handler`.
  // main.ts imports handler from './moduleA' and calls it in run().
  // The graph should link run → moduleA:handler only, NOT moduleB:handler.
  const root = '/tmp/graph-test';
  const config: JambavanConfig = {
    projectRoot: root,
    indexDir: path.join(root, '.jambavan'),
    memoryDir: path.join(root, '.jambavan/memory'),
    contextTokenBudget: 8000,
    ignore: [],
  };

  const symbols: Symbol[] = [
    {
      name: 'handler',
      type: 'function',
      filePath: path.join(root, 'moduleA.ts'),
      startLine: 1,
      endLine: 1,
      content: "export function handler() { return 'A'; }",
    },
    {
      name: 'handler',
      type: 'function',
      filePath: path.join(root, 'moduleB.ts'),
      startLine: 1,
      endLine: 1,
      content: "export function handler() { return 'B'; }",
    },
    {
      name: 'run',
      type: 'function',
      filePath: path.join(root, 'main.ts'),
      startLine: 3,
      endLine: 3,
      content: 'export function run() { return handler(); }',
      references: [
        { name: 'handler', type: 'call' },
        { name: 'handler', type: 'import', specifier: './moduleA' },
      ],
    },
  ];

  const graph = buildSymbolGraph(symbols, config);

  // Find call edges from run
  const runId = graph.nodes.find(n => n.label === 'run')!.id;
  const callEdges = graph.edges.filter(e => e.from === runId && e.type === 'call');

  // Should have exactly one call edge, to moduleA's handler
  assert.equal(callEdges.length, 1, `Expected 1 call edge from run, got ${callEdges.length}`);
  const targetNode = graph.nodes.find(n => n.id === callEdges[0].to)!;
  assert.equal(targetNode.filePath, 'moduleA.ts');
  assert.equal(targetNode.label, 'handler');
});

test('buildSymbolGraph: ambiguous call without import specifier fans out to all targets', () => {
  // When there's no import info, the old fan-out behavior is preserved.
  const root = '/tmp/graph-test2';
  const config: JambavanConfig = {
    projectRoot: root,
    indexDir: path.join(root, '.jambavan'),
    memoryDir: path.join(root, '.jambavan/memory'),
    contextTokenBudget: 8000,
    ignore: [],
  };

  const symbols: Symbol[] = [
    {
      name: 'helper',
      type: 'function',
      filePath: path.join(root, 'a.ts'),
      startLine: 1,
      endLine: 1,
      content: 'export function helper() { return 1; }',
    },
    {
      name: 'helper',
      type: 'function',
      filePath: path.join(root, 'b.ts'),
      startLine: 1,
      endLine: 1,
      content: 'export function helper() { return 2; }',
    },
    {
      name: 'caller',
      type: 'function',
      filePath: path.join(root, 'c.ts'),
      startLine: 1,
      endLine: 1,
      content: 'export function caller() { return helper(); }',
      references: [{ name: 'helper', type: 'call' }],
    },
  ];

  const graph = buildSymbolGraph(symbols, config);
  const callerId = graph.nodes.find(n => n.label === 'caller')!.id;
  const callEdges = graph.edges.filter(e => e.from === callerId && e.type === 'call');

  // Should fan out to both targets (no import info to disambiguate)
  assert.equal(callEdges.length, 2, `Expected 2 call edges (fan-out), got ${callEdges.length}`);
});
