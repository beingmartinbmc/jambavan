/**
 * Structured JSON output for `jambavan review-pack --format json`.
 *
 * Reuses all the same primitives as buildReviewPackHandlers but returns a
 * typed object rather than a markdown string, so the GitHub Action script
 * can render its own comment format without parsing markdown.
 */

import * as path from 'path';
import type { JambavanConfig } from '../config/jambavan.config';
import type { JambavanIndex } from '../index/indexer';
import { buildSymbolGraph, type GraphNode } from '../knowledge/graph';
import { buildTestMap, isTestFile, testAssociationsFor } from '../index/test-map';
import { harvestRin } from './vibhishana-niti';
import { MemoryArchive } from '../memory/archive';
import { projectScope } from './jambavan';
import { changedSymbols, deletedSymbols, type ChangedFile } from './changed-symbols';
import { detectBaseBranch, getBaseAnalysis, getChangedFiles, type BaseAnalysis } from './review-pack';

const DEFAULT_MAX_FILES = 30;

export interface ReviewPackSymbol {
  name:     string;
  type:     string;
  startLine: number;
  deleted:  boolean;
  callers:  string[];
  testAssociations: string[];
  /** @deprecated Use testAssociations. Kept for 2.x workflow consumers. */
  tests:     string[];
}

export interface ReviewPackFile {
  status:  string;
  path:    string;
  symbols: ReviewPackSymbol[];
  risks:   string[];
}

export interface ReviewPackFailureRef {
  title:     string;
  status:    string;
  timestamp: string;
}

export interface ReviewPackJson {
  base:         string;
  touchedCount: number;
  analyzedCount: number;
  truncated:    boolean;
  files:        ReviewPackFile[];
  rinMarkers:   { file: string; line: number; comment: string; hasUpgrade: boolean }[];
  failures:     ReviewPackFailureRef[];
  warnings:     string[];
}

