import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { mkTempConfig } from '../test-support/config';
import { JambavanIndex } from '../src/index/indexer';
import { buildReviewPackHandlers } from '../src/tools/review-pack';

function git(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root });
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

test('jambavan_review_pack: reports touched symbols, tests, and risk flags for an untested new function', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    initRepoWithBranchDiff(root);

    const index = new JambavanIndex(config);
    await index.index();

    const handlers = buildReviewPackHandlers(config, () => index);
    const result = handlers.jambavan_review_pack({ base: 'main' });

    assert.match(result, /Jambavan Review Pack/);
    assert.match(result, /src\/util\.ts/);
    assert.match(result, /\*\*add\*\*/, 'touched util.ts should list the add symbol');
    assert.match(result, /\*\*subtract\*\*/, 'touched util.ts should list the new subtract symbol');
    assert.match(result, /Tests:/, 'add is covered by a test import');
    assert.doesNotMatch(
      result,
      /no symbol in this file has a matching test/,
      'add IS covered by a test, so the file-level "no matching test" risk should not fire',
    );
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
    assert.match(result, /no symbol in this file has a matching test/);
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
