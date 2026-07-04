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
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { loadConfig }                    from '../config/jambavan.config';
import { ToolRegistry, boundedInt }      from '../tools/registry';
import { createReadFileTool }            from '../tools/read-file';
import { createWriteFileTool, createPatchFileTool } from '../tools/write-file';
import { createBashTool }                from '../tools/bash';
import { createSearchTool, createListFilesTool } from '../tools/search';
import { JambavanIndex }                   from '../index/indexer';
import { FileWatcher }                   from '../index/watcher';
import { ASTParser }                     from '../index/ast-parser';
import { ContextAssembler }              from '../context/assembler';
import type { ContextChunk }             from '../context/assembler';
import { vibhishanaNitiInstructions, harvestRin, formatRinReport } from '../tools/vibhishana-niti';
import { MEMORY_TOOL_DEFS, buildMemoryHandlers } from '../tools/memory';
import { sankshiptaFile } from '../tools/sankshipta';
import { awakenReport, jambavanInstructions } from '../tools/jambavan';
import { buildSymbolGraph, graphPath, graphQuery, graphReport } from '../knowledge/graph';

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const config    = loadConfig();
const registry  = new ToolRegistry();
const assembler = new ContextAssembler(config);

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

// Index and watcher are created lazily — the server starts cleanly even if
// .jambavan/ doesn't exist yet. jambavan_index creates it on first call.
let jambavanIndex:   JambavanIndex   | undefined;
let fileWatcher:   FileWatcher   | undefined;

