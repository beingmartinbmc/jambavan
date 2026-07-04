import * as path from 'path';
import type { JambavanConfig } from '../config/jambavan.config';
import type { Symbol, SymbolReference } from '../index/ast-parser';
import { countTokens } from '../context/token-counter';
import { truncateToTokenBudget } from '../context/token-counter';

export interface GraphNode {
  id: string;
  label: string;
  type: 'file' | 'symbol' | 'memory';
  filePath?: string;
  line?: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: 'contains' | 'mentions' | 'same_file' | SymbolReference['type'];
  confidence: 'EXTRACTED' | 'INFERRED';
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const MAX_INFERRED_MENTION_TARGETS_PER_NAME = 25;

function rel(filePath: string, config: JambavanConfig): string {
  return path.relative(config.projectRoot, filePath).replace(/\\/g, '/') || filePath;
}

function symbolId(s: Symbol, config: JambavanConfig): string {
  return `symbol:${rel(s.filePath, config)}:${s.name}:${s.startLine}`;
}

function nodeLine(n: GraphNode): string {
  const loc = n.filePath ? ` — ${n.filePath}${n.line ? `:${n.line}` : ''}` : '';
  return `${n.id} (${n.type}) ${n.label}${loc}`;
}

function edgeLine(e: GraphEdge, byId: Map<string, GraphNode>): string {
  return `${byId.get(e.from)?.label ?? e.from} -[${e.type}/${e.confidence}]-> ${byId.get(e.to)?.label ?? e.to}`;
}

function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  return edges.filter(e => {
    const key = `${e.from}\0${e.to}\0${e.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Build a map: relative file path → Set of symbol names exported/defined in that file.
 * Used to resolve import edges to their actual source file instead of name-only matching.
 */
function buildFileExportMap(symbols: Symbol[], config: JambavanConfig): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const s of symbols) {
    const file = rel(s.filePath, config);
    if (!map.has(file)) map.set(file, new Set());
    map.get(file)!.add(s.name);
  }
  return map;
}

/**
 * Resolve a relative import specifier (e.g. './foo', '../utils/bar') from a source file
 * to a relative file path in the project. Returns the resolved path (without extension)
 * or null if it can't be resolved. Tries common extensions.
 */
function resolveImportPath(fromFile: string, specifier: string, fileExports: Map<string, Set<string>>): string | null {
  if (!specifier.startsWith('.')) return null; // skip bare/package imports
  const dir = path.dirname(fromFile);
  const base = path.join(dir, specifier).replace(/\\/g, '/');
  // Try exact match, then common extensions, then /index variants
  const candidates = [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mts`,
    `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`,
  ];
  for (const c of candidates) {
    const normalized = c.replace(/\\/g, '/');
    if (fileExports.has(normalized)) return normalized;
  }
  return null;
}

export function buildSymbolGraph(symbols: Symbol[], config: JambavanConfig): KnowledgeGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  for (const s of symbols) {
    const file = rel(s.filePath, config);
    const fileId = `file:${file}`;
    const id = symbolId(s, config);

    nodes.set(fileId, { id: fileId, label: file, type: 'file', filePath: file });
    nodes.set(id, { id, label: s.name, type: 'symbol', filePath: file, line: s.startLine });
    edges.push({ from: fileId, to: id, type: 'contains', confidence: 'EXTRACTED' });
  }

  const symbolsByName = new Map<string, string[]>();
  for (const node of nodes.values()) {
    if (node.type !== 'symbol') continue;
    if (!symbolsByName.has(node.label)) symbolsByName.set(node.label, []);
    symbolsByName.get(node.label)!.push(node.id);
  }

  // Build file-level export map for import resolution
  const fileExports = buildFileExportMap(symbols, config);

  // Map node id → its relative file path for quick lookup
  const nodeFile = new Map<string, string>();
  for (const node of nodes.values()) {
    if (node.filePath) nodeFile.set(node.id, node.filePath);
  }

  for (const s of symbols) {
    const from = symbolId(s, config);
    const fromFile = rel(s.filePath, config);

    // Build import lookup for this symbol: name → specifier (from import-typed refs)
    const importSpecifiers = new Map<string, string>();
    for (const ref of s.references ?? []) {
      if (ref.type === 'import' && ref.specifier) {
        importSpecifiers.set(ref.name, ref.specifier);
      }
    }

    for (const ref of s.references ?? []) {
      // Skip import refs from edge creation — they're only used for resolution metadata.
      // The actual edges come from 'call' or 'implements' refs.
      if (ref.type === 'import') continue;

      const targets = symbolsByName.get(ref.name) ?? [];
      if (targets.length === 0) continue;

      if (targets.length === 1) {
        // Unambiguous — single target
        if (targets[0] !== from) edges.push({ from, to: targets[0], type: ref.type, confidence: 'EXTRACTED' });
        continue;
      }

      // Multiple targets with same name: try import-path resolution first.
      const specifier = importSpecifiers.get(ref.name);
      if (specifier) {
        const resolved = resolveImportPath(fromFile, specifier, fileExports);
        if (resolved) {
          // Only link to targets in the resolved file
          let linked = false;
          for (const to of targets) {
            if (to !== from && nodeFile.get(to) === resolved) {
              edges.push({ from, to, type: ref.type, confidence: 'EXTRACTED' });
              linked = true;
            }
          }
          if (linked) continue;
        }
      }

      // Fallback: prefer same-file target, then fan out to all
      const sameFile = targets.filter(t => t !== from && nodeFile.get(t) === fromFile);
      if (sameFile.length > 0) {
        for (const to of sameFile) edges.push({ from, to, type: ref.type, confidence: 'EXTRACTED' });
      } else {
        // Fall back: link to all (original behavior)
        for (const to of targets) {
          if (to !== from) edges.push({ from, to, type: ref.type, confidence: 'EXTRACTED' });
        }
      }
    }
  }

