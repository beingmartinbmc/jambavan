/**
 * AST Parser — extract symbols from source files using tree-sitter.
 *
 * Tree-sitter gives us a real parse tree: accurate symbol boundaries,
 * correct handling of nested scopes, and no false positives from comments
 * or string literals that happen to look like declarations.
 *
 * Falls back to the regex extractor when a grammar is not installed,
 * so the server degrades gracefully rather than crashing on unknown languages.
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SymbolReference {
  name: string;
  type: 'call' | 'import' | 'implements';
  /** For import refs: the module specifier (e.g. './moduleA'). */
  specifier?: string;
}

export interface Symbol {
  name: string;
  type: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'export';
  startLine: number;
  endLine: number;
  content: string;
  filePath: string;
  references?: SymbolReference[];
}

/**
 * A cross-file re-export directive: `export * from './x'` (imported/exported
 * both '*') or `export { a, b as c } from './x'` (one row per named binding,
 * `imported` = the name in the source file, `exported` = the name this file
 * re-exposes it as). Local re-exports without a `from` clause (`export { x }`)
 * aren't cross-file and are skipped — `x` is already captured as its own Symbol.
 */
export interface ReExport {
  specifier: string;
  imported: string;
  exported: string;
}

export interface ParsedFile {
  filePath: string;
  symbols: Symbol[];
  language: string;
  reExports: ReExport[];
}

// ── Language map ──────────────────────────────────────────────────────────────

const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'tsx',
  '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
};

// ── Grammar loader (lazy, cached) ─────────────────────────────────────────────

type TreeSitterLanguage = object; // opaque to TS; tree-sitter types it as Language

const _grammarCache = new Map<string, TreeSitterLanguage | null>();

// Records WHY a language fell back to regex, so a native binding failure (ABI
// mismatch) is diagnosable instead of being silently indistinguishable from a
// grammar that was never installed. Keyed by language.
const _backendError = new Map<string, string>();

function loadGrammar(language: string): TreeSitterLanguage | null {
  if (_grammarCache.has(language)) return _grammarCache.get(language)!;

  // Map language name → npm package name for grammar
  const pkgMap: Record<string, string> = {
    typescript:  'tree-sitter-typescript',
    tsx:         'tree-sitter-typescript',
    javascript:  'tree-sitter-javascript',
    python:      'tree-sitter-python',
    go:          'tree-sitter-go',
    rust:        'tree-sitter-rust',
    java:        'tree-sitter-java',
  };

  const pkg = pkgMap[language];
  if (!pkg) { _grammarCache.set(language, null); return null; }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(pkg);
    // tree-sitter-typescript exports { typescript, tsx }; others export the language directly
    const grammar: TreeSitterLanguage =
      language === 'typescript' ? (mod.typescript ?? mod) :
      language === 'tsx'        ? (mod.tsx        ?? mod) :
      mod;
    _grammarCache.set(language, grammar);
    return grammar;
  } catch (err) {
    _backendError.set(language, err instanceof Error ? err.message : String(err));
    _grammarCache.set(language, null);
    return null;
  }
}

// ── Tree-sitter parser (lazy, cached per-language) ────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TSParser = any;

let _Parser: (new () => TSParser) | null | undefined = undefined; // undefined = not yet tried
let _parserError: string | undefined;

