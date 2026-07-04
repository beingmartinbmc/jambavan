import * as fs from 'fs';
import * as path from 'path';
import type { JambavanConfig } from '../config/jambavan.config';

// Files that commonly hold credentials. Denied to ALL file tools (read + write)
// unless JAMBAVAN_ALLOW_SECRETS=1. This is the one shared guard, not a per-tool patch.
const SECRET_BASENAMES = new Set([
  '.npmrc', '.netrc', '.pgpass', '.htpasswd',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
]);
const SECRET_PATTERNS = [
  /^\.env(\..+)?$/i,          // .env, .env.local, .env.production
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
];

function assertNotSecret(target: string, label: string): void {
  if (process.env.JAMBAVAN_ALLOW_SECRETS === '1') return;
  const base = path.basename(target);
  if (SECRET_BASENAMES.has(base) || SECRET_PATTERNS.some(re => re.test(base))) {
    throw new Error(`${label} blocked: "${base}" looks like a secret file (set JAMBAVAN_ALLOW_SECRETS=1 to override)`);
  }
}

function realPathForPossiblyNew(target: string): string {
  const missingParts: string[] = [];
  let cursor = target;

  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missingParts.unshift(path.basename(cursor));
    cursor = parent;
  }

  return path.join(fs.realpathSync(cursor), ...missingParts);
}

export function resolveInsideRoot(rawPath: string | undefined, config: JambavanConfig, label = 'path'): string {
  const raw = (rawPath ?? '.').trim();
  if (!raw) throw new Error(`${label} is required`);

  const target = path.resolve(path.isAbsolute(raw) ? raw : path.join(config.projectRoot, raw));
  assertNotSecret(target, label);
  if (process.env.JAMBAVAN_ALLOW_OUTSIDE_ROOT === '1') return target;

  const root = fs.realpathSync(config.projectRoot);
  const realTarget = realPathForPossiblyNew(target);
  const rel = path.relative(root, realTarget);

  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return target;
  throw new Error(`${label} escapes project root: ${raw}`);
}

export function projectRelative(filePath: string, config: JambavanConfig): string {
  const rel = path.relative(config.projectRoot, filePath).replace(/\\/g, '/');
  return rel || '.';
}
