import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { mkTempConfig } from '../test-support/config';
import { JambavanIndex } from '../src/index/indexer';
import { MemoryStore } from '../src/memory/store';
import { projectScope } from '../src/tools/jambavan';
import { buildReviewPackHandlers } from '../src/tools/review-pack';
import { buildReviewPackJson } from '../src/tools/review-pack-json';
import { parseChangedRanges, parseNameStatus, changedSymbols } from '../src/tools/changed-symbols';
import type { Symbol } from '../src/index/ast-parser';
import { buildImpactHandlers } from '../src/tools/impact';

function git(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root });
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, [
    '--require', 'ts-node/register/transpile-only',
    'src/index.ts',
    ...args,
  ], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf-8',
  });
}

function initRepoWithBranchDiff(root: string): void {
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);

  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'util.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'initial']);

  git(root, ['checkout', '-q', '-b', 'feature']);
  fs.writeFileSync(
    path.join(root, 'src', 'util.ts'),
    'export function add(a: number, b: number) { return a + b; }\n' +
      'export function subtract(a: number, b: number) { return a - b; }\n',
  );
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'test', 'util.test.ts'),
    'import { add } from "../src/util";\ntest("adds", () => { add(1, 2); });\n',
  );
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'add subtract, no test for it']);
}

test('changed-symbol diff parser preserves rename destination and added-line ranges', () => {
  const files = parseNameStatus('R100\tsrc/old.ts\tsrc/new.ts\n');
  const ranges = parseChangedRanges(
    'diff --git a/src/new.ts b/src/new.ts\n--- a/src/new.ts\n+++ b/src/new.ts\n@@ -2,0 +3,2 @@\n',
  );

  assert.deepEqual(files[0], {
    status: 'R100',
    oldPath: 'src/old.ts',
    path: 'src/new.ts',
    ranges: [],
  });
  assert.deepEqual(ranges.get('src/new.ts'), [{ start: 3, end: 4 }]);
});

test('changed-symbol diff parser decodes git-quoted paths', () => {
  const files = parseNameStatus('M\t"src/space \\303\\251.ts"\n');
  const ranges = parseChangedRanges(
    'diff --git "a/src/space \\303\\251.ts" "b/src/space \\303\\251.ts"\n' +
      '--- "a/src/space \\303\\251.ts"\n' +
      '+++ "b/src/space \\303\\251.ts"\n' +
      '@@ -1 +1 @@\n',
  );

  assert.equal(files[0].path, 'src/space é.ts');
  assert.deepEqual(ranges.get('src/space é.ts'), [{ start: 1, end: 1 }]);
});

test('changedSymbols: full deletion of a top-level function does NOT tag its neighbour', () => {
  // git emits `@@ -1,3 +0,0 @@` for a fully-deleted top-level function: new-side
  // count 0 at line 0. parseChangedRanges encodes that as the zero-width range
  // {start:1,end:0}, which contains no symbol — so the surviving neighbour is
  // never mis-tagged as changed.
  const ranges = parseChangedRanges(
    'diff --git a/s.ts b/s.ts\n--- a/s.ts\n+++ b/s.ts\n@@ -1,3 +0,0 @@\n',
  );
  const neighbour: Symbol = { name: 'kept', type: 'function', startLine: 1, endLine: 3, content: '', filePath: 's.ts' };
  assert.deepEqual(
    changedSymbols([neighbour], ranges.get('s.ts') ?? []),
    [],
    'a whole-function deletion must not tag the surviving neighbour',
  );
});

test('changedSymbols: interior line deletion still tags its containing function', () => {
  // Interior deletion inside kept(): `@@ -6,2 +6 @@` — new-side count 1 at line 6.
  // The enclosing function spanning line 6 is tagged as changed.
  const ranges = parseChangedRanges(
    'diff --git a/s.ts b/s.ts\n--- a/s.ts\n+++ b/s.ts\n@@ -6,2 +5,1 @@\n',
  );
  const enclosing: Symbol = { name: 'kept', type: 'function', startLine: 4, endLine: 8, content: '', filePath: 's.ts' };
  const other: Symbol = { name: 'far', type: 'function', startLine: 20, endLine: 25, content: '', filePath: 's.ts' };
  assert.deepEqual(
    changedSymbols([enclosing, other], ranges.get('s.ts') ?? []).map(s => s.name),
    ['kept'],
    'an interior deletion must tag only the function that encloses it',
  );
});

