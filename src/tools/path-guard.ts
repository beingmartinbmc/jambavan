import * as fs from 'fs';
import * as path from 'path';
import type { JambavanConfig } from '../config/jambavan.config';

// Files that commonly hold credentials. Denied to ALL file tools (read + write)
// unless JAMBAVAN_ALLOW_SECRETS=1. This is the one shared guard, not a per-tool patch.
const SECRET_BASENAMES = new Set([
  '.npmrc', '.netrc', '.pgpass', '.htpasswd',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  'credentials',       // .aws/credentials
  '.git-credentials',  // git credential store
]);
const SECRET_PATTERNS = [
  /^\.env(\..+)?$/i,          // .env, .env.local, .env.production
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^service[-_]?account.*\.json$/i,  // GCP service account key files
];
// Directories that make themselves and every descendant secret.
const SECRET_PARENT_DIRS = new Set(['.aws', '.docker', '.ssh']);

function assertNotSecret(target: string, label: string): void {
  if (process.env.JAMBAVAN_ALLOW_SECRETS === '1') return;
  const base = path.basename(target);
  const normalizedBase = base.toLowerCase();
  const pathParts = path.resolve(target).split(path.sep).map(part => part.toLowerCase());
  if (
    SECRET_BASENAMES.has(normalizedBase) ||
    SECRET_PATTERNS.some(re => re.test(base)) ||
    pathParts.some(part => SECRET_PARENT_DIRS.has(part))
  ) {
    throw new Error(`${label} blocked: "${base}" looks like a secret file (set JAMBAVAN_ALLOW_SECRETS=1 to override)`);
  }
}

function realPathForPossiblyNew(target: string): string {
  const missingParts: string[] = [];
  let cursor = target;

  while (true) {
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(cursor);
        return realPathForPossiblyNew(path.resolve(path.dirname(cursor), linkTarget));
      }
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missingParts.unshift(path.basename(cursor));
    cursor = parent;
  }

  return path.join(fs.realpathSync(cursor), ...missingParts);
}

/** Reject a symlink leaf for source mutation; write tools must not follow it. */
export function assertSafeWriteTarget(target: string, label = 'path'): void {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) {
      throw new Error(`${label} blocked: symbolic-link write targets are not allowed`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function resolveInsideRoot(rawPath: string | undefined, config: JambavanConfig, label = 'path'): string {
  const raw = (rawPath ?? '.').trim();
  if (!raw) throw new Error(`${label} is required`);

  const target = path.resolve(path.isAbsolute(raw) ? raw : path.join(config.projectRoot, raw));
  assertNotSecret(target, label);
  const realTarget = realPathForPossiblyNew(target);
  assertNotSecret(realTarget, label);
  if (process.env.JAMBAVAN_ALLOW_OUTSIDE_ROOT === '1') return target;

  const root = fs.realpathSync(config.projectRoot);
  const rel = path.relative(root, realTarget);

  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return target;
  throw new Error(`${label} escapes project root: ${raw}`);
}

export function projectRelative(filePath: string, config: JambavanConfig): string {
  const rel = path.relative(config.projectRoot, filePath).replace(/\\/g, '/');
  return rel || '.';
}
