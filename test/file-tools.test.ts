import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { createReadFileTool } from '../src/tools/read-file';
import { createWriteFileTool, createPatchFileTool } from '../src/tools/write-file';
import { mkTempConfig } from '../test-support/config';

test('read_file: returns whole file', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    fs.writeFileSync(path.join(root, 'f.txt'), 'hello\nworld\n');
    const r = await createReadFileTool(config).handler({ path: 'f.txt' });
    assert.equal(r.success, true);
    assert.equal(r.output, 'hello\nworld\n');
  } finally { cleanup(); }
});

test('read_file: missing file returns structured error, does not throw', async () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const r = await createReadFileTool(config).handler({ path: 'nope.txt' });
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /File not found/);
  } finally { cleanup(); }
});

test('read_file: directory target is rejected', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    fs.mkdirSync(path.join(root, 'sub'));
    const r = await createReadFileTool(config).handler({ path: 'sub' });
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /Not a file/);
  } finally { cleanup(); }
});

test('read_file: line range is inclusive and clamps out-of-range bounds', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    fs.writeFileSync(path.join(root, 'lines.txt'), 'a\nb\nc\nd\ne\n');
    const tool = createReadFileTool(config);
    assert.equal((await tool.handler({ path: 'lines.txt', start_line: 2, end_line: 4 })).output, 'b\nc\nd');
    // Out-of-range clamps rather than throwing or returning garbage.
    assert.equal((await tool.handler({ path: 'lines.txt', start_line: -10, end_line: 999 })).output, 'a\nb\nc\nd\ne\n');
    // start only
    assert.equal((await tool.handler({ path: 'lines.txt', start_line: 4 })).output, 'd\ne\n');
  } finally { cleanup(); }
});

test('read_file: file over the default size cap is refused before reading into memory', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    // Default cap is 5 MiB; write just over it. Cap is enforced via statSync,
    // so the oversized content is never read into memory.
    fs.writeFileSync(path.join(root, 'big.txt'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
    const r = await createReadFileTool(config).handler({ path: 'big.txt' });
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /too large/);
  } finally { cleanup(); }
});

test('write_file: creates parent directories and reports char count', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    const r = await createWriteFileTool(config).handler({ path: 'deep/nested/f.txt', content: 'abc' });
    assert.equal(r.success, true);
    assert.match(r.output, /3 chars/);
    assert.equal(fs.readFileSync(path.join(root, 'deep/nested/f.txt'), 'utf-8'), 'abc');
  } finally { cleanup(); }
});

test('write_file: refuses to write a secret file by default', async () => {
  const { config, cleanup } = mkTempConfig();
  try {
    await assert.rejects(
      () => createWriteFileTool(config).handler({ path: '.env', content: 'SECRET=1' }),
      /secret file/,
    );
  } finally { cleanup(); }
});

test('patch_file: replaces a unique occurrence', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    fs.writeFileSync(path.join(root, 'code.ts'), 'const a = 1;\nconst b = 2;\n');
    const r = await createPatchFileTool(config).handler({ path: 'code.ts', old_text: 'const b = 2;', new_text: 'const b = 3;' });
    assert.equal(r.success, true);
    assert.equal(fs.readFileSync(path.join(root, 'code.ts'), 'utf-8'), 'const a = 1;\nconst b = 3;\n');
  } finally { cleanup(); }
});

test('patch_file: missing file errors without mutating anything', async () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const r = await createPatchFileTool(config).handler({ path: 'ghost.ts', old_text: 'x', new_text: 'y' });
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /File not found/);
  } finally { cleanup(); }
});

test('patch_file: absent old_text errors and leaves file unchanged', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    const p = path.join(root, 'code.ts');
    fs.writeFileSync(p, 'original\n');
    const r = await createPatchFileTool(config).handler({ path: 'code.ts', old_text: 'nope', new_text: 'y' });
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /not found/);
    assert.equal(fs.readFileSync(p, 'utf-8'), 'original\n');
  } finally { cleanup(); }
});

test('patch_file: ambiguous old_text is rejected (must be unique)', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    const p = path.join(root, 'code.ts');
    fs.writeFileSync(p, 'dup\ndup\n');
    const r = await createPatchFileTool(config).handler({ path: 'code.ts', old_text: 'dup', new_text: 'x' });
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /ambiguous — found 2 times/);
    assert.equal(fs.readFileSync(p, 'utf-8'), 'dup\ndup\n');
  } finally { cleanup(); }
});
