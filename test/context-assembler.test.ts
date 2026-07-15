/**
 * Focused unit tests for the context assembler (budget packing, prose
 * compression, truncation) and the diff-enricher (git log parsing + formatting).
 * These paths run only inside jambavan_context in production, so exercise them
 * directly here.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ContextAssembler, type ContextChunk } from '../src/context/assembler';
import {
  getRecentFileChanges,
  getRecentSymbolChanges,
  formatRecentChanges,
} from '../src/context/diff-enricher';
import { mkTempConfig } from '../test-support/config';

function chunk(over: Partial<ContextChunk> = {}): ContextChunk {
  return {
    filePath: 'src/a.ts',
    content: 'export function a() { return 1; }',
    score: 1,
    type: 'function',
    ...over,
  };
}

test('assemble: empty chunk list returns an empty block', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const out = new ContextAssembler(config).assemble([]);
    assert.deepEqual(out, { contextBlock: '', usedTokens: 0, includedChunks: 0, droppedChunks: 0 });
  } finally { cleanup(); }
});

test('assemble: packs high-score chunks first and formats headers with line ranges', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    config.contextTokenBudget = 8000;
    const out = new ContextAssembler(config).assemble([
      chunk({ content: 'low', score: 0.1, startLine: 5, endLine: 9 }),
      chunk({ content: 'high', score: 0.9, filePath: 'src/b.ts' }),
    ]);
    assert.equal(out.includedChunks, 2);
    assert.ok(out.contextBlock.indexOf('src/b.ts') < out.contextBlock.indexOf('src/a.ts:5-9'),
      'higher score is emitted first');
    assert.match(out.contextBlock, /### src\/a\.ts:5-9 \[function\]/);
  } finally { cleanup(); }
});

test('assemble: a chunk that overflows the tiny budget is dropped', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    config.contextTokenBudget = 5; // smaller than any real chunk+header
    const out = new ContextAssembler(config).assemble([chunk({ content: 'a'.repeat(400) })]);
    assert.equal(out.includedChunks, 0);
    assert.equal(out.droppedChunks, 1);
  } finally { cleanup(); }
});

test('assemble: compressProse compresses comment lines but keeps code verbatim', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    config.contextTokenBudget = 8000;
    const code = [
      '// In order to make sure that the reader is able to fully understand this',
      'export function keep() {',
      '  return 42;',
      '}',
    ].join('\n');
    const out = new ContextAssembler(config).assemble([chunk({ content: code })], { compressProse: true });
    assert.match(out.contextBlock, /export function keep\(\)/, 'code line preserved');
    assert.match(out.contextBlock, /return 42;/, 'code body preserved');
  } finally { cleanup(); }
});

// ── diff-enricher ────────────────────────────────────────────────────────────

function gitRepo(): { root: string; cleanup: () => void } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jambavan-diff-')));
  const git = (args: string[]) => execFileSync('git', args, { cwd: root });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'diff@example.com']);
  git(['config', 'user.name', 'Diff']);
  fs.writeFileSync(path.join(root, 'f.ts'), 'export const a = 1;\nexport const b = 2;\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'add a and b']);
  fs.writeFileSync(path.join(root, 'f.ts'), 'export const a = 10;\nexport const b = 2;\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'change a']);
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('getRecentFileChanges: returns parsed commits for a tracked file', () => {
  const { root, cleanup } = gitRepo();
  try {
    const { config } = mkTempConfig();
    config.projectRoot = root;
    const changes = getRecentFileChanges(config, 'f.ts', 5);
    assert.ok(changes.length >= 1, 'at least one commit');
    assert.match(changes[0].message, /change a|add a and b/);
    assert.match(changes[0].date, /^\d{4}-\d{2}-\d{2}$/);
    const formatted = formatRecentChanges(changes, 'a');
    assert.match(formatted, /Recent changes to `a`/);
  } finally { cleanup(); }
});

test('getRecentSymbolChanges: line-range log returns commits touching the line', () => {
  const { root, cleanup } = gitRepo();
  try {
    const { config } = mkTempConfig();
    config.projectRoot = root;
    const changes = getRecentSymbolChanges(config, 'f.ts', 1, 1, 5);
    assert.ok(changes.length >= 1);
    assert.match(changes[0].message, /change a|add a and b/);
  } finally { cleanup(); }
});

test('diff-enricher: untracked file and empty changes degrade gracefully', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    assert.deepEqual(getRecentFileChanges(config, 'nope.ts', 3), []);
    assert.deepEqual(getRecentSymbolChanges(config, 'nope.ts', 1, 2, 3), []);
    assert.equal(formatRecentChanges([]), '');
  } finally { cleanup(); }
});
