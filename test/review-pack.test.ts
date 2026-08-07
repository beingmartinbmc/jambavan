import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { mkTempConfig } from '../test-support/config';
import { JambavanIndex } from '../src/index/indexer';
import { MemoryStore } from '../src/memory/store';
import { projectScope } from '../src/tools/jambavan';
import { buildReviewPackHandlers, getChangedFiles } from '../src/tools/review-pack';
import { buildReviewPackJson } from '../src/tools/review-pack-json';
import { parseChangedRanges, parseDiffRanges, parseNameStatus, changedSymbols, deletedSymbols } from '../src/tools/changed-symbols';
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

test('deletedSymbols: replacement hunk detects a removed function but not a surviving neighbour', () => {
  const ranges = parseDiffRanges(
    'diff --git a/s.ts b/s.ts\n--- a/s.ts\n+++ b/s.ts\n@@ -1,7 +1,3 @@\n',
  );
  const removed: Symbol = { name: 'removed', type: 'function', startLine: 1, endLine: 3, content: '', filePath: 's.ts' };
  const kept: Symbol = { name: 'kept', type: 'function', startLine: 5, endLine: 7, content: '', filePath: 's.ts' };
  const currentKept: Symbol = { ...kept, startLine: 1, endLine: 3 };

  assert.deepEqual(
    deletedSymbols([removed, kept], ranges.get('s.ts') ?? [], [currentKept]).map(symbol => symbol.name),
    ['removed'],
  );
});

test('deletedSymbols: modified functions are not classified as deleted', () => {
  const ranges = parseDiffRanges(
    'diff --git a/s.ts b/s.ts\n--- a/s.ts\n+++ b/s.ts\n@@ -1,3 +1,3 @@\n',
  );
  const before: Symbol = { name: 'changed', type: 'function', startLine: 1, endLine: 3, content: '', filePath: 's.ts' };
  const after: Symbol = { ...before, content: 'changed body' };

  assert.deepEqual(deletedSymbols([before], ranges.get('s.ts') ?? [], [after]), []);
});

test('deletedSymbols: a renamed declaration retains the old symbol as deleted', () => {
  const before: Symbol = { name: 'oldName', type: 'function', startLine: 1, endLine: 3, content: '', filePath: 's.ts' };
  const after: Symbol = { ...before, name: 'newName' };

  assert.deepEqual(
    deletedSymbols([before], [{ oldStart: 1, oldCount: 1 }], [after]).map(symbol => symbol.name),
    ['oldName'],
  );
});

test('deletedSymbols: renames are detected per hunk and for nested methods', () => {
  const oldName: Symbol = { name: 'oldName', type: 'function', startLine: 1, endLine: 3, content: '', filePath: 's.ts' };
  const edited: Symbol = { name: 'edited', type: 'function', startLine: 6, endLine: 8, content: '', filePath: 's.ts' };
  const klass: Symbol = { name: 'Service', type: 'class', startLine: 11, endLine: 17, content: '', filePath: 's.ts' };
  const oldMethod: Symbol = { name: 'oldMethod', type: 'function', startLine: 12, endLine: 16, content: '', filePath: 's.ts' };
  const current = [
    { ...oldName, name: 'newName' },
    { ...edited, content: 'edited body' },
    { ...klass },
    { ...oldMethod, name: 'newMethod' },
  ];

  assert.deepEqual(
    deletedSymbols([oldName, edited, klass, oldMethod], [
      { oldStart: 1, oldCount: 1 },
      { oldStart: 7, oldCount: 1 },
      { oldStart: 12, oldCount: 1 },
    ], current).map(symbol => symbol.name),
    ['oldName', 'oldMethod'],
  );
});

test('deletedSymbols: duplicate symbol names still report a removed occurrence', () => {
  const first: Symbol = { name: 'run', type: 'function', startLine: 1, endLine: 3, content: '', filePath: 's.ts' };
  const second: Symbol = { ...first, startLine: 5, endLine: 7 };
  const surviving: Symbol = { ...second };
  assert.deepEqual(
    deletedSymbols([first, second], [{ oldStart: 1, oldCount: 3 }], [surviving]).map(item => item.startLine),
    [1],
  );
});

