import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { applyResolvedRoot, defaultMemoryDir, loadConfig, type JambavanConfig } from '../src/config/jambavan.config';
import { MemoryArchive, isLegacyMigrationCurrent } from '../src/memory/archive';
import { migrateLegacyMemory } from '../src/memory/migrate';
import { legacyProjectScope, normalizedRemotePath, projectScope } from '../src/memory/project-scope';
import { MemoryStore } from '../src/memory/store';
import { buildMemoryHandlers } from '../src/tools/memory';
import { mkTempConfig, withEnv } from '../test-support/config';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo(root: string): void {
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'initial');
}

function configFor(root: string, memoryDir: string, memorySource: JambavanConfig['memorySource'] = 'default'): JambavanConfig {
  return {
    projectRoot: root,
    indexDir: path.join(root, '.jambavan'),
    memoryDir,
    memorySource,
    contextTokenBudget: 8_000,
    ignore: [],
    rootSource: 'env',
  };
}

test('global memory config: defaults to home, honors complete override, and never follows root rebinding', async () => {
  await withEnv({ JAMBAVAN_ROOT: undefined, JAMBAVAN_MEMORY_HOME: undefined }, () => {
    const config = loadConfig();
    assert.equal(config.memoryDir, defaultMemoryDir());
    assert.equal(config.memorySource, 'default');
    const before = config.memoryDir;
    applyResolvedRoot(config, path.join(os.tmpdir(), 'another-root'));
    assert.equal(config.memoryDir, before);
  });
  await withEnv({ JAMBAVAN_MEMORY_HOME: path.join(os.tmpdir(), 'complete-memory-override') }, () => {
    const config = loadConfig();
    assert.equal(config.memoryDir, path.join(os.tmpdir(), 'complete-memory-override'));
    assert.equal(config.memorySource, 'env');
  });
});

test('project identity: normalizes HTTPS/SSH remotes without credentials', () => {
  assert.equal(normalizedRemotePath('https://user:token@github.com/acme/widget.git'), 'acme/widget');
  assert.equal(normalizedRemotePath('git@github.com:acme/widget.git'), 'acme/widget');
  assert.equal(normalizedRemotePath('ssh://git@github.com/acme/widget.git'), 'acme/widget');
  assert.equal(normalizedRemotePath(''), undefined);
});

test('project identity: is clone-stable, fork-aware, and stable without a remote', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jambavan-scope-'));
  const source = path.join(dir, 'source');
  const httpsClone = path.join(dir, 'https', 'widget');
  const sshClone = path.join(dir, 'ssh', 'widget');
  const forkClone = path.join(dir, 'fork', 'widget');
  const localA = path.join(dir, 'local-a', 'widget');
  const localB = path.join(dir, 'local-b', 'widget');
  try {
    fs.mkdirSync(source, { recursive: true });
    initRepo(source);
    for (const clone of [httpsClone, sshClone, forkClone, localA, localB]) {
      fs.mkdirSync(path.dirname(clone), { recursive: true });
      execFileSync('git', ['clone', '-q', source, clone]);
    }
    git(httpsClone, 'remote', 'set-url', 'origin', 'https://user:token@github.com/acme/widget.git');
    git(sshClone, 'remote', 'set-url', 'origin', 'git@github.com:acme/widget.git');
    git(forkClone, 'remote', 'set-url', 'origin', 'git@github.com:someone-else/widget.git');
    git(localA, 'remote', 'remove', 'origin');
    git(localB, 'remote', 'remove', 'origin');

    const scope = (root: string) => projectScope(configFor(root, path.join(dir, 'memory'), 'override'));
    assert.equal(scope(httpsClone), scope(sshClone));
    assert.notEqual(scope(httpsClone), scope(forkClone));
    assert.equal(scope(localA), scope(localB));
    assert.doesNotMatch(scope(httpsClone), /github|user|token|\//);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('project identity: explicit scope wins and non-Git directories retain path-derived separation', () => {
  const a = mkTempConfig();
  const b = mkTempConfig();
  try {
    assert.notEqual(projectScope(a.config), projectScope(b.config));
    a.config.scope = 'shared-project';
    assert.equal(projectScope(a.config), 'shared-project');
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test('collections: serialize, infer for legacy documents, filter, and count by scope', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const store = new MemoryStore(config.memoryDir);
    const decision = store.store({ title: 'Choose SQLite', body: 'portable', type: 'Decision', scope: 'proj' });
    const failure = store.store({ title: 'Build failed', body: 'native ABI', type: 'FailureRecord', scope: 'proj' });
    const note = store.store({ title: 'Release note', body: 'ship it', scope: 'proj', collection: 'releases' });
    const fallback = store.store({ title: 'Invalid collection', body: 'fallback', scope: 'proj', collection: '!!!' });
    for (const id of [decision, failure]) {
      const file = store.get(id)!.filePath;
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^collection:.*\n/m, ''));
    }
    assert.equal(store.get(decision)?.frontmatter.collection, 'decisions');
    assert.equal(store.get(failure)?.frontmatter.collection, 'failures');
    assert.equal(store.get(fallback)?.frontmatter.collection, 'general');
    assert.deepEqual(store.list('proj', { collection: 'releases' }).map(doc => doc.id), [note]);
    assert.deepEqual(store.status().scopes[0].collections, [
      { collection: 'decisions', count: 1 },
      { collection: 'failures', count: 1 },
      { collection: 'general', count: 1 },
      { collection: 'releases', count: 1 },
    ]);
  } finally {
    cleanup();
  }
});

