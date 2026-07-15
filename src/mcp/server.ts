/**
 * Jambavan MCP Server
 *
 * Exposes Jambavan's capabilities — index search, memory, file read/write,
 * bash, and patch — as MCP tools that any MCP-compatible host
 * (Claude Code, Codex CLI, Cursor, Continue) can register and call.
 *
 * Jambavan is NOT an agent. It does not call an LLM.
 * The host model thinks. Jambavan acts.
 *
 * Transport: stdio (default).
 *
 * Registration examples:
 *   Claude Code  → claude mcp add jambavan -- npx -y jambavan
 *   Cursor       → add to .cursor/mcp.json
 *   Codex        → add to codex MCP config
 */

import { Server }               from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport }       from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'url';
import * as fs from 'fs';
import * as path from 'path';

import pkg from '../../package.json';
import {
  loadConfig,
  applyResolvedRoot,
  isUnsafeFallbackRoot,
  resolveToolRoot,
} from '../config/jambavan.config';
import { aliasToolsFor, resolveToolAlias } from './tool-aliases';
import { detectHost, doctorIssueReport, doctorReport } from '../tools/doctor';
import { ToolRegistry, boundedInt, capOutput } from '../tools/registry';
import { createReadFileTool }            from '../tools/read-file';
import { createWriteFileTool, createPatchFileTool } from '../tools/write-file';
import { createBashTool }                from '../tools/bash';
import { createSearchTool, createListFilesTool } from '../tools/search';
import { JambavanIndex, type SymbolSearchResult } from '../index/indexer';
import { FileWatcher }                   from '../index/watcher';
import { ASTParser }                     from '../index/ast-parser';
import { ContextAssembler }              from '../context/assembler';
import type { ContextChunk }             from '../context/assembler';
import { countTokens, truncateToTokenBudget } from '../context/token-counter';
import { vibhishanaNitiInstructions, harvestRin, formatRinReport } from '../tools/vibhishana-niti';
import { MEMORY_TOOL_DEFS, buildMemoryHandlers } from '../tools/memory';
import {
  FAILURE_MEMORY_TOOL_DEFS,
  buildFailureHandlers,
  knownFailureBlock,
  recordAutomaticBashFailure,
  resolveBlockingFailure,
} from '../tools/failure-memory';
import { SESSION_HANDOFF_TOOL_DEFS, buildSessionHandoffHandlers } from '../tools/session-handoff';
import { REVIEW_PACK_TOOL_DEFS, buildReviewPackHandlers } from '../tools/review-pack';
import { IMPACT_TOOL_DEFS, buildImpactHandlers } from '../tools/impact';
import { legacyDaemonNotice } from '../tools/daemon';
import { sankshiptaFile } from '../tools/sankshipta';
import { awakenReport, projectScope } from '../tools/jambavan';
import {
  buildGraphNeighborhood,
  buildSymbolGraph,
  extractedStructuralNeighbors,
  graphPath,
  graphQuery,
  graphReport,
} from '../knowledge/graph';
import { moolKaaranProtocol } from '../tools/mool-kaaran';
import { pramanProtocol } from '../tools/praman';
import { yuktiProtocol } from '../tools/yukti';
import { vibhaajanProtocol } from '../tools/vibhaajan';
import { getRecentSymbolChanges, formatRecentChanges } from '../context/diff-enricher';
import { buildTestMap, formatTestAssociations, testAssociationsFor } from '../index/test-map';
import { MemoryStore } from '../memory/store';

let rootResolutionIssue: string | undefined;

/**
 * Ask the MCP host for its real workspace root via roots/list, if it supports
 * that capability. Fixes hosts that spawn the server with cwd=$HOME (see
 * jambavan.config.ts's findProjectRoot() cwd-walkup fallback).
 * Runs once, right after the client's `initialized` notification arrives —
 * before the model's first tool call in practice, since a local stdio
 * round-trip is far faster than the model deciding to call a tool.
 */
async function resolveClientRoots(server: Server, config: ReturnType<typeof loadConfig>): Promise<void> {
  if (process.env.JAMBAVAN_ROOT) return;
  if (!server.getClientCapabilities()?.roots) return;
  try {
    const { roots } = await server.listRoots();
    const newRoot = selectClientRoot(roots ?? []);
    if (!newRoot) return;
    applyResolvedRoot(config, newRoot);
    rootResolutionIssue = undefined;
  } catch (err) {
    // An explicit tool root can still recover from an unanswered, unsupported,
    // or ambiguous roots/list response. Mark the fallback unresolved so
    // stateful calls fail closed until the user selects one repository.
    rootResolutionIssue = err instanceof Error ? err.message : String(err);
    config.rootSource = 'cwd-fallback';
  }
}

export function selectClientRoot(roots: Array<{ uri: string }>): string | undefined {
  if (roots.length > 1) {
    throw new Error('Jambavan root selection failed: multiple workspace roots require an explicit JAMBAVAN_ROOT.');
  }
  const uri = roots[0]?.uri;
  if (!uri) return undefined;
  if (!uri.startsWith('file://')) {
    throw new Error(`Jambavan root selection failed: unsupported non-file workspace URI "${uri}".`);
  }
  return fileURLToPath(uri);
}

export class RootResolutionGate {
  private ready: Promise<void> = Promise.resolve();
  private error: Error | undefined;

