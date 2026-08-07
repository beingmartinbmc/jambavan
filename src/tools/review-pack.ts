/**
 * jambavan_review_pack — assemble a code review pack for the current branch.
 *
 * Pure composition of existing primitives: git diff for touched files, the
 * indexer for touched symbols, the knowledge graph for callers, the test map
 * for test associations, harvestRin for open debt, and the memory store for past
 * failures mentioning the same files. No new subsystem.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { JambavanConfig } from '../config/jambavan.config';
import type { JambavanIndex, ReExportRow } from '../index/indexer';
import { ASTParser, type Symbol } from '../index/ast-parser';
import { buildSymbolGraph, type GraphNode } from '../knowledge/graph';
import { buildTestMap, formatTestAssociations, isTestFile, testAssociationsFor } from '../index/test-map';
import { harvestRin } from './vibhishana-niti';
import { MemoryArchive } from '../memory/archive';
import { projectScope } from './jambavan';
import { changedSymbols, deletedSymbols, parseChangedRanges, parseDiffRanges, parseNameStatus, type ChangedFile, type DiffRange } from './changed-symbols';
import { MAX_READ_BYTES } from './read-file';

const DEFAULT_MAX_FILES = 20;
const BASE_CANDIDATES = ['main', 'master', 'origin/main', 'origin/master'];

// stdio must be explicit: execFileSync's default inherits the child's stderr
// straight to the real terminal (in addition to buffering it into err.stderr),
// so an invalid/probed ref (e.g. detectBaseBranch's candidate scan) would print
// "fatal: ..." noise even though the caller already formats a clean error.
function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function detectBaseBranch(root: string): string {
  for (const candidate of BASE_CANDIDATES) {
    try {
      git(root, ['rev-parse', '--verify', '--quiet', candidate]);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return 'main'; // no candidate resolved; surface the real git error at diff time
}

export function resolveBaseCommit(root: string, base: string): string {
  const commit = git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${base}^{commit}`]).trim();
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new Error(`invalid base ref: ${base}`);
  return commit;
}

export function getChangedFiles(root: string, base: string, includeWorktree = false): ChangedFile[] {
  // Both modes diff from the merge-base so a file that only exists on the base
  // branch is never reported as changed here.
  //   committed-only: `base...HEAD` (three-dot) already means merge-base→HEAD.
  //   include_worktree: resolve the merge-base commit explicitly and diff it
  //     against the working tree (`git diff <merge-base>`), giving committed and
  //     uncommitted ranges one shared coordinate system. Plain `git diff <base>`
  //     would compare the base branch's *tip* to the working tree and mis-report
  //     base-only files as deletions.
  const baseCommit = resolveBaseCommit(root, base);
  let range: string[];
  if (includeWorktree) {
    const mergeBase = git(root, ['merge-base', baseCommit, 'HEAD']).trim();
    range = [mergeBase];
  } else {
    range = [`${baseCommit}...HEAD`];
  }
  const touched = parseNameStatus(git(root, ['diff', '--find-renames', '--name-status', ...range]));
  const ranges = parseChangedRanges(git(root, ['diff', '--find-renames', '--unified=0', ...range]));
  const byPath = new Map(touched.map(file => [file.path, file]));

  if (includeWorktree) {
    for (const file of git(root, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)) {
      let lineCount = 0;
      try {
        const absolute = path.join(root, file);
        if (fs.statSync(absolute).size <= MAX_READ_BYTES) {
          lineCount = fs.readFileSync(absolute, 'utf-8').split('\n').length;
        }
      } catch {
        // Keep the touched-file entry; unreadable/binary files simply have no
        // source line ranges to intersect with indexed symbols.
      }
      byPath.set(file, {
        status: '??',
        path: file,
        ranges: lineCount > 0 ? [{ start: 1, end: lineCount }] : [],
      });
    }
  }

  return [...byPath.values()].map(file => ({
    ...file,
    ranges: ranges.get(file.path) ?? file.ranges,
  }));
}

export interface BaseAnalysis {
  symbolsByPath: Map<string, Symbol[]>;
  currentSymbolsByPath: Map<string, Symbol[]>;
  contentsByPath: Map<string, string>;
  reExports: ReExportRow[];
  currentReExports: ReExportRow[];
  diffRanges: Map<string, DiffRange[]>;
  warnings: string[];
}

export function getBaseAnalysis(root: string, base: string, files: ChangedFile[], includeWorktree = false): BaseAnalysis {
  const baseCommit = resolveBaseCommit(root, base);
  const mergeBase = git(root, ['merge-base', baseCommit, 'HEAD']).trim();
  const diffPaths = [...new Set(files.flatMap(file => [file.path, file.oldPath].filter((value): value is string => Boolean(value))))];
  const diff = git(root, [
    'diff', '--find-renames', '--unified=0', mergeBase,
    ...(!includeWorktree ? ['HEAD'] : []),
    ...(diffPaths.length ? ['--', ...diffPaths] : []),
  ]);
  const parser = new ASTParser();
  const symbolsByPath = new Map<string, Symbol[]>();
  const currentSymbolsByPath = new Map<string, Symbol[]>();
  const contentsByPath = new Map<string, string>();
  const reExports: ReExportRow[] = [];
  const currentReExports: ReExportRow[] = [];
  const warnings: string[] = [];

  for (const file of files) {
    const oldPath = file.oldPath ?? file.path;
    if (!ASTParser.canParse(oldPath)) {
      warnings.push(`Base symbol analysis unavailable for unsupported path: ${oldPath}`);
      continue;
    }
    try {
      const source = git(root, ['show', `${mergeBase}:${oldPath}`]);
      const absoluteOldPath = path.join(root, oldPath);
      contentsByPath.set(absoluteOldPath, source);
      const parsed = parser.parseSource(source, absoluteOldPath);
      symbolsByPath.set(oldPath, parsed.symbols);
      reExports.push(...parsed.reExports.map(reExport => ({ filePath: path.join(root, oldPath), ...reExport })));
    } catch {
      if (!file.status.startsWith('A') && file.status !== '??') {
        warnings.push(`Base symbol analysis failed for: ${oldPath}`);
      }
    }
    if (!includeWorktree && !file.status.startsWith('D')) {
      try {
        const parsed = parser.parseSource(git(root, ['show', `HEAD:${file.path}`]), path.join(root, file.path));
        currentSymbolsByPath.set(file.path, parsed.symbols);
        currentReExports.push(...parsed.reExports.map(reExport => ({ filePath: path.join(root, file.path), ...reExport })));
      } catch {
        warnings.push(`HEAD-side symbol analysis failed for: ${file.path}`);
      }
    }
  }

  return { symbolsByPath, currentSymbolsByPath, contentsByPath, reExports, currentReExports, diffRanges: parseDiffRanges(diff), warnings };
}

export const REVIEW_PACK_TOOL_DEFS = [
  {
    name: 'jambavan_review_pack',
    description: [
      'Assemble a review pack for the current branch vs a base branch: touched files, the symbols',
      'changed or deleted in them, their callers (via the knowledge graph), related test associations/references,',
      'past failure records mentioning the same files, and risk flags (open rin debt, no matching test association). Call before',
      'opening/updating a PR, or whenever asked "what changed" / "review this branch". Requires',
      'jambavan_index to have been run at least once for symbol/caller/test/risk analysis.',
    ].join(' '),
    inputSchema: {
      type: 'object' as const,
      properties: {
        base: {
          type: 'string',
          description: 'Base ref to diff against (three-dot diff from merge-base to HEAD). Auto-detects main/master/origin variants if omitted.',
        },
        max_files: {
          type: 'number',
          description: `Max touched files to analyze in depth (default: ${DEFAULT_MAX_FILES}).`,
        },
        include_worktree: {
          type: 'boolean',
          description: 'Also include staged, unstaged, and untracked working-tree changes (default: false).',
        },
      },
      required: [],
    },
  },
] as const;

export function buildReviewPackHandlers(config: JambavanConfig, getIndex: () => JambavanIndex | undefined) {
  return {
    jambavan_review_pack(input: Record<string, unknown>): string {
      const root = config.projectRoot;
      const base = typeof input['base'] === 'string' && input['base'] ? input['base'] : detectBaseBranch(root);
      const maxFiles = typeof input['max_files'] === 'number' && input['max_files'] > 0 ? input['max_files'] : DEFAULT_MAX_FILES;
      const includeWorktree = input['include_worktree'] === true;

      let touched: ChangedFile[];
      try {
        touched = getChangedFiles(root, base, includeWorktree);
      } catch (err) {
        const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
        return `Error: could not diff against base "${base}" (${msg}). Pass an explicit \`base\` ref, or ensure this is a git repo with that ref available.`;
      }

      if (touched.length === 0) {
        return `# Jambavan Review Pack\n\nNo changes vs \`${base}\` — branch is up to date or already merged.`;
      }

      const sections: string[] = [
        '# Jambavan Review Pack',
        `**Base:** ${base}  ·  **Touched files:** ${touched.length}${touched.length > maxFiles ? ` (analyzing first ${maxFiles})` : ''}`,
        '',
      ];

      const index = getIndex();
      if (!index) {
        sections.push(`Touched files:`, ...touched.map(f => `- ${f.status}\t${f.path}`));
        sections.push('', 'Index not built yet — call jambavan_index first for symbol/caller/test/risk analysis.');
        return sections.join('\n');
      }

      const analyzed = touched.slice(0, maxFiles);
      const allSymbols = index.getAllSymbols(100_000);
      let baseAnalysis: BaseAnalysis;
      try {
        baseAnalysis = getBaseAnalysis(root, base, analyzed, includeWorktree);
      } catch (err) {
        const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
        sections.push(`Warning: base-side symbol analysis failed (${message}); deleted symbols and callers may be omitted.`);
        return sections.join('\n');
      }
      const deletedByPath = new Map(analyzed.map(file => {
        const oldPath = file.oldPath ?? file.path;
        const currentSymbols = includeWorktree
          ? index.getFileSymbols(path.join(root, file.path))
          : baseAnalysis.currentSymbolsByPath.get(file.path) ?? [];
        return [file.path, deletedSymbols(
          baseAnalysis.symbolsByPath.get(oldPath) ?? [],
          baseAnalysis.diffRanges.get(oldPath) ?? [],
          currentSymbols,
        )];
      }));
      const deleted = [...deletedByPath.values()].flat();
      const touchedPaths = new Set(analyzed.map(file => path.join(root, file.path)));
      const currentSymbols = [
        ...allSymbols.filter(symbol => !touchedPaths.has(symbol.filePath)),
        ...analyzed.flatMap(file => includeWorktree
          ? index.getFileSymbols(path.join(root, file.path))
          : baseAnalysis.currentSymbolsByPath.get(file.path) ?? []),
      ];
      const baseSymbols = [
        ...allSymbols.filter(symbol => !touchedPaths.has(symbol.filePath)),
        ...[...baseAnalysis.symbolsByPath.values()].flat(),
      ];
      const indexedReExports = index.getAllReExports().filter(reExport => !touchedPaths.has(reExport.filePath));
      const currentGraph = buildSymbolGraph(currentSymbols, config, [
        ...indexedReExports,
        ...(includeWorktree ? index.getAllReExports().filter(reExport => touchedPaths.has(reExport.filePath)) : baseAnalysis.currentReExports),
      ]);
      const baseGraph = buildSymbolGraph(baseSymbols, config, [...indexedReExports, ...baseAnalysis.reExports]);
      const currentTestMap = buildTestMap(currentSymbols, config);
      const baseTestMap = buildTestMap(baseSymbols, config, baseAnalysis.contentsByPath);
      const { markers: rinMarkers } = harvestRin(config);
      const rinByFile = new Set(rinMarkers.map(m => m.file.replace(/^\.\//, '')));

      const failures = new MemoryArchive(config).list(projectScope(config))
        .filter(d => d.frontmatter.type === 'FailureRecord');

      const currentNodeById = new Map(currentGraph.nodes.map(n => [n.id, n]));
      const baseNodeById = new Map(baseGraph.nodes.map(n => [n.id, n]));
      const symbolNodeKey = (n: GraphNode) => `${n.filePath}\0${n.label}\0${n.line}`;
      const symbolNodeByKey = new Map<string, GraphNode>();
      for (const n of [...currentGraph.nodes, ...baseGraph.nodes]) {
        if (n.type === 'symbol') symbolNodeByKey.set(symbolNodeKey(n), n);
      }

      for (const file of analyzed) {
        const absPath = path.join(root, file.path);
        const isTest = isTestFile(absPath);
        const headSymbols = includeWorktree
          ? index.getFileSymbols(absPath)
          : baseAnalysis.currentSymbolsByPath.get(file.path) ?? [];
        const fileSymbols = [
          ...changedSymbols(headSymbols, file.ranges),
          ...(deletedByPath.get(file.path) ?? []),
        ];
        const testedSymbols = new Set<Symbol>();

        sections.push(`## ${file.status}\t${file.path}`);

        if (fileSymbols.length === 0) {
          sections.push('_No changed or deleted parsed symbols found (analysis may be incomplete for unparsed or non-code files)._');
        } else {
          for (const sym of fileSymbols) {
            const symbolPath = path.relative(root, sym.filePath).replace(/\\/g, '/');
            const node = symbolNodeByKey.get(`${symbolPath}\0${sym.name}\0${sym.startLine}`);
            const isDeleted = (deletedByPath.get(file.path) ?? []).includes(sym);
            const graph = isDeleted ? baseGraph : currentGraph;
            const nodeById = isDeleted ? baseNodeById : currentNodeById;
            const callers = node
              ? graph.edges
                  .filter(e => e.to === node.id && e.type !== 'contains' && e.confidence === 'EXTRACTED')
                  .map(e => nodeById.get(e.from))
                  .filter((n): n is GraphNode => n !== undefined)
              : [];

            const deletedLabel = isDeleted ? ', deleted' : '';
            sections.push(`- **${sym.name}** (${sym.type}${deletedLabel}, base/current L${sym.startLine})`);
            if (callers.length > 0) {
              const names = callers.slice(0, 5).map(c => c.label);
              const more = callers.length > 5 ? `, +${callers.length - 5} more` : '';
              sections.push(`  Callers: ${names.join(', ')}${more}`);
            }
            const graphTestFiles = isDeleted
              ? callers.filter(caller => caller.filePath && isTestFile(path.join(root, caller.filePath))).map(caller => caller.filePath!)
              : [];
            const associations = testAssociationsFor(isDeleted ? baseTestMap : currentTestMap, sym, config);
            for (const testFile of graphTestFiles) {
              if (!associations.some(association => association.testFile === testFile)) {
                associations.push({ testFile, sourceFile: symbolPath, symbolName: sym.name, confidence: 'mention' });
              }
            }
            const testNote = formatTestAssociations(associations);
            if (testNote) {
              testedSymbols.add(sym);
              sections.push(`  ${testNote.replace(/\n/g, '\n  ')}`);
            }
          }
        }

        const risks: string[] = [];
        if (rinByFile.has(file.path)) risks.push('has open rin debt marker(s)');
        const untested = fileSymbols.filter(symbol => !testedSymbols.has(symbol));
        if (!isTest && untested.length > 0) {
          risks.push(`${untested.length} changed/deleted symbol(s) have no matching test association/reference`);
        }
        const fileFailures = failures.filter(d => d.body.includes(file.path));
        if (fileFailures.length > 0) risks.push(`${fileFailures.length} past failure record(s) mention this file`);
        if (risks.length > 0) sections.push(`  ⚠ Risk: ${risks.join('; ')}`);

        sections.push('');
      }

      if (baseAnalysis.warnings.length > 0) {
        sections.push('## Analysis warnings', ...baseAnalysis.warnings.map(warning => `- ${warning}`));
      }

      return sections.join('\n');
    },
  };
}
