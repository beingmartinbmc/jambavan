import * as crypto from 'crypto';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { JambavanConfig } from '../config/jambavan.config';

const scopeCache = new Map<string, string>();

function gitOutput(root: string, args: string[]): string | undefined {
  try {
    const value = execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/** Strip protocol, credentials, host aliases, and .git from a remote. */
export function normalizedRemotePath(remote: string): string | undefined {
  const raw = remote.trim();
  if (!raw || raw.includes('\0')) return undefined;

  let pathname: string;
  if (raw.includes('://')) {
    try { pathname = new URL(raw).pathname; } catch { return undefined; }
  } else {
    const scp = raw.match(/^(?:[^@/]+@)?[^:/]+:(.+)$/);
    pathname = scp?.[1] ?? raw;
  }

  const normalized = pathname
    .replace(/[?#].*$/, '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '');
  return normalized || undefined;
}

function repositoryIdentity(root: string): { base: string; key: string } | undefined {
  const initialCommit = gitOutput(root, ['rev-list', '--max-parents=0', 'HEAD'])
    ?.split(/\r?\n/).filter(Boolean).sort()[0];
  if (!initialCommit) return undefined;

  let remote = gitOutput(root, ['remote', 'get-url', 'origin']);
  if (!remote) {
    const firstRemote = gitOutput(root, ['remote'])?.split(/\r?\n/).filter(Boolean).sort()[0];
    if (firstRemote) remote = gitOutput(root, ['remote', 'get-url', firstRemote]);
  }
  const remotePath = remote ? normalizedRemotePath(remote) : undefined;
  const base = path.basename(remotePath ?? root).replace(/\.git$/i, '') || 'project';
  return { base, key: `${remotePath ?? base}\0${initialCommit}` };
}

/** Clone-stable project memory scope, with JAMBAVAN_SCOPE as the override. */
export function projectScope(config: JambavanConfig): string {
  if (config.scope) return config.scope;
  const cached = scopeCache.get(config.projectRoot);
  if (cached) return cached;

  const identity = repositoryIdentity(config.projectRoot);
  const base = (identity?.base ?? path.basename(config.projectRoot))
    .toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'project';
  const hash = crypto.createHash('sha256')
    .update(identity?.key ?? config.projectRoot)
    .digest('hex').slice(0, 8);
  const scope = `${base}-${hash}`;
  scopeCache.set(config.projectRoot, scope);
  return scope;
}

/** Pre-1.1 path-derived scope, used only to read and migrate legacy stores. */
export function legacyProjectScope(config: JambavanConfig): string {
  const base = path.basename(config.projectRoot).toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'project';
  const hash = crypto.createHash('sha256').update(config.projectRoot).digest('hex').slice(0, 6);
  return `${base}-${hash}`;
}