test('changedSymbols: pure interior deletion (new count 0) tags only the enclosing function', () => {
  // `@@ -5 +4,0 @@`: one interior line removed with no replacement. Encoded as the
  // zero-width probe {start:5,end:4}; it is contained by a function spanning 5,
  // but not by a top-level sibling that starts at 5.
  const ranges = parseChangedRanges(
    'diff --git a/s.ts b/s.ts\n--- a/s.ts\n+++ b/s.ts\n@@ -5 +4,0 @@\n',
  );
  const enclosing: Symbol = { name: 'wrap', type: 'function', startLine: 3, endLine: 7, content: '', filePath: 's.ts' };
  const siblingBelow: Symbol = { name: 'below', type: 'function', startLine: 5, endLine: 9, content: '', filePath: 's.ts' };
  assert.deepEqual(
    changedSymbols([enclosing, siblingBelow], ranges.get('s.ts') ?? []).map(s => s.name),
    ['wrap'],
    'zero-width deletion probe must require strict containment',
  );
});

test('jambavan_review_pack: reports only changed symbols and per-symbol test risk', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    initRepoWithBranchDiff(root);

    const index = new JambavanIndex(config);
    await index.index();

    const handlers = buildReviewPackHandlers(config, () => index);
    const result = handlers.jambavan_review_pack({ base: 'main' });

    assert.match(result, /Jambavan Review Pack/);
    assert.match(result, /src\/util\.ts/);
    assert.doesNotMatch(result, /\*\*add\*\*/, 'unchanged add must not be labeled touched');
    assert.match(result, /\*\*subtract\*\*/, 'new subtract symbol should be reported');
    assert.match(result, /1 changed symbol\(s\) have no matching test/);
  } finally { cleanup(); }
});

test('jambavan_review_pack: a fully deleted function shows the file as deleted, tagging no survivor', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    // Base: two functions. `removed` sits above `kept`.
    fs.writeFileSync(
      path.join(root, 'src', 'm.ts'),
      'export function removed() {\n  return 1;\n}\n\nexport function kept() {\n  return 2;\n}\n',
    );
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'initial']);

    // Feature: delete `removed` entirely; `kept` shifts up but is otherwise untouched.
    git(root, ['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(
      path.join(root, 'src', 'm.ts'),
      'export function kept() {\n  return 2;\n}\n',
    );
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'delete removed()']);

    const index = new JambavanIndex(config);
    await index.index();

    const result = buildReviewPackHandlers(config, () => index).jambavan_review_pack({ base: 'main' });

    // Deletion analysis was removed for 1.0: the whole-function removal must not
    // be mis-attributed to the surviving neighbour. `kept` shifted but its body
    // is unchanged, so no changed symbol is reported for it either.
    assert.match(result, /src\/m\.ts/, 'the touched file is listed');
    assert.doesNotMatch(result, /\*\*kept\*\*/, 'untouched survivor must not be flagged as changed');
  } finally { cleanup(); }
});

test('jambavan_review_pack: flags a file where no symbol has a matching test', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'initial']);

    git(root, ['checkout', '-q', '-b', 'feature']);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'orphan.ts'), 'export function untested() { return 1; }\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'untested addition']);

    const index = new JambavanIndex(config);
    await index.index();

    const handlers = buildReviewPackHandlers(config, () => index);
    const result = handlers.jambavan_review_pack({ base: 'main' });

    assert.match(result, /\*\*untested\*\*/);
    assert.match(result, /1 changed symbol\(s\) have no matching test/);
  } finally { cleanup(); }
});

test('jambavan_review_pack: reports "no changes" when branch matches base', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'initial']);

    const handlers = buildReviewPackHandlers(config, () => undefined);
    const result = handlers.jambavan_review_pack({ base: 'main' });
    assert.match(result, /No changes vs `main`/);
  } finally { cleanup(); }
});

test('jambavan_review_pack: optionally includes untracked working-tree symbols', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'initial']);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'pending.ts'), 'export function pending() { return true; }\n');

    const index = new JambavanIndex(config);
    await index.index();
    const result = buildReviewPackHandlers(config, () => index)
      .jambavan_review_pack({ base: 'main', include_worktree: true });

    assert.match(result, /src\/pending\.ts/);
    assert.match(result, /\*\*pending\*\*/);
  } finally { cleanup(); }
});

test('jambavan_review_pack: include_worktree uses one merge-base→worktree diff (branch-added, worktree-deleted line)', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'initial']);

    // Branch commit ADDS a multi-line function...
    git(root, ['checkout', '-q', '-b', 'feature']);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src', 'edited.ts'),
      'export function edited() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n',
    );
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'add edited()']);

    // ...then the WORKING TREE deletes an interior line of that same function.
    // The old two-diff union parsed HEAD-relative removals against merge-base
    // coordinates and produced "No indexed symbols"; the single merge-base→
    // worktree diff attributes it correctly to edited().
    fs.writeFileSync(
      path.join(root, 'src', 'edited.ts'),
      'export function edited() {\n  const a = 1;\n  return a;\n}\n',
    );

    const index = new JambavanIndex(config);
    await index.index();
    const result = buildReviewPackHandlers(config, () => index)
      .jambavan_review_pack({ base: 'main', include_worktree: true });

    assert.match(result, /src\/edited\.ts/);
    assert.match(result, /\*\*edited\*\*/, 'the function edited across commit+worktree must be tagged');
    assert.doesNotMatch(result, /_No indexed symbols/);
  } finally { cleanup(); }
});

