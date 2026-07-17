import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { boundedInt } from '../tools/registry';

// rin: host launch env only; add opt-in project config when users need persistent settings.
// Auto-ingesting .env secrets into process.env is a leak vector for an MCP server.

/**
 * Walk up the directory tree from cwd to find the project root.
 * Identified by the presence of package.json or .git.
 */
function findProjectRoot(): { root: string; foundProject: boolean } {
  let dir = process.cwd();
  while (dir !== path.parse(dir).root) {
    if (
      fs.existsSync(path.join(dir, '.git')) ||
      fs.existsSync(path.join(dir, 'package.json'))
    ) {
      return { root: dir, foundProject: true };
    }
    dir = path.dirname(dir);
  }
  return { root: process.cwd(), foundProject: false };
}

/** Where projectRoot came from — surfaced by jambavan_doctor to explain root confusion. */
export type RootSource = 'env' | 'client-roots' | 'tool-input' | 'cwd-project' | 'cwd-fallback';
export type MemorySource = 'default' | 'env' | 'override';

export interface JambavanConfig {
  /** Absolute path to the project being indexed/served */
  projectRoot: string;
  /** Where the .jambavan/ index directory lives */
  indexDir: string;
  /** Root-independent OKF archive (defaults to ~/.jambavan/memory). */
  memoryDir: string;
  /** Where memoryDir came from; omitted only by older programmatic callers. */
  memorySource?: MemorySource;
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
  const detected = findProjectRoot();
  const projectRoot = envRoot ?? detected.root;
  const rootSource: RootSource = envRoot ? 'env' : detected.foundProject ? 'cwd-project' : 'cwd-fallback';
  const scope = overrides.scope ?? process.env.JAMBAVAN_SCOPE;

  const indexDir = path.join(projectRoot, '.jambavan');
  const envMemoryDir = process.env.JAMBAVAN_MEMORY_HOME;
  const memoryDir = overrides.memoryDir ?? envMemoryDir ?? defaultMemoryDir();
  const memorySource: MemorySource = overrides.memoryDir !== undefined
    ? 'override'
    : envMemoryDir !== undefined ? 'env' : 'default';

  return {
    projectRoot,
    indexDir,
    memoryDir,
    memorySource,
    contextTokenBudget: boundedInt(process.env.JAMBAVAN_TOKEN_BUDGET, {
      min: 100, max: 1_000_000, fallback: 8_000,
    }),
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
export function applyResolvedRoot(
  config: JambavanConfig,
  newRoot: string,
  source: Extract<RootSource, 'client-roots' | 'tool-input'> = 'client-roots',
): boolean {
  if (process.env.JAMBAVAN_ROOT) return false;
  if (newRoot === config.projectRoot) {
    if (config.rootSource !== 'cwd-fallback') return false;
    config.rootSource = source;
    return true;
  }

  config.projectRoot = newRoot;
  config.indexDir = path.join(newRoot, '.jambavan');
  config.rootSource = source;
  return true;
}

export function defaultMemoryDir(): string {
  return path.join(os.homedir(), '.jambavan', 'memory');
}

export function isUnsafeFallbackRoot(config: JambavanConfig): boolean {
  return config.rootSource === 'cwd-fallback';
}

export function resolveToolRoot(config: JambavanConfig, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('root must be a non-empty absolute directory path.');
  }
  if (value.includes('\0') || !path.isAbsolute(value)) {
    throw new Error('root must be a non-empty absolute directory path.');
  }

  let resolved: string;
  try {
    resolved = fs.realpathSync(value);
  } catch {
    throw new Error(`root does not exist: ${value}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`root is not a directory: ${value}`);
  }
  if (config.rootSource !== 'cwd-fallback' && resolved !== config.projectRoot) {
    throw new Error(`root is already fixed by ${config.rootSource}: ${config.projectRoot}`);
  }
  const relative = path.relative(config.projectRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`root must be inside the current fallback root: ${config.projectRoot}`);
  }
  return resolved;
}

export function ensureGeneratedStateDir(indexDir: string): void {
  fs.mkdirSync(indexDir, { recursive: true });
  const ignoreFile = path.join(indexDir, '.gitignore');
  if (!fs.existsSync(ignoreFile)) fs.writeFileSync(ignoreFile, '*\n', 'utf8');
}