function ensureIndex(): JambavanIndex {
  if (!jambavanIndex) jambavanIndex = new JambavanIndex(config);
  return jambavanIndex;
}

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
      properties: {},
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
          description: 'Max symbols to return before token-budget truncation (default: 30)',
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
      'While running, every file save triggers an incremental re-index of just that file (no full rescan).',
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
      'Call jambavan_index first. Edges are structural contains plus inferred symbol-name mentions.',
      'Defaults to the first 5000 indexed symbols; raise symbol_limit for larger repos if needed.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {
        max_nodes:    { type: 'number', description: 'Max hub nodes to show (default: 10).' },
        symbol_limit: { type: 'number', description: 'Max indexed symbols to graph (default: 5000).' },
      },
      required: [],
    },
  },
  {
    name: 'jambavan_graph_query',
    description: [
      'Query the current knowledge graph: find matching nodes and BFS neighbors within a token budget.',
      'Call jambavan_index first. Uses extracted call/import edges where available plus inferred mentions.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {
        query:        { type: 'string', description: 'Symbol/file text to find in the graph.' },
        budget:       { type: 'number', description: 'Max output tokens (default: 2000).' },
        symbol_limit: { type: 'number', description: 'Max indexed symbols to graph (default: 5000).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'jambavan_graph_path',
    description: [
      'Find the shortest path between two graph nodes/symbols using BFS over extracted and inferred edges.',
      'Call jambavan_index first.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {
        from:         { type: 'string', description: 'Start symbol/file query.' },
        to:           { type: 'string', description: 'End symbol/file query.' },
        symbol_limit: { type: 'number', description: 'Max indexed symbols to graph (default: 5000).' },
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
  // Memory tools from OKF bundle definitions
  ...(MEMORY_TOOL_DEFS.map(def => ({
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
  })) as unknown as Tool[]),
];

// ── Server ────────────────────────────────────────────────────────────────────

export async function startServer(): Promise<void> {
  const server = new Server(
    { name: 'jambavan', version: '0.3.0' },
    { capabilities: { tools: {} }, instructions: jambavanInstructions(config) },
  );

  // ── tools/list ─────────────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const registryTools = registry.definitions().map(toMcpTool);
    return { tools: [...NATIVE_TOOLS, ...registryTools] };
  });

  // ── tools/call ─────────────────────────────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const input = args as Record<string, unknown>;

    // ── jambavan_awaken ───────────────────────────────────────────────────────
    if (name === 'jambavan_awaken') {
      return {
        content: [{
          type: 'text',
          text: awakenReport(config, {
            includeMemories: (input['include_memories'] as boolean | undefined) ?? true,
          }),
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
          `Symbols extracted: ${stats.totalSymbols}`,
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
      if (!jambavanIndex) {
        return {
          content: [{
            type: 'text',
            text: 'Index not built yet. Call jambavan_index first.',
          }],
          isError: true,
        };
      }

      const query = input['query'] as string;
      const limit = boundedInt(input['limit'], { min: 1, max: 200, fallback: 30 });
      const results = jambavanIndex.search(query, limit);

      if (results.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No symbols found for: "${query}"\nTry a broader query or call jambavan_index to refresh.`,
          }],
        };
      }

      const chunks: ContextChunk[] = results.map(r => ({
        filePath:  r.symbol.filePath,
        content:   r.symbol.content,
        score:     r.score,
        startLine: r.symbol.startLine,
        endLine:   r.symbol.endLine,
        type:      (r.symbol.type === 'class' ? 'class' : 'function') as ContextChunk['type'],
      }));

      const { contextBlock, usedTokens, includedChunks, droppedChunks } =
        assembler.assemble(chunks);

      const header = [
        `# Jambavan Context: "${query}"`,
        `Symbols: ${includedChunks} included, ${droppedChunks} dropped (budget: ${config.contextTokenBudget} tokens)`,
        `Approximate tokens used: ${usedTokens}`,
        '',
      ].join('\n');

      return { content: [{ type: 'text', text: header + contextBlock }] };
    }

    // ── jambavan_watch ────────────────────────────────────────────────────────
    if (name === 'jambavan_watch') {
      const action = input['action'] as string;

      if (action === 'start') {
        if (!jambavanIndex) {
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
        fileWatcher = new FileWatcher(jambavanIndex, config);
        fileWatcher.start();
        return {
          content: [{
            type: 'text',
            text: [
              'Watcher started.',
              `Watching: ${config.projectRoot}`,
              'Every file save will incrementally update the index automatically.',
            ].join('\n'),
          }],
        };
      }

      if (action === 'stop') {
        if (!fileWatcher?.getStatus().running) {
          return { content: [{ type: 'text', text: 'Watcher is not running.' }] };
        }
        fileWatcher.stop();
        return { content: [{ type: 'text', text: 'Watcher stopped.' }] };
      }

      if (action === 'status') {
        const s = fileWatcher?.getStatus() ?? {
          running:        false,
          filesProcessed: 0,
          lastEvent:      null,
          lastFile:       null,
        };
        const lines = [
          `Running:         ${s.running}`,
          `Files processed: ${s.filesProcessed}`,
          `Last event:      ${s.lastEvent ?? 'none'}`,
          `Last file:       ${s.lastFile  ?? 'none'}`,
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
      try {
        return { content: [{ type: 'text', text: sankshiptaFile(input, config) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Sankshipta failed: ${err}` }], isError: true };
      }
    }

    // ── jambavan_graph_report ─────────────────────────────────────────────────
    if (name === 'jambavan_graph_report') {
      if (!jambavanIndex) {
        return { content: [{ type: 'text', text: 'Index not built yet. Call jambavan_index first.' }], isError: true };
      }
      const max = (input['max_nodes'] as number | undefined) ?? 10;
      const symbolLimit = (input['symbol_limit'] as number | undefined) ?? 5000;
      const graph = buildSymbolGraph(jambavanIndex.getAllSymbols(symbolLimit), config);
      const stats = jambavanIndex.stats();
      const note = stats.symbols > symbolLimit
        ? `\n\nNote: graphed ${symbolLimit} of ${stats.symbols} symbols. Re-run with a higher symbol_limit for full-repo hubs.`
        : '';
      return { content: [{ type: 'text', text: graphReport(graph, max) + note }] };
    }

    // ── jambavan_graph_query / jambavan_graph_path ───────────────────────────────
    if (name === 'jambavan_graph_query' || name === 'jambavan_graph_path') {
      if (!jambavanIndex) {
        return { content: [{ type: 'text', text: 'Index not built yet. Call jambavan_index first.' }], isError: true };
      }
      const symbolLimit = (input['symbol_limit'] as number | undefined) ?? 5000;
      const graph = buildSymbolGraph(jambavanIndex.getAllSymbols(symbolLimit), config);
      const text = name === 'jambavan_graph_query'
        ? graphQuery(graph, String(input['query'] ?? ''), (input['budget'] as number | undefined) ?? 2000)
        : graphPath(graph, String(input['from'] ?? ''), String(input['to'] ?? ''));
      return { content: [{ type: 'text', text }] };
    }

    // ── jambavan_diagnostics ───────────────────────────────────────────────────
    if (name === 'jambavan_diagnostics') {
      const backends = ASTParser.diagnostics();
      const tsBackends    = backends.filter(b => b.backend === 'tree-sitter').map(b => b.language);
      const regexBackends = backends.filter(b => b.backend === 'regex').map(b => b.language);

      const indexStats = jambavanIndex?.stats();
      const lines = [
        '## Jambavan Diagnostics',
        '',
        `Tree-sitter (${tsBackends.length}): ${tsBackends.join(', ') || 'none'}`,
        `Regex fallback (${regexBackends.length}): ${regexBackends.join(', ') || 'none'}`,
        '',
        indexStats
          ? `Index: ${indexStats.files.totalFiles} files · ${indexStats.symbols} symbols`
          : 'Index: not built (call jambavan_index)',
        `Watcher: ${fileWatcher?.getStatus().running ? 'running' : 'stopped'}`,
        `Project root: ${config.projectRoot}`,
      ];

      return { content: [{ type: 'text', text: lines.join('\n') }] };
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

    // ── Delegated: registry tools ────────────────────────────────────────────
    const result = await registry.execute(name, input);

    if (!result.success) {
      return {
        content:  [{ type: 'text', text: result.error ?? 'Tool execution failed' }],
        isError: true,
      };
    }

    return { content: [{ type: 'text', text: result.output }] };
  });

  // ── stdio transport ────────────────────────────────────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(`[jambavan] MCP server ready. Project root: ${config.projectRoot}\n`);
  process.stderr.write(`[jambavan] write_file/patch_file: ${allowWrite ? 'ENABLED' : 'disabled (set JAMBAVAN_ALLOW_WRITE=1)'} · bash: ${allowBash ? 'ENABLED' : 'disabled (set JAMBAVAN_ALLOW_BASH=1)'}\n`);
}
