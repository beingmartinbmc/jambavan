/**
 * Legacy daemon migration guard.
 *
 * The background daemon (`jambavan daemon start|stop|status`) was removed from
 * the stable 1.0 surface: a PID file is discovery metadata, not proof of
 * identity, so we could never safely signal a process we found there. All the
 * value it offered is covered by the in-process `jambavan_watch`.
 *
 * What remains is read-only migration handling: a `.jambavan/daemon.pid` left
 * behind by a pre-1.0 install (JSON record OR a legacy bare-integer file) is
 * detected and surfaced with safe upgrade instructions. We NEVER call
 * process.kill on that pid — the user stops any lingering process themselves.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { JambavanConfig } from '../config/jambavan.config';

function pidFile(config: JambavanConfig): string {
  return path.join(config.indexDir, 'daemon.pid');
}

/**
 * Best-effort read of a leftover daemon pid record for *display only*.
 * Accepts both the 1.0-era JSON record and a pre-JSON bare-integer file.
 * Returns undefined when no record exists. The pid is never signalled.
 */
export function detectLegacyDaemon(config: JambavanConfig): { pid?: number } | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(pidFile(config), 'utf-8').trim();
  } catch {
    return undefined; // no record
  }
  if (!raw) return { pid: undefined };
  try {
    const rec = JSON.parse(raw) as { pid?: unknown };
    if (typeof rec.pid === 'number' && Number.isInteger(rec.pid) && rec.pid > 0) {
      return { pid: rec.pid };
    }
  } catch {
    // Legacy bare-integer pid file.
    const n = Number.parseInt(raw, 10);
    if (Number.isInteger(n) && n > 0) return { pid: n };
  }
  return { pid: undefined };
}

/**
 * One-line upgrade notice if a legacy daemon record is present, else undefined.
 * Surfaced by jambavan_watch/awaken so a lingering pre-1.0 daemon can't
 * silently double-index. No signalling — the instruction is manual.
 */
export function legacyDaemonNotice(config: JambavanConfig): string | undefined {
  const rec = detectLegacyDaemon(config);
  if (!rec) return undefined;
  const where = pidFile(config);
  const pid = rec.pid !== undefined ? ` (pid ${rec.pid})` : '';
  return [
    `Found a leftover background-daemon record${pid} from a pre-1.0 Jambavan.`,
    'The background daemon was removed in 1.0. If that process is still running it may',
    `double-index this project — stop it manually${rec.pid !== undefined ? ` (e.g. \`kill ${rec.pid}\`)` : ''}`,
    `and delete ${where}. Use \`jambavan_watch start\` for a live index instead.`,
  ].join(' ');
}
