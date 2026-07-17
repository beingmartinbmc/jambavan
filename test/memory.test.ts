import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { MemoryStore } from '../src/memory/store';
import { mkTempConfig } from '../test-support/config';

test('MemoryStore: invalidated memories are excluded from list and search by default', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const store = new MemoryStore(config.memoryDir);
    const id = store.store({ scope: 'proj', title: 'Old fact', body: 'stale value' });
    assert.equal(store.invalidate(id, 'replaced'), true);
    assert.deepEqual(store.list('proj').map(d => d.id), []);
    assert.deepEqual(store.search('stale', { scope: 'proj' }).map(r => r.doc.id), []);
    assert.deepEqual(store.list('proj', { includeInvalidated: true }).map(d => d.id), [id]);
  } finally { cleanup(); }
});

test('MemoryStore: store/get/list/search/status preserve metadata and ranking', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const store = new MemoryStore(config.memoryDir);
    const alpha = store.store({
      scope: 'Proj A',
      title: 'GraphQL decision',
      description: 'Use GraphQL for public API',
      body: 'Apollo schema federation gateway graphql graphql',
      tags: ['api', 'graphql'],
      source: 'session.md',
      supersedes: 'proj-a/old-api',
    });
    const beta = store.store({ scope: 'Proj A', title: 'Redis cache', body: 'cache ttl redis', tags: ['cache'] });
    store.store({ scope: 'Other', title: 'Other GraphQL', body: 'graphql elsewhere' });

    const doc = store.get(alpha);
    assert.equal(alpha, 'proj-a/graphql-decision');
    assert.equal(doc?.frontmatter.title, 'GraphQL decision');
    assert.deepEqual(doc?.frontmatter.tags, ['api', 'graphql']);
    assert.equal(doc?.frontmatter.source, 'session.md');
    assert.equal(doc?.frontmatter.supersedes, 'proj-a/old-api');
    assert.match(doc?.body ?? '', /Apollo schema/);
    assert.deepEqual(store.list('Proj A').map(d => d.id).sort(), [alpha, beta].sort());
    assert.deepEqual(store.search('graphql', { scope: 'Proj A', limit: 1 }).map(r => r.doc.id), [alpha]);
    assert.equal(store.search('!!!', { scope: 'Proj A', limit: 1 })[0].score, 0);
    assert.deepEqual(store.status().scopes.map(s => s.scope).sort(), ['other', 'proj-a']);
    assert.equal(store.status().totalMemories, 3);
  } finally { cleanup(); }
});

test('MemoryStore: overwrites same-title docs and updates log/index', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const store = new MemoryStore(config.memoryDir);
    const first = store.store({ scope: 'proj', title: 'Same title', body: 'old' });
    const second = store.store({ scope: 'proj', title: 'Same title', body: 'new' });
    assert.equal(second, first);
    assert.equal(store.get(first)?.body, 'new\n');
    assert.match(store.get(first)?.filePath ?? '', /same-title\.md$/);
    assert.match(store.list('proj', { includeInvalidated: true })[0].frontmatter.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  } finally { cleanup(); }
});

test('MemoryStore: delete, deleteByScope, and missing ids return correctly', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const store = new MemoryStore(config.memoryDir);
    const a = store.store({ scope: 'proj', title: 'A', body: 'one' });
    const b = store.store({ scope: 'proj', title: 'B', body: 'two' });
    assert.equal(store.get('missing/id'), null);
    assert.equal(store.invalidate('missing/id'), false);
    assert.equal(store.delete('missing/id'), false);
    assert.equal(store.delete(a), true);
    assert.equal(store.get(a), null);
    assert.deepEqual(store.list('proj').map(d => d.id), [b]);
    assert.equal(store.deleteByScope('proj'), 1);
    assert.equal(store.deleteByScope('proj'), 0);
    assert.deepEqual(store.status(), { totalMemories: 0, scopes: [] });
  } finally { cleanup(); }
});

// ── Issue 2: slug collision with different titles ────────────────────────────

test('MemoryStore: different titles that produce same slug get disambiguated, not overwritten', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const store = new MemoryStore(config.memoryDir);
    const id1 = store.store({ scope: 'proj', title: 'Fix Auth Bug!', body: 'first fix' });
    const id2 = store.store({ scope: 'proj', title: 'fix auth bug', body: 'second fix' });
    // They must NOT be the same ID (slug collision should be resolved)
    assert.notEqual(id1, id2);
    // Both are retrievable with distinct content
    assert.equal(store.get(id1)?.body, 'first fix\n');
    assert.equal(store.get(id2)?.body, 'second fix\n');
    assert.equal(store.list('proj').length, 2);
  } finally { cleanup(); }
});

// ── Issue 5: deleteByScope counts invalidated entries ────────────────────────

test('MemoryStore: deleteByScope reports count including invalidated memories', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const store = new MemoryStore(config.memoryDir);
    store.store({ scope: 'proj', title: 'Alive', body: 'yes' });
    const inv = store.store({ scope: 'proj', title: 'Dead', body: 'no' });
    store.invalidate(inv);
    // 1 active + 1 invalidated = 2 actual files deleted
    assert.equal(store.deleteByScope('proj'), 2);
  } finally { cleanup(); }
});

// ── Issue 1: appendLog is append-only (no read-modify-write) ─────────────────

test('MemoryStore: concurrent stores produce distinct log entries without corruption', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const store = new MemoryStore(config.memoryDir);
    // Rapid sequential stores — exercises O_APPEND path
    for (let i = 0; i < 20; i++) {
      store.store({ scope: 'proj', title: `Entry ${i}`, body: `body ${i}` });
    }
    const log = fs.readFileSync(path.join(config.memoryDir, 'log.md'), 'utf-8');
    // All 20 store entries should be present
    for (let i = 0; i < 20; i++) {
      assert.match(log, new RegExp(`Entry ${i}`), `missing log entry for Entry ${i}`);
    }
  } finally { cleanup(); }
});

test('MemoryStore: read-only instances reject every mutation', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const writable = new MemoryStore(config.memoryDir);
    const id = writable.store({ title: 'Keep', body: 'unchanged', scope: 'proj' });
    const readOnly = new MemoryStore(config.memoryDir, { readOnly: true });
    assert.throws(() => readOnly.store({ title: 'No', body: 'write', scope: 'proj' }), /read-only/);
    assert.throws(() => readOnly.invalidate(id), /read-only/);
    assert.throws(() => readOnly.delete(id), /read-only/);
    assert.throws(() => readOnly.deleteByScope('proj'), /read-only/);
    assert.equal(writable.get(id)?.body.trim(), 'unchanged');
  } finally {
    cleanup();
  }
});