test('jambavan_review_pack: surfaces a clear error for an unresolvable base ref', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'initial']);

    const handlers = buildReviewPackHandlers(config, () => undefined);
    const result = handlers.jambavan_review_pack({ base: 'does-not-exist-branch' });
    assert.match(result, /Error: could not diff against base/);
  } finally { cleanup(); }
});

test('jambavan_review_pack: does not leak raw git stderr for an unresolvable base ref', async () => {
  const { config, root, cleanup } = mkTempConfig();
  const originalWrite = process.stderr.write.bind(process.stderr);
  let leaked = '';
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'initial']);

    const handlers = buildReviewPackHandlers(config, () => undefined);
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      leaked += String(chunk);
      return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;

    handlers.jambavan_review_pack({ base: 'does-not-exist-branch' });
  } finally {
    process.stderr.write = originalWrite;
    cleanup();
  }
  assert.doesNotMatch(leaked, /fatal:/, 'execFileSync should not inherit git stderr to the real process stderr');
});

test('jambavan_review_pack: reports index-not-built with a plain touched-file list', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    initRepoWithBranchDiff(root);

    const handlers = buildReviewPackHandlers(config, () => undefined);
    const result = handlers.jambavan_review_pack({ base: 'main' });

    assert.match(result, /src\/util\.ts/);
    assert.match(result, /Index not built yet/);
  } finally { cleanup(); }
});

test('jambavan_review_pack: rin debt and failure record risks are flagged', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'initial']);

    git(root, ['checkout', '-q', '-b', 'feature']);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src', 'risky.ts'),
      'export function risky() { return 1; }\n// rin: linear scan, add index if list grows\n',
    );
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'add risky']);

    const index = new JambavanIndex(config);
    await index.index();

    // Store a failure record that mentions risky.ts
    new MemoryStore(config.memoryDir).store({
      title: 'Failure: risky.ts blew up',
      body: 'src/risky.ts caused an out-of-memory error.',
      scope: projectScope(config),
      type: 'FailureRecord',
      description: 'unresolved',
      tags: ['failure', 'unresolved'],
    });

    const handlers = buildReviewPackHandlers(config, () => index);
    const result = handlers.jambavan_review_pack({ base: 'main' });

    assert.match(result, /has open rin debt marker/);
    assert.match(result, /past failure record/);
  } finally { cleanup(); }
});

test('jambavan_review_pack: max_files limits depth of analysis', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'initial']);

    git(root, ['checkout', '-q', '-b', 'feature']);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    for (let i = 1; i <= 3; i++) {
      fs.writeFileSync(path.join(root, 'src', `file${i}.ts`), `export function fn${i}() { return ${i}; }\n`);
    }
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'add three files']);

    const index = new JambavanIndex(config);
    await index.index();

    const handlers = buildReviewPackHandlers(config, () => index);
    const result = handlers.jambavan_review_pack({ base: 'main', max_files: 1 });

    assert.match(result, /analyzing first 1/);
  } finally { cleanup(); }
});

test('jambavan review-pack JSON reports when file analysis is truncated', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'initial']);

    git(root, ['checkout', '-q', '-b', 'feature']);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    for (let i = 1; i <= 3; i++) {
      fs.writeFileSync(path.join(root, 'src', `json${i}.ts`), `export function json${i}() { return ${i}; }\n`);
    }
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'add json files']);

    const index = new JambavanIndex(config);
    await index.index();

    const pack = buildReviewPackJson(config, index, 'main', 1);

    assert.equal(pack.touchedCount, 3);
    assert.equal(pack.analyzedCount, 1);
    assert.equal(pack.truncated, true);
    assert.equal(pack.files.length, 1);
  } finally { cleanup(); }
});

test('jambavan_review_pack: rin markers inside fixture strings are ignored', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'initial']);

    git(root, ['checkout', '-q', '-b', 'feature']);
    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'test', 'fixture.test.ts'),
      "const fixture = '// rin: this is test data, not debt';\n",
    );
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'add fixture']);

    const index = new JambavanIndex(config);
    await index.index();

    const handlers = buildReviewPackHandlers(config, () => index);
    const result = handlers.jambavan_review_pack({ base: 'main' });
    const pack = buildReviewPackJson(config, index, 'main');

    assert.doesNotMatch(result, /has open rin debt marker/);
    assert.equal(pack.rinMarkers.length, 0);
  } finally { cleanup(); }
});

