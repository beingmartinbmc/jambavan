import * as path from 'path';
import * as fs from 'fs';

// rin: intentionally NOT loading .env — auto-ingesting project secrets into
// process.env is a leak vector for an MCP server. JAMBAVAN_* config vars come
// from the host's MCP launch env. Re-enable dotenv only if a user need appears.

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
}

export function loadConfig(overrides: Partial<JambavanConfig> = {}): JambavanConfig {
  const projectRoot = process.env.JAMBAVAN_ROOT ?? findProjectRoot();

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
    ...overrides,
  };
}
