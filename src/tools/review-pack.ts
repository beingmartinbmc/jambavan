/**
 * jambavan_review_pack — assemble a code review pack for the current branch.
 *
 * Pure composition of existing primitives: git diff for touched files, the
 * indexer for touched symbols, the knowledge graph for callers, the test map
 * for coverage, harvestRin for open debt, and the memory store for past
 * failures mentioning the same files. No new subsystem.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { JambavanConfig } from '../config/jambavan.config';
import type { JambavanIndex } from '../index/indexer';
import type { Symbol } from '../index/ast-parser';
import { buildSymbolGraph, type GraphNode } from '../knowledge/graph';
import { buildTestMap, formatTestAssociations, isTestFile, testAssociationsFor } from '../index/test-map';
import { harvestRin } from './vibhishana-niti';
import { MemoryStore } from '../memory/store';
import { projectScope } from './jambavan';
import { analyzeFileChange, changedSymbols, parseChangedRanges, parseNameStatus, parseOldRanges, type ChangedFile, type FileChangeSymbols } from './changed-symbols';
import { ASTParser } from '../index/ast-parser';
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

export function getChangedFiles(root: string, base: string, includeWorktree = false): ChangedFile[] {
  const touched = parseNameStatus(git(root, ['diff', '--find-renames', '--name-status', `${base}...HEAD`]));
  const ranges = parseChangedRanges(git(root, ['diff', '--find-renames', '--unified=0', `${base}...HEAD`]));
  const oldRanges = parseOldRanges(git(root, ['diff', '--find-renames', '--unified=0', `${base}...HEAD`]));
  const byPath = new Map(touched.map(file => [file.path, file]));

  if (includeWorktree) {
    for (const file of parseNameStatus(git(root, ['diff', '--find-renames', '--name-status', 'HEAD']))) {
      const existing = byPath.get(file.path);
      if (existing) {
        if (existing.status !== file.status) existing.status = `${existing.status}+${file.status}`;
      } else {
        byPath.set(file.path, file);
      }
    }
    for (const [file, additions] of parseChangedRanges(git(root, ['diff', '--find-renames', '--unified=0', 'HEAD']))) {
      ranges.set(file, [...(ranges.get(file) ?? []), ...additions]);
    }
    for (const [file, removals] of parseOldRanges(git(root, ['diff', '--find-renames', '--unified=0', 'HEAD']))) {
      oldRanges.set(file, [...(oldRanges.get(file) ?? []), ...removals]);
    }
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
    oldRanges: oldRanges.get(file.oldPath ?? file.path) ?? [],
  }));
}

/**
 * Symbols deleted or modified-in-place for one file, using base-side parsing.
 * Returns `{ changed, deleted }`. `deleted` names symbols that existed in the
 * merge-base but are gone from HEAD — invisible to the HEAD-only index.
 * `base` is the resolved ref getChangedFiles diffed against; worktree changes
 * are attributed against HEAD.
 */
export function analyzeChange(
  root: string,
  base: string,
  file: ChangedFile,
  headSymbols: Symbol[],
): FileChangeSymbols {
  const oldRanges = file.oldRanges ?? [];
  if (oldRanges.length === 0) {
    return { changed: changedSymbols(headSymbols, file.ranges), deleted: [] };
  }
  // Base-side source: `git show <base>:<oldPath>`. Renames diff old→new, so the
  // pre-image lives at oldPath. A worktree-only deletion has base === HEAD.
  const basePath = file.oldPath ?? file.path;
  const revPath = `${base}:${basePath}`;
  let baseSymbols: Symbol[] = [];
  try {
    const source = git(root, ['show', revPath]);
    baseSymbols = new ASTParser().parseContent(source, basePath).symbols;
  } catch {
    // Base revision unreadable (e.g. binary, or path absent at base): fall back
    // to HEAD-only attribution — no deleted symbols, but modified ones survive.
    return { changed: changedSymbols(headSymbols, file.ranges), deleted: [] };
  }
  return analyzeFileChange(headSymbols, baseSymbols, file.ranges, oldRanges);
}

