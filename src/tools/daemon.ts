/**
 * Background daemon — runs the existing FileWatcher standalone in a detached
 * process so the index stays live without an MCP host process attached.
 *
 * No new watch mechanism: this only manages the lifecycle (spawn/PID
 * file/liveness check) around the same `FileWatcher` used in-process by the
 * `jambavan_watch` tool (src/index/watcher.ts). The worker script it spawns
 * is `dist/daemon-worker.js` (see src/daemon-worker.ts).
 *
 * Caveat (documented in README): many MCP hosts restart the server process
 * per session anyway, which narrows how much this buys you over
 * `jambavan_watch start` — it mainly helps long-lived terminal/CI workflows
 * where nothing else keeps the index warm between tool calls.
 */

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ensureGeneratedStateDir, type JambavanConfig } from '../config/jambavan.config';

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  stale?: boolean; // pid file present but process is dead (crashed / killed without cleanup)
}

/** How the daemon proves identity: written by us at start, refreshed by the worker. */
interface DaemonRecord {
  pid: number;
  instanceId: string;
  startedAt: string; // ISO-8601
}

/** Worker heartbeat: refreshed on a timer so a *reused* PID can't masquerade as us. */
interface Heartbeat {
  instanceId: string;
  ts: number; // epoch ms
}

/** Heartbeat older than this = worker gone (only meaningful once startup grace passed). */
const HEARTBEAT_FRESH_MS = 30_000;
/** Right after spawn the worker may be indexing before its first beat — trust our own record. */
const STARTUP_GRACE_MS = 60_000;
/** Worker beat interval — export so the worker uses one source of truth. */
export const HEARTBEAT_INTERVAL_MS = 10_000;

function pidFile(config: JambavanConfig): string {
  return path.join(config.indexDir, 'daemon.pid');
}

function logFile(config: JambavanConfig): string {
  return path.join(config.indexDir, 'daemon.log');
}

export function heartbeatFile(config: JambavanConfig): string {
  return path.join(config.indexDir, 'daemon.heartbeat');
}

function readRecord(config: JambavanConfig): DaemonRecord | undefined {
  try {
    const raw = fs.readFileSync(pidFile(config), 'utf-8').trim();
    const rec = JSON.parse(raw) as Partial<DaemonRecord>;
    if (
      typeof rec.pid === 'number' && Number.isInteger(rec.pid) && rec.pid > 0 &&
      typeof rec.instanceId === 'string' && rec.instanceId.length > 0 &&
      typeof rec.startedAt === 'string'
    ) {
      return { pid: rec.pid, instanceId: rec.instanceId, startedAt: rec.startedAt };
    }
    return undefined;
  } catch {
    // Missing, unparseable, or a pre-JSON (bare-integer) pid file: we can no longer
    // prove identity, so refuse to treat it as a daemon we may signal. start() will
    // overwrite it. Safe for a per-session daemon.
    return undefined;
  }
}

