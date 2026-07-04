/**
 * Test-Symbol Association — discover which test files cover which symbols.
 *
 * Scans test files for imports and function-name mentions to build a
 * symbol→test map. Used by jambavan_context to surface relevant tests
 * alongside implementation code.
 *
 * Architecture:
 *   - Heuristic: file in test/ or __tests__/ or *.test.* or *.spec.*
 *   - Parse import paths → resolve to source files
 *   - Scan test body for symbol name mentions → associate
 */

import * as fs from 'fs';
import * as path from 'path';
import ignore from 'ignore';
import type { JambavanConfig } from '../config/jambavan.config';
import type { Symbol } from '../index/ast-parser';

export interface TestAssociation {
  testFile: string;
  symbolName: string;
  sourceFile: string;
  confidence: 'import' | 'mention';
}

const TEST_FILE_PATTERNS = [
  /[/\\]test[/\\]/,
  /[/\\]__tests__[/\\]/,
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /_test\.(go|py|rs)$/,
  /test_.*\.py$/,
];

export function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some(re => re.test(filePath));
}

/**
 * Given indexed symbols, build a map: symbolName → test files that reference it.
 *
 * Scans test files by reading their full content (not just parsed symbols),
 * because test files often have no exportable declarations and may not produce
 * indexable symbols. This ensures top-level imports and test() bodies are visible.
 */
export function buildTestMap(
  symbols: Symbol[],
  config: JambavanConfig,
): Map<string, TestAssociation[]> {
  const sourceSymbols = symbols.filter(s => !isTestFile(s.filePath));

  // Build a quick-lookup: source symbol name → source file(s)
  const sourceByName = new Map<string, string[]>();
  for (const s of sourceSymbols) {
    if (!sourceByName.has(s.name)) sourceByName.set(s.name, []);
    const rel = path.relative(config.projectRoot, s.filePath).replace(/\\/g, '/');
    if (!sourceByName.get(s.name)!.includes(rel)) {
      sourceByName.get(s.name)!.push(rel);
    }
  }

  if (sourceByName.size === 0) return new Map();

  // Collect test file paths from two sources:
  // 1. Indexed symbols (may produce entries for test files that have classes/functions)
  // 2. Filesystem scan (catches test files with no exportable symbols)
  const testFilePaths = new Set<string>();
  for (const s of symbols) {
    if (isTestFile(s.filePath)) testFilePaths.add(s.filePath);
  }

  // Filesystem discovery for test files the parser may have skipped
  try {
    const ig = ignore();
    const gitignorePath = path.join(config.projectRoot, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      ig.add(fs.readFileSync(gitignorePath, 'utf-8'));
    }
    ig.add(config.ignore);

    const entries = fs.readdirSync(config.projectRoot, { recursive: true, encoding: 'utf-8' });
    for (const entry of entries) {
      if (ig.ignores(entry)) continue;
      const abs = path.resolve(config.projectRoot, entry);
      if (isTestFile(abs)) testFilePaths.add(abs);
    }
  } catch {
    // readdirSync may fail (e.g., permissions); fall through with symbol-only set
  }

  const result = new Map<string, TestAssociation[]>();

  for (const testPath of testFilePaths) {
    const testRel = path.relative(config.projectRoot, testPath).replace(/\\/g, '/');

    // Read the full file content for import/mention scanning
    let content: string;
    try {
      content = fs.readFileSync(testPath, 'utf-8');
    } catch {
      continue; // file may have been deleted since indexing
    }

    // Extract import names (ES import { foo, bar } from ... and require destructure)
    const importNames = new Set<string>();
    const importRe = /import\s+\{([^}]+)\}/g;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(content)) !== null) {
      for (const name of m[1].split(',')) {
        const clean = name.trim().split(/\s+as\s+/)[0].trim();
        if (clean) importNames.add(clean);
      }
    }
    // Also catch default imports: import Foo from '...'
    const defaultImportRe = /import\s+([A-Z]\w+)\s+from/g;
    while ((m = defaultImportRe.exec(content)) !== null) {
      importNames.add(m[1]);
    }

    // Associate imported names with source symbols (high confidence)
    for (const name of importNames) {
      if (!sourceByName.has(name)) continue;
      if (!result.has(name)) result.set(name, []);
      for (const sourceFile of sourceByName.get(name)!) {
        const existing = result.get(name)!;
        if (!existing.some(a => a.testFile === testRel && a.sourceFile === sourceFile)) {
          existing.push({ testFile: testRel, symbolName: name, sourceFile, confidence: 'import' });
        }
      }
    }

    // Body mention scan: tokenize the entire file content
    const tokens = new Set(content.match(/[A-Za-z_]\w*/g) ?? []);
    for (const name of tokens) {
      if (name.length < 4) continue;
      if (importNames.has(name)) continue; // already handled with higher confidence
      if (!sourceByName.has(name)) continue;
      if (!result.has(name)) result.set(name, []);
      const existing = result.get(name)!;
      for (const sourceFile of sourceByName.get(name)!) {
        if (!existing.some(a => a.testFile === testRel && a.sourceFile === sourceFile)) {
          existing.push({ testFile: testRel, symbolName: name, sourceFile, confidence: 'mention' });
        }
      }
    }
  }

  return result;
}

/**
 * For a given symbol name, format test associations as a context note.
 */
export function formatTestAssociations(associations: TestAssociation[]): string {
  if (associations.length === 0) return '';

  const imports = associations.filter(a => a.confidence === 'import');
  const mentions = associations.filter(a => a.confidence === 'mention');

  const lines = ['**Tests:**'];
  for (const a of imports) {
    lines.push(`  ✓ ${a.testFile} (imports)`);
  }
  for (const a of mentions) {
    if (!imports.some(i => i.testFile === a.testFile)) {
      lines.push(`  ~ ${a.testFile} (mentions)`);
    }
  }
  return lines.join('\n');
}
