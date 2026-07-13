import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { mkTempConfig, withEnv } from '../test-support/config';
import {
  applyResolvedRoot,
  isUnsafeFallbackRoot,
  resolveToolRoot,
} from '../src/config/jambavan.config';
import { doctorIssueReport, doctorReport } from '../src/tools/doctor';
import { buildMemoryHandlers } from '../src/tools/memory';
import { buildFailureHandlers } from '../src/tools/failure-memory';
import { buildSessionHandoffHandlers } from '../src/tools/session-handoff';
import { RootResolutionGate, selectClientRoot } from '../src/mcp/server';

// ── applyResolvedRoot ────────────────────────────────────────────────────────

test('RootResolutionGate: stateful work waits for client root resolution', async () => {
  const gate = new RootResolutionGate();
  let settle!: () => void;
  gate.start(new Promise<void>(resolve => { settle = resolve; }));

  let statefulCallRan = false;
  const statefulCall = gate.wait().then(() => { statefulCallRan = true; });
  await Promise.resolve();
  assert.equal(statefulCallRan, false);

  settle();
  await statefulCall;
  assert.equal(statefulCallRan, true);
});

test('RootResolutionGate: captures resolution failures until the tool call can report them', async () => {
  const gate = new RootResolutionGate();
  gate.start(Promise.reject(new Error('choose one root')));
  await assert.rejects(gate.wait(), /choose one root/);
});

test('selectClientRoot: rejects ambiguous or non-file workspaces', () => {
  assert.throws(
    () => selectClientRoot([{ uri: 'file:///one' }, { uri: 'file:///two' }]),
    /multiple workspace roots require an explicit JAMBAVAN_ROOT/,
  );
  assert.throws(
    () => selectClientRoot([{ uri: 'vscode-remote://ssh/project' }]),
    /unsupported non-file workspace URI/,
  );
  assert.match(selectClientRoot([{ uri: 'file:///tmp/project' }])!, /tmp[\\/]project$/);
});

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

test('applyResolvedRoot: explicit tool root resolves an identical cwd fallback', async () => {
  await withEnv({ JAMBAVAN_ROOT: undefined }, () => {
    const { config, cleanup } = mkTempConfig();
    try {
      config.rootSource = 'cwd-fallback';
      assert.equal(applyResolvedRoot(config, config.projectRoot, 'tool-input'), true);
      assert.equal(config.rootSource, 'tool-input');
    } finally {
      cleanup();
    }
  });
});

test('resolveToolRoot: accepts only an existing directory inside an unresolved fallback root', () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    config.rootSource = 'cwd-fallback';
    const child = path.join(root, 'Portfolio');
    const file = path.join(root, 'file.txt');
    fs.mkdirSync(child);
    fs.writeFileSync(file, 'x');

    assert.equal(resolveToolRoot(config, child), fs.realpathSync(child));
    assert.throws(() => resolveToolRoot(config, 'Portfolio'), /absolute directory/);
    assert.throws(() => resolveToolRoot(config, file), /not a directory/);
    assert.throws(() => resolveToolRoot(config, path.dirname(root)), /inside the current fallback root/);
    assert.throws(() => resolveToolRoot(config, `${child}\0bad`), /absolute directory/);
  } finally {
    cleanup();
  }
});

test('unsafe unresolved fallback is explicit and tool binding marks the resolved source', async () => {
  await withEnv({ JAMBAVAN_ROOT: undefined, JAMBAVAN_MEMORY_HOME: undefined }, () => {
    const { config, root, cleanup } = mkTempConfig();
    try {
      config.projectRoot = require('os').homedir();
      config.rootSource = 'cwd-fallback';
      assert.equal(isUnsafeFallbackRoot(config), true);

      config.projectRoot = path.dirname(root);
      const resolved = resolveToolRoot(config, root);
      assert.equal(applyResolvedRoot(config, resolved, 'tool-input'), true);
      assert.equal(config.rootSource, 'tool-input');
      assert.equal(isUnsafeFallbackRoot(config), false);
    } finally {
      cleanup();
    }
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
  assert.match(report, /Project root is unresolved \(fallback: \$HOME\)/);
});

test('doctorReport: no $HOME warning when root came from env', () => {
  const { config } = mkTempConfig();
  const report = doctorReport(config, { allowWrite: false, allowBash: false });
  assert.doesNotMatch(report, /Project root is unresolved/);
});

test('doctorReport: reports index stats when provided, "not built" otherwise', () => {
  const { config } = mkTempConfig();
  const withoutIndex = doctorReport(config, { allowWrite: false, allowBash: false });
  assert.match(withoutIndex, /not built/);

  const withIndex = doctorReport(config, { allowWrite: false, allowBash: false, indexStats: { files: 3, symbols: 12 } });
  assert.match(withIndex, /3 files, 12 symbols/);

  const withFailure = doctorReport(config, {
    allowWrite: false,
    allowBash: false,
    indexStats: { files: 3, symbols: 12, failures: [{ filePath: '/tmp/broken.ts', error: 'parse failed' }] },
  });
  assert.match(withFailure, /1 failures/);
  assert.match(withFailure, /broken\.ts: parse failed/);
});

test('doctorIssueReport: emits a copy-ready redacted issue URL and actionable body', () => {
  const { config } = mkTempConfig();
  const secret = 'ghp_123456789012345678901234567890123456';
  const report = doctorIssueReport(config, {
    allowWrite: false,
    allowBash: false,
    host: 'Cursor',
    watcherRunning: false,
    indexStats: {
      files: 3,
      symbols: 12,
      failures: [{ filePath: path.join(config.projectRoot, 'private.ts'), error: `token=${secret}` }],
    },
  });

  assert.match(report, /https:\/\/github\.com\/beingmartinbmc\/jambavan\/issues\/new/);
  assert.match(report, /## Environment/);
  assert.match(report, /OS:/);
  assert.match(report, /Host: Cursor/);
  assert.match(report, new RegExp(`Node: ${process.version.replaceAll('.', '\\.')}`));
  assert.match(report, /Root source: env/);
  assert.match(report, /Parser health/);
  assert.match(report, /Suggested action/);
  assert.match(report, /No issue was posted/);
  assert.ok(!report.includes(config.projectRoot));
  assert.ok(!report.includes(secret));
});
