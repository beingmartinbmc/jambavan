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
