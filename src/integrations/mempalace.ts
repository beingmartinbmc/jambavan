import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REQUIRED_TOOLS = new Set([
  'mempalace_search',
  'mempalace_get_drawer',
  'mempalace_list_drawers',
  'mempalace_get_taxonomy',
  'mempalace_status',
]);
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_CHARS = 1_000_000;
const MAX_CONTENT_CHARS = 100_000;
const MAX_RESULTS = 100;

type JsonObject = Record<string, unknown>;

export interface MemPalaceSearchResult {
  text: string;
  wing: string;
  room: string;
  sourceFile?: string;
  similarity?: number;
}

export interface MemPalaceDrawer {
  id: string;
  wing: string;
  room: string;
  content: string;
}

export interface MemPalaceTaxonomy {
  totalDrawers?: number;
  taxonomy: Record<string, Record<string, number>>;
}

export class MemPalaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemPalaceError';
  }
}

interface Connection {
  client: Client;
  transport: StdioClientTransport;
  closed: boolean;
}

export interface MemPalaceAdapterOptions {
  command?: string;
  timeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
}

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MemPalaceError('MemPalace returned a malformed response.');
  }
  return value as JsonObject;
}

function boundedString(value: unknown, max = MAX_CONTENT_CHARS): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function boundedCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') throw new MemPalaceError('MemPalace returned a malformed response.');
  return value.slice(0, MAX_CONTENT_CHARS);
}

function resultLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(MAX_RESULTS, Math.floor(value!))) : fallback;
}

function safeEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const env = getDefaultEnvironment();
  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith('MEMPALACE_') && value !== undefined) env[name] = value;
  }
  return env;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('timeout') || message.includes('timed out')) return 'MemPalace request timed out.';
  if (message.includes('enoent') || message.includes('not found')) return 'MemPalace is unavailable. Install MemPalace v3.5.0+ or configure JAMBAVAN_MEMPALACE_COMMAND.';
  if (message.includes('closed') || message.includes('eof') || message.includes('connection')) return 'MemPalace connection closed.';
  return 'MemPalace request failed.';
}