export function buildReviewPackJson(
  config: JambavanConfig,
  index: JambavanIndex,
  base?: string,
  maxFiles = DEFAULT_MAX_FILES,
  includeWorktree = false,
): ReviewPackJson {
  const root = config.projectRoot;
  const resolvedBase = base ?? detectBaseBranch(root);

  let touched: ChangedFile[];
  try {
    touched = getChangedFiles(root, resolvedBase, includeWorktree);
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    throw new Error(`Could not diff against base "${resolvedBase}": ${msg}`);
  }

  if (touched.length === 0) {
    return {
      base:          resolvedBase,
      touchedCount:  0,
      analyzedCount: 0,
      truncated:     false,
      files:         [],
      rinMarkers:    [],
      failures:      [],
      warnings:      [],
    };
  }

  const analyzed = touched.slice(0, maxFiles);
  const allSymbols = index.getAllSymbols(100_000);
  let baseAnalysis: BaseAnalysis;
  try {
    baseAnalysis = getBaseAnalysis(root, resolvedBase, analyzed, includeWorktree);
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
    return {
      base: resolvedBase,
      touchedCount: touched.length,
      analyzedCount: 0,
      truncated: touched.length > analyzed.length,
      files: [],
      rinMarkers: [],
      failures: [],
      warnings: [`Base-side symbol analysis failed (${message}); deleted symbols and callers may be omitted.`],
    };
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
  const touchedAbsolutePaths = new Set(analyzed.map(file => path.join(root, file.path)));
  const currentSymbols = [
    ...allSymbols.filter(symbol => !touchedAbsolutePaths.has(symbol.filePath)),
    ...analyzed.flatMap(file => includeWorktree
      ? index.getFileSymbols(path.join(root, file.path))
      : baseAnalysis.currentSymbolsByPath.get(file.path) ?? []),
  ];
  const baseSymbols = [
    ...allSymbols.filter(symbol => !touchedAbsolutePaths.has(symbol.filePath)),
    ...[...baseAnalysis.symbolsByPath.values()].flat(),
  ];
  const indexedReExports = index.getAllReExports().filter(reExport => !touchedAbsolutePaths.has(reExport.filePath));
  const currentGraph = buildSymbolGraph(currentSymbols, config, [
    ...indexedReExports,
    ...(includeWorktree ? index.getAllReExports().filter(reExport => touchedAbsolutePaths.has(reExport.filePath)) : baseAnalysis.currentReExports),
  ]);
  const baseGraph = buildSymbolGraph(baseSymbols, config, [...indexedReExports, ...baseAnalysis.reExports]);
  const currentTestMap = buildTestMap(currentSymbols, config);
  const baseTestMap = buildTestMap(baseSymbols, config, baseAnalysis.contentsByPath);
  const { markers: rinMarkers } = harvestRin(config);
  const rinByFile = new Set(rinMarkers.map(m => m.file.replace(/^\.\//, '')));
  const currentNodeById = new Map(currentGraph.nodes.map(n => [n.id, n]));
  const baseNodeById = new Map(baseGraph.nodes.map(n => [n.id, n]));

  type SymbolKey = string;
  const symbolNodeByKey = new Map<SymbolKey, GraphNode>();
  for (const n of [...currentGraph.nodes, ...baseGraph.nodes]) {
    if (n.type === 'symbol' && n.filePath && n.line !== undefined) {
      symbolNodeByKey.set(`${n.filePath}\0${n.label}\0${n.line}`, n);
    }
  }

  const allFailures = new MemoryArchive(config).list(projectScope(config))
    .filter(d => d.frontmatter.type === 'FailureRecord');

  const files: ReviewPackFile[] = [];

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

    const symbols: ReviewPackSymbol[] = fileSymbols.map(sym => {
      const symbolPath = path.relative(root, sym.filePath).replace(/\\/g, '/');
      const node = symbolNodeByKey.get(`${symbolPath}\0${sym.name}\0${sym.startLine}`);
      const deleted = (deletedByPath.get(file.path) ?? []).includes(sym);
      const graph = deleted ? baseGraph : currentGraph;
      const nodeById = deleted ? baseNodeById : currentNodeById;
      const callerNodes = node
        ? graph.edges
            .filter(e => e.to === node.id && e.type !== 'contains' && e.confidence === 'EXTRACTED')
            .map(e => nodeById.get(e.from))
            .filter((n): n is GraphNode => n !== undefined)
        : [];
      const callers = callerNodes.slice(0, 8).map(n => n.label);
      const testAssociations = new Set(testAssociationsFor(deleted ? baseTestMap : currentTestMap, sym, config).map(t => t.testFile));
      if (deleted) {
        for (const callerNode of callerNodes) {
          if (callerNode?.filePath && isTestFile(path.join(root, callerNode.filePath))) testAssociations.add(callerNode.filePath);
        }
      }
      const tests = [...testAssociations].sort();
      return {
        name: sym.name,
        type: sym.type,
        startLine: sym.startLine,
        deleted,
        callers,
        testAssociations: tests,
        tests,
      };
    });

    const risks: string[] = [];
    if (rinByFile.has(file.path)) risks.push('has open rin debt marker(s)');
    const untested = symbols.filter(symbol => symbol.testAssociations.length === 0);
    if (!isTest && untested.length > 0) {
      risks.push(`${untested.length} changed/deleted symbol(s) have no matching test association/reference`);
    }
    const ff = allFailures.filter(d => d.body.includes(file.path));
    if (ff.length > 0) risks.push(`${ff.length} past failure record(s) mention this file`);

    files.push({ status: file.status, path: file.path, symbols, risks });
  }

  // Collect failure refs for files touched in this diff
  const touchedPaths = new Set(touched.map(f => f.path));
  const failures: ReviewPackFailureRef[] = allFailures
    .filter(d => [...touchedPaths].some(p => d.body.includes(p)))
    .map(d => ({
      title:     d.frontmatter.title,
      status:    d.frontmatter.tags.find(t => ['unresolved', 'resolved', 'wontfix'].includes(t)) ?? 'unresolved',
      timestamp: d.frontmatter.timestamp,
    }));

  return {
    base:          resolvedBase,
    touchedCount:  touched.length,
    analyzedCount: files.length,
    truncated:     touched.length > analyzed.length,
    files,
    rinMarkers:   rinMarkers
      .filter(m => touchedPaths.has(m.file.replace(/^\.\//, '')))
      .map(m => ({ file: m.file, line: m.line, comment: m.comment, hasUpgrade: m.hasUpgrade })),
    failures,
    warnings:      baseAnalysis.warnings,
  };
}
