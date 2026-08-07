import * as path from 'path';
import type { JambavanConfig } from '../config/jambavan.config';
import type { JambavanIndex } from '../index/indexer';
import type { Symbol } from '../index/ast-parser';
import { buildTestMap, testAssociationsFor } from '../index/test-map';
import { buildSymbolGraph, type GraphNode } from '../knowledge/graph';
import { changedSymbols, deletedSymbols, type ChangedFile } from './changed-symbols';
import { detectBaseBranch, getBaseAnalysis, getChangedFiles, type BaseAnalysis } from './review-pack';

const DEFAULT_SYMBOL_LIMIT = 100_000;

export const IMPACT_TOOL_DEFS = [{
  name: 'jambavan_impact',
  description: [
    'Analyze changed symbols against inbound extracted graph edges and test associations/references.',
    'Reports bounded transitive callers, test associations/references, and explicit graph incompleteness.',
    'Use before a risky refactor or PR review; call jambavan_index first.',
  ].join(' '),
  inputSchema: {
    type: 'object' as const,
    properties: {
      base: { type: 'string', description: 'Base ref for the three-dot branch diff (auto-detects main/master and origin variants).' },
      max_depth: { type: 'number', description: 'Inbound caller traversal depth, 1-5 (default: 2).' },
      include_worktree: { type: 'boolean', description: 'Include staged, unstaged, and untracked changes.' },
    },
    required: [],
  },
}] as const;

function symbolKey(filePath: string, name: string, line: number): string {
  return `${filePath}\0${name}\0${line}`;
}