/** Explicit, read-only client for the official MemPalace stdio MCP server. */
export class MemPalaceAdapter {
  private connection?: Connection;
  private connecting?: Promise<Connection>;
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: MemPalaceAdapterOptions = {}) {
    this.command = options.command ?? process.env.JAMBAVAN_MEMPALACE_COMMAND ?? 'mempalace-mcp';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.environment = options.environment ?? process.env;
  }

  async search(query: string, opts: { wing?: string; room?: string; limit?: number } = {}): Promise<MemPalaceSearchResult[]> {
    const payload = await this.call('mempalace_search', {
      query: query.slice(0, 250),
      limit: resultLimit(opts.limit, 10),
      ...(opts.wing ? { wing: opts.wing.slice(0, 200) } : {}),
      ...(opts.room ? { room: opts.room.slice(0, 200) } : {}),
    });
    if (!Array.isArray(payload['results'])) throw new MemPalaceError('MemPalace returned a malformed response.');
    const results = payload['results'].slice(0, MAX_RESULTS);
    return results.map(item => {
      const result = asObject(item);
      return {
        text: requiredString(result['text']),
        wing: requiredString(result['wing']).slice(0, 200),
        room: requiredString(result['room']).slice(0, 200),
        ...(result['source_file'] ? { sourceFile: boundedString(result['source_file'], 500) } : {}),
        ...(boundedCount(result['similarity']) !== undefined ? { similarity: boundedCount(result['similarity']) } : {}),
      };
    });
  }

  async listDrawers(opts: { wing?: string; room?: string; limit?: number } = {}): Promise<MemPalaceDrawer[]> {
    const payload = await this.call('mempalace_list_drawers', {
      limit: resultLimit(opts.limit, 20),
      offset: 0,
      ...(opts.wing ? { wing: opts.wing.slice(0, 200) } : {}),
      ...(opts.room ? { room: opts.room.slice(0, 200) } : {}),
    });
    if (!Array.isArray(payload['drawers'])) throw new MemPalaceError('MemPalace returned a malformed response.');
    const drawers = payload['drawers'].slice(0, MAX_RESULTS);
    return drawers.map(item => {
      const drawer = asObject(item);
      return {
        id: requiredString(drawer['drawer_id']).slice(0, 500),
        wing: requiredString(drawer['wing']).slice(0, 200),
        room: requiredString(drawer['room']).slice(0, 200),
        content: requiredString(drawer['content_preview']),
      };
    });
  }

  async getDrawer(id: string): Promise<MemPalaceDrawer | null> {
    const payload = await this.call('mempalace_get_drawer', { drawer_id: id.slice(0, 500) }, true);
    if (typeof payload['error'] === 'string' && payload['error'].toLowerCase().includes('not found')) return null;
    if (typeof payload['error'] === 'string') throw new MemPalaceError('MemPalace tool returned an error.');
    return {
      id: requiredString(payload['drawer_id']).slice(0, 500),
      wing: requiredString(payload['wing']).slice(0, 200),
      room: requiredString(payload['room']).slice(0, 200),
      content: requiredString(payload['content']),
    };
  }

  async taxonomy(): Promise<MemPalaceTaxonomy> {
    const payload = await this.call('mempalace_get_taxonomy', {});
    return { taxonomy: this.parseTaxonomy(payload['taxonomy']) };
  }

  async status(): Promise<MemPalaceTaxonomy> {
    const payload = await this.call('mempalace_status', {});
    const taxonomy = await this.taxonomy();
    return { totalDrawers: boundedCount(payload['total_drawers']), taxonomy: taxonomy.taxonomy };
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.connecting = undefined;
    if (connection) await connection.transport.close().catch(() => undefined);
  }

  private parseTaxonomy(value: unknown): Record<string, Record<string, number>> {
    const raw = asObject(value);
    const taxonomy: Record<string, Record<string, number>> = {};
    for (const [wing, roomsValue] of Object.entries(raw).slice(0, MAX_RESULTS)) {
      const rooms = asObject(roomsValue);
      taxonomy[wing.slice(0, 200)] = Object.fromEntries(
        Object.entries(rooms).slice(0, MAX_RESULTS)
          .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
          .map(([room, count]) => [room.slice(0, 200), count]),
      );
    }
    return taxonomy;
  }

  private async call(tool: string, args: JsonObject, allowPayloadError = false): Promise<JsonObject> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const connection = await this.connect();
      try {
        const result = await connection.client.callTool(
          { name: tool, arguments: args },
          undefined,
          { timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs },
        ) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
        if (result.isError) throw new MemPalaceError('MemPalace tool returned an error.');
        const raw = (result.content ?? [])
          .filter(item => item.type === 'text')
          .map(item => item.text ?? '')
          .join('');
        if (!raw || raw.length > MAX_RESPONSE_CHARS) throw new MemPalaceError('MemPalace returned a malformed response.');
        let decoded: unknown;
        try {
          decoded = JSON.parse(raw) as unknown;
        } catch {
          throw new MemPalaceError('MemPalace returned a malformed response.');
        }
        const payload = asObject(decoded);
        if (!allowPayloadError && typeof payload['error'] === 'string') throw new MemPalaceError('MemPalace tool returned an error.');
        return payload;
      } catch (error) {
        if (attempt === 0 && connection.closed) {
          await this.resetConnection();
          continue;
        }
        if (error instanceof MemPalaceError) throw error;
        throw new MemPalaceError(errorMessage(error));
      }
    }
    throw new MemPalaceError('MemPalace request failed.');
  }

  private async connect(): Promise<Connection> {
    if (this.connection && !this.connection.closed) return this.connection;
    if (this.connecting) return this.connecting;
    this.connecting = this.openConnection();
    try {
      this.connection = await this.connecting;
      return this.connection;
    } finally {
      this.connecting = undefined;
    }
  }

  private async openConnection(): Promise<Connection> {
    if (!this.command.trim() || this.command.includes('\0')) {
      throw new MemPalaceError('JAMBAVAN_MEMPALACE_COMMAND must name one executable.');
    }
    const transport = new StdioClientTransport({
      command: this.command,
      env: safeEnvironment(this.environment),
      stderr: 'pipe',
    });
    transport.stderr?.on('data', () => undefined);
    const client = new Client({ name: 'jambavan-mempalace-reader', version: '1.0.0' }, { capabilities: {} });
    try {
      await client.connect(transport, { timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs });
      const connection: Connection = { client, transport, closed: false };
      const priorClose = transport.onclose;
      transport.onclose = () => {
        connection.closed = true;
        priorClose?.();
      };
      const listed = await client.listTools(undefined, { timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs });
      const names = new Set(listed.tools.map(tool => tool.name));
      const missing = [...REQUIRED_TOOLS].filter(tool => !names.has(tool));
      if (missing.length > 0) {
        await transport.close().catch(() => undefined);
        throw new MemPalaceError(`MemPalace is missing required read capabilities: ${missing.join(', ')}.`);
      }
      return connection;
    } catch (error) {
      await transport.close().catch(() => undefined);
      if (error instanceof MemPalaceError) throw error;
      throw new MemPalaceError(errorMessage(error));
    }
  }

  private async resetConnection(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    if (connection) await connection.transport.close().catch(() => undefined);
  }
}
