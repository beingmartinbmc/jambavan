import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { resolveInsideRoot, projectRelative } from '../src/tools/path-guard';
import { mkTempConfig, withEnv } from '../test-support/config';

test('resolveInsideRoot: project-relative path resolves under root', () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    assert.equal(resolveInsideRoot('a/b.txt', config), path.join(root, 'a/b.txt'));
    fs.mkdirSync(path.join(root, 'a'));
    assert.equal(resolveInsideRoot('a/new/b.txt', config), path.join(root, 'a/new/b.txt'));
  } finally { cleanup(); }
});

test('resolveInsideRoot: undefined path resolves to root; empty string is rejected', () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    assert.equal(resolveInsideRoot(undefined, config), root);
    // Empty / whitespace-only is not the same as "absent" — it is an explicit
    // bad input and must be rejected rather than silently meaning root.
    assert.throws(() => resolveInsideRoot('', config), /required/);
    assert.throws(() => resolveInsideRoot('   ', config), /required/);
  } finally { cleanup(); }
});

test('resolveInsideRoot: rejects ../ traversal escaping root', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    assert.throws(() => resolveInsideRoot('../escape.txt', config), /escapes project root/);
    assert.throws(() => resolveInsideRoot('a/../../escape.txt', config), /escapes project root/);
  } finally { cleanup(); }
});

test('resolveInsideRoot: rejects absolute path outside root', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    assert.throws(() => resolveInsideRoot('/etc/passwd', config), /escapes project root/);
  } finally { cleanup(); }
});

test('resolveInsideRoot: symlink escaping root is rejected (realpath check)', () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    const outside = fs.mkdtempSync(path.join(root, '..', 'jambavan-outside-'));
    try {
      const link = path.join(root, 'link');
      fs.symlinkSync(outside, link);
      // Target resolves through the symlink to a dir outside root -> rejected.
      assert.throws(() => resolveInsideRoot('link/secret.txt', config), /escapes project root/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  } finally { cleanup(); }
});

test('resolveInsideRoot: dangling symlink escaping root is rejected', () => {
  const { config, root, cleanup } = mkTempConfig();
  const outside = fs.mkdtempSync(path.join(root, '..', 'jambavan-dangling-'));
  try {
    fs.symlinkSync(path.join(outside, 'future.txt'), path.join(root, 'link.txt'));
    assert.throws(() => resolveInsideRoot('link.txt', config), /escapes project root/);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    cleanup();
  }
});

test('resolveInsideRoot: JAMBAVAN_ALLOW_OUTSIDE_ROOT=1 bypasses containment', async () => {
  const { config, cleanup } = mkTempConfig();
  try {
    await withEnv({ JAMBAVAN_ALLOW_OUTSIDE_ROOT: '1' }, () => {
      assert.equal(resolveInsideRoot('/etc/hosts', config), '/etc/hosts');
    });
  } finally { cleanup(); }
});

test('resolveInsideRoot: secret filenames are blocked by default', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    for (const name of ['.env', '.env.production', 'id_rsa', 'server.key', 'cert.pem', '.npmrc', 'store.p12']) {
      assert.throws(() => resolveInsideRoot(name, config), /secret file/, `expected ${name} blocked`);
    }
  } finally { cleanup(); }
});

test('resolveInsideRoot: secret directories and all descendants are blocked', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    for (const name of [
      '.aws',
      '.aws/credentials',
      '.aws/sso/cache/session.json',
      '.docker',
      '.docker/config.json',
      '.docker/contexts/meta/context/meta.json',
      '.ssh',
      '.ssh/known_hosts',
      '.ssh/config.d/work',
      '.git-credentials',
      'service-account.json',
      'service_account_key.json',
    ]) {
      assert.throws(() => resolveInsideRoot(name, config), /secret file/, `expected ${name} blocked`);
    }
  } finally { cleanup(); }
});

test('resolveInsideRoot: secret paths are blocked regardless of case', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    for (const name of ['.NPMRC', 'ID_ED25519', '.AWS/credentials', '.Docker/config.json', '.SSH/config']) {
      assert.throws(() => resolveInsideRoot(name, config), /secret file/, `expected ${name} blocked`);
    }
  } finally { cleanup(); }
});

test('resolveInsideRoot: symlinks into secret directories are blocked', () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    fs.mkdirSync(path.join(root, '.ssh'));
    fs.writeFileSync(path.join(root, '.ssh', 'config'), 'Host secret\n');
    fs.symlinkSync(path.join(root, '.ssh'), path.join(root, 'safe-looking'));
    assert.throws(() => resolveInsideRoot('safe-looking/config', config), /secret file/);
  } finally { cleanup(); }
});

test('resolveInsideRoot: non-secret filenames pass', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    for (const name of ['env.ts', 'keyboard.js', 'environment.md', 'readme.pem.txt', 'config.json']) {
      assert.doesNotThrow(() => resolveInsideRoot(name, config), `expected ${name} allowed`);
    }
  } finally { cleanup(); }
});

test('resolveInsideRoot: JAMBAVAN_ALLOW_SECRETS=1 unblocks secret files', async () => {
  const { config, cleanup } = mkTempConfig();
  try {
    await withEnv({ JAMBAVAN_ALLOW_SECRETS: '1' }, () => {
      assert.doesNotThrow(() => resolveInsideRoot('.env', config));
      assert.doesNotThrow(() => resolveInsideRoot('.ssh', config));
      assert.doesNotThrow(() => resolveInsideRoot('.aws/sso/cache/session.json', config));
    });
  } finally { cleanup(); }
});

test('projectRelative: returns "." for the root and posix separators below', () => {
  const { config, cleanup } = mkTempConfig();
  try {
    assert.equal(projectRelative(config.projectRoot, config), '.');
    assert.equal(projectRelative(path.join(config.projectRoot, 'a', 'b.ts'), config), 'a/b.ts');
  } finally { cleanup(); }
});
