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
 * Accepts the 1.0-era JSON record `{ pid }` and a pre-JSON bare-integer file
 * (which is also valid JSON). Malformed content yields `{ pid: undefined }`.
 * Returns undefined only when the file is absent (ENOENT). An unreadable
 * record (EACCES/EIO/etc.) yields `{ pid: undefined }` so startup fails closed.
 * The pid is never signalled.
 */
export function detectLegacyDaemon(config: JambavanConfig): { pid?: number } | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(pidFile(config), 'utf-8').trim();
  } catch (err: unknown) {
    // Only ENOENT means "no record exists". Any other read failure (EACCES,
    // EIO, etc.) means a record is present but unreadable — fail closed so
    // the watcher refuses to double-index.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return { pid: undefined };
  }
  if (!raw) return { pid: undefined };
  try {
    const parsed = JSON.parse(raw) as unknown;
    // 1.0-era record: { pid: <n> }. Legacy bare-integer files also parse as
    // valid JSON numbers, so accept a top-level number too.
    const pid = typeof parsed === 'number'
      ? parsed
      : (parsed && typeof (parsed as { pid?: unknown }).pid === 'number'
          ? (parsed as { pid: number }).pid
          : undefined);
    if (pid !== undefined && Number.isInteger(pid) && pid > 0) {
      return { pid };
    }
  } catch {
    // Not JSON at all (e.g. a malformed "123abc"): no trustworthy pid.
  }
  return { pid: undefined };
}

/**
 * One-line upgrade notice if a legacy daemon record is present, else undefined.
 * Surfaced by jambavan_watch/awaken so a lingering pre-1.0 daemon can't
 * silently double-index. No signalling and no `kill` suggestion — a PID file is
 * discovery metadata, not proof of identity, so the pid may now belong to an
 * unrelated process. The user identifies and stops the real daemon manually.
 */
export function legacyDaemonNotice(config: JambavanConfig): string | undefined {
  const rec = detectLegacyDaemon(config);
  if (!rec) return undefined;
  const where = pidFile(config);
  const pid = rec.pid !== undefined ? ` (recorded pid ${rec.pid})` : '';
  return [
    `Found a leftover background-daemon record${pid} from a pre-1.0 Jambavan.`,
    'The background daemon was removed in 1.0. If that process is still running it may',
    'double-index this project. Find it yourself (the recorded pid may since have been',
    `reused by an unrelated process, so do not blindly kill it), stop it, and delete ${where}.`,
    'Use `jambavan_watch start` for a live index instead.',
  ].join(' ');
}