test('jambavan_review_pack: test files are not flagged for missing matching tests', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'initial']);

    git(root, ['checkout', '-q', '-b', 'feature']);
    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test', 'helper.test.ts'), 'export function helper() { return 1; }\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'add test helper']);

    const index = new JambavanIndex(config);
    await index.index();

    const handlers = buildReviewPackHandlers(config, () => index);
    const result = handlers.jambavan_review_pack({ base: 'main' });
    const pack = buildReviewPackJson(config, index, 'main');

    assert.doesNotMatch(result, /no symbol in this file has a matching test/);
    assert.ok(!pack.files.some(f => f.risks.some(r => r.includes('have no matching test'))));
  } finally { cleanup(); }
});

test('jambavan_review_pack: a deleted file is listed as deleted with no indexed symbols', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'gone.ts'), 'export function gone() { return 0; }\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'initial']);

    git(root, ['checkout', '-q', '-b', 'feature']);
    fs.rmSync(path.join(root, 'src', 'gone.ts'));
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'delete gone.ts']);

    const index = new JambavanIndex(config);
    await index.index();

    const handlers = buildReviewPackHandlers(config, () => index);
    const result = handlers.jambavan_review_pack({ base: 'main' });

    // Deletion analysis removed for 1.0: deleted files stay visible via their D
    // status, but we no longer parse the base to name their removed symbols.
    assert.match(result, /D\tsrc\/gone\.ts/);
    assert.match(result, /_No indexed symbols/);
  } finally { cleanup(); }
});

test('jambavan_review_pack: shows caller list when a touched symbol is called by another', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'util.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
    fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'import { add } from "./util"; export function run() { return add(1, 2); }\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'initial']);

    git(root, ['checkout', '-q', '-b', 'feature']);
    // Modify add itself (the callee symbol)
    fs.writeFileSync(
      path.join(root, 'src', 'util.ts'),
      'export function add(a: number, b: number) { return Number(a) + Number(b); }\n',
    );
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'change add']);

    const index = new JambavanIndex(config);
    await index.index();

    const handlers = buildReviewPackHandlers(config, () => index);
    const result = handlers.jambavan_review_pack({ base: 'main' });

    // add is called by run in main.ts — Callers section should appear
    assert.match(result, /Callers:/);
  } finally { cleanup(); }
});

test('jambavan_impact: detects master and traces extracted inbound callers and tests', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    git(root, ['init', '-q', '-b', 'master']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'util.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
    fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'import { add } from "./util"; export function run() { return add(1, 2); }\n');
    fs.writeFileSync(path.join(root, 'test', 'util.test.ts'), 'import { add } from "../src/util"; test("add", () => add(1, 2));\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'initial']);
    git(root, ['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(root, 'src', 'util.ts'), 'export function add(a: number, b: number) { return Number(a) + Number(b); }\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'change add']);

    const index = new JambavanIndex(config);
    await index.index();
    const output = buildImpactHandlers(config, () => index).jambavan_impact({});

    assert.match(output, /Base: `master`/);
    assert.match(output, /changed symbols: 1/);
    assert.match(output, /run — src\/main\.ts/);
    assert.match(output, /test\/util\.test\.ts/);
  } finally { cleanup(); }
});

test('jambavan_impact: reports an invalid base without throwing', async () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const index = new JambavanIndex(config);
    const output = buildImpactHandlers(config, () => index)
      .jambavan_impact({ base: 'missing-ref' });
    assert.match(output, /Error: could not analyze changes against base "missing-ref"/);
    index.close();
  } finally { cleanup(); }
});

test('review-pack CLI rejects invalid and unknown options before indexing', () => {
  const cases: Array<[string[], RegExp]> = [
    [['review-pack', '--format', 'yaml'], /--format must be markdown or json/],
    [['review-pack', '--max-files', '0'], /--max-files must be a positive finite number/],
    [['review-pack', '--max-files', 'Infinity'], /--max-files must be a positive finite number/],
    [['review-pack', '--base'], /--base requires a value/],
    [['review-pack', '--unknown'], /Unknown review-pack option: --unknown/],
  ];

  for (const [args, error] of cases) {
    const result = runCli(args);
    assert.equal(result.status, 1, `${args.join(' ')} should fail`);
    assert.match(result.stderr, error);
  }
});

test('CLI help reflects supported hosts, tools, commands, and safety gates', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0);
  for (const expected of [
    'Claude Code, Cursor, Codex, Continue',
    'jambavan_impact',
    'jambavan review-pack',
    'jambavan handoff --write-pr-template',
    'JAMBAVAN_ALLOW_WRITE=1',
    'JAMBAVAN_ALLOW_BASH=1',
    'JAMBAVAN_ALLOW_SECRETS=1',
  ]) {
    assert.match(result.stdout, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(result.stdout, /npx jambavan bench/);
});