function getParser(language: string): TSParser | null {
  if (_Parser === null) return null; // tree-sitter not installed

  if (_Parser === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      _Parser = require('tree-sitter');
    } catch (err) {
      _parserError = err instanceof Error ? err.message : String(err);
      _Parser = null;
      return null;
    }
  }

  const grammar = loadGrammar(language);
  if (!grammar) return null;

  try {
    const parser = new _Parser!();
    parser.setLanguage(grammar);
    return parser;
  } catch (err) {
    // setLanguage throws on an ABI mismatch between tree-sitter and a grammar.
    _backendError.set(language, err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ── Tree-sitter extraction ────────────────────────────────────────────────────

/**
 * Node types that represent top-level declarations in each language.
 * We extract these regardless of nesting depth — inner classes / nested
 * functions are included so the model can find any callable by name.
 */
const DECLARATION_TYPES: Record<string, Set<string>> = {
  typescript: new Set([
    'function_declaration',
    'generator_function_declaration',
    'class_declaration',
    'abstract_class_declaration',
    'interface_declaration',
    'type_alias_declaration',
    'lexical_declaration',      // const/let declarations
    'variable_declaration',
    'method_definition',
    'public_field_definition',
    'export_statement',
  ]),
  tsx: new Set([
    'function_declaration',
    'generator_function_declaration',
    'class_declaration',
    'abstract_class_declaration',
    'interface_declaration',
    'type_alias_declaration',
    'lexical_declaration',
    'variable_declaration',
    'method_definition',
    'public_field_definition',
    'export_statement',
  ]),
  javascript: new Set([
    'function_declaration',
    'generator_function_declaration',
    'class_declaration',
    'lexical_declaration',
    'variable_declaration',
    'method_definition',
    'field_definition',
    'export_statement',
  ]),
  python: new Set([
    'function_definition',
    'decorated_definition',
    'class_definition',
  ]),
  go: new Set([
    'function_declaration',
    'method_declaration',
    // Go names structs/interfaces/aliases under type_declaration → type_spec.
    // Collect type_spec directly so both `type X struct{}` and grouped
    // `type ( A int; B int )` blocks yield one symbol per declared type.
    'type_spec',
  ]),
  rust: new Set([
    'function_item',
    'struct_item',
    'trait_item',
    'impl_item',
    'enum_item',
    'type_item',
  ]),
  java: new Set([
    'method_declaration',
    'class_declaration',
    'interface_declaration',
    'enum_declaration',
    'constructor_declaration',
  ]),
};

/**
 * Extract the identifier name from a tree-sitter node.
 * Handles the variety of ways each language grammar names its identifier child.
 */
function extractName(node: TSParser, language: string): string | null {
  // Most grammars put a child named 'name' on declarations
  const byName = node.childForFieldName?.('name');
  if (byName) return byName.text;

  // export_statement wraps another declaration — recurse into the declaration child
  if (node.type === 'export_statement') {
    const decl =
      node.childForFieldName?.('declaration') ??
      node.children?.find((c: TSParser) =>
        c.type !== 'export' && c.type !== 'default' && c.type !== 'comment'
      );
    if (decl) return extractName(decl, language);
  }

  if (node.type === 'method_definition' || node.type === 'field_definition' || node.type === 'public_field_definition') {
    const property = node.children?.find((c: TSParser) => c.type === 'property_identifier' || c.type === 'private_property_identifier');
    return property?.text ?? null;
  }

  // lexical_declaration / variable_declaration: first declarator's name
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    const declarator = node.children?.find((c: TSParser) =>
      c.type === 'variable_declarator'
    );
    if (declarator) {
      const id = declarator.childForFieldName?.('name') ?? declarator.children?.[0];
      return id?.text ?? null;
    }
  }

  // decorated_definition (Python): recurse into the actual definition
  if (node.type === 'decorated_definition') {
    const def = node.children?.find((c: TSParser) =>
      c.type === 'function_definition' || c.type === 'class_definition'
    );
    if (def) return extractName(def, language);
  }

  return null;
}

/**
 * The declaration an export_statement wraps carries the real kind
 * (class / function / interface / …). Classifying the export_statement node
 * itself would mislabel every exported symbol as 'export', so unwrap first.
 */
function unwrapExport(node: TSParser): TSParser {
  if (node.type !== 'export_statement') return node;
  const decl =
    node.childForFieldName?.('declaration') ??
    node.children?.find((c: TSParser) =>
      c.type !== 'export' && c.type !== 'default' && c.type !== 'comment'
    );
  return decl ? unwrapExport(decl) : node;
}

/**
 * Map tree-sitter node type to our Symbol type.
 */
function nodeToSymbolType(nodeType: string): Symbol['type'] {
  if (/class/.test(nodeType))     return 'class';
  if (/interface|trait/.test(nodeType)) return 'interface';
  if (/type/.test(nodeType))      return 'type';
  if (/variable|lexical|field/.test(nodeType)) return 'variable';
  if (nodeType === 'export_statement') return 'export';
  return 'function';
}

function identifierFromExpression(node: TSParser): string | null {
  if (node.type === 'identifier' || node.type === 'property_identifier' || node.type === 'type_identifier') return node.text;
  const name = node.childForFieldName?.('name');
  if (name) return name.text;
  const property = node.childForFieldName?.('property');
  if (property) return property.text;
  const tail = node.text?.match(/([A-Za-z_$][\w$]*)\s*$/)?.[1];
  return tail ?? null;
}

function collectReferences(root: TSParser): SymbolReference[] {
  // Iterative DFS: stack depth is bounded by AST height, but keeping it on the
  // heap makes pathologically deep trees (generated code) safe from stack overflow.
  const results: SymbolReference[] = [];
  const stack: TSParser[] = [root];

  while (stack.length > 0) {
    const node = stack.pop()!;

    if (node.type === 'call_expression') {
      const name = identifierFromExpression(node.childForFieldName?.('function') ?? node.children?.[0]);
      if (name) results.push({ name, type: 'call' });
    }

    if (/^import/.test(node.type)) {
      for (const child of node.children ?? []) {
        if (/identifier$/.test(child.type) && child.text) results.push({ name: child.text, type: 'import' });
      }
    }

    if (/heritage|extends|implements/.test(node.type)) {
      for (const child of node.children ?? []) {
        const name = identifierFromExpression(child);
        if (name && !/^(extends|implements)$/.test(name)) results.push({ name, type: 'implements' });
      }
    }

    // Reverse push preserves pre-order traversal (matches the old recursion).
    const children = node.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }

  return results;
}

function dedupeReferences(refs: SymbolReference[]): SymbolReference[] {
  const seen = new Set<string>();
  return refs.filter(ref => {
    const key = `${ref.type}:${ref.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Walk the AST and collect all declaration nodes at any depth.
 * We cap depth at 3 to avoid pulling in deeply nested helper lambdas;
 * top-level and class-member declarations are always at depth 0–2.
 */
function collectDeclarations(
  node: TSParser,
  language: string,
  depth = 0,
  results: TSParser[] = [],
): TSParser[] {
  if (depth > 3) return results;
  const types = DECLARATION_TYPES[language];
  if (!types) return results;

  if (types.has(node.type)) {
    results.push(node);
    // Don't recurse into the body of a found declaration — we want top-level only
    // EXCEPT for class bodies (methods inside classes are still useful)
    if (!/class|impl/.test(node.type)) return results;
  }

  for (const child of node.children ?? []) {
    collectDeclarations(child, language, depth + 1, results);
  }
  return results;
}

/**
 * Collect import references from direct children of the file root node.
 * These are module-level import statements (import { X } from './foo').
 * Returns SymbolReference[] with type 'import' for each imported name,
 * including the module specifier string.
 */
function collectFileImports(root: TSParser): SymbolReference[] {
  const results: SymbolReference[] = [];
  for (const child of root.children ?? []) {
    if (!/^import/.test(child.type)) continue;

    // Extract the module specifier from the import statement.
    // It's typically a string/string_fragment node: './moduleA'
    let specifier: string | undefined;
    for (const sub of child.children ?? []) {
      if (/string/.test(sub.type)) {
        // Strip quotes from the string literal text
        const raw = sub.text ?? '';
        specifier = raw.replace(/^['"]|['"]$/g, '');
        break;
      }
      // Some grammars use a "source" field
      if (sub.type === 'source' || sub.type === 'module') {
        const raw = sub.text ?? '';
        specifier = raw.replace(/^['"]|['"]$/g, '');
        break;
      }
    }

    // Collect the locally-bound name for each specifier in the clause
    // (default import, `* as NS`, or `{ X }` / `{ X as Y }`).
    const clause = child.children?.find((c: TSParser) => c.type === 'import_clause');
    const names = clause ? collectImportedNames(clause) : [];

    for (const name of names) {
      results.push({ name, type: 'import', specifier });
    }
  }
  return dedupeReferences(results);
}

/**
 * Recursively find the locally-bound identifier for each import specifier under
 * an import_clause: named (`{ X }`, using `alias` over `name` for `{ X as Y }`),
 * namespace (`* as NS` — the bound name is the trailing identifier), or default
 * (a bare identifier child of import_clause itself).
 */
function collectImportedNames(node: TSParser): string[] {
  if (node.type === 'import_specifier') {
    const bound = node.childForFieldName?.('alias') ?? node.childForFieldName?.('name');
    return bound?.text ? [bound.text] : [];
  }
  if (node.type === 'namespace_import') {
    const idChild = [...(node.children ?? [])].reverse().find((c: TSParser) => /identifier$/.test(c.type));
    return idChild?.text ? [idChild.text] : [];
  }
  if (node.type !== 'import_clause' && /identifier$/.test(node.type)) {
    return node.text ? [node.text] : [];
  }
  const names: string[] = [];
  for (const child of node.children ?? []) names.push(...collectImportedNames(child));
  return names;
}

/**
 * Collect module-level re-export directives from the file root:
 *   export * from './origin';                → { specifier: './origin', imported: '*', exported: '*' }
 *   export { a, b as c } from './other';      → { specifier: './other', imported: 'a', exported: 'a' },
 *                                                { specifier: './other', imported: 'b', exported: 'c' }
 * Only TS/JS grammars have these node shapes; other languages just get [].
 */
function collectFileReExports(root: TSParser): ReExport[] {
  const results: ReExport[] = [];
  for (const child of root.children ?? []) {
    if (child.type !== 'export_statement') continue;

    // A re-export always has a module string ("from './x'"); a local
    // declaration or a bare `export { x }` (no from-clause) doesn't.
    const stringChild = child.children?.find((c: TSParser) => /string/.test(c.type));
    if (!stringChild) continue;
    const specifier = (stringChild.text ?? '').replace(/^['"]|['"]$/g, '');

    if (child.children?.some((c: TSParser) => c.type === '*')) {
      results.push({ specifier, imported: '*', exported: '*' });
      continue;
    }

    const clause = child.children?.find((c: TSParser) => c.type === 'export_clause');
    for (const spec of clause?.children ?? []) {
      if (spec.type !== 'export_specifier') continue;
      const imported = spec.childForFieldName?.('name')?.text;
      const exported = spec.childForFieldName?.('alias')?.text ?? imported;
      if (imported && exported) results.push({ specifier, imported, exported });
    }
  }
  return results;
}

function extractWithTreeSitter(
  source: string,
  filePath: string,
  language: string,
  parser: TSParser,
): { symbols: Symbol[]; reExports: ReExport[] } {
  // node-tree-sitter 0.21 defaults to a 32 KiB native input buffer and throws
  // "Invalid argument" for larger strings unless the caller sizes it explicitly.
  const tree = parser.parse(source, undefined, { bufferSize: source.length + 1 });
  const lines = source.split('\n');
  const declarations = collectDeclarations(tree.rootNode, language);
  const reExports = collectFileReExports(tree.rootNode);

  // Collect module-level import references from the file root so every symbol in
  // this file knows what names are imported (and from where). This makes the
  // graph builder's import-edge resolution reachable for the standard pattern:
  //   import { X } from './foo';  // at module level
  //   export function bar() { X(); }  // X appears as call in bar's body
  const fileImports = collectFileImports(tree.rootNode);

  const symbols: Symbol[] = [];

  for (const node of declarations) {
    const name = extractName(node, language);
    if (!name) continue;

    const startLine = node.startPosition.row + 1; // 1-based
    const endLine   = node.endPosition.row   + 1;
    const content   = lines.slice(startLine - 1, endLine).join('\n');
    const localRefs = dedupeReferences(collectReferences(node)).filter(ref => ref.name !== name);

    // Merge file-level imports that are actually used (called/referenced) in this symbol's body.
    // Only include imports for names that appear in the symbol's own references as 'call' or 'implements',
    // to keep the reference list bounded and relevant.
    const localNames = new Set(localRefs.map(r => r.name));
    const relevantImports = fileImports.filter(imp => localNames.has(imp.name));
    const merged = dedupeReferences([...localRefs, ...relevantImports]);

    symbols.push({
      name,
      type:       nodeToSymbolType(unwrapExport(node).type),
      startLine,
      endLine,
      content,
      filePath,
      references: merged,
    });
  }

  return { symbols, reExports };
}

// ── Regex fallback (kept for languages without a grammar) ─────────────────────

const REGEX_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/m,
    /^(?:export\s+)?class\s+(\w+)/m,
    /^(?:export\s+)?interface\s+(\w+)/m,
    /^(?:export\s+)?type\s+(\w+)\s*=/m,
    /^(?:export\s+)?const\s+(\w+)\s*(?::\s*[\w<>[\],\s]+\s*)?=\s*(?:async\s+)?\(/m,
    /^(?:export\s+)?const\s+(\w+)\s*(?::\s*[\w<>[\],\s]+\s*)?=\s*(?:async\s+)?function/m,
  ],
  tsx: [
    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/m,
    /^(?:export\s+)?class\s+(\w+)/m,
    /^(?:export\s+)?interface\s+(\w+)/m,
    /^(?:export\s+)?type\s+(\w+)\s*=/m,
    /^(?:export\s+)?const\s+(\w+)\s*(?::\s*[\w<>[\],\s]+\s*)?=\s*(?:async\s+)?\(/m,
    /^(?:export\s+)?const\s+(\w+)\s*(?::\s*[\w<>[\],\s]+\s*)?=\s*(?:async\s+)?function/m,
  ],
  javascript: [
    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/m,
    /^(?:export\s+)?class\s+(\w+)/m,
    /^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(/m,
  ],
  python: [
    /^(?:async\s+)?def\s+(\w+)/m,
    /^class\s+(\w+)/m,
  ],
  go: [
    /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/m,
    /^type\s+(\w+)\s+struct/m,
    /^type\s+(\w+)\s+interface/m,
  ],
  rust: [
    /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/m,
    /^(?:pub\s+)?struct\s+(\w+)/m,
    /^(?:pub\s+)?trait\s+(\w+)/m,
    /^(?:pub\s+)?impl\s+(\w+)/m,
  ],
};

function findBlockEnd(lines: string[], startLine: number, language: string): number {
  const isPython = language === 'python';

  if (isPython) {
    const baseIndent = lines[startLine].match(/^(\s*)/)?.[1].length ?? 0;
    for (let i = startLine + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') continue;
      const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (indent <= baseIndent && i > startLine + 1) return i - 1;
    }
    return lines.length - 1;
  }

  let depth = 0;
  let found = false;
  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; found = true; }
      if (ch === '}') { depth--; }
    }
    if (found && depth <= 0) return i;
    if (!found && i > startLine) return i;
  }
  return Math.min(startLine + 50, lines.length - 1);
}

function extractWithRegex(
  source: string,
  filePath: string,
  language: string,
): Symbol[] {
  const lines  = source.split('\n');
  const patterns = REGEX_PATTERNS[language] ?? [];
  const symbols: Symbol[] = [];

  lines.forEach((line, lineIdx) => {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match && match[1]) {
        const endLine = findBlockEnd(lines, lineIdx, language);
        const content = lines.slice(lineIdx, endLine + 1).join('\n');

        let type: Symbol['type'] = 'function';
        if (/\bclass\b/.test(line))         type = 'class';
        else if (/\binterface\b/.test(line)) type = 'interface';
        else if (/\btype\b/.test(line))      type = 'type';
        else if (/\bconst\b|\blet\b|\bvar\b/.test(line)) type = 'variable';

        symbols.push({
          name: match[1],
          type,
          startLine: lineIdx + 1,
          endLine:   endLine + 1,
          content,
          filePath,
        });
        break;
      }
    }
  });

  return symbols;
}

// ── Public API ────────────────────────────────────────────────────────────────

export class ASTParser {
  parseFile(filePath: string): ParsedFile {
    const ext      = path.extname(filePath).toLowerCase();
    const language = LANGUAGE_MAP[ext] ?? 'unknown';

    if (language === 'unknown') {
      return { filePath, symbols: [], language, reExports: [] };
    }

    return this.parseContent(fs.readFileSync(filePath, 'utf-8'), filePath);
  }

  /**
   * Parse source text that is not (or not yet) on disk — e.g. a merge-base
   * revision fetched via `git show <base>:<path>`. Language is inferred from
   * filePath's extension, exactly as parseFile does. Used by the review pack to
   * attribute *deleted* symbols, which no longer exist in the working tree.
   */
  parseContent(source: string, filePath: string): ParsedFile {
    const ext      = path.extname(filePath).toLowerCase();
    const language = LANGUAGE_MAP[ext] ?? 'unknown';

    if (language === 'unknown') {
      return { filePath, symbols: [], language, reExports: [] };
    }

    const parser = getParser(language);
    const { symbols, reExports } = parser
      ? extractWithTreeSitter(source, filePath, language, parser)
      : { symbols: extractWithRegex(source, filePath, language), reExports: [] };

    return { filePath, symbols, language, reExports };
  }

  /** Check if a file extension is supported */
  static canParse(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ext in LANGUAGE_MAP;
  }

  /** Supported extensions without the leading dot, deduped — for glob patterns. */
  static supportedExtensions(): string[] {
    return [...new Set(Object.keys(LANGUAGE_MAP).map(e => e.replace(/^\./, '')))];
  }

  /**
   * Report which languages are backed by tree-sitter vs regex.
   * When a language degrades to regex because a native binding failed to load
   * (e.g. an ABI mismatch after a Node upgrade), `error` carries the reason so
   * the degradation is diagnosable instead of silently masking parser bugs.
   */
  static diagnostics(): { language: string; backend: 'tree-sitter' | 'regex'; error?: string }[] {
    return Object.values(LANGUAGE_MAP)
      .filter((v, i, a) => a.indexOf(v) === i) // unique
      .map(language => {
        const backend = getParser(language) ? 'tree-sitter' as const : 'regex' as const;
        const error = backend === 'regex'
          ? (_parserError ?? _backendError.get(language))
          : undefined;
        return error ? { language, backend, error } : { language, backend };
      });
  }
}
