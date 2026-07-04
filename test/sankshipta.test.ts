import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { sankshiptaFile, sankshiptaText } from '../src/tools/sankshipta';
import { mkTempConfig } from '../test-support/config';

test('sankshipta: drops filler words and shortens phrases', () => {
  const out = sankshiptaText('Please make sure to utilize the helper.\n');
  assert.ok(out.length < 'Please make sure to utilize the helper.\n'.length);
  assert.match(out, /use/);
  assert.doesNotMatch(out, /Please/);
});

test('sankshipta: never touches text inside fenced code blocks', () => {
  const src = 'Please note this.\n```ts\nconst please = the && that;\n```\nplease do it\n';
  const out = sankshiptaText(src);
  assert.match(out, /const please = the && that;/); // code untouched verbatim
});

test('sankshipta: preserves inline code, paths, URLs, versions, CONSTANTS', () => {
  const src = 'Please use `keepMe()` at src/index.ts see https://x.io/y v1.2.3 and MAX_SIZE.\n';
  const out = sankshiptaText(src);
  for (const token of ['`keepMe()`', 'src/index.ts', 'https://x.io/y', 'v1.2.3', 'MAX_SIZE']) {
    assert.ok(out.includes(token), `expected preserved: ${token}`);
  }
});

test('sankshipta: collapses repeated punctuation but keeps ellipsis', () => {
  assert.match(sankshiptaText('Ship,, done!!\n'), /^Ship, done!/);
  assert.match(sankshiptaText('Wait for it ...\n'), /\.\.\./);
});

test('sankshipta: leaves YAML frontmatter block intact', () => {
  const src = '---\ntitle: "Please keep this"\n---\nPlease drop this word.\n';
  const out = sankshiptaText(src);
  assert.match(out, /title: "Please keep this"/); // frontmatter verbatim
  assert.doesNotMatch(out.split('---\n')[2] ?? '', /Please/); // body compressed
});

test('sankshipta: empty / whitespace-only input is returned unchanged', () => {
  assert.equal(sankshiptaText(''), '');
  assert.equal(sankshiptaText('   \n  '), '   \n  ');
});

test('sankshipta: is idempotent enough to not corrupt already-terse text', () => {
  const terse = 'use `f()` now\n';
  assert.equal(sankshiptaText(sankshiptaText(terse)), sankshiptaText(terse));
});

test('sankshiptaFile: preview mode returns compressed content without writing', () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    const file = path.join(root, 'notes.md');
    const raw = 'Please make sure to utilize the helper.\n';
    fs.writeFileSync(file, raw);
    const out = sankshiptaFile({ path: 'notes.md', in_place: false }, config);
    assert.match(out, /# Jambavan Sankshipta: notes\.md/);
    assert.match(out, /Tokens: \d+ → \d+/);
    assert.match(out, /use helper/);
    assert.equal(fs.readFileSync(file, 'utf-8'), raw);
  } finally { cleanup(); }
});

test('sankshiptaFile: in-place mode writes once and reuses backup', () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    const file = path.join(root, 'notes.md');
    const raw = 'Please make sure to utilize the helper.\n';
    fs.writeFileSync(file, raw);
    const first = sankshiptaFile({ path: 'notes.md' }, config);
    assert.match(first, /Backup: notes\.md\.original\.md/);
    assert.match(fs.readFileSync(file, 'utf-8'), /use helper/);
    assert.equal(fs.readFileSync(`${file}.original.md`, 'utf-8'), raw);
    const second = sankshiptaFile({ path: 'notes.md', backup: true }, config);
    assert.match(second, /already existed/);
  } finally { cleanup(); }
});

test('sankshiptaFile: backup can be skipped', () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    fs.writeFileSync(path.join(root, 'notes.md'), 'Please utilize it.\n');
    const out = sankshiptaFile({ path: 'notes.md', backup: false }, config);
    assert.match(out, /Backup: skipped/);
    assert.equal(fs.existsSync(path.join(root, 'notes.md.original.md')), false);
  } finally { cleanup(); }
});
