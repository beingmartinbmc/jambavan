/**
 * Jambavan memory tools for the OKF-backed memory bundle.
 *
 * Advertised MCP tools (2.0 consolidated eight tools into five):
 *   jambavan_memory_store        — persist a memory as an OKF concept document
 *   jambavan_memory_read         — get by ID, BM25 search, or recall recent
 *   jambavan_memory_forget       — invalidate (keep history) or delete
 *   jambavan_memory_mine_session — mine durable facts from a transcript/log text
 *   jambavan_memory_status       — active-memory statistics by scope
 *
 * The pre-2.0 names (get/search/recall/invalidate/delete) still dispatch via
 * src/mcp/tool-aliases.ts; they are just no longer advertised.
 */

import { MemoryArchive } from '../memory/archive';
import type { JambavanConfig } from '../config/jambavan.config';
import { isUnsafeFallbackRoot } from '../config/jambavan.config';
import { projectScope } from '../memory/project-scope';
import { MemPalaceAdapter, MemPalaceError } from '../integrations/mempalace';
import { boundedInt } from './registry';

type MemoryProvider = 'jambavan' | 'mempalace' | 'all';

function providerFrom(input: Record<string, unknown>, allowAll = true): MemoryProvider {
  const provider = String(input['provider'] ?? 'jambavan');
  const allowed = allowAll ? ['jambavan', 'mempalace', 'all'] : ['jambavan', 'mempalace'];
  if (!allowed.includes(provider)) throw new Error(`Invalid provider: ${provider}.`);
  return provider as MemoryProvider;
}

// ── Tool descriptors ─────────────────────────────────────────────────────────

