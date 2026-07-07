import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import type { JambavanConfig } from '../config/jambavan.config';
import type { RegisteredTool } from './registry';
import { resolveInsideRoot } from './path-guard';

const execFileAsync = promisify(execFile);
const PWD_MARKER = '\n__JAMBAVAN_PWD__';

// bash inherits nothing by default — a minimal env avoids leaking the host's
// secrets/tokens into arbitrary shell commands. Opt back in with JAMBAVAN_BASH_INHERIT_ENV=1.
function quietEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, NO_COLOR: '1', FORCE_COLOR: '0' };
}

function minimalEnv(): NodeJS.ProcessEnv {
  if (process.env.JAMBAVAN_BASH_INHERIT_ENV === '1') return quietEnv(process.env);
  const keep = ['PATH', 'HOME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'USER'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return quietEnv(env);
}

// NOT a security boundary. These patterns catch a few obvious footguns
// (typo'd root/home/project wipes, fork bombs, blind curl|sh). They are trivially
// bypassed by encoding, aliases, scripts, or unlisted commands like
// `find . -delete`. Real isolation must come from running this server inside
// a sandboxed workspace (container / microVM), not from this list.
const FOOTGUN_PATTERNS: RegExp[] = [
  /rm\s+-rf\s+\/\*?(?=$|\s)/,       // root wipe
  /rm\s+-rf\s+(~|\$HOME)(?=$|\s)/,  // home wipe
  /rm\s+-rf\s+(\.|\.\/|\*)($|\s)/, // project wipe
  /git\s+clean\s+.*-[^\s]*[fx]/,     // destructive untracked-file wipe
  /git\s+reset\s+--hard/,            // destructive reset
  /mkfs\b/,
  /dd\s+if=.*of=\/dev/,
  /:\(\)\{.*\}/,
  /(curl|wget)\b[^|;]*[|;]\s*(sh|bash)\b/, // blind remote script execution
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function projectWipePattern(config: JambavanConfig): RegExp {
  const root = path.resolve(config.projectRoot).replace(/\\/g, '/').replace(/\/$/, '');
  return new RegExp(`rm\\s+-rf\\s+${escapeRegExp(root)}/?(?=$|\\s)`);
}

function splitFinalPwd(stdout: string, cwd: string): { commandStdout: string; finalPwd: string } {
  const markerAt = stdout.lastIndexOf(PWD_MARKER);
  if (markerAt === -1) return { commandStdout: stdout, finalPwd: cwd };
  return {
    commandStdout: stdout.slice(0, markerAt),
    finalPwd: stdout.slice(markerAt + PWD_MARKER.length).trim().split(/\r?\n/)[0] ?? cwd,
  };
}

export function createBashTool(config: JambavanConfig): RegisteredTool {
  return {
    definition: {
      name: 'bash',
      description: [
        'Execute a shell command and return stdout + stderr.',
        'Use for builds, tests, git status/diff, installs, and linting; prefer quiet/no-color commands and filter output at source.',
        'The process starts in cwd, which is confined to the project root unless JAMBAVAN_ALLOW_OUTSIDE_ROOT=1.',
        'This is not a sandbox: commands can still read/write outside via absolute paths or child processes.',
        'Commands that finish outside the project root are reported as failures.',
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

      for (const pattern of [...FOOTGUN_PATTERNS, projectWipePattern(config)]) {
        if (pattern.test(command)) {
          return {
            success: false,
            output: '',
            error: `Blocked footgun (not a security boundary): matched ${pattern}`,
          };
        }
      }

      try {
        const { stdout, stderr } = await execFileAsync(
          '/bin/sh',
          ['-c', `set -e\nexport NO_COLOR=1 FORCE_COLOR=0\n${command}\nprintf '${PWD_MARKER}%s' "$(pwd -P)"`],
          {
            cwd,
            timeout,
            maxBuffer: 10 * 1024 * 1024,
            env: minimalEnv(),
          },
        );
        const { commandStdout, finalPwd } = splitFinalPwd(String(stdout), cwd);
        const output = [commandStdout, stderr ? String(stderr) : ''].filter(Boolean).join('\n--- stderr ---\n');
        try {
          resolveInsideRoot(finalPwd, config, 'final cwd');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { success: false, output: output.trim(), error: message };
        }
        return { success: true, output: output.trim() };
      } catch (err: unknown) {
        const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string; code?: number | string; signal?: string };
        const output = [e.stdout?.toString(), e.stderr?.toString(), e.message].filter(Boolean).join('\n');
        const cause = e.signal ? `signal ${e.signal}` : e.code !== undefined ? `exit code ${e.code}` : 'unknown cause';
        return { success: false, output: output.trim(), error: `Command failed (${cause})` };
      }
    },
  };
}
