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
import * as fs from 'fs';
import * as path from 'path';
import type { JambavanConfig } from '../config/jambavan.config';

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  stale?: boolean; // pid file present but process is dead (crashed / killed without cleanup)
}

function pidFile(config: JambavanConfig): string {
  return path.join(config.indexDir, 'daemon.pid');
}

function logFile(config: JambavanConfig): string {
  return path.join(config.indexDir, 'daemon.log');
}

function readPid(config: JambavanConfig): number | undefined {
  try {
    const raw = fs.readFileSync(pidFile(config), 'utf-8').trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0: existence check only, doesn't actually kill
    return true;
  } catch {
    return false;
  }
}

export function getDaemonStatus(config: JambavanConfig): DaemonStatus {
  const pid = readPid(config);
  if (pid === undefined) return { running: false };
  if (isAlive(pid)) return { running: true, pid };
  return { running: false, pid, stale: true };
}

export function startDaemon(config: JambavanConfig): { started: boolean; pid?: number; message: string } {
  const status = getDaemonStatus(config);
  if (status.running) {
    return { started: false, pid: status.pid, message: `Daemon already running (pid ${status.pid}).` };
  }

  fs.mkdirSync(config.indexDir, { recursive: true });
  const workerPath = path.join(__dirname, '..', 'daemon-worker.js');
  const out = fs.openSync(logFile(config), 'a');
  const err = fs.openSync(logFile(config), 'a');

  const child = spawn(process.execPath, [workerPath], {
    cwd: config.projectRoot,
    env: { ...process.env, JAMBAVAN_ROOT: config.projectRoot },
    detached: true,
    stdio: ['ignore', out, err],
  });
  child.unref();

  if (!child.pid) return { started: false, message: 'Failed to spawn daemon process.' };

  fs.writeFileSync(pidFile(config), String(child.pid), 'utf-8');
  return { started: true, pid: child.pid, message: `Daemon started (pid ${child.pid}). Log: ${logFile(config)}` };
}

export function stopDaemon(config: JambavanConfig): { stopped: boolean; message: string } {
  const status = getDaemonStatus(config);
  if (!status.pid) return { stopped: false, message: 'Daemon is not running (no pid file).' };
  if (!status.running) {
    fs.rmSync(pidFile(config), { force: true });
    return { stopped: false, message: `Daemon pid file was stale (pid ${status.pid} not alive); cleaned up.` };
  }
  try {
    process.kill(status.pid, 'SIGTERM');
  } catch (err) {
    return { stopped: false, message: `Failed to stop daemon (pid ${status.pid}): ${err instanceof Error ? err.message : err}` };
  }
  fs.rmSync(pidFile(config), { force: true });
  return { stopped: true, message: `Daemon stopped (pid ${status.pid}).` };
}

export function formatDaemonStatus(config: JambavanConfig): string {
  const status = getDaemonStatus(config);
  if (status.running) return `Daemon active (pid ${status.pid}). Log: ${logFile(config)}`;
  if (status.stale) return `Daemon pid file is stale (pid ${status.pid} not alive) — run "jambavan daemon stop" to clean it up, then "start" again.`;
  return 'Daemon not running.';
}
