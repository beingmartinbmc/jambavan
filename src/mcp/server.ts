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
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
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
import { resolveToolCall } from './tool-aliases';
import { PROMPTS, PROMPT_TOOL_HANDLERS, getPrompt } from './prompts';
import { detectHost, doctorIssueReport, doctorReport } from '../tools/doctor';
import { ToolRegistry, boundedInt, capOutput } from '../tools/registry';
import { createReadFileTool }            from '../tools/read-file';
import { createWriteFileTool, createPatchFileTool } from '../tools/write-file';
import { createBashTool }                from '../tools/bash';
import { createSearchTool, createListFilesTool } from '../tools/search';
import { JambavanIndex, type SymbolSearchResult } from '../index/indexer';
import { FileWatcher }                   from '../index/watcher';
import { ContextAssembler }              from '../context/assembler';
import type { ContextChunk }             from '../context/assembler';
import { countTokens, truncateToTokenBudget } from '../context/token-counter';
import { harvestRin, formatRinReport }   from '../tools/vibhishana-niti';
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
import { getRecentSymbolChanges, formatRecentChanges } from '../context/diff-enricher';
import { buildTestMap, formatTestAssociations, testAssociationsFor } from '../index/test-map';
import { MemoryArchive } from '../memory/archive';
import { MemPalaceError } from '../integrations/mempalace';

let rootResolutionIssue: string | undefined;

const ROOTLESS_SAFE_TOOLS = new Set([
  'jambavan_awaken',
  'jambavan_doctor',
  // Counsel protocols are static text with no repository access, so they stay
  // available when the project root is unresolved.
  ...Object.keys(PROMPT_TOOL_HANDLERS),
  ...MEMORY_TOOL_DEFS.map(def => def.name),
]);

export function isRootlessSafeTool(name: string): boolean {
  return ROOTLESS_SAFE_TOOLS.has(name);
}

async function memoryReadResult(read: () => Promise<string>): Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}> {
  try {
    return { content: [{ type: 'text', text: await read() }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: error instanceof MemPalaceError ? error.message : 'Memory provider failed.' }],
      isError: true,
    };
  }
}

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

/**
 * Resolve which graph operation a call wants. An explicit `action` wins (a
 * deprecated graph_* alias always pins one); otherwise the arguments decide,
 * so `{ from, to }` means path and `{ query }` means query without ceremony.
 * Returns undefined for an unrecognised explicit action so the caller can
 * fail loudly instead of silently running a report.
 */