test('deletedSymbols: duplicate names attribute deletion to the unmatched occurrence', () => {
  const changed: Symbol = { name: 'run', type: 'function', startLine: 1, endLine: 3, content: 'old first', filePath: 's.ts' };
  const removed: Symbol = { ...changed, startLine: 5, endLine: 7, content: 'old second' };
  const current: Symbol = { ...changed, content: 'new first' };

  assert.deepEqual(
    deletedSymbols([changed, removed], [
      { oldStart: 1, oldCount: 3 },
      { oldStart: 5, oldCount: 3 },
    ], [current]).map(symbol => symbol.startLine),
    [5],
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
    assert.match(result, /1 changed\/deleted symbol\(s\) have no matching test association\/reference/);
  } finally { cleanup(); }
});

test('impact and review analysis recover a fully deleted function, its caller, and JSON state from base', async () => {
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

    fs.writeFileSync(
      path.join(root, 'src', 'caller.ts'),
      'import { removed } from "./m";\nexport function caller() { return removed(); }\nexport function currentOnly() { return true; }\n',
    );
    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'test', 'm.test.ts'),
      'import { removed } from "../src/m";\ntest("removed", () => removed());\n',
    );
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'add caller and test association']);

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
    const pack = buildReviewPackJson(config, index, 'main');
    const impact = buildImpactHandlers(config, () => index).jambavan_impact({ base: 'main' });

    assert.match(result, /src\/m\.ts/, 'the touched file is listed');
    assert.match(result, /\*\*removed\*\* \(function, deleted/);
    assert.match(result, /Callers:.*caller/);
    assert.doesNotMatch(result, /Callers:.*currentOnly/, 'unrelated current symbols must not be attributed as callers');
    assert.match(result, /Test associations\/references:/);
    assert.doesNotMatch(result, /\*\*kept\*\*/, 'untouched survivor must not be flagged as changed');
    const removed = pack.files.find(file => file.path === 'src/m.ts')?.symbols.find(symbol => symbol.name === 'removed');
    assert.deepEqual(removed, {
      name: 'removed',
      type: 'function',
      startLine: 1,
      deleted: true,
      callers: ['caller'],
      testAssociations: ['test/m.test.ts'],
      tests: ['test/m.test.ts'],
    });
    assert.match(impact, /removed — src\/m\.ts:1/);
    assert.match(impact, /caller — src\/caller\.ts/);
    assert.match(impact, /Test associations\/references/);
    assert.match(impact, /test\/m\.test\.ts/);
  } finally { cleanup(); }
});

test('impact and review analysis retain old callers when a declaration is renamed', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'm.ts'), 'export function oldName() {\n  return 1;\n}\n');
    fs.writeFileSync(
      path.join(root, 'src', 'caller.ts'),
      'import { oldName } from "./m";\nexport function caller() { return oldName(); }\n',
    );
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'initial']);

    git(root, ['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(root, 'src', 'm.ts'), 'export function newName() {\n  return 1;\n}\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'rename declaration']);

    const index = new JambavanIndex(config);
    await index.index();

    const review = buildReviewPackHandlers(config, () => index).jambavan_review_pack({ base: 'main' });
    const impact = buildImpactHandlers(config, () => index).jambavan_impact({ base: 'main' });

    assert.match(review, /\*\*oldName\*\* \(function, deleted/);
    assert.match(review, /Callers:.*caller/);
    assert.match(impact, /oldName/);
    assert.match(impact, /caller/);
  } finally { cleanup(); }
});

test('deleted-symbol analysis retains base callers and tests removed in the same diff', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'm.ts'), 'export function removed() { return 1; }\n');
    fs.writeFileSync(path.join(root, 'src', 'caller.ts'), 'import { removed } from "./m";\nexport function caller() { return removed(); }\n');
    fs.writeFileSync(path.join(root, 'test', 'm.test.ts'), 'import { removed } from "../src/m";\ntest("removed", () => removed());\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'base']);
    git(root, ['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(root, 'src', 'm.ts'), 'export const kept = true;\n');
    fs.writeFileSync(path.join(root, 'src', 'caller.ts'), 'export function caller() { return 0; }\n');
    fs.writeFileSync(path.join(root, 'test', 'm.test.ts'), 'test("kept", () => {});\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'remove symbol and references']);

    const index = new JambavanIndex(config);
    await index.index();
    const pack = buildReviewPackJson(config, index, 'main');
    const removed = pack.files.find(file => file.path === 'src/m.ts')?.symbols.find(item => item.name === 'removed');

    assert.deepEqual(removed?.callers, ['caller']);
    assert.deepEqual(removed?.testAssociations, ['test/m.test.ts']);
    index.close();
  } finally { cleanup(); }
});

test('review JSON keeps a deleted symbol test caller when caller labels collide', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'm.ts'), 'export function removed() { return 1; }\n');
    fs.writeFileSync(path.join(root, 'src', 'prod.ts'), 'import { removed } from "./m";\nexport function sameName() { return removed(); }\n');
    fs.writeFileSync(path.join(root, 'test', 'handler.test.ts'), 'import { removed } from "../src/m";\nexport function sameName() { return removed(); }\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'base']);
    git(root, ['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(root, 'src', 'm.ts'), 'export const kept = true;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'delete removed']);

    const index = new JambavanIndex(config);
    await index.index();
    const pack = buildReviewPackJson(config, index, 'main');
    const removed = pack.files.find(file => file.path === 'src/m.ts')?.symbols.find(item => item.name === 'removed');

    assert.deepEqual(removed?.callers, ['sameName', 'sameName']);
    assert.deepEqual(removed?.testAssociations, ['test/handler.test.ts']);
    index.close();
  } finally { cleanup(); }
});