test('rootless memory handlers default writes to global without a project root', async () => {
  const { config, cleanup } = mkTempConfig();
  try {
    config.rootSource = 'cwd-fallback';
    const handlers = buildMemoryHandlers(config);
    assert.match(handlers.jambavan_memory_store({ title: 'Rootless fact', body: 'available everywhere' }), /global\/rootless-fact/);
    assert.match(await handlers.jambavan_memory_recall({ scope: 'global' }), /Rootless fact/);
  } finally {
    cleanup();
  }
});

test('legacy read-through remaps project/general scopes, preserves alternatives, labels results, and prefers global duplicates', () => {
  const fixture = mkTempConfig();
  const globalDir = path.join(fixture.root, 'global-memory');
  const config = configFor(fixture.root, globalDir);
  try {
    const legacy = new MemoryStore(path.join(fixture.root, '.jambavan', 'memory'));
    legacy.store({ title: 'Legacy general', body: 'old general body', scope: 'general' });
    legacy.store({ title: 'Legacy project', body: 'old project body', scope: legacyProjectScope(config) });
    legacy.store({ title: 'Alternative', body: 'keep own scope', scope: 'other-scope' });
    legacy.store({ title: 'Duplicate', body: 'same body', scope: 'general' });
    new MemoryStore(globalDir).store({ title: 'Duplicate', body: 'same body', scope: projectScope(config) });
    new MemoryStore(globalDir).store({ title: 'Alternative', body: 'keep own scope', scope: 'unrelated-scope' });

    const archive = new MemoryArchive(config);
    const active = archive.list(projectScope(config));
    assert.deepEqual(active.map(doc => doc.frontmatter.title).sort(), ['Duplicate', 'Legacy general', 'Legacy project']);
    assert.equal(active.find(doc => doc.frontmatter.title === 'Duplicate')?.archiveSource, 'archive');
    assert.equal(active.find(doc => doc.frontmatter.title === 'Legacy general')?.frontmatter.scope, projectScope(config));
    assert.equal(archive.list('other-scope')[0].frontmatter.title, 'Alternative');
    assert.equal(archive.list().filter(doc => doc.frontmatter.title === 'Alternative').length, 2,
      'identical content in distinct scopes is not a migrated duplicate');
    assert.equal(archive.search('general body', { scope: projectScope(config) })[0].doc.archiveSource, 'legacy');
    assert.equal(archive.get(`${projectScope(config)}/legacy-general`)?.archiveSource, 'legacy');
  } finally {
    fixture.cleanup();
  }
});

