import { test } from 'node:test';
import * as assert from 'node:assert/strict';
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