test('review JSON detects deleted-symbol tests beyond the displayed caller limit', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'm.ts'), 'export function removed() { return 1; }\n');
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(root, 'src', `caller-${i}.ts`), `import { removed } from "./m";\nexport function caller${i}() { return removed(); }\n`);
    }
    fs.writeFileSync(path.join(root, 'test', 'm.test.ts'), 'import { removed } from "../src/m";\ntest("removed", () => removed());\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'base']);
    git(root, ['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(root, 'src', 'm.ts'), 'export const kept = true;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'delete removed']);

    const index = new JambavanIndex(config);
    await index.index();
    const pack = buildReviewPackJson(config, index, 'main');
    const file = pack.files.find(item => item.path === 'src/m.ts');
    const removed = file?.symbols.find(item => item.name === 'removed');

    assert.equal(removed?.callers.length, 8);
    assert.deepEqual(removed?.testAssociations, ['test/m.test.ts']);
    assert.deepEqual(file?.risks, ['1 changed/deleted symbol(s) have no matching test association/reference']);
    index.close();
  } finally { cleanup(); }
});

test('markdown review does not flag a graph-discovered deleted-symbol test as missing', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'm.ts'), 'export function removed() { return 1; }\n');
    fs.writeFileSync(path.join(root, 'src', 'barrel.ts'), 'export { removed as alias } from "./m";\n');
    fs.writeFileSync(path.join(root, 'test', 'alias.test.ts'), 'import { alias } from "../src/barrel";\nexport function testCaller() { return alias(); }\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'base']);
    git(root, ['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(root, 'src', 'm.ts'), 'export const kept = true;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'delete removed']);

    const index = new JambavanIndex(config);
    await index.index();
    const review = buildReviewPackHandlers(config, () => index).jambavan_review_pack({ base: 'main' });

    assert.match(review, /Test associations\/references:.*test\/alias\.test\.ts/s);
    assert.match(review, /1 changed\/deleted symbol\(s\) have no matching test association\/reference/);
    assert.doesNotMatch(review, /2 changed\/deleted symbol\(s\) have no matching test association\/reference/);
    index.close();
  } finally { cleanup(); }
});

test('committed-only review ignores a dirty worktree restoration', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(root, 'm.ts'), 'export function removed() { return 1; }\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'base']);
    git(root, ['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(root, 'm.ts'), 'export const kept = true;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'delete removed']);
    fs.writeFileSync(path.join(root, 'm.ts'), 'export function removed() { return 1; }\nexport const kept = true;\n');

    const index = new JambavanIndex(config);
    await index.index();
    const pack = buildReviewPackJson(config, index, 'main', 30, false);
    const removed = pack.files.find(file => file.path === 'm.ts')?.symbols.find(item => item.name === 'removed');

    assert.equal(removed?.deleted, true);
    index.close();
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
    assert.match(result, /1 changed\/deleted symbol\(s\) have no matching test association\/reference/);
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

test('jambavan_review_pack: include_worktree diffs from the merge-base, not the base tip', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'initial']);

    // Branch off, then let main advance with a file that exists ONLY on main.
    git(root, ['checkout', '-q', '-b', 'feature']);
    git(root, ['checkout', '-q', 'main']);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'base-only.ts'), 'export const x = 1;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'main-only file']);
    git(root, ['checkout', '-q', 'feature']);

    // A plain `git diff main` (base tip → worktree) would report src/base-only.ts
    // as DELETED on the feature branch. Diffing from the merge-base must not.
    const index = new JambavanIndex(config);
    await index.index();
    const result = buildReviewPackHandlers(config, () => index)
      .jambavan_review_pack({ base: 'main', include_worktree: true });

    assert.doesNotMatch(result, /base-only\.ts/, 'a base-only file must not be reported as changed on the feature branch');
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

