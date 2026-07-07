/**
 * Jambavan memory tools — store, search, recall, delete, and status
 * for the OKF-backed memory bundle.
 *
 * MCP tools:
 *   jambavan_memory_store        — persist a memory as an OKF concept document
 *   jambavan_memory_search       — BM25 search across stored memories
 *   jambavan_memory_recall       — load all memories for a scope (session wake-up)
 *   jambavan_memory_mine_session — mine durable facts from a transcript/log text
 *   jambavan_memory_invalidate   — mark a memory superseded/obsolete without deleting
 *   jambavan_memory_delete       — remove a memory by ID or delete an entire scope
 *   jambavan_memory_status       — bundle statistics (total, by scope)
 */

import { MemoryStore } from '../memory/store';
import type { JambavanConfig } from '../config/jambavan.config';

// ── Tool descriptors ─────────────────────────────────────────────────────────

export const MEMORY_TOOL_DEFS = [
  {
    name: 'jambavan_memory_store',
    description: [
      'Persist a memory as an Open Knowledge Format (OKF) concept document.',
      'Memories are markdown files with YAML frontmatter — human-readable, git-diffable, portable.',
      'Each memory has a title, body (markdown), optional tags, and a scope (e.g. project name).',
      'Memories with the same title in the same scope are overwritten (idempotent).',
      'Returns the OKF concept ID (scope/slug) of the stored document.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {
        title:       { type: 'string',              description: 'Short label for this memory.' },
        body:        { type: 'string',              description: 'Full markdown content to store verbatim.' },
        scope:       { type: 'string',              description: 'Scope / project name. Defaults to "general".' },
        type:        { type: 'string',              description: 'OKF concept type. Defaults to "Memory".' },
        description: { type: 'string',              description: 'One-line summary (used in index.md). Defaults to title.' },
        tags:        { type: 'array', items: { type: 'string' }, description: 'Optional tags for filtering.' },
        source:      { type: 'string',              description: 'Optional: source file or session identifier.' },
        supersedes:  { type: 'string',              description: 'Optional OKF concept ID this memory replaces.' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'jambavan_memory_search',
    description: [
      'Search stored memories using BM25 full-text ranking.',
      'Searches across title, description, tags, and body content.',
      'Returns ranked results with score, title, scope, and a body preview.',
      'Optional: filter to a specific scope.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {
        query: { type: 'string', description: 'Natural-language or keyword query.' },
        scope: { type: 'string', description: 'Restrict search to this scope. Omit to search all.' },
        limit: { type: 'number', description: 'Max results to return (default: 10).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'jambavan_memory_recall',
    description: [
      'Recall all memories for a scope — the session wake-up operation.',
      'Returns the full content of every memory in the scope, newest first.',
      'Use at the start of a new session to restore context about a project or topic.',
      'Omit scope to retrieve all memories across all scopes.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {
        scope: { type: 'string', description: 'Scope to recall. Omit for all memories.' },
        limit: { type: 'number', description: 'Max memories to return (default: 20).' },
      },
      required: [],
    },
  },
  {
    name: 'jambavan_memory_mine_session',
    description: [
      'Mine durable facts, decisions, TODOs, and constraints from a pasted session transcript or log.',
      'Stores each extracted item as an OKF memory in the requested scope.',
      'This is deterministic text mining — no summarization or external service.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {
        text:   { type: 'string', description: 'Session transcript, notes, or log text to mine.' },
        scope:  { type: 'string', description: 'Memory scope / project name. Defaults to "general".' },
        source: { type: 'string', description: 'Optional source label, e.g. session id or file path.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'jambavan_memory_invalidate',
    description: [
      'Mark a memory as invalidated/superseded without deleting the OKF document.',
      'Use when a durable fact changed and you want temporal history instead of silent overwrite.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {
        id:     { type: 'string', description: 'OKF concept ID to invalidate (e.g. "general/old-decision").' },
        reason: { type: 'string', description: 'Optional reason appended to the memory body.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'jambavan_memory_delete',
    description: [
      'Delete a memory by its OKF concept ID (scope/slug), or delete all memories in a scope.',
      'Provide id to delete a single memory. Provide scope with delete_scope: true to wipe all memories in that scope.',
      'Returns confirmation with the count of deleted memories.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {
        id:           { type: 'string',  description: 'OKF concept ID to delete (e.g. "general/why-graphql").' },
        scope:        { type: 'string',  description: 'Scope to wipe (requires delete_scope: true).' },
        delete_scope: { type: 'boolean', description: 'Set true to delete all memories in scope.' },
      },
      required: [],
    },
  },
  {
    name: 'jambavan_memory_status',
    description: [
      'Show memory bundle statistics: total memory count and breakdown by scope.',
      'Read-only. Use to understand what is stored before a search or recall.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {},
      required:   [],
    },
  },
] as const;

// ── Handlers ─────────────────────────────────────────────────────────────────

export function buildMemoryHandlers(config: JambavanConfig) {
  // Lazy per-call construction (not captured once at build time): handlers are
  // built before the MCP host's roots/list root resolution lands, so a cached
  // instance would keep pointing at a stale config.memoryDir. Construction is
  // just an mkdirSync — cheap enough to redo per call.
  const store = () => new MemoryStore(config.memoryDir);

  return {
    jambavan_memory_store(input: Record<string, unknown>): string {
      const title  = String(input['title'] ?? '');
      const body   = String(input['body']  ?? '');
      if (!title || !body) return 'Error: title and body are required.';

      const id = store().store({
        title,
        body,
        scope:       input['scope']       ? String(input['scope'])       : undefined,
        type:        input['type']        ? String(input['type'])        : undefined,
        description: input['description'] ? String(input['description']) : undefined,
        tags:        Array.isArray(input['tags']) ? input['tags'].map(String) : undefined,
        source:      input['source']      ? String(input['source'])      : undefined,
        supersedes:  input['supersedes']  ? String(input['supersedes'])  : undefined,
      });
      return `Stored. OKF concept ID: ${id}`;
    },

    jambavan_memory_search(input: Record<string, unknown>): string {
      const query = String(input['query'] ?? '');
      if (!query) return 'Error: query is required.';

      const results = store().search(query, {
        scope: input['scope'] ? String(input['scope']) : undefined,
        limit: input['limit'] ? Number(input['limit']) : undefined,
      });

      if (results.length === 0) return `No memories found for: "${query}"`;

      return results.map(({ doc, score }) => {
        const preview = doc.body.split('\n').slice(0, 3).join('\n');
        return [
          `## ${doc.frontmatter.title}`,
          `ID: ${doc.id}  |  scope: ${doc.frontmatter.scope}  |  score: ${score.toFixed(2)}`,
          doc.frontmatter.invalidated ? 'INVALIDATED' : '',
          doc.frontmatter.supersedes ? `supersedes: ${doc.frontmatter.supersedes}` : '',
          doc.frontmatter.tags.length > 0 ? `tags: ${doc.frontmatter.tags.join(', ')}` : '',
          '',
          preview,
          preview.split('\n').length < doc.body.split('\n').length ? '…' : '',
        ].filter(l => l !== undefined).join('\n').trimEnd();
      }).join('\n\n---\n\n');
    },

    jambavan_memory_recall(input: Record<string, unknown>): string {
      const scope = input['scope'] ? String(input['scope']) : undefined;
      const limit = input['limit'] ? Number(input['limit']) : 20;
      const docs  = store().list(scope)
        .sort((a, b) => b.frontmatter.timestamp.localeCompare(a.frontmatter.timestamp))
        .slice(0, limit);

      if (docs.length === 0) {
        return scope
          ? `No memories in scope "${scope}".`
          : 'No memories stored yet.';
      }

      const header = scope
        ? `# Memories: ${scope} (${docs.length})\n`
        : `# All Memories (${docs.length})\n`;

      return header + '\n' + docs.map(doc =>
        `## ${doc.frontmatter.title}\n` +
        `*${doc.frontmatter.timestamp.slice(0, 10)}* · scope: ${doc.frontmatter.scope}` +
        (doc.frontmatter.invalidated ? ' · INVALIDATED' : '') +
        (doc.frontmatter.supersedes ? ` · supersedes: ${doc.frontmatter.supersedes}` : '') +
        (doc.frontmatter.tags.length > 0 ? ` · tags: ${doc.frontmatter.tags.join(', ')}` : '') +
        `\n\n${doc.body}`
      ).join('\n\n---\n\n');
    },

    jambavan_memory_mine_session(input: Record<string, unknown>): string {
      const text = String(input['text'] ?? '');
      if (!text.trim()) return 'Error: text is required.';

      const scope  = input['scope']  ? String(input['scope'])  : undefined;
      const source = input['source'] ? String(input['source']) : 'session-mine';

      const KEYWORD = /\b(decision|decided|todo|fixme|remember|constraint|invariant|architecture|root cause|bug|follow[- ]?up)\b/i;
      const raw = text.split('\n');

      // Match on individual lines but keep ±1 line of surrounding rationale.
      // Merge overlapping/adjacent windows so shared context isn't stored twice.
      const ranges: Array<[number, number]> = [];
      raw.forEach((line, i) => {
        if (!KEYWORD.test(line)) return;
        const start = Math.max(0, i - 1);
        const end   = Math.min(raw.length - 1, i + 1);
        const last  = ranges[ranges.length - 1];
        if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
        else ranges.push([start, end]);
      });

      const blocks = ranges
        .slice(0, 20)
        .map(([s, e]) => raw.slice(s, e + 1).map(l => l.trim()).filter(Boolean).join('\n'))
        .filter(Boolean);

      if (blocks.length === 0) return 'No durable memory candidates found.';

      const ids = blocks.map((block, i) => {
        // Title from the first keyword-bearing line in the block; body keeps context.
        const titleLine = block.split('\n').find(l => KEYWORD.test(l)) ?? block;
        return store().store({
          title: titleLine.replace(/^[-*#\s]+/, '').slice(0, 80) || `Session memory ${i + 1}`,
          body: block,
          scope,
          source,
          tags: ['session', 'mined'],
          type: 'Memory',
        });
      });

      return `Stored ${ids.length} mined memories:\n${ids.map(id => `- ${id}`).join('\n')}`;
    },

    jambavan_memory_invalidate(input: Record<string, unknown>): string {
      const id = input['id'] ? String(input['id']) : '';
      if (!id) return 'Error: id is required.';
      const ok = store().invalidate(id, input['reason'] ? String(input['reason']) : undefined);
      return ok ? `Invalidated memory: ${id}` : `Memory not found: ${id}`;
    },

    jambavan_memory_delete(input: Record<string, unknown>): string {
      const id          = input['id']    ? String(input['id'])    : undefined;
      const scope       = input['scope'] ? String(input['scope']) : undefined;
      const deleteScope = Boolean(input['delete_scope']);

      if (deleteScope && scope) {
        const n = store().deleteByScope(scope);
        return `Deleted ${n} memories from scope "${scope}".`;
      }
      if (id) {
        const ok = store().delete(id);
        return ok ? `Deleted memory: ${id}` : `Memory not found: ${id}`;
      }
      return 'Provide id (single delete) or scope + delete_scope: true (scope wipe).';
    },

    jambavan_memory_status(_input: Record<string, unknown>): string {
      const { totalMemories, scopes } = store().status();
      if (totalMemories === 0) return 'No memories stored yet.';
      const lines = [
        `Total memories: ${totalMemories}`,
        '',
        'By scope:',
        ...scopes.map(s => `  ${s.scope}: ${s.count}`),
      ];
      return lines.join('\n');
    },
  };
}
