import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { JambavanConfig } from '../config/jambavan.config';
import type { RegisteredTool } from './registry';
import { resolveInsideRoot } from './path-guard';
import { boundedInt } from './registry';

function run(command: string, args: string[]): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    timeout: 10_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

/** Enforce a GLOBAL line cap — rg/grep only limit matches per file, not overall. */
export function capLines(stdout: string, max: number): string {
  const lines = stdout.split('\n').filter(Boolean);
  if (lines.length === 0) return '(no matches)';
  const capped = lines.slice(0, max);
  if (lines.length > max) capped.push(`… (${lines.length - max} more matches truncated; raise max_results to see them)`);
  return capped.join('\n');
}

export function createSearchTool(config: JambavanConfig): RegisteredTool {
  return {
    definition: {
      name: 'search',
      description: 'Search project files using ripgrep, with grep fallback. Fast regex search. Paths are confined to the project root unless JAMBAVAN_ALLOW_OUTSIDE_ROOT=1.',
      parameters: {
        type: 'object',
        properties: {
          pattern:        { type: 'string',  description: 'Regex pattern to search' },
          path:           { type: 'string',  description: 'Directory or file to search in (default: project root)' },
          case_sensitive: { type: 'boolean', description: 'Case sensitive search (default: false)' },
          file_pattern:   { type: 'string',  description: 'Glob to filter files, e.g. "*.ts"' },
          max_results:    { type: 'number',  description: 'Max matching lines to return (default: 50)' },
        },
        required: ['pattern'],
      },
    },
    async handler(input) {
      const pattern       = input['pattern'] as string;
      const searchPath    = resolveInsideRoot(input['path'] as string | undefined, config);
      const caseSensitive = (input['case_sensitive'] as boolean | undefined) ?? false;
      const filePattern   = input['file_pattern'] as string | undefined;
      const maxResults    = boundedInt(input['max_results'], { min: 1, max: 1000, fallback: 50 });

      const rgArgs = [
        '--line-number',
        '--no-heading',
        '--max-count', String(maxResults),
        '--color', 'never',
        ...(caseSensitive ? [] : ['--ignore-case']),
        ...(filePattern ? ['--glob', filePattern] : []),
        pattern,
        searchPath,
      ];

      const rg = run('rg', rgArgs);
      if (rg.status === 0) return { success: true, output: capLines(rg.stdout, maxResults) };
      if (rg.status === 1) return { success: true, output: '(no matches)' };

      const grepArgs = [
        '-rn',
        ...(caseSensitive ? [] : ['-i']),
        ...(filePattern ? [`--include=${filePattern}`] : []),
        pattern,
        searchPath,
      ];
      const grep = run('grep', grepArgs);
      if (grep.status === 0) return { success: true, output: capLines(grep.stdout, maxResults) };
      if (grep.status === 1) return { success: true, output: '(no matches)' };
      return { success: false, output: '', error: (rg.stderr || grep.stderr || 'Search failed').trim() };
    },
  };
}

export function createListFilesTool(config: JambavanConfig): RegisteredTool {
  return {
    definition: {
      name: 'list_files',
      description: 'List project files in a directory. Paths are confined to the project root unless JAMBAVAN_ALLOW_OUTSIDE_ROOT=1.',
      parameters: {
        type: 'object',
        properties: {
          path:      { type: 'string',  description: 'Directory path (default: project root)' },
          recursive: { type: 'boolean', description: 'List recursively (default: false)' },
          pattern:   { type: 'string',  description: 'Substring filter, e.g. ".ts"' },
        },
        required: [],
      },
    },
    async handler(input) {
      const dirPath   = resolveInsideRoot(input['path'] as string | undefined, config);
      const recursive = (input['recursive'] as boolean | undefined) ?? false;
      const pattern   = input['pattern'] as string | undefined;

      if (!fs.existsSync(dirPath)) {
        return { success: false, output: '', error: `Path not found: ${dirPath}` };
      }

      const stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) {
        return { success: false, output: '', error: `Not a directory: ${dirPath}` };
      }

      function walk(dir: string, depth: number): string[] {
        if (depth > 5) return [];
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const results: string[] = [];
        for (const e of entries) {
          if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
          const full = path.join(dir, e.name);
          if (pattern && !full.includes(pattern)) {
            if (recursive && e.isDirectory()) results.push(...walk(full, depth + 1));
            continue;
          }
          results.push(e.isDirectory() ? `${full}/` : full);
          if (recursive && e.isDirectory()) results.push(...walk(full, depth + 1));
        }
        return results;
      }

      return { success: true, output: walk(dirPath, 0).join('\n') };
    },
  };
}
