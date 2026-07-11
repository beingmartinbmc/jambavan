import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const repoRoot = path.resolve(__dirname, '..');

function runShellInstaller(mcpConfig: string, npxExit = 0, nodeMajor = 20, continueConfig?: string | null): {
  status: number | null;
  configPath: string;
  continuePath: string;
  original: string;
  stdout: string;
  stderr: string;
  cleanup: () => void;
} {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jambavan-install-test-'));
  const bin = path.join(home, 'bin');
  const cursor = path.join(home, '.cursor');
  fs.mkdirSync(bin);
  fs.mkdirSync(cursor);
  const nodePath = path.join(bin, 'node');
  fs.writeFileSync(nodePath, `#!/bin/sh
if [ "$1" = "-p" ] && [ "$2" = "process.versions.node.split('.')[0]" ]; then
  printf '%s\\n' '${nodeMajor}'
else
  exec '${process.execPath.replace(/'/g, "'\\''")}' "$@"
fi
`);
  fs.chmodSync(nodePath, 0o755);
  fs.writeFileSync(path.join(bin, 'npx'), `#!/bin/sh\nexit ${npxExit}\n`);
  fs.chmodSync(path.join(bin, 'npx'), 0o755);

  const configPath = path.join(cursor, 'mcp.json');
  fs.writeFileSync(configPath, mcpConfig);
  const continuePath = path.join(home, '.continue', 'config.yaml');
  if (continueConfig !== undefined) {
    fs.mkdirSync(path.dirname(continuePath));
    if (continueConfig !== null) fs.writeFileSync(continuePath, continueConfig);
  }
  const result = spawnSync('/bin/bash', [path.join(repoRoot, 'install.sh')], {
    env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin` },
    encoding: 'utf8',
  });

  return {
    status: result.status,
    configPath,
    continuePath,
    original: mcpConfig,
    stdout: result.stdout,
    stderr: result.stderr,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

test('install.sh: malformed Cursor config fails closed without modification', () => {
  const run = runShellInstaller('{not-json');
  try {
    assert.notEqual(run.status, 0);
    assert.equal(fs.readFileSync(run.configPath, 'utf8'), run.original);
  } finally { run.cleanup(); }
});

test('install.sh: package preflight failure aborts before config changes', () => {
  const existing = '{"mcpServers":{}}\n';
  const run = runShellInstaller(existing, 1);
  try {
    assert.notEqual(run.status, 0);
    assert.equal(fs.readFileSync(run.configPath, 'utf8'), existing);
  } finally { run.cleanup(); }
});

test('install.sh: rejects Node versions outside >=20 <27', () => {
  for (const nodeMajor of [19, 27]) {
    const existing = '{"mcpServers":{}}\n';
    const run = runShellInstaller(existing, 0, nodeMajor);
    try {
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /Node\.js >= 20 and < 27 is required/);
      assert.equal(fs.readFileSync(run.configPath, 'utf8'), existing);
    } finally { run.cleanup(); }
  }
});

test('install.sh: preserves existing servers and backs up before atomic replacement', () => {
  const existing = JSON.stringify({
    mcpServers: { existing: { command: 'existing-command' } },
    unrelated: true,
  }, null, 2) + '\n';
  const run = runShellInstaller(existing);
  try {
    assert.equal(run.status, 0);
    const updated = JSON.parse(fs.readFileSync(run.configPath, 'utf8'));
    assert.deepEqual(updated.mcpServers.existing, { command: 'existing-command' });
    assert.deepEqual(updated.mcpServers.jambavan, { command: 'npx', args: ['-y', 'jambavan'] });
    assert.equal(updated.unrelated, true);
    assert.equal(fs.readFileSync(`${run.configPath}.bak`, 'utf8'), existing);
  } finally { run.cleanup(); }
});

test('install.sh: writes documented Continue config.yaml instead of a JSON drop-in', () => {
  const run = runShellInstaller('{"mcpServers":{}}\n', 0, 20, null);
  try {
    assert.equal(run.status, 0);
    const config = fs.readFileSync(run.continuePath, 'utf8');
    assert.match(config, /^name: Local config$/m);
    assert.match(config, /^schema: v1$/m);
    assert.match(config, /^mcpServers:\n  - name: Jambavan$/m);
    assert.match(config, /^    command: npx$/m);
    assert.equal(
      fs.existsSync(path.join(path.dirname(run.continuePath), 'mcpServers', 'jambavan.json')),
      false,
    );
  } finally { run.cleanup(); }
});

test('install.sh: preserves existing Continue YAML and prints exact manual guidance', () => {
  const existing = 'name: Existing\nversion: 1.0.0\nschema: v1\n';
  const run = runShellInstaller('{"mcpServers":{}}\n', 0, 20, existing);
  try {
    assert.equal(run.status, 0);
    assert.equal(fs.readFileSync(run.continuePath, 'utf8'), existing);
    assert.match(run.stdout, /mcpServers:\n  - name: Jambavan\n    command: npx\n    args:\n      - -y\n      - jambavan/);
  } finally { run.cleanup(); }
});

test('install.ps1: stays compatible with PowerShell 5.1 and documents lifecycle commands', () => {
  const script = fs.readFileSync(path.join(repoRoot, 'install.ps1'), 'utf8');
  assert.doesNotMatch(script, /ConvertFrom-Json\s+-AsHashtable/);
  assert.doesNotMatch(script, /mcpServers[\\/]jambavan\.json/);
  assert.match(script, /Node\.js >= 20 and < 27 is required/);
  assert.match(script, /Join-Path \$continueDir "config\.yaml"/);
  assert.match(script, /Package preflight failed/);
  assert.match(script, /\.bak/);
  assert.match(script, /\.tmp-/);
  assert.match(script, /call jambavan_awaken once/);
  assert.match(script, /mcp remove jambavan/);
});

test('release and reusable review workflows keep version inputs and checks safe', () => {
  const workflows = path.join(repoRoot, '.github', 'workflows');
  const ci = fs.readFileSync(path.join(workflows, 'ci.yml'), 'utf8');
  const review = fs.readFileSync(path.join(workflows, 'jambavan-review.yml'), 'utf8');
  const release = fs.readFileSync(path.join(workflows, 'release.yml'), 'utf8');

  assert.match(ci, /node-version: \[20, 22, 24, 26\]/);
  assert.match(ci, /shell: powershell/);
  assert.match(ci, /PSVersionTable\.PSVersion\.Major/);
  assert.match(review, /^\s{6}package_version:$/m);
  assert.match(review, /PACKAGE_VERSION: \$\{\{ inputs\.package_version \|\| 'latest' \}\}/);
  assert.match(review, /Invalid package_version: \$PACKAGE_VERSION/);
  assert.match(review, /npx --yes "jambavan@\$PACKAGE_VERSION" review-pack/);
  assert.match(release, /\[\[ "\$GITHUB_REF_NAME" != "v\$package_version" \]\]/);
  const publish = release.indexOf('npm publish --provenance --access public');
  for (const command of ['docs-check', 'installer-check', 'coverage', 'build']) {
    const check = `npm run ${command}`;
    assert.ok(release.indexOf(check) > 0 && release.indexOf(check) < publish);
  }
  assert.ok(release.indexOf('npm test') > 0 && release.indexOf('npm test') < publish);
  assert.ok(release.indexOf('npm pack --dry-run') > 0 && release.indexOf('npm pack --dry-run') < publish);
});
