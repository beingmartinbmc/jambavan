const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jambavan-installer-'));
const bin = path.join(home, 'bin');
fs.mkdirSync(bin);
fs.mkdirSync(path.join(home, '.cursor'));
fs.mkdirSync(path.join(home, '.continue'));

const cursorFile = path.join(home, '.cursor', 'mcp.json');
fs.writeFileSync(cursorFile, JSON.stringify({
  theme: 'dark',
  mcpServers: { existing: { command: 'existing-server' } },
}));

const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
};

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`,
  );
}

try {
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'npx.cmd'), '@exit /b 0\r\n');
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'install.ps1')]);
  } else {
    const mockNpx = path.join(bin, 'npx');
    fs.writeFileSync(mockNpx, '#!/usr/bin/env sh\nexit 0\n');
    fs.chmodSync(mockNpx, 0o755);
    run('bash', [path.join(root, 'install.sh')]);
  }

  const cursor = JSON.parse(fs.readFileSync(cursorFile, 'utf8'));
  assert.equal(cursor.theme, 'dark', 'installer must preserve unrelated Cursor settings');
  assert.deepEqual(cursor.mcpServers.existing, { command: 'existing-server' });
  assert.deepEqual(cursor.mcpServers.jambavan, {
    command: 'npx',
    args: ['-y', 'jambavan'],
  });

  const continueFile = path.join(home, '.continue', 'config.yaml');
  const continueConfig = fs.readFileSync(continueFile, 'utf8');
  assert.match(continueConfig, /^name: Local config$/m);
  assert.match(continueConfig, /^schema: v1$/m);
  assert.match(continueConfig, /^mcpServers:\r?\n  - name: Jambavan$/m);
  assert.match(continueConfig, /^    command: npx$/m);
  assert.match(continueConfig, /^      - jambavan$/m);
  assert.equal(
    fs.existsSync(path.join(home, '.continue', 'mcpServers', 'jambavan.json')),
    false,
    'installer must not write the undocumented Continue JSON drop-in',
  );

  console.log(`installer-check: ${process.platform} config transforms passed`);
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
