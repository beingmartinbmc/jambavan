/**
 * Structured JSON output for `jambavan review-pack --format json`.
 *
 * Reuses all the same primitives as buildReviewPackHandlers but returns a
 * typed object rather than a markdown string, so the GitHub Action script
 * can render its own comment format without parsing markdown.
 */

import { execFileSync } from 'child_process';
import * as path from 'path';
import type { JambavanConfig } from '../config/jambavan.config';
import type { JambavanIndex } from '../index/indexer';
import { buildSymbolGraph, type GraphNode } from '../knowledge/graph';
import { buildTestMap, isTestFile } from '../index/test-map';
import { harvestRin } from './vibhishana-niti';
import { MemoryStore } from '../memory/store';
import { projectScope } from './jambavan';

const DEFAULT_MAX_FILES = 30;
const BASE_CANDIDATES = ['main', 'master', 'origin/main', 'origin/master'];

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function detectBaseBranch(root: string): string {
  for (const candidate of BASE_CANDIDATES) {
    try { git(root, ['rev-parse', '--verify', '--quiet', candidate]); return candidate; }
    catch { /* try next */ }
  }
  return 'main';
}

export interface ReviewPackSymbol {
  name:     string;
  type:     string;
  startLine: number;
  callers:  string[];
  tests:    string[];
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
}

export function buildReviewPackJson(
  config: JambavanConfig,
  index: JambavanIndex,
  base?: string,
  maxFiles = DEFAULT_MAX_FILES,
): ReviewPackJson {
  const root = config.projectRoot;
  const resolvedBase = base ?? detectBaseBranch(root);

  let rawDiff: string;
  try {
    rawDiff = git(root, ['diff', '--name-status', `${resolvedBase}...HEAD`]);
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    throw new Error(`Could not diff against base "${resolvedBase}": ${msg}`);
  }

  const touched = rawDiff
    .split('\n').filter(Boolean)
    .map(line => { const [status, ...rest] = line.split('\t'); return { status, path: rest.join('\t') }; })
    .filter(f => f.path);

  if (touched.length === 0) {
    return {
      base:          resolvedBase,
      touchedCount:  0,
      analyzedCount: 0,
      truncated:     false,
      files:         [],
      rinMarkers:    [],
      failures:      [],
    };
  }

  const analyzed = touched.slice(0, maxFiles);
  const allSymbols = index.getAllSymbols(100_000);
  const graph = buildSymbolGraph(allSymbols, config, index.getAllReExports());
  const testMap = buildTestMap(allSymbols, config);
  const { markers: rinMarkers } = harvestRin(config);
  const rinByFile = new Set(rinMarkers.map(m => m.file.replace(/^\.\//, '')));
  const nodeById = new Map(graph.nodes.map(n => [n.id, n]));

  type SymbolKey = string;
  const symbolNodeByKey = new Map<SymbolKey, GraphNode>();
  for (const n of graph.nodes) {
    if (n.type === 'symbol' && n.filePath && n.line !== undefined) {
      symbolNodeByKey.set(`${n.filePath}\0${n.label}\0${n.line}`, n);
    }
  }

  const store = new MemoryStore(config.memoryDir);
  const allFailures = store.list(projectScope(config)).filter(d => d.frontmatter.type === 'FailureRecord');

  const files: ReviewPackFile[] = [];

  for (const file of analyzed) {
    const absPath = path.join(root, file.path);
    const isTest = isTestFile(absPath);
    const fileSymbols = file.status === 'D' ? [] : index.getFileSymbols(absPath);

    const symbols: ReviewPackSymbol[] = fileSymbols.map(sym => {
      const node = symbolNodeByKey.get(`${file.path}\0${sym.name}\0${sym.startLine}`);
      const callers = node
        ? graph.edges
            .filter(e => e.to === node.id && e.type !== 'contains' && e.confidence === 'EXTRACTED')
            .map(e => nodeById.get(e.from))
            .filter((n): n is GraphNode => n !== undefined)
            .slice(0, 8)
            .map(n => n.label)
        : [];
      const tests = (testMap.get(sym.name) ?? []).map(t => path.relative(root, t.testFile));
      return { name: sym.name, type: sym.type, startLine: sym.startLine, callers, tests };
    });

    const risks: string[] = [];
    if (rinByFile.has(file.path)) risks.push('has open rin debt marker(s)');
    if (!isTest && fileSymbols.length > 0 && !symbols.some(s => s.tests.length > 0)) {
      risks.push('no symbol in this file has a matching test');
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
  };
}