  start(resolution: Promise<void>): void {
    this.error = undefined;
    this.ready = resolution.catch(err => {
      this.error = err instanceof Error ? err : new Error(String(err));
    });
  }

  async wait(): Promise<void> {
    await this.ready;
    if (this.error) throw this.error;
  }
}

function graphTruncationNote(totalSymbols: number, symbolLimit: number): string {
  return totalSymbols > symbolLimit
    ? `\n\nWarning: graph is truncated to ${symbolLimit} of ${totalSymbols} indexed symbols. Results can omit nodes/paths; raise symbol_limit only if you can afford the extra cost.`
    : '';
}

export function hybridContextResults(
  index: JambavanIndex,
  config: ReturnType<typeof loadConfig>,
  query: string,
  limit: number,
): { results: SymbolSearchResult[]; structuralCount: number } {
  const lexical = index.search(query, limit);
  const seen = new Set(lexical.map(result =>
    `${result.symbol.filePath}\0${result.symbol.name}\0${result.symbol.startLine}`));
  const neighbors = extractedStructuralNeighbors(index, config, lexical.map(result => result.symbol), 6)
    .filter(symbol => !seen.has(`${symbol.filePath}\0${symbol.name}\0${symbol.startLine}`));
  const structuralScore = Math.max(0, Math.min(...lexical.map(result => result.score), 1) - 0.5);
  return {
    results: [
      ...lexical,
      ...neighbors.map(symbol => ({ symbol, score: structuralScore })),
    ],
    structuralCount: neighbors.length,
  };
}

export function projectMemoryContext(
  config: ReturnType<typeof loadConfig>,
  query: string,
  budget: number,
): string {
  if (budget <= 0) return '';
  const matches = new MemoryStore(config.memoryDir).search(query, {
    scope: projectScope(config),
    limit: 3,
  });
  if (matches.length === 0) return '';
  const raw = [
    '## Project memory (automatic project-scope matches)',
    ...matches.map(({ doc, score }) => [
      `### ${doc.frontmatter.title} [${doc.frontmatter.type}; score ${score.toFixed(2)}]`,
      doc.body.trim(),
    ].join('\n')),
  ].join('\n\n');
  return truncateToTokenBudget(raw, budget);
}