export const REVIEW_PACK_TOOL_DEFS = [
  {
    name: 'jambavan_review_pack',
    description: [
      'Assemble a review pack for the current branch vs a base branch: touched files, the symbols',
      'changed in them, their callers (via the knowledge graph), related tests, past failure records',
      'mentioning the same files, and risk flags (open rin debt, no matching test). Call before',
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
      const graph = buildSymbolGraph(allSymbols, config, index.getAllReExports());
      const testMap = buildTestMap(allSymbols, config);
      const { markers: rinMarkers } = harvestRin(config);
      const rinByFile = new Set(rinMarkers.map(m => m.file.replace(/^\.\//, '')));

      const store = new MemoryStore(config.memoryDir);
      const failures = store.list(projectScope(config)).filter(d => d.frontmatter.type === 'FailureRecord');

      const nodeById = new Map(graph.nodes.map(n => [n.id, n]));
      const symbolNodeKey = (n: GraphNode) => `${n.filePath}\0${n.label}\0${n.line}`;
      const symbolNodeByKey = new Map<string, GraphNode>();
      for (const n of graph.nodes) {
        if (n.type === 'symbol') symbolNodeByKey.set(symbolNodeKey(n), n);
      }

      for (const file of analyzed) {
        const absPath = path.join(root, file.path);
        const isTest = isTestFile(absPath);
        const { changed: fileSymbols, deleted } = file.status.startsWith('D') || (file.oldRanges?.length ?? 0) > 0
          ? analyzeChange(root, base, file, index.getFileSymbols(absPath))
          : { changed: changedSymbols(index.getFileSymbols(absPath), file.ranges), deleted: [] as Symbol[] };

        sections.push(`## ${file.status}\t${file.path}`);

        if (fileSymbols.length === 0 && deleted.length === 0) {
          sections.push('_No indexed symbols (deleted, unparsed, or non-code file)._');
        } else {
          for (const sym of fileSymbols) {
            const node = symbolNodeByKey.get(`${file.path}\0${sym.name}\0${sym.startLine}`);
            const callers = node
              ? graph.edges
                  .filter(e => e.to === node.id && e.type !== 'contains' && e.confidence === 'EXTRACTED')
                  .map(e => nodeById.get(e.from))
                  .filter((n): n is GraphNode => n !== undefined)
              : [];

            sections.push(`- **${sym.name}** (${sym.type}, L${sym.startLine})`);
            if (callers.length > 0) {
              const names = callers.slice(0, 5).map(c => c.label);
              const more = callers.length > 5 ? `, +${callers.length - 5} more` : '';
              sections.push(`  Callers: ${names.join(', ')}${more}`);
            }
            const testNote = formatTestAssociations(testAssociationsFor(testMap, sym, config));
            if (testNote) sections.push(`  ${testNote.replace(/\n/g, '\n  ')}`);
          }
          for (const sym of deleted) {
            // Deleted symbols carry callers that may now be broken — surface them
            // from the HEAD graph (a caller still referencing a removed symbol is
            // exactly the review risk worth flagging).
            const callers = graph.edges
              .filter(e => e.type !== 'contains' && e.confidence === 'EXTRACTED'
                && nodeById.get(e.to)?.label === sym.name)
              .map(e => nodeById.get(e.from))
              .filter((n): n is GraphNode => n !== undefined);
            sections.push(`- **${sym.name}** (${sym.type}, deleted — was L${sym.startLine})`);
            if (callers.length > 0) {
              const names = [...new Set(callers.map(c => c.label))].slice(0, 5);
              sections.push(`  ⚠ Still referenced by: ${names.join(', ')}`);
            }
          }
        }

        const risks: string[] = [];
        if (rinByFile.has(file.path)) risks.push('has open rin debt marker(s)');
        const untested = fileSymbols.filter(s => testAssociationsFor(testMap, s, config).length === 0);
        if (!isTest && untested.length > 0) {
          risks.push(`${untested.length} changed symbol(s) have no matching test`);
        }
        const fileFailures = failures.filter(d => d.body.includes(file.path));
        if (fileFailures.length > 0) risks.push(`${fileFailures.length} past failure record(s) mention this file`);
        if (risks.length > 0) sections.push(`  ⚠ Risk: ${risks.join('; ')}`);

        sections.push('');
      }

      return sections.join('\n');
    },
  };
}