test('legacy migration: dry-run, apply, invalidated history, idempotency, and stale marker detection', () => {
  const fixture = mkTempConfig();
  const config = configFor(fixture.root, path.join(fixture.root, 'global-memory'));
  const legacyDir = path.join(fixture.root, '.jambavan', 'memory');
  try {
    const legacy = new MemoryStore(legacyDir);
    legacy.store({ title: 'Decision one', body: 'body one', type: 'Decision', scope: 'general', source: 'old-session' });
    const invalidated = legacy.store({ title: 'Old fact', body: 'stale', scope: legacyProjectScope(config) });
    legacy.invalidate(invalidated, 'replaced');
    legacy.store({ title: 'Other project', body: 'preserve scope', scope: 'other-scope' });

    const dryRun = migrateLegacyMemory(config);
    assert.deepEqual({ found: dryRun.found, copied: dryRun.copied, conflicts: dryRun.conflicts.length, applied: dryRun.applied }, { found: 3, copied: 0, conflicts: 0, applied: false });
    assert.equal(fs.existsSync(config.memoryDir), false, 'dry-run must not create the destination archive');
    assert.equal(new MemoryStore(config.memoryDir).list(undefined, { includeInvalidated: true }).length, 0);

    const applied = migrateLegacyMemory(config, true);
    assert.equal(applied.copied, 3);
    assert.equal(applied.applied, true);
    const migrated = new MemoryStore(config.memoryDir).list(undefined, { includeInvalidated: true });
    assert.equal(migrated.length, 3);
    assert.equal(migrated.find(doc => doc.frontmatter.title === 'Old fact')?.frontmatter.invalidated, true);
    assert.equal(migrated.find(doc => doc.frontmatter.title === 'Decision one')?.frontmatter.source, 'old-session');
    assert.equal(migrated.find(doc => doc.frontmatter.title === 'Other project')?.frontmatter.scope, 'other-scope');
    assert.equal(isLegacyMigrationCurrent(config, legacyDir), true);

    const again = migrateLegacyMemory(config, true);
    assert.equal(again.copied, 0);
    assert.equal(again.skipped, 3);
    legacy.store({ title: 'Late legacy change', body: 'new after migration', scope: 'general' });
    assert.equal(isLegacyMigrationCurrent(config, legacyDir), false);
    assert.match(new MemoryArchive(config).list(projectScope(config)).map(doc => doc.frontmatter.title).join(','), /Late legacy change/);
  } finally {
    fixture.cleanup();
  }
});

test('legacy migration preserves existing slug suffixes and rejects target-ID collisions', () => {
  const fixture = mkTempConfig();
  const config = configFor(fixture.root, path.join(fixture.root, 'global-memory'));
  try {
    const legacy = new MemoryStore(path.join(fixture.root, '.jambavan', 'memory'));
    const first = legacy.store({ title: 'Same slug!', body: 'first', scope: 'general' });
    const second = legacy.store({ title: 'same slug', body: 'second', scope: 'general' });
    assert.match(second, /-2$/);
    assert.equal(migrateLegacyMemory(config, true).copied, 2);
    const scope = projectScope(config);
    const destination = new MemoryStore(config.memoryDir);
    assert.equal(destination.get(`${scope}/${path.basename(first)}`)?.body.trim(), 'first');
    assert.equal(destination.get(`${scope}/${path.basename(second)}`)?.body.trim(), 'second');

    const later = legacy.store({ title: 'Different title', body: 'collision', scope: 'general' });
    const laterFile = legacy.get(later)!.filePath;
    fs.renameSync(laterFile, path.join(path.dirname(laterFile), `${path.basename(first)}.md`));
    const conflict = migrateLegacyMemory(config, true);
    assert.equal(conflict.applied, false);
    assert.match(conflict.conflicts[0]?.reason ?? '', /target ID|same title/);
  } finally {
    fixture.cleanup();
  }
});

test('legacy migration: conflicting target content aborts before any document is copied', () => {
  const fixture = mkTempConfig();
  const config = configFor(fixture.root, path.join(fixture.root, 'global-memory'));
  try {
    const legacy = new MemoryStore(path.join(fixture.root, '.jambavan', 'memory'));
    legacy.store({ title: 'Conflict', body: 'legacy value', scope: 'general' });
    legacy.store({ title: 'Would copy', body: 'must not be copied', scope: 'general' });
    const destination = new MemoryStore(config.memoryDir);
    destination.store({ title: 'Conflict', body: 'new value', scope: projectScope(config) });

    const report = migrateLegacyMemory(config, true);
    assert.equal(report.applied, false);
    assert.equal(report.copied, 0);
    assert.equal(report.conflicts.length, 1);
    assert.equal(destination.findByTitle(projectScope(config), 'Would copy'), undefined);
  } finally {
    fixture.cleanup();
  }
});
