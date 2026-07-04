import { exec } from 'child_process';
import { promisify } from 'util';
import type { JambavanConfig } from '../config/jambavan.config';
import type { RegisteredTool } from './registry';
import { resolveInsideRoot } from './path-guard';

const execAsync = promisify(exec);

// bash inherits nothing by default — a minimal env avoids leaking the host's
// secrets/tokens into arbitrary shell commands. Opt back in with JAMBAVAN_BASH_INHERIT_ENV=1.
function minimalEnv(): NodeJS.ProcessEnv {
  if (process.env.JAMBAVAN_BASH_INHERIT_ENV === '1') return process.env;
  const keep = ['PATH', 'HOME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'USER'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

// NOT a security boundary. These patterns catch a few obvious footguns
// (typo'd root/project wipes, fork bombs, blind curl|sh). They are trivially
// bypassed by encoding, aliases, scripts, or unlisted commands like
// `find . -delete`. Real isolation must come from running this server inside
// a sandboxed workspace (container / microVM), not from this list.
const FOOTGUN_PATTERNS: RegExp[] = [
  /rm\s+-rf\s+\/(?!\S)/,           // root wipe
  /rm\s+-rf\s+(\.|\.\/|\*)($|\s)/, // project wipe
  /git\s+clean\s+.*-[^\s]*[fx]/,     // destructive untracked-file wipe
  /git\s+reset\s+--hard/,            // destructive reset
  /mkfs\b/,
  /dd\s+if=.*of=\/dev/,
  /:\(\)\{.*\}/,
  /(curl|wget)\b[^|;]*[|;]\s*(sh|bash)\b/, // blind remote script execution
];

export function createBashTool(config: JambavanConfig): RegisteredTool {
  return {
    definition: {
      name: 'bash',
      description: [
        'Execute a shell command in the project root and return stdout + stderr.',
        'Use for builds, tests, git status/diff, installs, and linting.',
        'cwd is confined to the project root unless JAMBAVAN_ALLOW_OUTSIDE_ROOT=1.',
        'Avoid interactive or destructive commands.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run' },
          cwd:     { type: 'string', description: 'Working directory (defaults to project root)' },
          timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
        },
        required: ['command'],
      },
    },
    async handler(input) {
      const command = input['command'] as string;
      const cwd     = resolveInsideRoot(input['cwd'] as string | undefined, config);
      const timeout = (input['timeout'] as number | undefined) ?? 30_000;

      for (const pattern of FOOTGUN_PATTERNS) {
        if (pattern.test(command)) {
          return {
            success: false,
            output: '',
            error: `Blocked footgun (not a security boundary): matched ${pattern}`,
          };
        }
      }

      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd,
          timeout,
          maxBuffer: 10 * 1024 * 1024,
          env: minimalEnv(),
        });
        const output = [stdout, stderr].filter(Boolean).join('\n--- stderr ---\n');
        return { success: true, output: output.trim() };
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        const output = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n');
        return { success: false, output: output.trim(), error: 'Command failed' };
      }
    },
  };
}
