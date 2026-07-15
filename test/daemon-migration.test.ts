import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { mkTempConfig } from '../test-support/config';
import { detectLegacyDaemon, legacyDaemonNotice } from '../src/tools/daemon';

function writePid(config: { indexDir: string }, contents: string): void {
  fs.mkdirSync(config.indexDir, { recursive: true });
  fs.writeFileSync(path.join(config.indexDir, 'daemon.pid'), contents);
}

test('detectLegacyDaemon: no pid file yields no record', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    assert.equal(detectLegacyDaemon(config), undefined);
    assert.equal(legacyDaemonNotice(config), undefined);
  } finally { cleanup(); }
});

test('detectLegacyDaemon: reads a JSON record pid', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    writePid(config, JSON.stringify({ pid: 4321 }));
    assert.deepEqual(detectLegacyDaemon(config), { pid: 4321 });
  } finally { cleanup(); }
});

test('detectLegacyDaemon: reads a legacy bare-integer pid file', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    writePid(config, '4321\n');
    assert.deepEqual(detectLegacyDaemon(config), { pid: 4321 });
  } finally { cleanup(); }
});

test('detectLegacyDaemon: rejects malformed pid values like 123abc', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    writePid(config, '123abc');
    // Record present but pid not trustworthy → detected with undefined pid.
    assert.deepEqual(detectLegacyDaemon(config), { pid: undefined });
    const notice = legacyDaemonNotice(config);
    assert.match(notice!, /leftover background-daemon record/);
    assert.doesNotMatch(notice!, /123/);
  } finally { cleanup(); }
});

test('detectLegacyDaemon: unreadable record fails closed instead of open', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    // A present-but-unreadable pid file (dir where a file is expected) makes
    // readFileSync throw a non-ENOENT error. That must NOT be treated as "no
    // record"; it must block startup via { pid: undefined }.
    fs.mkdirSync(path.join(config.indexDir, 'daemon.pid'), { recursive: true });
    assert.deepEqual(detectLegacyDaemon(config), { pid: undefined });
    assert.match(legacyDaemonNotice(config)!, /leftover background-daemon record/);
  } finally { cleanup(); }
});

test('legacyDaemonNotice: never suggests killing the recorded pid', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    writePid(config, JSON.stringify({ pid: 4321 }));
    const notice = legacyDaemonNotice(config);
    assert.match(notice!, /recorded pid 4321/);
    assert.doesNotMatch(notice!, /`kill 4321`|kill 4321/);
    assert.match(notice!, /jambavan_watch start/);
  } finally { cleanup(); }
});
