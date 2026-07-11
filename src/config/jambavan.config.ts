import * as path from 'path';
import * as fs from 'fs';

// rin: host launch env only; add opt-in project config when users need persistent settings.
// Auto-ingesting .env secrets into process.env is a leak vector for an MCP server.

/**
 * Walk up the directory tree from cwd to find the project root.
 * Identified by the presence of package.json or .git.
 */
function findProjectRoot(): string {
  let dir = process.cwd();
  while (dir !== path.parse(dir).root) {
    if (
      fs.existsSync(path.join(dir, '.git')) ||
      fs.existsSync(path.join(dir, 'package.json'))
    ) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

/** Where projectRoot came from — surfaced by jambavan_doctor to explain root confusion. */
export type RootSource = 'env' | 'client-roots' | 'cwd-fallback';

export interface JambavanConfig {
  /** Absolute path to the project being indexed/served */
  projectRoot: string;
  /** Where the .jambavan/ index directory lives */
  indexDir: string;
  /** Where OKF memory documents live (defaults to <indexDir>/memory; set JAMBAVAN_MEMORY_HOME for shared palace) */
  memoryDir: string;
  /** Token budget for context assembly (injected into tool results) */
  contextTokenBudget: number;
  /** File / directory patterns to skip during indexing */
  ignore: string[];
  /** How projectRoot was determined. Mutated in place by applyResolvedRoot(). */
  rootSource: RootSource;
  /** Optional clone-independent memory scope from JAMBAVAN_SCOPE. */
  scope?: string;
}

function validateScope(scope: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(scope)) {
    throw new Error('Invalid JAMBAVAN_SCOPE: use a lowercase slug of 1-80 letters, numbers, or hyphens.');
  }
  return scope;
}

export function loadConfig(overrides: Partial<JambavanConfig> = {}): JambavanConfig {
  const envRoot = process.env.JAMBAVAN_ROOT;
  const projectRoot = envRoot ?? findProjectRoot();
  const rootSource: RootSource = envRoot ? 'env' : 'cwd-fallback';
  const scope = overrides.scope ?? process.env.JAMBAVAN_SCOPE;

  const indexDir = path.join(projectRoot, '.jambavan');

  return {
    projectRoot,
    indexDir,
    memoryDir: process.env.JAMBAVAN_MEMORY_HOME ?? path.join(indexDir, 'memory'),
    contextTokenBudget: Number(process.env.JAMBAVAN_TOKEN_BUDGET ?? 8_000),
    ignore: [
      'node_modules', '.git', 'dist', 'build', '.jambavan',
      '*.lock', '*.log', '.DS_Store', 'coverage', '.next', '.nuxt',
    ],
    rootSource,
    ...overrides,
    ...(scope !== undefined ? { scope: validateScope(scope) } : {}),
  };
}

/**
 * Mutates `config` in place once the MCP host reports its real workspace root
 * via the `roots/list` request — this fixes hosts that spawn the server with
 * cwd=$HOME (findProjectRoot() then silently resolves to $HOME).
 * No-op if JAMBAVAN_ROOT was set explicitly (that always wins) or the new
 * root matches what's already resolved.
 */
export function applyResolvedRoot(config: JambavanConfig, newRoot: string): void {
  if (process.env.JAMBAVAN_ROOT) return;
  if (newRoot === config.projectRoot) return;

  config.projectRoot = newRoot;
  config.indexDir = path.join(newRoot, '.jambavan');
  if (!process.env.JAMBAVAN_MEMORY_HOME) {
    config.memoryDir = path.join(config.indexDir, 'memory');
  }
  config.rootSource = 'client-roots';
}
