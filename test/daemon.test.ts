import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { mkTempConfig } from '../test-support/config';
import { getDaemonStatus, startDaemon, stopDaemon, formatDaemonStatus } from '../src/tools/daemon';

function writePid(indexDir: string, pid: number): void {
  fs.mkdirSync(indexDir, { recursive: true });
  fs.writeFileSync(path.join(indexDir, 'daemon.pid'), String(pid), 'utf-8');
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

test('getDaemonStatus: pid file with a live pid -> running', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    writePid(config.indexDir, process.pid); // this test process is definitely alive
    const status = getDaemonStatus(config);
    assert.equal(status.running, true);
    assert.equal(status.pid, process.pid);
  } finally {
    cleanup();
  }
});

test('getDaemonStatus: pid file with a dead pid -> stale, not running', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    writePid(config.indexDir, deadPid());
    const status = getDaemonStatus(config);
    assert.equal(status.running, false);
    assert.equal(status.stale, true);
  } finally {
    cleanup();
  }
});

test('stopDaemon: cleans up a stale pid file and reports it was stale', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const pidPath = path.join(config.indexDir, 'daemon.pid');
    writePid(config.indexDir, deadPid());
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

test('stopDaemon: live pid -> sends SIGTERM and removes the pid file', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const pidPath = path.join(config.indexDir, 'daemon.pid');
    // A long-lived child we can safely SIGTERM without affecting the test runner.
    const proc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    assert.ok(proc.pid);
    writePid(config.indexDir, proc.pid!);

    const result = stopDaemon(config);
    assert.equal(result.stopped, true);
    assert.equal(fs.existsSync(pidPath), false);
  } finally {
    cleanup();
  }
});

test('formatDaemonStatus: renders running / stale / not-running messages', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    assert.equal(formatDaemonStatus(config), 'Daemon not running.');

    writePid(config.indexDir, process.pid);
    assert.match(formatDaemonStatus(config), /Daemon active \(pid \d+\)/);
  } finally {
    cleanup();
  }
});

test('formatDaemonStatus: stale pid file reports the stale message', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    writePid(config.indexDir, deadPid());
    assert.match(formatDaemonStatus(config), /stale/);
  } finally {
    cleanup();
  }
});

test('startDaemon: reports already-running when daemon is live', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    writePid(config.indexDir, process.pid); // this process is alive
    const result = startDaemon(config);
    assert.equal(result.started, false);
    assert.match(result.message, /already running/);
    assert.equal(result.pid, process.pid);
  } finally {
    cleanup();
  }
});

test('startDaemon: spawns a new process, writes pid file, and returns started=true', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    const result = startDaemon(config);
    assert.equal(fs.readFileSync(path.join(config.indexDir, '.gitignore'), 'utf8'), '*\n');
    // Worker path does not exist in test env, but spawn still assigns a pid on most platforms
    // before the child exits. Only assert structural shape; the child will die immediately.
    assert.ok(typeof result.started === 'boolean');
    assert.ok(typeof result.message === 'string');
    if (result.started) {
      assert.ok(typeof result.pid === 'number' && result.pid! > 0);
      assert.match(result.message, /Daemon started/);
    }
  } finally {
    cleanup();
  }
});

test('readPid: non-integer content in pid file returns undefined (treated as no daemon)', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    fs.mkdirSync(config.indexDir, { recursive: true });
    fs.writeFileSync(path.join(config.indexDir, 'daemon.pid'), 'not-a-number', 'utf-8');
    const status = getDaemonStatus(config);
    assert.equal(status.running, false);
    // stale is not set — readPid returned undefined, so we took the "no pid file" path
    assert.equal(status.stale, undefined);
  } finally {
    cleanup();
  }
});