export const MEMORY_TOOL_DEFS = [
  {
    name: 'jambavan_memory_store',
    description: [
      'Persist a memory as an Open Knowledge Format (OKF) concept document.',
      'Memories are markdown files with YAML frontmatter — human-readable and portable.',
      'Each memory has a title, body (markdown), optional tags, and a scope (e.g. project name).',
      'Memories with the same title in the same scope are overwritten (idempotent).',
      'Returns the OKF concept ID (scope/slug) of the stored document.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {
        title:       { type: 'string',              description: 'Short label for this memory.' },
        body:        { type: 'string',              description: 'Full markdown content to store verbatim.' },
        scope:       { type: 'string',              description: 'Scope / project name. Defaults to the active project, or "global" without a root.' },
        collection:  { type: 'string',              description: 'Logical collection within the scope. Defaults from type.' },
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
    name: 'jambavan_memory_read',
    description: [
      'Read stored memories. Pass id to fetch one document, query to BM25-search, or neither to recall the most recent.',
      'Set provider=mempalace for explicit read-only MemPalace access, or provider=all for separate provider sections;',
      'ordinary reads never start MemPalace. Jambavan scope/collection map to MemPalace wing/room.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {
        id: { type: 'string', description: 'Fetch one memory by OKF concept ID, e.g. "project/why-graphql".' },
        query: { type: 'string', description: 'BM25 search query. Ignored when id is set.' },
        scope: { type: 'string', description: 'Restrict to this scope. Omit to read across scopes.' },
        collection: { type: 'string', description: 'Restrict to one logical collection.' },
        provider: { type: 'string', enum: ['jambavan', 'mempalace', 'all'], description: 'Defaults to jambavan.' },
        limit: { type: 'number', description: 'Max results (default: 10 for search, 20 for recall).' },
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
        scope:  { type: 'string', description: 'Memory scope / project name. Defaults to the active project, or "global" without a root.' },
        collection: { type: 'string', description: 'Logical collection. Defaults to "general".' },
        source: { type: 'string', description: 'Optional source label, e.g. session id or file path.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'jambavan_memory_forget',
    description: [
      'Retire a memory. mode=invalidate marks it superseded but keeps the document for temporal history;',
      'mode=delete (the default) removes it. Provide id for one memory, or scope with delete_scope: true to wipe a scope.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {
        id:           { type: 'string',  description: 'OKF concept ID, e.g. "general/old-decision".' },
        mode:         { type: 'string',  enum: ['delete', 'invalidate'], description: 'Defaults to delete.' },
        reason:       { type: 'string',  description: 'Reason appended to the body when mode=invalidate.' },
        scope:        { type: 'string',  description: 'Scope to wipe (requires delete_scope: true).' },
        delete_scope: { type: 'boolean', description: 'Set true to delete all memories in scope.' },
      },
      required: [],
    },
  },
  {
    name: 'jambavan_memory_status',
    description: [
      'Show active Jambavan counts by scope and collection by default.',
      'Set provider=mempalace or provider=all to explicitly include read-only MemPalace status and taxonomy.',
    ].join(' '),
    inputSchema: {
      type:       'object' as const,
      properties: {
        provider: { type: 'string', enum: ['jambavan', 'mempalace', 'all'], description: 'Show Jambavan, MemPalace, or both in separate sections. Defaults to jambavan.' },
      },
      required:   [],
    },
  },
] as const;

// ── Handlers ─────────────────────────────────────────────────────────────────

export function buildMemoryHandlers(config: JambavanConfig, mempalace = new MemPalaceAdapter()) {
  // Lazy per-call construction (not captured once at build time): handlers are
  // built before the MCP host's roots/list root resolution lands, so a cached
  // instance would use the wrong default project scope and legacy read-through.
  const archive = () => new MemoryArchive(config);
  const defaultScope = () => isUnsafeFallbackRoot(config) ? 'global' : projectScope(config);

  const handlers = {
    jambavan_memory_store(input: Record<string, unknown>): string {
      const title  = String(input['title'] ?? '');
      const body   = String(input['body']  ?? '');
      if (!title || !body) return 'Error: title and body are required.';

      const id = archive().primary.store({
        title,
        body,
        scope:       input['scope']       ? String(input['scope'])       : defaultScope(),
        collection:  input['collection']  ? String(input['collection'])  : undefined,
        type:        input['type']        ? String(input['type'])        : undefined,
        description: input['description'] ? String(input['description']) : undefined,
        tags:        Array.isArray(input['tags']) ? input['tags'].map(String) : undefined,
        source:      input['source']      ? String(input['source'])      : undefined,
        supersedes:  input['supersedes']  ? String(input['supersedes'])  : undefined,
      });
      return `Stored. OKF concept ID: ${id}`;
    },

    async jambavan_memory_get(input: Record<string, unknown>): Promise<string> {
      const id = input['id'] ? String(input['id']) : '';
      if (!id) return 'Error: id is required.';
      if (providerFrom(input, false) === 'mempalace') {
        const drawer = await mempalace.getDrawer(id);
        if (!drawer) return `MemPalace drawer not found: ${id}`;
        return [
          `# MemPalace drawer ${drawer.id}`,
          `wing: ${drawer.wing}  |  room: ${drawer.room}  |  provider: mempalace`,
          '',
          drawer.content,
        ].join('\n');
      }
      const doc = archive().get(id);
      if (!doc) return `Memory not found: ${id}`;
      return [
        `# ${doc.frontmatter.title}`,
        `ID: ${doc.id}  |  scope: ${doc.frontmatter.scope}  |  collection: ${doc.frontmatter.collection}  |  storage: ${doc.archiveSource}`,
        `type: ${doc.frontmatter.type}  |  timestamp: ${doc.frontmatter.timestamp}`,
        doc.frontmatter.tags.length ? `tags: ${doc.frontmatter.tags.join(', ')}` : '',
        '',
        doc.body,
      ].filter(Boolean).join('\n');
    },

    async jambavan_memory_search(input: Record<string, unknown>): Promise<string> {
      const query = String(input['query'] ?? '');
      if (!query) return 'Error: query is required.';
      const provider = providerFrom(input);
      const scope = input['scope'] ? String(input['scope']) : undefined;
      const collection = input['collection'] ? String(input['collection']) : undefined;
      const limit = boundedInt(input['limit'], { min: 1, max: 100, fallback: 10 });
      const results = provider === 'mempalace' ? [] : archive().search(query, {
        scope, collection, limit,
      });
      const local = provider === 'mempalace' ? '' : results.length === 0 ? `No memories found for: "${query}"` : results.map(({ doc, score }) => {
        const preview = doc.body.split('\n').slice(0, 3).join('\n');
        return [
          `## ${doc.frontmatter.title}`,
          `ID: ${doc.id}  |  scope: ${doc.frontmatter.scope}  |  collection: ${doc.frontmatter.collection}  |  storage: ${doc.archiveSource}  |  score: ${score.toFixed(2)}`,
          doc.frontmatter.invalidated ? 'INVALIDATED' : '',
          doc.frontmatter.supersedes ? `supersedes: ${doc.frontmatter.supersedes}` : '',
          doc.frontmatter.tags.length > 0 ? `tags: ${doc.frontmatter.tags.join(', ')}` : '',
          '',
          preview,
          preview.split('\n').length < doc.body.split('\n').length ? '…' : '',
        ].filter(l => l !== undefined).join('\n').trimEnd();
      }).join('\n\n---\n\n');

      if (provider === 'jambavan') return local;
      try {
        const remote = await mempalace.search(query, { wing: scope, room: collection, limit });
        const remoteText = remote.length === 0 ? `No MemPalace drawers found for: "${query}"` : remote.map((result, i) => [
          `## MemPalace result ${i + 1}`,
          `wing: ${result.wing}  |  room: ${result.room}` +
            (result.similarity !== undefined ? `  |  similarity: ${result.similarity.toFixed(3)}` : ''),
          result.sourceFile ? `source: ${result.sourceFile}` : '',
          '',
          result.text,
        ].filter(Boolean).join('\n')).join('\n\n---\n\n');
        return provider === 'mempalace'
          ? remoteText
          : `# Jambavan results\n\n${local}\n\n# MemPalace results\n\n${remoteText}`;
      } catch (error) {
        if (provider === 'mempalace') throw error;
        const warning = error instanceof MemPalaceError ? error.message : 'MemPalace request failed.';
        return `# Jambavan results\n\n${local}\n\n# MemPalace results\n\nWarning: ${warning}`;
      }
    },

    async jambavan_memory_recall(input: Record<string, unknown>): Promise<string> {
      const scope = input['scope'] ? String(input['scope']) : undefined;
      const limit = boundedInt(input['limit'], { min: 1, max: 100, fallback: 20 });
      const collection = input['collection'] ? String(input['collection']) : undefined;
      const provider = providerFrom(input);
      const docs = (provider === 'mempalace' ? [] : archive().list(scope, { collection }))
        .sort((a, b) => b.frontmatter.timestamp.localeCompare(a.frontmatter.timestamp))
        .slice(0, limit);

      const local = provider === 'mempalace' ? '' : docs.length === 0
        ? (scope
          ? `No memories in scope "${scope}".`
          : 'No memories stored yet.')
        : (scope
        ? `# Memories: ${scope} (${docs.length})\n`
        : `# Active Memories (${docs.length})\n`) + '\n' + docs.map(doc =>
        `## ${doc.frontmatter.title}\n` +
        `*${doc.frontmatter.timestamp.slice(0, 10)}* · scope: ${doc.frontmatter.scope}` +
        ` · collection: ${doc.frontmatter.collection} · storage: ${doc.archiveSource}` +
        (doc.frontmatter.invalidated ? ' · INVALIDATED' : '') +
        (doc.frontmatter.supersedes ? ` · supersedes: ${doc.frontmatter.supersedes}` : '') +
        (doc.frontmatter.tags.length > 0 ? ` · tags: ${doc.frontmatter.tags.join(', ')}` : '') +
        `\n\n${doc.body}`
      ).join('\n\n---\n\n');

      if (provider === 'jambavan') return local;
      try {
        const drawers = await mempalace.listDrawers({ wing: scope, room: collection, limit });
        const remote = drawers.length === 0 ? 'No MemPalace drawers found.' : [
          `# MemPalace Drawers (${drawers.length})`,
          '',
          ...drawers.map(drawer => [
            `## ${drawer.id}`,
            `wing: ${drawer.wing}  |  room: ${drawer.room}`,
            '',
            drawer.content,
          ].join('\n')),
        ].join('\n\n---\n\n');
        return provider === 'mempalace'
          ? remote
          : `# Jambavan recall\n\n${local}\n\n# MemPalace recall\n\n${remote}`;
      } catch (error) {
        if (provider === 'mempalace') throw error;
        const warning = error instanceof MemPalaceError ? error.message : 'MemPalace request failed.';
        return `# Jambavan recall\n\n${local}\n\n# MemPalace recall\n\nWarning: ${warning}`;
      }
    },

    jambavan_memory_mine_session(input: Record<string, unknown>): string {
      const text = String(input['text'] ?? '');
      if (!text.trim()) return 'Error: text is required.';

      const scope  = input['scope']  ? String(input['scope'])  : defaultScope();
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
        return archive().primary.store({
          title: titleLine.replace(/^[-*#\s]+/, '').slice(0, 80) || `Session memory ${i + 1}`,
          body: block,
          scope,
          collection: input['collection'] ? String(input['collection']) : undefined,
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
      const ok = archive().primary.invalidate(id, input['reason'] ? String(input['reason']) : undefined);
      return ok ? `Invalidated memory: ${id}` : `Memory not found: ${id}`;
    },

    jambavan_memory_delete(input: Record<string, unknown>): string {
      const id          = input['id']    ? String(input['id'])    : undefined;
      const scope       = input['scope'] ? String(input['scope']) : undefined;
      const deleteScope = Boolean(input['delete_scope']);

      if (deleteScope && scope) {
        const n = archive().primary.deleteByScope(scope);
        return `Deleted ${n} memories from scope "${scope}".`;
      }
      if (id) {
        const ok = archive().primary.delete(id);
        return ok ? `Deleted memory: ${id}` : `Memory not found: ${id}`;
      }
      return 'Provide id (single delete) or scope + delete_scope: true (scope wipe).';
    },

    async jambavan_memory_status(input: Record<string, unknown>): Promise<string> {
      const provider = providerFrom(input);
      let local = '';
      if (provider !== 'mempalace') {
        const memoryArchive = archive();
        const { totalMemories, scopes } = memoryArchive.primary.status();
        const legacyCount = memoryArchive.legacyCount();
        local = totalMemories === 0 && legacyCount === 0 ? 'No memories stored yet.' : [
          `Total memories: ${totalMemories}`,
          `Legacy read-through: ${legacyCount}`,
          '',
          'By scope:',
          ...scopes.flatMap(s => [
            `  ${s.scope}: ${s.count}`,
            ...s.collections.map(c => `    ${c.collection}: ${c.count}`),
          ]),
        ].join('\n');
      }
      if (provider === 'jambavan') return local;
      try {
        const status = await mempalace.status();
        const remote = [
          `Total drawers: ${status.totalDrawers ?? 'unknown'}`,
          '',
          'By wing and room:',
          ...Object.entries(status.taxonomy).flatMap(([wing, rooms]) => [
            `  ${wing}: ${Object.values(rooms).reduce((sum, count) => sum + count, 0)}`,
            ...Object.entries(rooms).map(([room, count]) => `    ${room}: ${count}`),
          ]),
        ].join('\n');
        return provider === 'mempalace'
          ? remote
          : `# Jambavan status\n\n${local}\n\n# MemPalace status\n\n${remote}`;
      } catch (error) {
        if (provider === 'mempalace') throw error;
        const warning = error instanceof MemPalaceError ? error.message : 'MemPalace request failed.';
        return `# Jambavan status\n\n${local}\n\n# MemPalace status\n\nWarning: ${warning}`;
      }
    },
  };

  // ── Consolidated 2.0 entry points ──────────────────────────────────────────
  // Thin routers over the handlers above so the advertised surface shrinks
  // without any read/write behaviour changing. An explicit `action`/`mode`
  // (supplied by a deprecated alias) always wins over argument inference.
  return {
    ...handlers,

    async jambavan_memory_read(input: Record<string, unknown>): Promise<string> {
      const action = String(input['action'] ?? '');
      if (action === 'get' || (!action && input['id'])) return handlers.jambavan_memory_get(input);
      if (action === 'search' || (!action && input['query'])) return handlers.jambavan_memory_search(input);
      if (action && action !== 'recall') {
        return `Error: unknown action "${action}". Use get, search, or recall.`;
      }
      return handlers.jambavan_memory_recall(input);
    },

    jambavan_memory_forget(input: Record<string, unknown>): string {
      const mode = String(input['mode'] ?? 'delete');
      if (mode === 'invalidate') return handlers.jambavan_memory_invalidate(input);
      if (mode !== 'delete') return `Error: unknown mode "${mode}". Use delete or invalidate.`;
      return handlers.jambavan_memory_delete(input);
    },
  };
}
