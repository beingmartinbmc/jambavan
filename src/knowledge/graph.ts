import * as fs from 'fs';
import * as path from 'path';
import type { JambavanConfig } from '../config/jambavan.config';
import type { Symbol, SymbolReference } from '../index/ast-parser';
import type { ReExportRow } from '../index/indexer';
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
  /** Human-readable explanation of why this edge exists — shown in graph_query/graph_path output. */
  reason: string;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const MAX_INFERRED_MENTION_TARGETS_PER_NAME = 25;
const MAX_REEXPORT_DEPTH = 5;

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
  return `${byId.get(e.from)?.label ?? e.from} -[${e.type}/${e.confidence}]-> ${byId.get(e.to)?.label ?? e.to}  (${e.reason})`;
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

/** Try a base path (no extension) against the same candidate suffixes relative imports use. */
function matchFileCandidate(base: string, fileExports: Map<string, Set<string>>): string | null {
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

interface TsconfigAliases {
  baseUrl: string;
  paths: Record<string, string[]>;
}

/** Strip `//` and `/* *‍/` comments so tsconfig.json's common JSONC form parses as JSON. */
function stripJsonComments(raw: string): string {
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Load `compilerOptions.baseUrl`/`paths` from the project's tsconfig.json, if any.
 * Best-effort: a missing, comment-only-malformed, or path-less tsconfig just
 * means alias resolution is skipped, not an indexing failure.
 */
function loadTsconfigAliases(projectRoot: string): TsconfigAliases | null {
  const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) return null;
  try {
    const json = JSON.parse(stripJsonComments(fs.readFileSync(tsconfigPath, 'utf-8')));
    const co = json.compilerOptions ?? {};
    if (!co.paths) return null;
    return { baseUrl: co.baseUrl ?? '.', paths: co.paths };
  } catch {
    return null;
  }
}

/** Resolve a bare specifier (e.g. `@app/foo`) via tsconfig `paths` glob-style patterns. */
function resolveAliasedImportPath(
  specifier: string,
  fileExports: Map<string, Set<string>>,
  aliases: TsconfigAliases | null,
): string | null {
  if (!aliases) return null;
  for (const [pattern, targets] of Object.entries(aliases.paths)) {
    const starIdx = pattern.indexOf('*');
    let capture: string | null = null;
    if (starIdx === -1) {
      if (specifier !== pattern) continue;
      capture = '';
    } else {
      const prefix = pattern.slice(0, starIdx);
      const suffix = pattern.slice(starIdx + 1);
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
      capture = specifier.slice(prefix.length, specifier.length - suffix.length);
    }
    for (const target of targets) {
      const resolvedTarget = target.replace('*', capture ?? '');
      const base = path.join(aliases.baseUrl, resolvedTarget).replace(/\\/g, '/');
      const match = matchFileCandidate(base, fileExports);
      if (match) return match;
    }
  }
  return null;
}

/**
 * Resolve an import specifier from a source file to a relative file path in the
 * project: relative (`./foo`, `../utils/bar`) via the importing file's directory,
 * or bare/aliased (`@app/foo`) via tsconfig `paths`. Returns null if unresolved
 * (e.g. a real package import with no local file).
 */
function resolveImportPath(
  fromFile: string,
  specifier: string,
  fileExports: Map<string, Set<string>>,
  aliases: TsconfigAliases | null,
): string | null {
  if (specifier.startsWith('.')) {
    const base = path.join(path.dirname(fromFile), specifier).replace(/\\/g, '/');
    return matchFileCandidate(base, fileExports);
  }
  return resolveAliasedImportPath(specifier, fileExports, aliases);
}

function groupReExportsByFile(reExports: ReExportRow[], config: JambavanConfig): Map<string, ReExportRow[]> {
  const byFile = new Map<string, ReExportRow[]>();
  for (const r of reExports) {
    const file = rel(r.filePath, config);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push(r);
  }
  return byFile;
}

/**
 * Expand `fileExports` in place to include names reachable through re-export
 * chains (`export * from './x'`, `export { a as b } from './x'`), so a file
 * that only re-exports a symbol still resolves as a valid import target for
 * callers. Runs as a bounded fixed-point pass (not a single hop) so chains
 * spanning multiple re-exporting files (a → b → c) still resolve, capped at
 * MAX_REEXPORT_DEPTH passes for the same reason INFERRED mentions are capped —
 * bound the work on adversarial/circular re-export graphs.
 */
function expandReExports(
  fileExports: Map<string, Set<string>>,
  byFile: Map<string, ReExportRow[]>,
  aliases: TsconfigAliases | null,
): void {
  if (byFile.size === 0) return;

  for (let depth = 0; depth < MAX_REEXPORT_DEPTH; depth++) {
    let changed = false;
    for (const [file, entries] of byFile) {
      const exportSet = fileExports.get(file) ?? new Set<string>();
      for (const entry of entries) {
        const resolved = resolveImportPath(file, entry.specifier, fileExports, aliases);
        const sourceExports = resolved ? fileExports.get(resolved) : undefined;
        if (!sourceExports) continue;

        if (entry.imported === '*') {
          for (const name of sourceExports) {
            if (!exportSet.has(name)) { exportSet.add(name); changed = true; }
          }
        } else if (sourceExports.has(entry.imported) && !exportSet.has(entry.exported)) {
          exportSet.add(entry.exported);
          changed = true;
        }
      }
      if (exportSet.size > 0) fileExports.set(file, exportSet);
    }
    if (!changed) break;
  }
}

/**
 * Resolve `name` as visible from `file` (which may only re-export it under
 * that name) back to the file+name where it's actually declared. Needed
 * because a caller importing a re-exported/aliased name (e.g. `run` from a
 * barrel that does `export { handler as run } from './origin'`) has no
 * symbol literally named `run` anywhere — name-based lookup alone can't
 * find a target, only a chain walk back to the real declaration can.
 * `directExports` (pre-expansion) distinguishes "really declared here" from
 * "only visible here via re-export", which is what stops the recursion.
 */
function resolveExportOrigin(
  file: string,
  name: string,
  directExports: Map<string, Set<string>>,
  reExportsByFile: Map<string, ReExportRow[]>,
  fileExports: Map<string, Set<string>>,
  aliases: TsconfigAliases | null,
  depth = 0,
): { file: string; name: string } | null {
  if (directExports.get(file)?.has(name)) return { file, name };
  if (depth >= MAX_REEXPORT_DEPTH) return null;

  for (const entry of reExportsByFile.get(file) ?? []) {
    const nextName = entry.imported === '*' ? name : entry.exported === name ? entry.imported : null;
    if (nextName === null) continue;
    const resolvedFile = resolveImportPath(file, entry.specifier, fileExports, aliases);
    if (!resolvedFile) continue;
    const origin = resolveExportOrigin(resolvedFile, nextName, directExports, reExportsByFile, fileExports, aliases, depth + 1);
    if (origin) return origin;
  }
  return null;
}

export function buildSymbolGraph(symbols: Symbol[], config: JambavanConfig, reExports: ReExportRow[] = []): KnowledgeGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  for (const s of symbols) {
    const file = rel(s.filePath, config);
    const fileId = `file:${file}`;
    const id = symbolId(s, config);

    nodes.set(fileId, { id: fileId, label: file, type: 'file', filePath: file });
    nodes.set(id, { id, label: s.name, type: 'symbol', filePath: file, line: s.startLine });
    edges.push({
      from: fileId, to: id, type: 'contains', confidence: 'EXTRACTED',
      reason: `${s.name} defined at ${file}:${s.startLine}`,
    });
  }

  const symbolsByName = new Map<string, string[]>();
  for (const node of nodes.values()) {
    if (node.type !== 'symbol') continue;
    if (!symbolsByName.has(node.label)) symbolsByName.set(node.label, []);
    symbolsByName.get(node.label)!.push(node.id);
  }

  // Build file-level export map for import resolution, then widen it with
  // names only reachable through re-export chains and tsconfig path aliases.
  // directExports is kept as the pre-expansion snapshot: resolveExportOrigin
  // needs to tell "really declared here" from "only visible here via re-export".
  const fileExports = buildFileExportMap(symbols, config);
  const directExports = new Map([...fileExports].map(([f, names]) => [f, new Set(names)]));
  const aliases = loadTsconfigAliases(config.projectRoot);
  const reExportsByFile = groupReExportsByFile(reExports, config);
  expandReExports(fileExports, reExportsByFile, aliases);

  // Map node id → its relative file path for quick lookup
  const nodeFile = new Map<string, string>();
  for (const node of nodes.values()) {
    if (node.filePath) nodeFile.set(node.id, node.filePath);
  }

  // (file, name) → node ids, for resolving a re-export chain's endpoint back to a real symbol node.
  const nodeByFileAndName = new Map<string, string[]>();
  for (const node of nodes.values()) {
    if (node.type !== 'symbol' || !node.filePath) continue;
    const key = `${node.filePath}\0${node.label}`;
    if (!nodeByFileAndName.has(key)) nodeByFileAndName.set(key, []);
    nodeByFileAndName.get(key)!.push(node.id);
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
      if (targets.length === 0) {
        // No symbol is literally named this — it may be a re-exported or
        // aliased name (e.g. `run` from `export { handler as run } from './x'`).
        // Walk the chain back to where it's actually declared.
        const specifier = importSpecifiers.get(ref.name);
        const resolvedFile = specifier ? resolveImportPath(fromFile, specifier, fileExports, aliases) : null;
        const origin = resolvedFile
          ? resolveExportOrigin(resolvedFile, ref.name, directExports, reExportsByFile, fileExports, aliases)
          : null;
        for (const to of origin ? nodeByFileAndName.get(`${origin.file}\0${origin.name}`) ?? [] : []) {
          if (to !== from) {
            edges.push({
              from, to, type: ref.type, confidence: 'EXTRACTED',
              reason: `${ref.type} site — resolved via re-export chain '${specifier}' to ${origin!.file}:${origin!.name}`,
            });
          }
        }
        continue;
      }

      if (targets.length === 1) {
        // Unambiguous — single target
        if (targets[0] !== from) {
          edges.push({
            from, to: targets[0], type: ref.type, confidence: 'EXTRACTED',
            reason: `${ref.type} site — only one symbol named '${ref.name}' in the index`,
          });
        }
        continue;
      }

      // Multiple targets with same name: try import-path resolution first.
      const specifier = importSpecifiers.get(ref.name);
      if (specifier) {
        const resolved = resolveImportPath(fromFile, specifier, fileExports, aliases);
        if (resolved) {
          // The resolved file may only re-export the name (star or same-name
          // named re-export) rather than declare it — chase that back to
          // where it's actually declared before matching against targets.
          const origin = resolveExportOrigin(resolved, ref.name, directExports, reExportsByFile, fileExports, aliases);
          const targetFile = origin?.file ?? resolved;

          let linked = false;
          for (const to of targets) {
            if (to !== from && nodeFile.get(to) === targetFile) {
              edges.push({
                from, to, type: ref.type, confidence: 'EXTRACTED',
                reason: `${ref.type} site — resolved via import specifier '${specifier}' among ${targets.length} same-named symbols`,
              });
              linked = true;
            }
          }
          if (linked) continue;
        }
      }

      // Fallback: prefer same-file target, then fan out to all
      const sameFile = targets.filter(t => t !== from && nodeFile.get(t) === fromFile);
      if (sameFile.length > 0) {
        for (const to of sameFile) {
          edges.push({
            from, to, type: ref.type, confidence: 'EXTRACTED',
            reason: `${ref.type} site — no import info; picked the same-file symbol among ${targets.length} candidates named '${ref.name}'`,
          });
        }
      } else {
        // Fall back: link to all (original behavior)
        for (const to of targets) {
          if (to !== from) {
            edges.push({
              from, to, type: ref.type, confidence: 'EXTRACTED',
              reason: `${ref.type} site — ambiguous fan-out, no import info or same-file match among ${targets.length} candidates named '${ref.name}'`,
            });
          }
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
        if (to !== from) {
          edges.push({
            from, to, type: 'mentions', confidence: 'INFERRED',
            reason: `name mention — '${name}' appears in ${s.name}'s body, ${targets.length} of max ${MAX_INFERRED_MENTION_TARGETS_PER_NAME} candidates`,
          });
        }
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
      if (edge) lines.push(`   via ${edge.type}/${edge.confidence} — ${edge.reason}`);
    }
  }
  return lines.join('\n');
}