  // Tokenize each body once and look names up, instead of compiling and
  // running a regex for every (symbol × distinct-name) pair. Word-boundary
  // regex on an identifier == that identifier appearing as a token, so this
  // is behavior-preserving but O(total tokens) instead of O(N²·regex).
  for (const s of symbols) {
    const from = symbolId(s, config);
    const refNames = new Set((s.references ?? []).map(r => r.name));
    for (const name of new Set(s.content.match(/[A-Za-z_]\w*/g) ?? [])) {
      if (name === s.name || name.length < 3 || refNames.has(name)) continue;
      const targets = symbolsByName.get(name) ?? [];
      if (targets.length > MAX_INFERRED_MENTION_TARGETS_PER_NAME) continue;
      for (const to of targets) {
        if (to !== from) edges.push({ from, to, type: 'mentions', confidence: 'INFERRED' });
      }
    }
  }

  // rin: inferred fallback is capped symbol-name mentions; replace remaining non-AST edges when language resolvers grow.
  return { nodes: [...nodes.values()], edges: dedupeEdges(edges) };
}

export function graphReport(graph: KnowledgeGraph, max = 10): string {
  const degree = new Map<string, number>();
  for (const node of graph.nodes) degree.set(node.id, 0);
  for (const edge of graph.edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }

  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const hubs = [...degree.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([id, d], i) => {
      const n = byId.get(id)!;
      const loc = n.filePath ? ` — ${n.filePath}${n.line ? `:${n.line}` : ''}` : '';
      return `${i + 1}. ${n.label} (${n.type}, degree ${d})${loc}`;
    });

  const inferred = graph.edges.filter(e => e.confidence === 'INFERRED').length;
  return [
    '# Jambavan Knowledge Graph Report',
    '',
    `Nodes: ${graph.nodes.length}`,
    `Edges: ${graph.edges.length} (${inferred} inferred)`,
    '',
    '## Hub nodes',
    hubs.length ? hubs.join('\n') : 'No nodes yet. Call jambavan_index first.',
    '',
    '## Confidence',
    'EXTRACTED edges are structural/call/import facts. INFERRED edges are symbol-name mentions; verify before large refactors.',
  ].join('\n');
}

function adjacency(graph: KnowledgeGraph): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) adj.set(n.id, []);
  for (const e of graph.edges) {
    adj.get(e.from)?.push(e.to);
    adj.get(e.to)?.push(e.from);
  }
  return adj;
}

function matchNodes(graph: KnowledgeGraph, query: string): GraphNode[] {
  const q = query.toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  return graph.nodes
    .map(n => {
      const hay = `${n.label} ${n.filePath ?? ''}`.toLowerCase();
      const score = hay === q ? 100 : hay.includes(q) ? 50 : terms.filter(t => hay.includes(t)).length;
      return { n, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(x => x.n);
}

export function graphQuery(graph: KnowledgeGraph, query: string, budget = 2000): string {
  const starts = matchNodes(graph, query).slice(0, 5);
  if (starts.length === 0) return `No graph nodes found for: "${query}"`;

  const adj = adjacency(graph);
  const selected = new Set(starts.map(n => n.id));
  const queue = starts.map(n => n.id);

  while (queue.length && selected.size < 40) {
    const id = queue.shift()!;
    for (const next of adj.get(id) ?? []) {
      if (selected.has(next)) continue;
      selected.add(next);
      queue.push(next);
      if (selected.size >= 40) break;
    }
  }

  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const edges = graph.edges.filter(e => selected.has(e.from) && selected.has(e.to));
  const text = [
    `# Jambavan Graph Query: ${query}`,
    '',
    '## Nodes',
    [...selected].map(id => nodeLine(byId.get(id)!)).join('\n'),
    '',
    '## Edges',
    edges.length ? edges.map(e => edgeLine(e, byId)).join('\n') : 'No connecting edges in budget.',
  ].join('\n');

  return countTokens(text) > budget ? truncateToTokenBudget(text, budget) : text;
}

export function graphPath(graph: KnowledgeGraph, fromQuery: string, toQuery: string): string {
  const from = matchNodes(graph, fromQuery)[0];
  const to = matchNodes(graph, toQuery)[0];
  if (!from) return `No graph node found for from: "${fromQuery}"`;
  if (!to) return `No graph node found for to: "${toQuery}"`;

  const adj = adjacency(graph);
  const prev = new Map<string, string | null>([[from.id, null]]);
  const queue = [from.id];

  while (queue.length && !prev.has(to.id)) {
    const id = queue.shift()!;
    for (const next of adj.get(id) ?? []) {
      if (prev.has(next)) continue;
      prev.set(next, id);
      queue.push(next);
    }
  }

  if (!prev.has(to.id)) return `No path found: ${from.label} → ${to.label}`;

  const ids: string[] = [];
  for (let id: string | null = to.id; id; id = prev.get(id) ?? null) ids.push(id);
  ids.reverse();

  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const lines: string[] = [`# Jambavan Graph Path: ${from.label} → ${to.label}`, ''];
  for (let i = 0; i < ids.length; i++) {
    lines.push(`${i + 1}. ${nodeLine(byId.get(ids[i])!)}`);
    if (i < ids.length - 1) {
      const edge = graph.edges.find(e =>
        (e.from === ids[i] && e.to === ids[i + 1]) || (e.to === ids[i] && e.from === ids[i + 1])
      );
      if (edge) lines.push(`   via ${edge.type}/${edge.confidence}`);
    }
  }
  return lines.join('\n');
}
