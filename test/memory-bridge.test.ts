import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { mkTempConfig } from '../test-support/config';
import { MemoryStore } from '../src/memory/store';
import { exportToMemPalace, importFromMemPalace } from '../src/tools/memory-bridge';

test('memory bridge: round-trips memories between two Jambavan stores via a MemPalace-shaped tree', () => {
  const source = mkTempConfig();
  const dest = mkTempConfig();
  const bridgeDir = fs.mkdtempSync(path.join(source.root, 'bridge-'));
  try {
    const store = new MemoryStore(source.config.memoryDir);
    store.store({ title: 'Use template strings', body: 'Decided to use template strings over concatenation.', type: 'Decision', scope: 'proj', tags: ['style'] });
    store.store({ title: 'Failure: npm build', body: 'openssl linking error.\n\nResolution: brew install openssl.', type: 'FailureRecord', scope: 'proj', tags: ['build'] });
    store.store({ title: 'Random fact', body: 'The sky is blue.', scope: 'proj' });

    const exported = exportToMemPalace(source.config, bridgeDir);
    assert.equal(exported.files, 3);
    assert.deepEqual(exported.wings, ['proj']);

    // Files land under wing/room/*.md — verify the room split by type.
    assert.ok(fs.existsSync(path.join(bridgeDir, 'proj', 'decisions')));
    assert.ok(fs.existsSync(path.join(bridgeDir, 'proj', 'problems')));
    assert.ok(fs.existsSync(path.join(bridgeDir, 'proj', 'technical')));

    const imported = importFromMemPalace(dest.config, bridgeDir);
    assert.equal(imported.imported, 3);
    assert.equal(imported.skipped, 0);

    const destDocs = new MemoryStore(dest.config.memoryDir).list('proj');
    const byTitle = new Map(destDocs.map(d => [d.frontmatter.title, d]));

    assert.ok(byTitle.has('Use template strings'));
    assert.equal(byTitle.get('Use template strings')!.frontmatter.type, 'Decision');
    assert.match(byTitle.get('Use template strings')!.body, /template strings/);

    assert.ok(byTitle.has('Failure: npm build'));
    assert.equal(byTitle.get('Failure: npm build')!.frontmatter.type, 'FailureRecord');
    assert.match(byTitle.get('Failure: npm build')!.body, /openssl/);

    assert.ok(byTitle.has('Random fact'));
    assert.equal(byTitle.get('Random fact')!.frontmatter.type, 'Memory');
  } finally {
    source.cleanup();
    dest.cleanup();
  }
});

test('memory bridge: exporting an empty store produces zero files, no wings', () => {
  const source = mkTempConfig();
  const bridgeDir = fs.mkdtempSync(path.join(source.root, 'bridge-'));
  try {
    const result = exportToMemPalace(source.config, bridgeDir);
    assert.equal(result.files, 0);
    assert.deepEqual(result.wings, []);
  } finally { source.cleanup(); }
});

test('memory bridge: importing from a missing directory is a no-op, not a crash', () => {
  const dest = mkTempConfig();
  try {
    const result = importFromMemPalace(dest.config, path.join(dest.root, 'does-not-exist'));
    assert.deepEqual(result, { imported: 0, skipped: 0 });
  } finally { dest.cleanup(); }
});

test('memory bridge: a stray non-frontmatter markdown file is skipped, not fatal', () => {
  const source = mkTempConfig();
  const dest = mkTempConfig();
  const bridgeDir = fs.mkdtempSync(path.join(source.root, 'bridge-'));
  try {
    new MemoryStore(source.config.memoryDir).store({ title: 'Real memory', body: 'body', scope: 'proj' });
    exportToMemPalace(source.config, bridgeDir);

    fs.mkdirSync(path.join(bridgeDir, 'proj', 'diary'), { recursive: true });
    fs.writeFileSync(path.join(bridgeDir, 'proj', 'diary', 'freeform.md'), '# Not frontmatter\nJust prose.\n');

    const result = importFromMemPalace(dest.config, bridgeDir);
    assert.equal(result.imported, 1);
    assert.equal(result.skipped, 1);
  } finally {
    source.cleanup();
    dest.cleanup();
  }
});

test('memory bridge: exportToMemPalace uses the "technical" room for unknown memory types', () => {
  const source = mkTempConfig();
  const bridgeDir = fs.mkdtempSync(path.join(source.root, 'bridge-'));
  try {
    new MemoryStore(source.config.memoryDir).store({
      title: 'A plain memory',
      body: 'Just a note.',
      scope: 'proj',
      // type defaults to 'Memory' — not in TYPE_TO_ROOM → should land in 'technical'
    });

    const result = exportToMemPalace(source.config, bridgeDir);
    assert.equal(result.files, 1);
    assert.ok(fs.existsSync(path.join(bridgeDir, 'proj', 'technical')));
  } finally { source.cleanup(); }
});

test('memory bridge: exportToMemPalace with a scope filter only exports matching docs', () => {
  const source = mkTempConfig();
  const bridgeDir = fs.mkdtempSync(path.join(source.root, 'bridge-'));
  try {
    const store = new MemoryStore(source.config.memoryDir);
    store.store({ title: 'In scope', body: 'yes', scope: 'alpha', type: 'Decision', tags: [] });
    store.store({ title: 'Out of scope', body: 'no', scope: 'beta', type: 'Decision', tags: [] });

    const result = exportToMemPalace(source.config, bridgeDir, 'alpha');
    assert.equal(result.files, 1);
    assert.deepEqual(result.wings, ['alpha']);
  } finally { source.cleanup(); }
});