export function buildImpactHandlers(config: JambavanConfig, getIndex: () => JambavanIndex | undefined) {
  return {
    jambavan_impact(input: Record<string, unknown>): string {
      const index = getIndex();
      if (!index) return 'Index not built yet. Call jambavan_index first.';

      const base = typeof input['base'] === 'string' && input['base']
        ? input['base']
        : detectBaseBranch(config.projectRoot);
      const maxDepth = Math.max(1, Math.min(5, Number(input['max_depth']) || 2));
      const includeWorktree = input['include_worktree'] === true;
      let files: ChangedFile[];
      try {
        files = getChangedFiles(config.projectRoot, base, includeWorktree);
      } catch (err) {
        const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
        return `Error: could not analyze changes against base "${base}" (${message}). Pass a valid base ref or run inside a git repository.`;
      }
      const changed: Symbol[] = [];
      let baseAnalysis: BaseAnalysis;
      try {
        baseAnalysis = getBaseAnalysis(config.projectRoot, base, files, includeWorktree);
      } catch (err) {
        const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
        return `Error: could not analyze base-side symbols against "${base}" (${message}).`;
      }
      for (const file of files) {
        const currentSymbols = includeWorktree
          ? index.getFileSymbols(path.join(config.projectRoot, file.path))
          : baseAnalysis.currentSymbolsByPath.get(file.path) ?? [];
        changed.push(...changedSymbols(
          currentSymbols,
          file.ranges,
        ));
        const oldPath = file.oldPath ?? file.path;
        changed.push(...deletedSymbols(
          baseAnalysis.symbolsByPath.get(oldPath) ?? [],
          baseAnalysis.diffRanges.get(oldPath) ?? [],
          currentSymbols,
        ));
      }
      if (changed.length === 0) {
        return [
          '# Jambavan Impact',
          '',
          `No changed or deleted parsed symbols found vs \`${base}\`; absence here does not prove there is no symbol impact.`,
          ...baseAnalysis.warnings.map(warning => `Warning: ${warning}`),
        ].join('\n');
      }

      const allSymbols = index.getAllSymbols(DEFAULT_SYMBOL_LIMIT);
      const touchedPaths = new Set(files.map(file => path.join(config.projectRoot, file.path)));
      const currentSymbols = [
        ...allSymbols.filter(symbol => !touchedPaths.has(symbol.filePath)),
        ...files.flatMap(file => includeWorktree
          ? index.getFileSymbols(path.join(config.projectRoot, file.path))
          : baseAnalysis.currentSymbolsByPath.get(file.path) ?? []),
      ];
      const baseSymbols = [
        ...allSymbols.filter(symbol => !touchedPaths.has(symbol.filePath)),
        ...[...baseAnalysis.symbolsByPath.values()].flat(),
      ];
      const deletedSet = new Set(changed.filter(symbol => baseSymbols.includes(symbol)));
      const indexedReExports = index.getAllReExports().filter(reExport => !touchedPaths.has(reExport.filePath));
      const currentGraph = buildSymbolGraph(currentSymbols, config, [
        ...indexedReExports,
        ...(includeWorktree ? index.getAllReExports().filter(reExport => touchedPaths.has(reExport.filePath)) : baseAnalysis.currentReExports),
      ]);
      const baseGraph = buildSymbolGraph(baseSymbols, config, [...indexedReExports, ...baseAnalysis.reExports]);
      const currentTestMap = buildTestMap(currentSymbols, config);
      const baseTestMap = buildTestMap(baseSymbols, config, baseAnalysis.contentsByPath);
      const nodeByKey = new Map<string, GraphNode>();
      const symbolByNode = new Map<string, Symbol>();
      for (const node of [...currentGraph.nodes, ...baseGraph.nodes]) {
        if (node.type !== 'symbol' || !node.filePath || node.line === undefined) continue;
        nodeByKey.set(symbolKey(node.filePath, node.label, node.line), node);
      }
      for (const symbol of allSymbols) {
        const relative = path.relative(config.projectRoot, symbol.filePath).replace(/\\/g, '/');
        const node = nodeByKey.get(symbolKey(relative, symbol.name, symbol.startLine));
        if (node) symbolByNode.set(node.id, symbol);
      }

      const impacted = new Map<string, number>();
      const changedIds = new Set<string>();
      for (const symbol of changed) {
        const relative = path.relative(config.projectRoot, symbol.filePath).replace(/\\/g, '/');
        const node = nodeByKey.get(symbolKey(relative, symbol.name, symbol.startLine));
        if (!node) continue;
        const graph = deletedSet.has(symbol) ? baseGraph : currentGraph;
        const inbound = new Map<string, string[]>();
        for (const edge of graph.edges) {
          if (edge.type === 'contains' || edge.confidence !== 'EXTRACTED') continue;
          const callers = inbound.get(edge.to) ?? [];
          callers.push(edge.from);
          inbound.set(edge.to, callers);
        }
        changedIds.add(node.id);
        const queue: Array<{ id: string; depth: number }> = [{ id: node.id, depth: 0 }];
        const visited = new Set([node.id]);
        while (queue.length) {
          const current = queue.shift()!;
          if (current.depth >= maxDepth) continue;
          for (const caller of inbound.get(current.id) ?? []) {
            if (visited.has(caller)) continue;
            visited.add(caller);
            const depth = current.depth + 1;
            impacted.set(caller, Math.min(impacted.get(caller) ?? depth, depth));
            queue.push({ id: caller, depth });
          }
        }
      }
      for (const id of changedIds) impacted.delete(id);

      const tests = new Set<string>();
      for (const symbol of [...changed, ...[...impacted].map(([id]) => symbolByNode.get(id)).filter((s): s is Symbol => Boolean(s))]) {
        const testMap = deletedSet.has(symbol) ? baseTestMap : currentTestMap;
        for (const association of testAssociationsFor(testMap, symbol, config)) tests.add(association.testFile);
      }

      const affectedLines = [...impacted.entries()]
        .sort((a, b) => a[1] - b[1])
        .slice(0, 100)
        .map(([id, depth]) => {
          const node = currentGraph.nodes.find(candidate => candidate.id === id)
            ?? baseGraph.nodes.find(candidate => candidate.id === id)!;
          return `- ${node.label} — ${node.filePath}:${node.line} (inbound depth ${depth})`;
        });
      const stats = index.stats();
      const incomplete = stats.symbols > allSymbols.length;

      return [
        '# Jambavan Impact',
        '',
        `Base: \`${base}\` · changed symbols: ${changed.length} · inbound depth: ${maxDepth}`,
        `Graph coverage: ${allSymbols.length}/${stats.symbols} indexed symbols${incomplete ? ' (INCOMPLETE)' : ''}`,
        '',
        '## Changed symbols',
        ...changed.map(symbol => `- ${symbol.name} — ${path.relative(config.projectRoot, symbol.filePath)}:${symbol.startLine}`),
        '',
        '## Potentially affected callers',
        ...(affectedLines.length ? affectedLines : ['No extracted inbound callers found.']),
        '',
        '## Test associations/references',
        ...(tests.size ? [...tests].sort().map(testFile => `- ${testFile}`) : ['No matching test associations/references found for the changed impact set.']),
        ...baseAnalysis.warnings.flatMap(warning => ['', `Warning: ${warning}`]),
        ...(incomplete ? ['', `Warning: graph analysis stopped at ${DEFAULT_SYMBOL_LIMIT} symbols; narrow the repository or raise the implementation limit before relying on absence.`] : []),
      ].join('\n');
    },
  };
}
