import * as fs from 'fs';
import * as path from 'path';
import type { JambavanConfig } from '../config/jambavan.config';
import type { RegisteredTool } from './registry';
import { resolveInsideRoot } from './path-guard';

export function createWriteFileTool(config: JambavanConfig): RegisteredTool {
  return {
    definition: {
      name: 'write_file',
      description: 'Write or overwrite a project file. Creates parent directories. Paths are confined to the project root unless JAMBAVAN_ALLOW_OUTSIDE_ROOT=1.',
      parameters: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'Project-relative or absolute file path to write' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
      },
    },
    async handler(input) {
      const filePath = resolveInsideRoot(input['path'] as string, config);
      const content  = input['content'] as string;

      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf-8');

      return { success: true, output: `Written: ${filePath} (${content.length} chars)` };
    },
  };
}

export function createPatchFileTool(config: JambavanConfig): RegisteredTool {
  return {
    definition: {
      name: 'patch_file',
      description: [
        'Apply a targeted find-and-replace patch to an existing project file.',
        'More token-efficient than rewriting the whole file.',
        'old_text must appear exactly once in the file.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          path:     { type: 'string', description: 'Project-relative or absolute file path to patch' },
          old_text: { type: 'string', description: 'Exact text to replace (must appear exactly once)' },
          new_text: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
    async handler(input) {
      const filePath = resolveInsideRoot(input['path'] as string, config);
      const oldText  = input['old_text'] as string;
      const newText  = input['new_text'] as string;

      if (!fs.existsSync(filePath)) {
        return { success: false, output: '', error: `File not found: ${filePath}` };
      }

      const content     = fs.readFileSync(filePath, 'utf-8');
      const occurrences = content.split(oldText).length - 1;

      if (occurrences === 0) {
        return { success: false, output: '', error: `old_text not found in ${filePath}` };
      }
      if (occurrences > 1) {
        return {
          success: false,
          output: '',
          error: `old_text is ambiguous — found ${occurrences} times in ${filePath}. Make it more specific.`,
        };
      }

      fs.writeFileSync(filePath, content.replace(oldText, newText), 'utf-8');
      return { success: true, output: `Patched: ${filePath}` };
    },
  };
}