test('review diff rejects git-option-shaped base refs without writing files', () => {
  const { root, cleanup } = mkTempConfig();
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'initial']);

    assert.throws(() => getChangedFiles(root, '--output=sink', false));
    assert.equal(fs.existsSync(path.join(root, 'sink...HEAD')), false);
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
    assert.ok(!pack.files.some(f => f.risks.some(r => r.includes('have no matching test association'))));
  } finally { cleanup(); }
});

test('impact and review analysis recover symbols and inbound callers for a deleted file', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'gone.ts'), 'export function gone() { return 0; }\n');
    fs.writeFileSync(path.join(root, 'src', 'caller.ts'), 'import { gone } from "./gone"; export function callGone() { return gone(); }\nexport function currentOnly() { return true; }\n');
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
    const pack = buildReviewPackJson(config, index, 'main');
    const impact = buildImpactHandlers(config, () => index).jambavan_impact({ base: 'main' });

    assert.match(result, /D\tsrc\/gone\.ts/);
    assert.match(result, /\*\*gone\*\* \(function, deleted/);
    assert.match(result, /Callers:.*callGone/);
    assert.doesNotMatch(result, /Callers:.*currentOnly/, 'unrelated current symbols must not be attributed as callers');
    const gone = pack.files.find(file => file.path === 'src/gone.ts')?.symbols.find(symbol => symbol.name === 'gone');
    assert.equal(gone?.deleted, true);
    assert.deepEqual(gone?.callers, ['callGone']);
    assert.match(impact, /gone — src\/gone\.ts:1/);
    assert.match(impact, /callGone — src\/caller\.ts/);
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

test('memory migrate CLI is dry-run by default and applies only with --apply', () => {
  const { config, root, cleanup } = mkTempConfig();
  const globalDir = path.join(root, 'global-memory');
  try {
    new MemoryStore(config.memoryDir).store({ title: 'Legacy CLI fact', body: 'copy me', scope: 'general' });
    const env = { ...process.env, JAMBAVAN_MEMORY_HOME: globalDir };
    const dry = spawnSync(process.execPath, [
      '--require', 'ts-node/register/transpile-only', 'src/index.ts', 'memory', 'migrate', '--root', root,
    ], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', env });
    assert.equal(dry.status, 0);
    assert.match(dry.stdout, /dry run/);
    assert.equal(fs.existsSync(globalDir), false);

    const apply = spawnSync(process.execPath, [
      '--require', 'ts-node/register/transpile-only', 'src/index.ts', 'memory', 'migrate', '--root', root, '--apply',
    ], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', env });
    assert.equal(apply.status, 0);
    assert.match(apply.stdout, /migration applied/);
    assert.equal(new MemoryStore(globalDir).list(undefined, { includeInvalidated: true }).length, 1);
  } finally {
    cleanup();
  }
});

test('CLI rejects the removed daemon command with a migration message instead of starting the server', () => {
  const result = runCli(['daemon', 'status']);
  assert.equal(result.status, 2, 'daemon must be rejected, not silently start the MCP server');
  assert.match(result.stderr, /background daemon was removed in 1\.0/);
  assert.match(result.stderr, /jambavan_watch/);
  assert.doesNotMatch(result.stderr, /MCP server ready/);
});

test('CLI rejects an unknown command instead of starting the server', () => {
  const result = runCli(['frobnicate']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown command: frobnicate/);
});

test('CLI async commands (review-pack, html-handoff) do not start the MCP server', () => {
  // These commands own their own lifecycle; falling through to startServer()
  // was the P1 bug. Run them in an isolated temp root so they cannot index the
  // repo or write artifacts into the working tree, then assert no MCP boot.
  const { config, cleanup } = mkTempConfig();
  try {
    for (const cmd of ['review-pack', 'html-handoff']) {
      const result = spawnSync(process.execPath, [
        '--require', 'ts-node/register/transpile-only', 'src/index.ts', cmd,
      ], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf-8',
        env: { ...process.env, JAMBAVAN_ROOT: config.projectRoot },
      });
      assert.doesNotMatch(
        result.stderr,
        /MCP server ready/,
        `"${cmd}" must not start the MCP server`,
      );
    }
  } finally { cleanup(); }
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