export function graphAction(
  input: Record<string, unknown>,
): 'report' | 'query' | 'path' | undefined {
  const explicit = String(input['action'] ?? '');
  if (explicit) {
    return explicit === 'report' || explicit === 'query' || explicit === 'path'
      ? explicit
      : undefined;
  }
  if (input['from'] && input['to']) return 'path';
  if (input['query']) return 'query';
  return 'report';
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
  const matches = new MemoryArchive(config).search(query, {
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
        root: { type: 'string', description: 'Existing absolute directory inside the current fallback root. Re-points a previous tool-input root (needed by hosts that share one server across workspaces); cannot override an env, client-roots, or cwd-project binding.' },
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
        root: { type: 'string', description: 'Existing absolute directory inside the current fallback root. Re-points a previous tool-input root (needed by hosts that share one server across workspaces); cannot override an env, client-roots, or cwd-project binding.' },
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
    name: 'jambavan_debt_ledger',
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
    name: 'jambavan_compress_prompt',
    description: [
      'Compress a markdown/prose file into a shorter form for fewer prompt tokens.',
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
    name: 'jambavan_graph',
    description: [
      'Navigate the code graph built from the current index. Call jambavan_index first.',
      'action=report lists hub nodes and edge-confidence notes; action=query finds matching nodes and their BFS neighbors;',
      'action=path finds the shortest route between two symbols. Action is inferred from the arguments when omitted.',
      'Ambiguous same-name edges are excluded unless include_inferred=true.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {
        action:       { type: 'string', enum: ['report', 'query', 'path'], description: 'Inferred from arguments when omitted.' },
        query:        { type: 'string', description: 'action=query: symbol/file text to find.' },
        from:         { type: 'string', description: 'action=path: start symbol/file.' },
        to:           { type: 'string', description: 'action=path: end symbol/file.' },
        direction:    { type: 'string', enum: ['inbound', 'outbound', 'both'], description: 'action=query: traverse callers, callees, or both (default: both).' },
        max_nodes:    { type: 'number', description: 'action=report: max hub nodes (default: 10).' },
        budget:       { type: 'number', description: 'action=query: max output tokens (default: 2000).' },
        symbol_limit: { type: 'number', description: 'Max indexed symbols to graph (default: 5000; higher costs more).' },
        include_inferred: { type: 'boolean', description: 'Include ambiguous same-name inferred edges (default: false).' },
      },
      required: [],
    },
  },
  {
    name: 'jambavan_doctor',
    description: [
      'One-shot environment health check: root detection source, tree-sitter vs regex parser backends,',
      'write/bash tool gates, token budget, memory dir writability, .gitignore/CI presence, and index/watcher status.',
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
];

// The counsel protocols (root_cause, verify_gate, strategy_plan,
// decompose_task, dev_rules) are deliberately absent: they are static text
// with no repository access, so they ship as MCP prompts instead of tools.
// They remain dispatchable by name for hosts and skills that call them
// directly — see PROMPT_TOOL_HANDLERS and tool-aliases.ts.
function advertisedTools(): Tool[] {
  const native = allowWrite
    ? NATIVE_TOOLS
    : NATIVE_TOOLS.filter(tool => tool.name !== 'jambavan_compress_prompt');
  return [...native, ...registry.definitions().map(toMcpTool)];
}

// ── Server ────────────────────────────────────────────────────────────────────

export async function startServer(injectedTransport?: Transport): Promise<void> {
  const server = new Server(
    { name: 'jambavan', version: pkg.version },
    {
      capabilities: { tools: {}, prompts: {} },
      instructions: 'Call jambavan_awaken first; it reports the resolved project root and current operating protocol.',
    },
  );

  const rootResolution = new RootResolutionGate();
  server.oninitialized = () => rootResolution.start(resolveClientRoots(server, config));

  // ── tools/list ─────────────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // jambavan_compress_prompt mutates files in-place by default, so it is a
    // write tool: keep it off the advertised list unless writes are enabled.
    return { tools: advertisedTools() };
  });

  // ── prompts/list + prompts/get ─────────────────────────────────────────────
  // The counsel protocols live here rather than in tools/list so they cost the
  // host nothing per request. They need no project root and no index.

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const def = getPrompt(request.params.name);
    if (!def) throw new Error(`Unknown prompt: ${request.params.name}`);
    const args = (request.params.arguments ?? {}) as Record<string, string>;
    return {
      description: def.prompt.description,
      messages: [{
        role: 'user' as const,
        content: { type: 'text' as const, text: capOutput(def.render(args)) },
      }],
    };
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
    // Retired pre-2.0 names still dispatch here; they carry any action/mode the
    // merged tool cannot infer from arguments alone.
    const { name, input } = resolveToolCall(requestedName, args as Record<string, unknown>);

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
      if (!isRootlessSafeTool(name)) {
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

    // ── Counsel protocols (also exposed as MCP prompts) ───────────────────────
    const counsel = PROMPT_TOOL_HANDLERS[name];
    if (counsel) {
      return { content: [{ type: 'text', text: counsel(input) }] };
    }

    // ── jambavan_debt_ledger ──────────────────────────────────────────────────
    if (name === 'jambavan_debt_ledger') {
      const { markers } = harvestRin(config);
      return { content: [{ type: 'text', text: formatRinReport(markers, config.projectRoot) }] };
    }

    // ── jambavan_compress_prompt ──────────────────────────────────────────────
    if (name === 'jambavan_compress_prompt') {
      // Mutating tool: refuse unless writes are enabled, even if the name is guessed.
      if (!allowWrite) {
        return {
          content: [{ type: 'text', text: 'jambavan_compress_prompt writes files and is disabled. Set JAMBAVAN_ALLOW_WRITE=1 to enable it.' }],
          isError: true,
        };
      }
      try {
        return { content: [{ type: 'text', text: sankshiptaFile(input, config) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Prompt compression failed: ${err}` }], isError: true };
      }
    }

    // ── jambavan_graph (report | query | path) ────────────────────────────────
    if (name === 'jambavan_graph') {
      const index = loadExistingIndex();
      if (!index) {
        return { content: [{ type: 'text', text: 'Index not built yet. Call jambavan_index first.' }], isError: true };
      }
      const action = graphAction(input);
      if (!action) {
        return {
          content: [{ type: 'text', text: 'Error: unknown action. Use report, query (with query), or path (with from and to).' }],
          isError: true,
        };
      }
      const symbolLimit = boundedInt(input['symbol_limit'], { min: 100, max: 20_000, fallback: 5000 });
      const includeInferred = input['include_inferred'] === true;

      if (action === 'report') {
        const max = boundedInt(input['max_nodes'], { min: 1, max: 100, fallback: 10 });
        const graph = buildSymbolGraph(index.getAllSymbols(symbolLimit), config, index.getAllReExports());
        return {
          content: [{
            type: 'text',
            text: graphReport(graph, max, includeInferred)
              + graphTruncationNote(index.stats().symbols, symbolLimit),
          }],
        };
      }

      const queries = action === 'query'
        ? [String(input['query'] ?? '')]
        : [String(input['from'] ?? ''), String(input['to'] ?? '')];
      const neighborhood = buildGraphNeighborhood(index, config, queries, symbolLimit);
      const direction = ['inbound', 'outbound', 'both'].includes(String(input['direction']))
        ? String(input['direction']) as 'inbound' | 'outbound' | 'both'
        : 'both';
      const text = action === 'query'
        ? graphQuery(
            neighborhood.graph,
            String(input['query'] ?? ''),
            boundedInt(input['budget'], { min: 100, max: 20_000, fallback: 2000 }),
            direction,
            includeInferred,
          )
        : graphPath(neighborhood.graph, String(input['from'] ?? ''), String(input['to'] ?? ''), includeInferred);
      const note = neighborhood.truncated
        ? `\n\nWarning: focused graph expansion stopped at ${neighborhood.symbolCount} symbols. Results may be incomplete.`
        : `\n\nFocused graph neighborhood: ${neighborhood.symbolCount} symbols.`;
      return { content: [{ type: 'text', text: text + note }] };
    }

    // ── jambavan_doctor (absorbed jambavan_diagnostics in 2.0) ────────────────
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
    if (name === 'jambavan_memory_read') {
      return memoryReadResult(() => memoryHandlers.jambavan_memory_read(input));
    }
    if (name === 'jambavan_memory_forget') {
      return { content: [{ type: 'text', text: memoryHandlers.jambavan_memory_forget(input) }] };
    }
    if (name === 'jambavan_memory_mine_session') {
      return { content: [{ type: 'text', text: memoryHandlers.jambavan_memory_mine_session(input) }] };
    }
    if (name === 'jambavan_memory_status') {
      return memoryReadResult(() => memoryHandlers.jambavan_memory_status(input));
    }

    // ── Failure memory tools ─────────────────────────────────────────────────
    if (name === 'jambavan_failure_store') {
      return { content: [{ type: 'text', text: failureHandlers.jambavan_failure_store(input) }] };
    }
    if (name === 'jambavan_failure_search') {
      return { content: [{ type: 'text', text: failureHandlers.jambavan_failure_search(input) }] };
    }

    // ── Session handoff tool ─────────────────────────────────────────────────
    if (name === 'jambavan_session_handoff') {
      return { content: [{ type: 'text', text: sessionHandoffHandlers.jambavan_session_handoff(input) }] };
    }

    // ── Review pack tool ─────────────────────────────────────────────────────
    if (name === 'jambavan_review_pack') {
      return { content: [{ type: 'text', text: reviewPackHandlers.jambavan_review_pack(input) }] };
    }
    if (name === 'jambavan_impact') {
      return { content: [{ type: 'text', text: impactHandlers.jambavan_impact(input) }] };
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
