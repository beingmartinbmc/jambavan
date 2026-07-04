import * as fs from 'fs';
import type { JambavanConfig } from '../config/jambavan.config';
import type { RegisteredTool } from './registry';
import { boundedInt } from './registry';
import { resolveInsideRoot } from './path-guard';

/** Refuse to slurp files larger than this into memory (bytes). */
const MAX_READ_BYTES = Math.max(64 * 1024, Number(process.env.JAMBAVAN_MAX_READ_BYTES ?? 5 * 1024 * 1024));

export function createReadFileTool(config: JambavanConfig): RegisteredTool {
  return {
    definition: {
      name: 'read_file',
      description: 'Read the contents of a project file. Paths are confined to the project root unless JAMBAVAN_ALLOW_OUTSIDE_ROOT=1.',
      parameters: {
        type: 'object',
        properties: {
          path:       { type: 'string', description: 'Project-relative or absolute file path' },
          start_line: { type: 'number', description: 'Optional: 1-based start line' },
          end_line:   { type: 'number', description: 'Optional: 1-based end line' },
        },
        required: ['path'],
      },
    },
    async handler(input) {
      const filePath  = resolveInsideRoot(input['path'] as string, config);
      const hasStart  = input['start_line'] !== undefined;
      const hasEnd    = input['end_line']   !== undefined;

      if (!fs.existsSync(filePath)) {
        return { success: false, output: '', error: `File not found: ${filePath}` };
      }

      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        return { success: false, output: '', error: `Not a file: ${filePath}` };
      }
      if (stat.size > MAX_READ_BYTES) {
        return {
          success: false,
          output: '',
          error: `File too large (${stat.size} bytes > ${MAX_READ_BYTES}). Use start_line/end_line or raise JAMBAVAN_MAX_READ_BYTES.`,
        };
      }

      const raw = fs.readFileSync(filePath, 'utf-8');

      if (hasStart || hasEnd) {
        const lines = raw.split('\n');
        const startLine = boundedInt(input['start_line'], { min: 1, max: lines.length, fallback: 1 });
        const endLine   = boundedInt(input['end_line'],   { min: 1, max: lines.length, fallback: lines.length });
        return { success: true, output: lines.slice(startLine - 1, endLine).join('\n') };
      }

      return { success: true, output: raw };
    },
  };
}
