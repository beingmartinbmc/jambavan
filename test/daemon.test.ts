import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { mkTempConfig } from '../test-support/config';
import { getDaemonStatus, stopDaemon, formatDaemonStatus } from '../src/tools/daemon';

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
