import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemPalaceAdapter, MemPalaceError } from '../src/integrations/mempalace';
import { buildMemoryHandlers } from '../src/tools/memory';
import { mkTempConfig } from '../test-support/config';

const command = path.resolve(__dirname, '../test-support/fake-mempalace-server.js');

function adapter(mode = 'normal', extra: NodeJS.ProcessEnv = {}, timeoutMs = 2_000): MemPalaceAdapter {
  return new MemPalaceAdapter({
    command,
    timeoutMs,
    environment: { MEMPALACE_FAKE_MODE: mode, ...extra, SECRET_THING: 'must-not-leak' },
  });
}

test('MemPalace adapter: validates capabilities and maps all five read operations', async () => {
  const client = adapter();
  try {
    const results = await client.search('auth', { wing: 'project', room: 'decisions', limit: 5 });
    assert.deepEqual(results, [{ text: 'found auth', wing: 'project', room: 'decisions', sourceFile: 'notes.md', similarity: 0.91 }]);
    assert.deepEqual(await client.listDrawers({ wing: 'project', room: 'general' }), [{ id: 'drawer-1', wing: 'project', room: 'general', content: 'drawer preview' }]);
    assert.deepEqual(await client.getDrawer('drawer-1'), { id: 'drawer-1', wing: 'project', room: 'general', content: 'full drawer content' });
    assert.equal(await client.getDrawer('missing'), null);
    assert.deepEqual(await client.taxonomy(), { taxonomy: { project: { general: 1 } } });
    assert.deepEqual(await client.status(), { totalDrawers: 1, taxonomy: { project: { general: 1 } } });
    assert.equal((await client.search('env'))[0].text, 'secret=absent', 'unrelated parent environment must not reach the child');
  } finally {
    await client.close();
  }
});

test('MemPalace adapter: unavailable binary and missing capabilities are sanitized', async () => {
  const unavailable = new MemPalaceAdapter({ command: path.join(os.tmpdir(), 'missing-mempalace-binary'), timeoutMs: 200 });
  await assert.rejects(unavailable.status(), (error: unknown) =>
    error instanceof MemPalaceError && /unavailable/i.test(error.message));

  const missing = adapter('missing');
  try {
    await assert.rejects(missing.status(), (error: unknown) =>
      error instanceof MemPalaceError && /missing required read capabilities/i.test(error.message));
  } finally {
    await missing.close();
  }
});

test('MemPalace adapter: malformed JSON and request timeouts fail safely', async () => {
  const malformed = adapter('malformed');
  try {
    await assert.rejects(malformed.search('auth'), (error: unknown) =>
      error instanceof MemPalaceError && /request failed|malformed/i.test(error.message));
  } finally {
    await malformed.close();
  }

  const malformedShape = adapter('malformed-shape');
  try {
    await assert.rejects(malformedShape.search('auth'), (error: unknown) =>
      error instanceof MemPalaceError && /malformed/i.test(error.message));
  } finally {
    await malformedShape.close();
  }

  const timeout = adapter('timeout', {}, 100);
  try {
    await assert.rejects(timeout.search('auth'), (error: unknown) =>
      error instanceof MemPalaceError && /timed out/i.test(error.message));
  } finally {
    await timeout.close();
  }
});

test('MemPalace adapter: reconnects once after transport closure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jambavan-mempalace-reconnect-'));
  const stateFile = path.join(dir, 'state');
  const client = adapter('reconnect', { MEMPALACE_FAKE_STATE_FILE: stateFile });
  try {
    assert.equal((await client.search('retry'))[0].text, 'found retry');
    assert.equal(fs.readFileSync(stateFile, 'utf8'), 'closed once');
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('memory providers: default stays local, all is sectioned, and explicit MemPalace failures throw', async () => {
  const { config, cleanup } = mkTempConfig();
  const missing = new MemPalaceAdapter({ command: path.join(os.tmpdir(), 'missing-mempalace-binary'), timeoutMs: 200 });
  try {
    const handlers = buildMemoryHandlers(config, missing);
    handlers.jambavan_memory_store({ title: 'Local choice', body: 'keep local first', scope: 'proj' });
    assert.match(await handlers.jambavan_memory_search({ query: 'local', scope: 'proj' }), /Local choice/);
    const combined = await handlers.jambavan_memory_search({ query: 'local', scope: 'proj', provider: 'all' });
    assert.match(combined, /# Jambavan results/);
    assert.match(combined, /# MemPalace results/);
    assert.match(combined, /Warning: MemPalace is unavailable/);
    await assert.rejects(
      handlers.jambavan_memory_search({ query: 'local', provider: 'mempalace' }),
      MemPalaceError,
    );
  } finally {
    await missing.close();
    cleanup();
  }
});

test('invalid optional MemPalace command does not affect ordinary local memory', async () => {
  const { config, cleanup } = mkTempConfig();
  const invalid = new MemPalaceAdapter({ command: '' });
  try {
    const handlers = buildMemoryHandlers(config, invalid);
    handlers.jambavan_memory_store({ title: 'Local only', body: 'still works', scope: 'proj' });
    assert.match(await handlers.jambavan_memory_search({ query: 'works' }), /Local only/);
    await assert.rejects(
      handlers.jambavan_memory_status({ provider: 'mempalace' }),
      /must name one executable/,
    );
  } finally {
    await invalid.close();
    cleanup();
  }
});

test('explicit MemPalace providers do not open the local archive', async () => {
  const { config, cleanup } = mkTempConfig();
  const client = adapter();
  try {
    config.memoryDir = path.join(config.projectRoot, 'not-a-directory');
    fs.writeFileSync(config.memoryDir, 'local archive must stay unopened');
    const handlers = buildMemoryHandlers(config, client);
    assert.match(await handlers.jambavan_memory_search({ query: 'auth', provider: 'mempalace' }), /found auth/);
    assert.match(await handlers.jambavan_memory_recall({ provider: 'mempalace' }), /drawer-1/);
    assert.match(await handlers.jambavan_memory_status({ provider: 'mempalace' }), /Total drawers: 1/);
  } finally {
    await client.close();
    cleanup();
  }
});
