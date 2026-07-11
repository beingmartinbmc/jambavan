import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { JambavanIndex } from '../src/index/indexer';
import { mkTempConfig } from '../test-support/config';

function writeSrc(root: string, relPath: string, content: string): void {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

test('JambavanIndex.search: exact name match ranks above prefix and content-only matches', async () => {
  const { config, root, cleanup } = mkTempConfig();
  const idx = new JambavanIndex(config);
  try {
    writeSrc(root, 'a.ts', 'export function handler() { return 1; }');
    writeSrc(root, 'b.ts', 'export function handlerFactory() { return handler; }');
    writeSrc(root, 'c.ts', 'export function unrelated() { return "mentions handler in a string"; }');
    await idx.index();

    const results = idx.search('handler', 10);
    assert.ok(results.length >= 2);
    assert.equal(results[0].symbol.name, 'handler', 'exact name match must rank first');
    assert.ok(results[0].score > results[results.length - 1].score);
  } finally { idx.close(); cleanup(); }
});

test('JambavanIndex.search: natural-language stop words are ignored and sparse terms fall back to OR', async () => {
  const { config, root, cleanup } = mkTempConfig();
  const idx = new JambavanIndex(config);
  try {
    writeSrc(root, 'auth.ts', 'export function checkAuth() { /* auth middleware for session */ }');
    writeSrc(root, 'other.ts', 'export function otherThing() { /* unrelated */ }');
    await idx.index();

    const both = idx.search('where is the auth middleware?', 10);
    assert.ok(both.some(r => r.symbol.name === 'checkAuth'));

    const sparse = idx.search('auth nonexistentterm12345', 10);
    assert.ok(sparse.some(r => r.symbol.name === 'checkAuth'));
  } finally { idx.close(); cleanup(); }
});

test('JambavanIndex.search: content-only substring match is found via FTS token match', async () => {
  const { config, root, cleanup } = mkTempConfig();
  const idx = new JambavanIndex(config);
  try {
    writeSrc(root, 'calc.ts', 'export function total() { return computeSubtotal() + tax; }');
    await idx.index();
    const results = idx.search('computeSubtotal', 10);
    assert.ok(results.some(r => r.symbol.name === 'total'));
  } finally { idx.close(); cleanup(); }
});

test('JambavanIndex.search: never throws on FTS5-special characters in the query', async () => {
  const { config, root, cleanup } = mkTempConfig();
  const idx = new JambavanIndex(config);
  try {
    writeSrc(root, 'a.ts', 'export function handler() { return 1; }');
    await idx.index();
    for (const query of ['handler()', 'a:b', '"quoted"', '***', '(((', 'a-b-c']) {
      assert.doesNotThrow(() => idx.search(query, 5), `query "${query}" should not throw`);
    }
  } finally { idx.close(); cleanup(); }
});

test('JambavanIndex.search: deleted files are removed from both symbols and the FTS index', async () => {
  const { config, root, cleanup } = mkTempConfig();
  const idx = new JambavanIndex(config);
  try {
    const filePath = path.join(root, 'gone.ts');
    writeSrc(root, 'gone.ts', 'export function vanishingSymbol() { return 1; }');
    await idx.index();
    assert.ok(idx.search('vanishingSymbol', 10).length > 0);

    fs.unlinkSync(filePath);
    await idx.index();
    assert.equal(idx.search('vanishingSymbol', 10).length, 0);
  } finally { idx.close(); cleanup(); }
});

test('JambavanIndex: a parse failure preserves the valid index and explicit indexing retries it', async () => {
  const { config, root, cleanup } = mkTempConfig();
  const idx = new JambavanIndex(config);
  try {
    writeSrc(root, 'retry.ts', 'export function validBeforeFailure() { return 1; }');
    await idx.index();
    writeSrc(root, 'retry.ts', 'export function validAfterRetry() { return 2; }\n');

    const internals = idx as unknown as { parser: { parseFile(filePath: string): unknown } };
    const parseFile = internals.parser.parseFile.bind(internals.parser);
    internals.parser.parseFile = () => { throw new Error('synthetic parse failure'); };

    const failed = await idx.index();
    assert.equal(failed.failedFiles, 1);
    assert.ok(idx.search('validBeforeFailure', 10).length > 0);
    assert.equal(idx.search('validAfterRetry', 10).length, 0);
    assert.match(idx.stats().failures[0]?.error ?? '', /synthetic parse failure/);

    internals.parser.parseFile = parseFile;
    const retried = await idx.index();
    assert.equal(retried.failedFiles, 0);
    assert.equal(idx.search('validBeforeFailure', 10).length, 0);
    assert.ok(idx.search('validAfterRetry', 10).length > 0);
  } finally { idx.close(); cleanup(); }
});

test('JambavanIndex: a failed replacement rolls back partial symbol writes', async () => {
  const { config, root, cleanup } = mkTempConfig();
  const idx = new JambavanIndex(config);
  try {
    const file = path.join(root, 'transaction.ts');
    writeSrc(root, 'transaction.ts', 'export function stableSymbol() { return 1; }');
    await idx.index();
    writeSrc(root, 'transaction.ts', 'export function replacementSymbol() { return 2; }\n');

    const internals = idx as unknown as {
      parser: { parseFile(filePath: string): {
        filePath: string;
        language: string;
        reExports: never[];
        symbols: Array<Record<string, unknown>>;
      } };
    };
    internals.parser.parseFile = () => ({
      filePath: file,
      language: 'typescript',
      reExports: [],
      symbols: [
        { filePath: file, name: 'partialWrite', type: 'function', startLine: 1, endLine: 1, content: 'ok' },
        { filePath: file, name: 'invalidWrite', type: 'function', startLine: 1, endLine: 1, content: null },
      ],
    });

    const failed = await idx.index();
    assert.equal(failed.failedFiles, 1);
    assert.ok(idx.search('stableSymbol', 10).length > 0);
    assert.equal(idx.search('partialWrite', 10).length, 0);
  } finally { idx.close(); cleanup(); }
});

test('JambavanIndex: reopening an existing DB back-fills the FTS index (migration path)', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    writeSrc(root, 'a.ts', 'export function preExisting() { return 1; }');
    const idx1 = new JambavanIndex(config);
    await idx1.index();
    idx1.close();

    // Simulate a pre-FTS5 database: drop the fts table/triggers, leaving plain symbols rows.
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    const raw = new Database(path.join(config.indexDir, 'symbols.db'));
    raw.exec('DROP TRIGGER IF EXISTS symbols_ai; DROP TRIGGER IF EXISTS symbols_ad; DROP TRIGGER IF EXISTS symbols_au; DROP TABLE IF EXISTS symbols_fts;');
    raw.close();

    const idx2 = new JambavanIndex(config); // constructor runs initFts() -> should back-fill
    try {
      const results = idx2.search('preExisting', 10);
      assert.ok(results.some(r => r.symbol.name === 'preExisting'), 'FTS index should be back-filled from existing symbols rows');
    } finally { idx2.close(); }
  } finally { cleanup(); }
});
