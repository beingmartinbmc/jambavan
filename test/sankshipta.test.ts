import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { sankshiptaText } from '../src/tools/sankshipta';

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
