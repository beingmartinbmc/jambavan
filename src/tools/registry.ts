/**
 * Tool Registry — every file-system and shell capability Jambavan exposes.
 *
 * Tools are registered once at startup and dispatched by the MCP server.
 * Schema follows JSON Schema draft-07 (what MCP / OpenAI tool-call format expects).
 */

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

/** Max characters any tool result may return to the host model (flood guard). */
const MAX_OUTPUT_CHARS = Math.max(1_000, Number(process.env.JAMBAVAN_MAX_OUTPUT_CHARS ?? 100_000));

/** Truncate oversized output so a single tool call can't blow the model's context. */
export function capOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  return (
    output.slice(0, MAX_OUTPUT_CHARS) +
    `\n… (output truncated at ${MAX_OUTPUT_CHARS} chars — narrow the request: use line ranges, max_results, or a tighter path)`
  );
}

/**
 * Coerce untrusted tool input into a safe integer within [min, max].
 * Non-finite / non-numeric input falls back to `fallback`; out-of-range clamps.
 * Trust-boundary guard for host-supplied numeric params.
 */
export function boundedInt(value: unknown, opts: { min: number; max: number; fallback: number }): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return opts.fallback;
  return Math.min(opts.max, Math.max(opts.min, Math.floor(n)));
}

export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    this.tools.set(tool.definition.name, tool);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  all(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  definitions(): ToolDefinition[] {
    return this.all().map(t => t.definition);
  }

  async execute(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, output: '', error: `Unknown tool: ${name}` };
    }
    try {
      const result = await tool.handler(input);
      return result.success ? { ...result, output: capOutput(result.output) } : result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: msg };
    }
  }
}
