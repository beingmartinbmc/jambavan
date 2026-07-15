import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { mkTempConfig } from '../test-support/config';
import {
  getDaemonStatus, startDaemon, stopDaemon, formatDaemonStatus,
  writeHeartbeat, heartbeatFile,
} from '../src/tools/daemon';
import type { JambavanConfig } from '../src/config/jambavan.config';

/**
 * Write a daemon record (the JSON pid file). `startedAt` defaults to now so the
 * startup-grace window classifies it as running; pass an old date to simulate a
 * daemon that has been up long enough that liveness must come from a heartbeat.
 */
function writeRecord(config: JambavanConfig, pid: number, opts: { instanceId?: string; startedAt?: Date } = {}): string {
  const instanceId = opts.instanceId ?? 'test-instance';
  fs.mkdirSync(config.indexDir, { recursive: true });
  fs.writeFileSync(
    path.join(config.indexDir, 'daemon.pid'),
    JSON.stringify({ pid, instanceId, startedAt: (opts.startedAt ?? new Date()).toISOString() }),
    'utf-8',
  );
  return instanceId;
}

/** A start time far enough in the past that the startup grace (60s) has elapsed. */
function longAgo(): Date {
  return new Date(Date.now() - 5 * 60_000);
}

/** A PID guaranteed to be dead: spawn a process that exits immediately and wait for it. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  const pid = result.pid;
  assert.ok(pid, 'child process should have a pid');
  return pid;
}

test('getDaemonStatus: no pid file -> not running', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    assert.deepEqual(getDaemonStatus(config), { running: false });
  } finally {
    cleanup();
  }
});

test('getDaemonStatus: live pid within startup grace -> running', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    writeRecord(config, process.pid); // alive, startedAt=now -> grace window
    const status = getDaemonStatus(config);
    assert.equal(status.running, true);
    assert.equal(status.pid, process.pid);
  } finally {
    cleanup();
  }
});

test('getDaemonStatus: live pid past grace with a fresh matching heartbeat -> running', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const instanceId = writeRecord(config, process.pid, { startedAt: longAgo() });
    writeHeartbeat(config, instanceId); // fresh beat, matching instance
    const status = getDaemonStatus(config);
    assert.equal(status.running, true);
    assert.equal(status.pid, process.pid);
  } finally {
    cleanup();
  }
});

test('getDaemonStatus: reused PID (alive, past grace, no heartbeat) -> stale, NOT running', () => {
  // Regression: the bug was signalling an unrelated process that happened to reuse
  // the daemon PID. This process is alive, but it is not our worker: no heartbeat and
  // the recorded start time is well past the grace window -> must be classified stale.
  const { config, cleanup } = mkTempConfig();
  try {
    writeRecord(config, process.pid, { startedAt: longAgo() });
    const status = getDaemonStatus(config);
    assert.equal(status.running, false);
    assert.equal(status.stale, true);
    assert.equal(status.pid, process.pid);
  } finally {
    cleanup();
  }
});

test('getDaemonStatus: heartbeat from a different instanceId does not count as ours', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    writeRecord(config, process.pid, { instanceId: 'ours', startedAt: longAgo() });
    writeHeartbeat(config, 'someone-else'); // fresh, but wrong instance
    const status = getDaemonStatus(config);
    assert.equal(status.running, false);
    assert.equal(status.stale, true);
  } finally {
    cleanup();
  }
});

test('getDaemonStatus: pid file with a dead pid -> stale, not running', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    writeRecord(config, deadPid());
    const status = getDaemonStatus(config);
    assert.equal(status.running, false);
    assert.equal(status.stale, true);
  } finally {
    cleanup();
  }
});

test('stopDaemon: reused-PID (alive but not ours) is cleaned up WITHOUT signalling it', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const pidPath = path.join(config.indexDir, 'daemon.pid');
    // process.pid is alive (this test runner) but not our daemon: stop must NOT kill it.
    writeRecord(config, process.pid, { startedAt: longAgo() });
    const result = stopDaemon(config);
    assert.equal(result.stopped, false);
    assert.match(result.message, /stale/);
    assert.equal(fs.existsSync(pidPath), false);
    // If we had signalled, the test runner would be dead; reaching here proves we didn't.
  } finally {
    cleanup();
  }
});

test('stopDaemon: cleans up a stale (dead) pid file and reports it was stale', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const pidPath = path.join(config.indexDir, 'daemon.pid');
    writeRecord(config, deadPid());
    const result = stopDaemon(config);
    assert.equal(result.stopped, false);
    assert.match(result.message, /stale/);
    assert.equal(fs.existsSync(pidPath), false);
  } finally {
    cleanup();
  }
});

test('stopDaemon: no pid file -> reports not running, nothing to clean up', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const result = stopDaemon(config);
    assert.equal(result.stopped, false);
    assert.match(result.message, /not running/);
  } finally {
    cleanup();
  }
});

test('stopDaemon: live pid within grace -> sends SIGTERM and removes pid + heartbeat files', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const pidPath = path.join(config.indexDir, 'daemon.pid');
    // A long-lived child we can safely SIGTERM without affecting the test runner.
    const proc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    assert.ok(proc.pid);
    const instanceId = writeRecord(config, proc.pid!); // startedAt=now -> grace -> running
    writeHeartbeat(config, instanceId);

    const result = stopDaemon(config);
    assert.equal(result.stopped, true);
    assert.equal(fs.existsSync(pidPath), false);
    assert.equal(fs.existsSync(heartbeatFile(config)), false);
  } finally {
    cleanup();
  }
});

test('formatDaemonStatus: renders running / stale / not-running messages', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    assert.equal(formatDaemonStatus(config), 'Daemon not running.');

    writeRecord(config, process.pid);
    assert.match(formatDaemonStatus(config), /Daemon active \(pid \d+\)/);
  } finally {
    cleanup();
  }
});

test('formatDaemonStatus: stale pid file reports the stale message', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    writeRecord(config, deadPid());
    assert.match(formatDaemonStatus(config), /stale/);
  } finally {
    cleanup();
  }
});

test('startDaemon: reports already-running when daemon is live', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    writeRecord(config, process.pid); // alive within grace
    const result = startDaemon(config);
    assert.equal(result.started, false);
    assert.match(result.message, /already running/);
    assert.equal(result.pid, process.pid);
  } finally {
    cleanup();
  }
});

test('startDaemon: writes a JSON record with pid, instanceId, and startedAt', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const result = startDaemon(config);
    assert.equal(fs.readFileSync(path.join(config.indexDir, '.gitignore'), 'utf8'), '*\n');
    assert.ok(typeof result.started === 'boolean');
    assert.ok(typeof result.message === 'string');
    if (result.started) {
      assert.ok(typeof result.pid === 'number' && result.pid! > 0);
      assert.match(result.message, /Daemon started/);
      const rec = JSON.parse(fs.readFileSync(path.join(config.indexDir, 'daemon.pid'), 'utf-8'));
      assert.equal(rec.pid, result.pid);
      assert.ok(typeof rec.instanceId === 'string' && rec.instanceId.length > 0);
      assert.ok(!Number.isNaN(Date.parse(rec.startedAt)));
    }
  } finally {
    cleanup();
  }
});

test('getDaemonStatus: non-JSON pid file (legacy bare integer) is ignored, not treated as a daemon', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    fs.mkdirSync(config.indexDir, { recursive: true });
    fs.writeFileSync(path.join(config.indexDir, 'daemon.pid'), String(process.pid), 'utf-8');
    const status = getDaemonStatus(config);
    // Can't prove identity from a bare integer -> not a daemon we will signal.
    assert.equal(status.running, false);
    assert.equal(status.stale, undefined);
  } finally {
    cleanup();
  }
});