function readHeartbeat(config: JambavanConfig): Heartbeat | undefined {
  try {
    const rec = JSON.parse(fs.readFileSync(heartbeatFile(config), 'utf-8')) as Partial<Heartbeat>;
    if (typeof rec.instanceId === 'string' && typeof rec.ts === 'number') {
      return { instanceId: rec.instanceId, ts: rec.ts };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Worker-side: refresh the heartbeat. Called by daemon-worker.ts on a timer. */
export function writeHeartbeat(config: JambavanConfig, instanceId: string): void {
  const beat: Heartbeat = { instanceId, ts: Date.now() };
  fs.writeFileSync(heartbeatFile(config), JSON.stringify(beat), 'utf-8');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0: existence check only, doesn't actually kill
    return true;
  } catch {
    return false;
  }
}

/** True only when the live PID is provably *our* worker (fresh heartbeat or startup grace). */
function isOurDaemon(config: JambavanConfig, rec: DaemonRecord): boolean {
  const beat = readHeartbeat(config);
  if (beat && beat.instanceId === rec.instanceId && Date.now() - beat.ts <= HEARTBEAT_FRESH_MS) {
    return true;
  }
  const started = Date.parse(rec.startedAt);
  return Number.isFinite(started) && Date.now() - started <= STARTUP_GRACE_MS;
}

export function getDaemonStatus(config: JambavanConfig): DaemonStatus {
  const rec = readRecord(config);
  if (rec === undefined) return { running: false };
  if (!isAlive(rec.pid)) return { running: false, pid: rec.pid, stale: true };
  // PID is alive but may have been *reused* by an unrelated process after a crash.
  if (!isOurDaemon(config, rec)) return { running: false, pid: rec.pid, stale: true };
  return { running: true, pid: rec.pid };
}

export function startDaemon(config: JambavanConfig): { started: boolean; pid?: number; message: string } {
  const status = getDaemonStatus(config);
  if (status.running) {
    return { started: false, pid: status.pid, message: `Daemon already running (pid ${status.pid}).` };
  }

  ensureGeneratedStateDir(config.indexDir);
  const workerPath = path.join(__dirname, '..', 'daemon-worker.js');
  const out = fs.openSync(logFile(config), 'a');
  const err = fs.openSync(logFile(config), 'a');
  const instanceId = crypto.randomUUID();

  const child = spawn(process.execPath, [workerPath], {
    cwd: config.projectRoot,
    env: { ...process.env, JAMBAVAN_ROOT: config.projectRoot, JAMBAVAN_DAEMON_INSTANCE: instanceId },
    detached: true,
    stdio: ['ignore', out, err],
  });
  child.unref();

  if (!child.pid) return { started: false, message: 'Failed to spawn daemon process.' };

  // Clear any stale heartbeat from a previous crashed instance before publishing our record,
  // so getDaemonStatus can't be fooled by a leftover beat during our startup grace window.
  fs.rmSync(heartbeatFile(config), { force: true });
  const record: DaemonRecord = { pid: child.pid, instanceId, startedAt: new Date().toISOString() };
  fs.writeFileSync(pidFile(config), JSON.stringify(record), 'utf-8');
  // rin: no readiness handshake — start returns before the worker opens index/watcher.
  //      Add one (worker writes a ready marker; start polls it) if hosts need "index warm on start=success".
  return { started: true, pid: child.pid, message: `Daemon started (pid ${child.pid}). Log: ${logFile(config)}` };
}

export function stopDaemon(config: JambavanConfig): { stopped: boolean; message: string } {
  const status = getDaemonStatus(config);
  if (!status.pid) return { stopped: false, message: 'Daemon is not running (no pid file).' };
  if (!status.running) {
    // pid dead, OR alive-but-not-ours (reused PID): never signal an unrelated process.
    fs.rmSync(pidFile(config), { force: true });
    fs.rmSync(heartbeatFile(config), { force: true });
    return { stopped: false, message: `Daemon pid file was stale (pid ${status.pid} not our daemon); cleaned up.` };
  }
  try {
    process.kill(status.pid, 'SIGTERM');
  } catch (err) {
    return { stopped: false, message: `Failed to stop daemon (pid ${status.pid}): ${err instanceof Error ? err.message : err}` };
  }
  fs.rmSync(pidFile(config), { force: true });
  fs.rmSync(heartbeatFile(config), { force: true });
  return { stopped: true, message: `Daemon stopped (pid ${status.pid}).` };
}

export function formatDaemonStatus(config: JambavanConfig): string {
  const status = getDaemonStatus(config);
  if (status.running) return `Daemon active (pid ${status.pid}). Log: ${logFile(config)}`;
  if (status.stale) return `Daemon pid file is stale (pid ${status.pid} not our daemon) — run "jambavan daemon stop" to clean it up, then "start" again.`;
  return 'Daemon not running.';
}
