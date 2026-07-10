/**
 * jambavan_review_pack — assemble a code review pack for the current branch.
 *
 * Pure composition of existing primitives: git diff for touched files, the
 * indexer for touched symbols, the knowledge graph for callers, the test map
 * for coverage, harvestRin for open debt, and the memory store for past
 * failures mentioning the same files. No new subsystem.
 */

import { execFileSync } from 'child_process';
import * as path from 'path';
import type { JambavanConfig } from '../config/jambavan.config';
import type { JambavanIndex } from '../index/indexer';
import { buildSymbolGraph, type GraphNode } from '../knowledge/graph';
import { buildTestMap, formatTestAssociations, isTestFile } from '../index/test-map';
import { harvestRin } from './vibhishana-niti';
import { MemoryStore } from '../memory/store';
import { projectScope } from './jambavan';

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

function detectBaseBranch(root: string): string {
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

interface TouchedFile {
  status: string;
  path: string;
}

function getTouchedFiles(root: string, base: string): TouchedFile[] {
  const raw = git(root, ['diff', '--name-status', `${base}...HEAD`]);
  return raw
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [status, ...rest] = line.split('\t');
      return { status, path: rest.join('\t') };
    })
    .filter(f => f.path);
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

      let touched: TouchedFile[];
      try {
        touched = getTouchedFiles(root, base);
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
        const fileSymbols = file.status === 'D' ? [] : index.getFileSymbols(absPath);

        sections.push(`## ${file.status}\t${file.path}`);

        if (fileSymbols.length === 0) {
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
            const testNote = formatTestAssociations(testMap.get(sym.name) ?? []);
            if (testNote) sections.push(`  ${testNote.replace(/\n/g, '\n  ')}`);
          }
        }

        const risks: string[] = [];
        if (rinByFile.has(file.path)) risks.push('has open rin debt marker(s)');
        if (!isTest && fileSymbols.length > 0 && !fileSymbols.some(s => (testMap.get(s.name) ?? []).length > 0)) {
          risks.push('no symbol in this file has a matching test');
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