export function buildContextResponse(
  index: JambavanIndex,
  config: ReturnType<typeof loadConfig>,
  input: Record<string, unknown>,
): string {
  const query = String(input['query'] ?? '');
  const limit = boundedInt(input['limit'], { min: 1, max: 200, fallback: 30 });
  const compressProse = Boolean(input['compress_prose']);
  const includeDiff = Boolean(input['include_diff']);
  const includeTests = Boolean(input['include_tests']);
  const { results, structuralCount } = hybridContextResults(index, config, query, limit);
  const memoryBlock = projectMemoryContext(config, query, Math.floor(config.contextTokenBudget * 0.2));

  if (results.length === 0 && !memoryBlock) {
    return `No symbols or project memories found for: "${query}"\nTry a broader query or call jambavan_index to refresh.`;
  }

  const chunks: ContextChunk[] = results.map(result => ({
    filePath:  result.symbol.filePath,
    content:   result.symbol.content,
    score:     result.score,
    startLine: result.symbol.startLine,
    endLine:   result.symbol.endLine,
    type:      result.symbol.type,
  }));

  const headerReserve = 100;
  const memoryTokens = countTokens(memoryBlock);
  const contentBudget = Math.max(0, config.contextTokenBudget - headerReserve - memoryTokens);
  const enrichmentRequested = includeDiff || includeTests;
  const symbolBudget = enrichmentRequested ? Math.floor(contentBudget * 0.8) : contentBudget;
  const assembler = new ContextAssembler(config);
  const { contextBlock, usedTokens, includedChunks, droppedChunks } =
    assembler.assemble(chunks, { compressProse, budgetOverride: symbolBudget });
  const enrichmentBudget = Math.max(0, contentBudget - usedTokens);

  let diffBlock = '';
  if (includeDiff && enrichmentBudget > 100) {
    const diffs = results.slice(0, 5)
      .map(result => formatRecentChanges(
        getRecentSymbolChanges(
          config,
          result.symbol.filePath,
          result.symbol.startLine,
          result.symbol.endLine,
          2,
        ),
        result.symbol.name,
      ))
      .filter(Boolean);
    if (diffs.length) {
      const diffBudget = includeTests ? Math.floor(enrichmentBudget * 0.5) : enrichmentBudget;
      diffBlock = truncateToTokenBudget('\n\n' + diffs.join('\n\n'), diffBudget);
    }
  }

  let testBlock = '';
  if (includeTests) {
    const remainingBudget = enrichmentBudget - countTokens(diffBlock);
    if (remainingBudget > 50) {
      const allSymbols = index.getAllSymbols();
      if (allSymbols.length > 0) {
        const testMap = buildTestMap(allSymbols, config);
        const testNotes = results.slice(0, 10)
          .map(result => formatTestAssociations(testAssociationsFor(testMap, result.symbol, config)))
          .filter(Boolean);
        if (testNotes.length) {
          testBlock = truncateToTokenBudget('\n\n' + testNotes.join('\n'), remainingBudget);
        }
      }
    }
  }

  const body = [memoryBlock, contextBlock, diffBlock, testBlock].filter(Boolean).join('\n\n');
  const estimatedTokens = Math.min(config.contextTokenBudget, countTokens(body) + headerReserve);
  const header = [
    `# Jambavan Context: "${query}"`,
    `Symbols: ${includedChunks} included, ${droppedChunks} dropped (budget: ${config.contextTokenBudget} tokens)`,
    `Structural candidates added before budgeting: ${structuralCount}`,
    `Approximate tokens used: ${estimatedTokens}`,
    '',
  ].join('\n');
  return truncateToTokenBudget(header + body, config.contextTokenBudget);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const config    = loadConfig();
const registry  = new ToolRegistry();

registry.register(createReadFileTool(config));
registry.register(createSearchTool(config));
registry.register(createListFilesTool(config));

// Mutating / shell tools are OFF by default — a read-only server is the safe
// default for an MCP host driven by an autonomous model. Opt in explicitly.
const allowWrite = process.env.JAMBAVAN_ALLOW_WRITE === '1';
const allowBash  = process.env.JAMBAVAN_ALLOW_BASH === '1';
if (allowWrite) {
  registry.register(createWriteFileTool(config));
  registry.register(createPatchFileTool(config));
}
if (allowBash) {
  registry.register(createBashTool(config));
}

const memoryHandlers = buildMemoryHandlers(config);
const failureHandlers = buildFailureHandlers(config);
const sessionHandoffHandlers = buildSessionHandoffHandlers(config);

// Index and watcher are created lazily — the server starts cleanly even if
// .jambavan/ doesn't exist yet. jambavan_index creates it on first call.
let jambavanIndex:   JambavanIndex   | undefined;
let fileWatcher:   FileWatcher   | undefined;

function ensureIndex(): JambavanIndex {
  if (!jambavanIndex) jambavanIndex = new JambavanIndex(config);
  return jambavanIndex;
}

function loadExistingIndex(): JambavanIndex | undefined {
  if (!jambavanIndex && fs.existsSync(path.join(config.indexDir, 'symbols.db'))) {
    jambavanIndex = new JambavanIndex(config);
  }
  return jambavanIndex;
}

function bindToolRoot(value: unknown): void {
  if (value === undefined) return;
  const root = resolveToolRoot(config, value);
  if (root === config.projectRoot) {
    applyResolvedRoot(config, root, 'tool-input');
    rootResolutionIssue = undefined;
    return;
  }
  fileWatcher?.stop();
  fileWatcher = undefined;
  jambavanIndex?.close();
  jambavanIndex = undefined;
  applyResolvedRoot(config, root, 'tool-input');
  rootResolutionIssue = undefined;
}

const reviewPackHandlers = buildReviewPackHandlers(config, loadExistingIndex);
const impactHandlers = buildImpactHandlers(config, loadExistingIndex);

// ── MCP Tool schema helpers ───────────────────────────────────────────────────

function toMcpTool(
  def: { name: string; description: string; parameters: Record<string, unknown> },
): Tool {
  return {
    name:        def.name,
    description: def.description,
    inputSchema: def.parameters as Tool['inputSchema'],
  };
}

// ── Native tool descriptors ───────────────────────────────────────────────────

const NATIVE_TOOLS: Tool[] = [
  {
    name: 'jambavan_awaken',
    description: [
      'Return the Jambavan operating protocol: recall memory, index/watch code, retrieve context before edits, patch surgically, run checks, and store durable decisions.',
      'Call once at the start of every host session. Includes recent project memories by default.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {
        include_memories: { type: 'boolean', description: 'Include recent memories for this project scope (default: true).' },
        root: { type: 'string', description: 'Existing absolute directory inside the current unresolved fallback root. Cannot override an already fixed env, client-roots, cwd-project, or tool-input binding.' },
      },
      required: [],
    },
  },
  {
    name: 'jambavan_index',
    description: [
      'Build or refresh the Jambavan codebase index.',
      'Parses source files with a tree-sitter AST extractor and stores symbols in a local SQLite database.',
      'Run once per project, then incrementally on file changes.',
      'Returns indexing statistics (files processed, symbols extracted, duration).',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {
        root: { type: 'string', description: 'Existing absolute directory inside the current unresolved fallback root. Cannot override an already fixed env, client-roots, cwd-project, or tool-input binding.' },
      },
      required:   [],
    },
  },
  {
    name: 'jambavan_context',
    description: [
      'Search the Jambavan index for code symbols and snippets most relevant to a query.',
      'Returns a ranked, token-budgeted context block of matching functions, classes, and types.',
      'Inject this block into your prompt to give the model precise, token-efficient codebase knowledge.',
      'Much cheaper than reading whole files — only the relevant symbol bodies are returned.',
      'Automatically includes top project-memory matches and a bounded set of extracted callers/callees under the same token budget.',
      'Options: compress_prose shrinks comments for extra budget; include_diff adds recent git changes; include_tests shows test coverage.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {
        query: {
          type:        'string',
          description: 'Natural-language or identifier query — e.g. "auth middleware", "UserService.login"',
        },
        limit: {
          type:        'number',
          description: 'Max lexical symbols before token-budget truncation; up to 6 extracted structural neighbors may be added (default: 30)',
        },
        compress_prose: {
          type:        'boolean',
          description: 'Compress comments/docstrings in results for more symbol density (default: false)',
        },
        include_diff: {
          type:        'boolean',
          description: 'Include recent git changes for each symbol (default: false)',
        },
        include_tests: {
          type:        'boolean',
          description: 'Include associated test file info for each symbol (default: false)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'jambavan_watch',
    description: [
      'Control the live file watcher that keeps the index in sync as you edit code.',
      'Actions: "start" — begin watching (index must exist first); "stop" — stop watching; "status" — show watcher state.',
      'While running, supported non-ignored source-file changes trigger incremental re-indexing (no full rescan).',
      'Use "start" after jambavan_index, then forget about it — the index stays fresh automatically.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {
        action: {
          type:        'string',
          enum:        ['start', 'stop', 'status'],
          description: '"start" | "stop" | "status"',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'jambavan_vibhishana_niti',
    description: [
      'Activate Vibhishana Niti in the current session: efficient, truthful senior-dev rules.',
      'Returns a concise ruleset: YAGNI-first, stdlib before dependencies, shortest working diff, root-cause fixes.',
      'Levels: "lite" — build what\'s asked, name the leaner option; "full" — the default ladder; "ultra" — deletion extremist.',
      'Inject the returned text into your system prompt or next message.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {
        mode: {
          type:        'string',
          enum:        ['lite', 'full', 'ultra'],
          description: 'Intensity level. Defaults to "full".',
        },
      },
      required: [],
    },
  },
  {
    name: 'jambavan_rin_mochan',
    description: [
      'Harvest every rin marker (lines marked with a ceiling and upgrade path) from the project into a debt ledger.',
      'Groups findings by file and flags any marker with no upgrade trigger — those are the ones that silently rot.',
      'Read-only. Call before a release or refactor sprint.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {},
      required:   [],
    },
  },
  {
    name: 'jambavan_sankshipta',
    description: [
      'Compress markdown/prose into sankshipta (concise) form for fewer prompt tokens.',
      'Preserves fenced code, inline code, URLs, file paths, commands-ish tokens, versions, and env vars verbatim.',
      'Defaults to in-place write with <file>.original.md backup; set in_place=false to preview only.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {
        path:     { type: 'string', description: 'Markdown/prose file path inside project root.' },
        in_place: { type: 'boolean', description: 'Overwrite file with compressed text (default: true).' },
        backup:   { type: 'boolean', description: 'Write <file>.original.md before overwriting (default: true).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'jambavan_graph_report',
    description: [
      'Build a lightweight knowledge graph from the current code index and return hub nodes plus edge confidence notes.',
      'Call jambavan_index first. Inferred ambiguous-name edges are excluded unless include_inferred=true.',
      'Defaults to the first 5000 indexed symbols; higher symbol_limit costs more.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {
        max_nodes:    { type: 'number', description: 'Max hub nodes to show (default: 10).' },
        symbol_limit: { type: 'number', description: 'Max indexed symbols to graph (default: 5000; higher values cost more).' },
        include_inferred: { type: 'boolean', description: 'Include ambiguous same-name inferred edges (default: false).' },
      },
      required: [],
    },
  },
  {
    name: 'jambavan_graph_query',
    description: [
      'Query the current knowledge graph: find matching nodes and BFS neighbors within a token budget.',
      'Call jambavan_index first. Uses extracted edges by default; set include_inferred=true to include ambiguous same-name candidates.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {
        query:        { type: 'string', description: 'Symbol/file text to find in the graph.' },
        budget:       { type: 'number', description: 'Max output tokens (default: 2000).' },
        symbol_limit: { type: 'number', description: 'Max symbols in the query-focused graph neighborhood (default: 5000).' },
        direction:    { type: 'string', enum: ['inbound', 'outbound', 'both'], description: 'Traverse callers, callees, or both (default: both).' },
        include_inferred: { type: 'boolean', description: 'Include ambiguous same-name inferred edges (default: false).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'jambavan_graph_path',
    description: [
      'Find the shortest path between two graph nodes/symbols using BFS over extracted edges.',
      'Call jambavan_index first. Set include_inferred=true to opt into ambiguous same-name edges.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {
        from:         { type: 'string', description: 'Start symbol/file query.' },
        to:           { type: 'string', description: 'End symbol/file query.' },
        symbol_limit: { type: 'number', description: 'Max symbols in the query-focused graph neighborhood (default: 5000).' },
        include_inferred: { type: 'boolean', description: 'Include ambiguous same-name inferred edges (default: false).' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'jambavan_diagnostics',
    description: [
      'Show which languages are backed by tree-sitter (full AST) vs regex fallback,',
      'plus current index statistics.',
      'Useful for verifying the parser setup after a fresh install.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {},
      required:   [],
    },
  },
  {
    name: 'jambavan_doctor',
    description: [
      'One-shot environment health check: root detection source, parser backends, write/bash tool gates,',
      'token budget, memory dir writability, .gitignore/CI presence, and index/watcher status.',
      'Call this first when something feels off (e.g. context results look like the wrong project) —',
      'it catches the most common cause: the MCP host resolving the wrong project root.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {
        issue_report: { type: 'boolean', description: 'Return a copy-ready redacted GitHub issue URL/body without posting it.' },
      },
      required:   [],
    },
  },
  // Memory tools from OKF bundle definitions
  ...(MEMORY_TOOL_DEFS.map(def => ({
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
  })) as unknown as Tool[]),
  // Failure memory tools
  ...(FAILURE_MEMORY_TOOL_DEFS.map(def => ({
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
  })) as unknown as Tool[]),
  // Session handoff tools
  ...(SESSION_HANDOFF_TOOL_DEFS.map(def => ({
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
  })) as unknown as Tool[]),
  // Review pack tool
  ...(REVIEW_PACK_TOOL_DEFS.map(def => ({
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
  })) as unknown as Tool[]),
  ...(IMPACT_TOOL_DEFS.map(def => ({
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
  })) as unknown as Tool[]),
  // ── Counsel tools (discipline protocols) ─────────────────────────────────
  {
    name: 'jambavan_mool_kaaran',
    description: [
      'Return a structured root-cause investigation protocol.',
      'Call BEFORE attempting to fix any bug, test failure, or unexpected behavior.',
      'Prevents guess-and-check thrashing by enforcing observe → compare → hypothesize → fix phases.',
      'If attempts_so_far >= 3, returns an escalation protocol (architecture problem likely).',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {
        symptom:          { type: 'string', description: 'What went wrong — the error message, unexpected behavior, or test failure.' },
        context:          { type: 'string', description: 'Additional context: file paths, recent changes, what you were doing.' },
        attempts_so_far:  { type: 'number', description: 'How many fix attempts have already failed (triggers escalation at 3+).' },
      },
      required: ['symptom'],
    },
  },
  {
    name: 'jambavan_praman',
    description: [
      'Return a verification gate protocol demanding fresh evidence before claiming completion.',
      'Call BEFORE asserting that tests pass, a build succeeds, a bug is fixed, or requirements are met.',
      'Forces: identify proof command → run it → paste output → only then make the claim.',
      'Types: tests, build, fix, requirements, general.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {
        claim: { type: 'string', description: 'What you are about to assert is done or passing.' },
        type:  { type: 'string', enum: ['tests', 'build', 'fix', 'requirements', 'general'], description: 'Kind of verification needed (default: general).' },
      },
      required: ['claim'],
    },
  },
  {
    name: 'jambavan_yukti',
    description: [
      'Return a strategic approach protocol for planning multi-step work.',
      'Call BEFORE starting implementation of any non-trivial task.',
      'Returns phased instructions scaled to task size: small (just do it), medium (2-3 approaches + sequence), large (decompose + checkpoint).',
      'Auto-infers scale from task description if not provided.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {
        task:        { type: 'string', description: 'What you need to accomplish.' },
        constraints: { type: 'string', description: 'Known constraints: time, compatibility, dependencies, scope limits.' },
        scale:       { type: 'string', enum: ['small', 'medium', 'large'], description: 'Task scale. If omitted, auto-inferred from task description.' },
      },
      required: ['task'],
    },
  },
  {
    name: 'jambavan_vibhaajan',
    description: [
      'Return a parallel work decomposition protocol for splitting a task into independent units.',
      'Call when a task has sub-units that can proceed independently (different files, no shared state).',
      'Returns: boundary identification, independence verification, contract definition, merge sequencing.',
      'Works for both multi-agent parallelism and solo context-switching with clean commits.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {
        task:        { type: 'string', description: 'What you need to decompose into parallel work units.' },
        units:       { type: 'number', description: 'Target number of parallel units (optional — protocol helps you find the right number).' },
        constraints: { type: 'string', description: 'Known constraints: shared state, file overlap, ordering requirements.' },
      },
      required: ['task'],
    },
  },
];

function advertisedTools(): Tool[] {
  const native = allowWrite
    ? NATIVE_TOOLS
    : NATIVE_TOOLS.filter(tool => tool.name !== 'jambavan_sankshipta');
  return [...native, ...aliasToolsFor(native), ...registry.definitions().map(toMcpTool)];
}

// ── Server ────────────────────────────────────────────────────────────────────

export async function startServer(injectedTransport?: Transport): Promise<void> {
  const server = new Server(
    { name: 'jambavan', version: pkg.version },
    {
      capabilities: { tools: {} },
      instructions: 'Call jambavan_awaken first; it reports the resolved project root and current operating protocol.',
    },
  );

  const rootResolution = new RootResolutionGate();
  server.oninitialized = () => rootResolution.start(resolveClientRoots(server, config));

  // ── tools/list ─────────────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // jambavan_sankshipta mutates files in-place by default, so it is a write
    // tool: keep it off the advertised list unless writes are explicitly enabled.
    return { tools: advertisedTools() };
  });

  // ── tools/call ─────────────────────────────────────────────────────────────
  // capOutput is applied once here for every tool response. Native-tool branches
  // below don't cap individually (registry.execute() already caps its own path) —
  // one guard here is smaller and can't be missed by a future branch.

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      await rootResolution.wait();
    } catch (err) {
      return {
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
    const result = await handleToolCall(request);
    return {
      ...result,
      content: result.content.map(c =>
        c.type === 'text' ? { ...c, text: capOutput(c.text) } : c,
      ),
    };
  });

  async function handleToolCall(
    request: { params: { name: string; arguments?: Record<string, unknown> } },
  ): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
    const { name: requestedName, arguments: args = {} } = request.params;
    const name = resolveToolAlias(requestedName);
    const input = args as Record<string, unknown>;

    if (name === 'jambavan_awaken' || name === 'jambavan_index') {
      try {
        bindToolRoot(input['root']);
      } catch (err) {
        return {
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    }

    if (isUnsafeFallbackRoot(config)) {
      const safeWithoutRoot = new Set([
        'jambavan_awaken',
        'jambavan_diagnostics',
        'jambavan_doctor',
        'jambavan_vibhishana_niti',
        'jambavan_mool_kaaran',
        'jambavan_praman',
        'jambavan_yukti',
        'jambavan_vibhaajan',
      ]);
      if (!safeWithoutRoot.has(name)) {
        return {
          content: [{
            type: 'text',
            text: 'Project root is unresolved; stateful MCP tools are blocked. Pass an eligible root to jambavan_awaken or jambavan_index, or set JAMBAVAN_ROOT and reconnect.',
          }],
          isError: true,
        };
      }
    }

    // ── jambavan_awaken ───────────────────────────────────────────────────────
    if (name === 'jambavan_awaken') {
      const report = awakenReport(config, {
        includeMemories: (input['include_memories'] as boolean | undefined) ?? true,
      });
      return {
        content: [{
          type: 'text',
          text: rootResolutionIssue ? `${report}\n\nRoot resolution issue: ${rootResolutionIssue}` : report,
        }],
      };
    }

    // ── jambavan_index ────────────────────────────────────────────────────────
    if (name === 'jambavan_index') {
      try {
        const idx   = ensureIndex();
        const stats = await idx.index();
        const text  = [
          `Indexed:          ${stats.indexedFiles} files`,
          `Skipped (unchanged): ${stats.skippedFiles} files`,
          `Failed:           ${stats.failedFiles} files`,
          `Symbols extracted this run: ${stats.indexedSymbols}`,
          `Total indexed symbols: ${stats.totalSymbols}`,
          `Duration:          ${stats.durationMs}ms`,
          `Index stored at:   ${config.indexDir}`,
        ].join('\n');
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return {
          content:  [{ type: 'text', text: `Index failed: ${err}` }],
          isError: true,
        };
      }
    }

    // ── jambavan_context ──────────────────────────────────────────────────────
    if (name === 'jambavan_context') {
      const index = loadExistingIndex();
      if (!index) {
        return {
          content: [{
            type: 'text',
            text: 'Index not built yet. Call jambavan_index first.',
          }],
          isError: true,
        };
      }

      return { content: [{ type: 'text', text: buildContextResponse(index, config, input) }] };
    }

    // ── jambavan_watch ────────────────────────────────────────────────────────
    if (name === 'jambavan_watch') {
      const action = input['action'] as string;

      if (action === 'start') {
        const index = loadExistingIndex();
        if (!index) {
          return {
            content: [{
              type: 'text',
              text: 'Index not built yet. Call jambavan_index first, then start the watcher.',
            }],
            isError: true,
          };
        }
        if (fileWatcher?.getStatus().running) {
          return { content: [{ type: 'text', text: 'Watcher already running.' }] };
        }
        // Refuse to start a second indexer while a pre-1.0 daemon record is
        // present: starting first and warning afterward still double-indexes.
        const legacy = legacyDaemonNotice(config);
        if (legacy) {
          return {
            content: [{ type: 'text', text: `⚠ ${legacy}` }],
            isError: true,
          };
        }
        fileWatcher = new FileWatcher(index, config);
        fileWatcher.start();
        return {
          content: [{
            type: 'text',
            text: [
              'Watcher started.',
              `Watching: ${config.projectRoot}`,
              'Supported non-ignored source-file changes will incrementally update the index.',
            ].join('\n'),
          }],
        };
      }

      if (action === 'stop') {
        if (fileWatcher?.getStatus().running) {
          fileWatcher.stop();
          return { content: [{ type: 'text', text: 'In-process watcher stopped.' }] };
        }
        return { content: [{ type: 'text', text: 'Watcher is not running.' }] };
      }

      if (action === 'status') {
        const s = fileWatcher?.getStatus() ?? {
          running:        false,
          filesProcessed: 0,
          lastEvent:      null,
          lastFile:       null,
        };
        const stats = loadExistingIndex()?.stats();
        const legacy = legacyDaemonNotice(config);
        const lines = [
          `In-process watcher running: ${s.running}`,
          ...(s.running
            ? [
                `Files processed this MCP session: ${s.filesProcessed}`,
                `Last event:      ${s.lastEvent ?? 'none'}`,
                `Last file:       ${s.lastFile  ?? 'none'}`,
              ]
            : []),
          `Indexed state:   ${stats ? `${stats.files.totalFiles} files, ${stats.symbols} symbols` : 'not built'}`,
          ...(legacy ? [`⚠ ${legacy}`] : []),
        ];
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      return {
        content:  [{ type: 'text', text: `Unknown action: "${action}". Use start | stop | status.` }],
        isError: true,
      };
    }

    // ── jambavan_vibhishana_niti ──────────────────────────────────────────────
    if (name === 'jambavan_vibhishana_niti') {
      const mode = input['mode'] as string | undefined;
      return { content: [{ type: 'text', text: vibhishanaNitiInstructions(mode) }] };
    }

    // ── jambavan_rin_mochan ───────────────────────────────────────────────────
    if (name === 'jambavan_rin_mochan') {
      const { markers } = harvestRin(config);
      return { content: [{ type: 'text', text: formatRinReport(markers, config.projectRoot) }] };
    }

    // ── jambavan_sankshipta ────────────────────────────────────────────────────
    if (name === 'jambavan_sankshipta') {
      // Mutating tool: refuse unless writes are enabled, even if the name is guessed.
      if (!allowWrite) {
        return {
          content: [{ type: 'text', text: 'jambavan_sankshipta writes files and is disabled. Set JAMBAVAN_ALLOW_WRITE=1 to enable it.' }],
          isError: true,
        };
      }
      try {
        return { content: [{ type: 'text', text: sankshiptaFile(input, config) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Sankshipta failed: ${err}` }], isError: true };
      }
    }

    // ── jambavan_graph_report ─────────────────────────────────────────────────
    if (name === 'jambavan_graph_report') {
      const index = loadExistingIndex();
      if (!index) {
        return { content: [{ type: 'text', text: 'Index not built yet. Call jambavan_index first.' }], isError: true };
      }
      const max = boundedInt(input['max_nodes'], { min: 1, max: 100, fallback: 10 });
      const symbolLimit = boundedInt(input['symbol_limit'], { min: 100, max: 20_000, fallback: 5000 });
      const graph = buildSymbolGraph(index.getAllSymbols(symbolLimit), config, index.getAllReExports());
      const stats = index.stats();
      return {
        content: [{
          type: 'text',
          text: graphReport(graph, max, input['include_inferred'] === true)
            + graphTruncationNote(stats.symbols, symbolLimit),
        }],
      };
    }

    // ── jambavan_graph_query / jambavan_graph_path ───────────────────────────────
    if (name === 'jambavan_graph_query' || name === 'jambavan_graph_path') {
      const index = loadExistingIndex();
      if (!index) {
        return { content: [{ type: 'text', text: 'Index not built yet. Call jambavan_index first.' }], isError: true };
      }
      const symbolLimit = boundedInt(input['symbol_limit'], { min: 100, max: 20_000, fallback: 5000 });
      const queries = name === 'jambavan_graph_query'
        ? [String(input['query'] ?? '')]
        : [String(input['from'] ?? ''), String(input['to'] ?? '')];
      const neighborhood = buildGraphNeighborhood(index, config, queries, symbolLimit);
      const graph = neighborhood.graph;
      const direction = ['inbound', 'outbound', 'both'].includes(String(input['direction']))
        ? String(input['direction']) as 'inbound' | 'outbound' | 'both'
        : 'both';
      const includeInferred = input['include_inferred'] === true;
      const text = name === 'jambavan_graph_query'
        ? graphQuery(
            graph,
            String(input['query'] ?? ''),
            boundedInt(input['budget'], { min: 100, max: 20_000, fallback: 2000 }),
            direction,
            includeInferred,
          )
        : graphPath(graph, String(input['from'] ?? ''), String(input['to'] ?? ''), includeInferred);
      const note = neighborhood.truncated
        ? `\n\nWarning: focused graph expansion stopped at ${neighborhood.symbolCount} symbols. Results may be incomplete.`
        : `\n\nFocused graph neighborhood: ${neighborhood.symbolCount} symbols.`;
      return { content: [{ type: 'text', text: text + note }] };
    }

    // ── jambavan_diagnostics ───────────────────────────────────────────────────
    if (name === 'jambavan_diagnostics') {
      const backends = ASTParser.diagnostics();
      const tsBackends    = backends.filter(b => b.backend === 'tree-sitter').map(b => b.language);
      const regexBackends = backends.filter(b => b.backend === 'regex').map(b => b.language);
      // A regex fallback that carries an error means a native binding failed to
      // load (e.g. ABI mismatch) — that silently degrades AST accuracy, so make
      // it loud here instead of letting it masquerade as a healthy fallback.
      const degraded = backends.filter(b => b.error);

      const indexStats = loadExistingIndex()?.stats();
      const lines = [
        '## Jambavan Diagnostics',
        '',
        `Tree-sitter (${tsBackends.length}): ${tsBackends.join(', ') || 'none'}`,
        `Regex fallback (${regexBackends.length}): ${regexBackends.join(', ') || 'none'}`,
        ...(degraded.length
          ? ['', '⚠ Native parser DEGRADED to regex — AST accuracy reduced (run `npm rebuild`):',
             ...degraded.map(b => `  ${b.language}: ${b.error}`)]
          : []),
        '',
        indexStats
          ? `Index: ${indexStats.files.totalFiles} files · ${indexStats.symbols} symbols · ${indexStats.failures.length} failures`
          : 'Index: not built (call jambavan_index)',
        ...(indexStats?.failures.map(f => `  ⚠ ${f.filePath}: ${f.error}`) ?? []),
        `Watcher: ${fileWatcher?.getStatus().running ? 'running' : 'stopped'} (in-process)`,
        `Project root: ${config.projectRoot} (source: ${config.rootSource})`,
      ];

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // ── jambavan_doctor ────────────────────────────────────────────────────────
    if (name === 'jambavan_doctor') {
      const index = loadExistingIndex();
      const context = {
        allowWrite: allowWrite,
        allowBash: allowBash,
        indexStats: index
          ? {
              files: index.stats().files.totalFiles,
              symbols: index.stats().symbols,
              failures: index.stats().failures,
            }
          : undefined,
        watcherRunning: fileWatcher?.getStatus().running ?? false,
        toolCount: advertisedTools().length,
        host: detectHost(),
      };
      const text = input['issue_report']
        ? doctorIssueReport(config, context)
        : doctorReport(config, context);
      return { content: [{ type: 'text', text }] };
    }

    // ── Memory tools ─────────────────────────────────────────────────────────
    if (name === 'jambavan_memory_store') {
      return { content: [{ type: 'text', text: memoryHandlers.jambavan_memory_store(input) }] };
    }
    if (name === 'jambavan_memory_search') {
      return { content: [{ type: 'text', text: memoryHandlers.jambavan_memory_search(input) }] };
    }
    if (name === 'jambavan_memory_recall') {
      return { content: [{ type: 'text', text: memoryHandlers.jambavan_memory_recall(input) }] };
    }
    if (name === 'jambavan_memory_mine_session') {
      return { content: [{ type: 'text', text: memoryHandlers.jambavan_memory_mine_session(input) }] };
    }
    if (name === 'jambavan_memory_invalidate') {
      return { content: [{ type: 'text', text: memoryHandlers.jambavan_memory_invalidate(input) }] };
    }
    if (name === 'jambavan_memory_delete') {
      return { content: [{ type: 'text', text: memoryHandlers.jambavan_memory_delete(input) }] };
    }
    if (name === 'jambavan_memory_status') {
      return { content: [{ type: 'text', text: memoryHandlers.jambavan_memory_status(input) }] };
    }

    // ── Failure memory tools ─────────────────────────────────────────────────
    if (name === 'jambavan_failure_store') {
      return { content: [{ type: 'text', text: failureHandlers.jambavan_failure_store(input) }] };
    }
    if (name === 'jambavan_failure_search') {
      return { content: [{ type: 'text', text: failureHandlers.jambavan_failure_search(input) }] };
    }

    // ── Session handoff tools ────────────────────────────────────────────────
    if (name === 'jambavan_session_export') {
      return { content: [{ type: 'text', text: sessionHandoffHandlers.jambavan_session_export(input) }] };
    }
    if (name === 'jambavan_session_import') {
      return { content: [{ type: 'text', text: sessionHandoffHandlers.jambavan_session_import(input) }] };
    }

    // ── Review pack tool ─────────────────────────────────────────────────────
    if (name === 'jambavan_review_pack') {
      return { content: [{ type: 'text', text: reviewPackHandlers.jambavan_review_pack(input) }] };
    }
    if (name === 'jambavan_impact') {
      return { content: [{ type: 'text', text: impactHandlers.jambavan_impact(input) }] };
    }

    // ── Counsel tools (discipline protocols) ─────────────────────────────────
    if (name === 'jambavan_mool_kaaran') {
      return { content: [{ type: 'text', text: moolKaaranProtocol(input) }] };
    }
    if (name === 'jambavan_praman') {
      return { content: [{ type: 'text', text: pramanProtocol(input) }] };
    }
    if (name === 'jambavan_yukti') {
      return { content: [{ type: 'text', text: yuktiProtocol(input) }] };
    }
    if (name === 'jambavan_vibhaajan') {
      return { content: [{ type: 'text', text: vibhaajanProtocol(input) }] };
    }

    // ── Delegated: registry tools ────────────────────────────────────────────
    const bashRegistered = name === 'bash' && Boolean(registry.get('bash'));
    if (bashRegistered) {
      const knownFailure = knownFailureBlock(config, input);
      if (knownFailure) {
        return {
          content: [{
            type: 'text',
            text: [
              `Blocked known unresolved failure for this exact command (${knownFailure.id}).`,
              `Do not retry: ${knownFailure.advice}`,
              'Change the conditions first, then set retry_known_failure=true for one deliberate retry.',
            ].join('\n'),
          }],
          isError: true,
        };
      }
    }

    const result = await registry.execute(name, input);

    if (!result.success) {
      // Preserve captured stdout/stderr on failure — for a debugging tool,
      // the generic error string alone (e.g. "Command failed") is useless.
      const detail = result.output
        ? `${result.error ?? 'Tool execution failed'}\n${result.output}`
        : (result.error ?? 'Tool execution failed');

      let failureNote = '';
      if (bashRegistered) {
        try {
          const recorded = recordAutomaticBashFailure(
            config,
            String(input['command'] ?? ''),
            detail,
          );
          failureNote = `\n\nFailureRecord ${recorded.stored ? 'stored' : 'already exists'}: ${recorded.id}`;
        } catch {
          failureNote = '\n\nWarning: command failed and its automatic FailureRecord could not be stored.';
        }
      }

      return {
        content:  [{ type: 'text', text: detail + failureNote }],
        isError: true,
      };
    }

    if (bashRegistered) {
      const resolved = resolveBlockingFailure(config, String(input['command'] ?? ''));
      const note = resolved ? `\n\nResolved prior FailureRecord after successful run: ${resolved}` : '';
      return { content: [{ type: 'text', text: result.output + note }] };
    }

    return { content: [{ type: 'text', text: result.output }] };
  }

  // ── transport ──────────────────────────────────────────────────────────────
  // Defaults to stdio (how every MCP host launches Jambavan). An injected
  // transport lets an in-process test drive the real tools/call dispatch through
  // the SDK without spawning a subprocess.
  const transport = injectedTransport ?? new StdioServerTransport();
  await server.connect(transport);

  if (!injectedTransport) {
    process.stderr.write(`[jambavan] MCP server ready. Project root: ${config.projectRoot}\n`);
    process.stderr.write(`[jambavan] write_file/patch_file: ${allowWrite ? 'ENABLED' : 'disabled (set JAMBAVAN_ALLOW_WRITE=1)'} · bash: ${allowBash ? 'ENABLED' : 'disabled (set JAMBAVAN_ALLOW_BASH=1)'}\n`);
  }
}
