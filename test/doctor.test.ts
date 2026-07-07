import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { mkTempConfig, withEnv } from '../test-support/config';
import { applyResolvedRoot } from '../src/config/jambavan.config';
import { doctorReport } from '../src/tools/doctor';
import { buildMemoryHandlers } from '../src/tools/memory';
import { buildFailureHandlers } from '../src/tools/failure-memory';
import { buildSessionHandoffHandlers } from '../src/tools/session-handoff';

// ── applyResolvedRoot ────────────────────────────────────────────────────────

test('applyResolvedRoot: updates projectRoot/indexDir/memoryDir and marks source client-roots', async () => {
  await withEnv({ JAMBAVAN_ROOT: undefined, JAMBAVAN_MEMORY_HOME: undefined }, () => {
    const { config } = mkTempConfig();
    const newRoot = '/tmp/some-other-project';
    applyResolvedRoot(config, newRoot);
    assert.equal(config.projectRoot, newRoot);
    assert.equal(config.indexDir, `${newRoot}/.jambavan`);
    assert.equal(config.memoryDir, `${newRoot}/.jambavan/memory`);
    assert.equal(config.rootSource, 'client-roots');
  });
});

test('applyResolvedRoot: no-op when JAMBAVAN_ROOT is explicitly set', async () => {
  await withEnv({ JAMBAVAN_ROOT: '/explicit/root' }, () => {
    const { config } = mkTempConfig();
    const before = { ...config };
    applyResolvedRoot(config, '/tmp/some-other-project');
    assert.deepEqual(config, before);
  });
});

test('applyResolvedRoot: preserves JAMBAVAN_MEMORY_HOME override', async () => {
  await withEnv({ JAMBAVAN_ROOT: undefined, JAMBAVAN_MEMORY_HOME: '/shared/palace' }, () => {
    const { config } = mkTempConfig();
    config.memoryDir = '/shared/palace';
    applyResolvedRoot(config, '/tmp/some-other-project');
    assert.equal(config.memoryDir, '/shared/palace');
    assert.equal(config.projectRoot, '/tmp/some-other-project');
  });
});

// ── handlers built before applyResolvedRoot must still honor the resolved root ──
// Regression test for server.ts's real sequence: buildMemoryHandlers/
// buildFailureHandlers/buildSessionHandoffHandlers are constructed once at
// module load, then applyResolvedRoot() runs later inside server.oninitialized.
// A build-time-captured `new MemoryStore(config.memoryDir)` would keep writing
// to the stale (pre-resolution) directory forever.

test('buildMemoryHandlers: built before applyResolvedRoot still writes to the resolved memoryDir', async () => {
  await withEnv({ JAMBAVAN_ROOT: undefined, JAMBAVAN_MEMORY_HOME: undefined }, () => {
    const { config, cleanup } = mkTempConfig();
    const staleMemoryDir = config.memoryDir;
    try {
      const memoryHandlers = buildMemoryHandlers(config); // built BEFORE resolution, like server.ts
      const { root: newRoot, cleanup: cleanupNewRoot } = mkTempConfig();
      try {
        applyResolvedRoot(config, newRoot); // fires later, like server.oninitialized
        memoryHandlers.jambavan_memory_store({ title: 'post-resolution fact', body: 'stored after root fix' });

        assert.ok(fs.existsSync(path.join(config.memoryDir, 'general')), 'memory should land under the resolved memoryDir');
        assert.ok(!fs.existsSync(staleMemoryDir), 'nothing should be written to the pre-resolution memoryDir');
      } finally {
        cleanupNewRoot();
      }
    } finally {
      cleanup();
    }
  });
});

test('buildFailureHandlers + buildSessionHandoffHandlers: honor a root resolved after construction', async () => {
  await withEnv({ JAMBAVAN_ROOT: undefined, JAMBAVAN_MEMORY_HOME: undefined }, () => {
    const { config, cleanup } = mkTempConfig();
    try {
      const failureHandlers = buildFailureHandlers(config);
      const sessionHandlers = buildSessionHandoffHandlers(config);
      const { root: newRoot, cleanup: cleanupNewRoot } = mkTempConfig();
      try {
        applyResolvedRoot(config, newRoot);

        failureHandlers.jambavan_failure_store({ command: 'npm test', symptom: 'flaked once' });
        const search = failureHandlers.jambavan_failure_search({ query: 'flaked' });
        assert.match(search, /flaked once/);

        const handoff = sessionHandlers.jambavan_session_export({});
        assert.match(handoff, /flaked once/, 'session export should see the failure stored under the resolved scope/root');
      } finally {
        cleanupNewRoot();
      }
    } finally {
      cleanup();
    }
  });
});

// ── doctorReport ─────────────────────────────────────────────────────────────

test('doctorReport: warns when root fell back to cwd and looks like $HOME', () => {
  const { config } = mkTempConfig();
  const os = require('os') as typeof import('os');
  config.projectRoot = os.homedir();
  config.rootSource = 'cwd-fallback';
  const report = doctorReport(config, { allowWrite: false, allowBash: false });
  assert.match(report, /Root fell back to \$HOME/);
});

test('doctorReport: no $HOME warning when root came from env', () => {
  const { config } = mkTempConfig();
  const report = doctorReport(config, { allowWrite: false, allowBash: false });
  assert.doesNotMatch(report, /Root fell back to \$HOME/);
});

test('doctorReport: reports index stats when provided, "not built" otherwise', () => {
  const { config } = mkTempConfig();
  const withoutIndex = doctorReport(config, { allowWrite: false, allowBash: false });
  assert.match(withoutIndex, /not built/);

  const withIndex = doctorReport(config, { allowWrite: false, allowBash: false, indexStats: { files: 3, symbols: 12 } });
  assert.match(withIndex, /3 files, 12 symbols/);
});
