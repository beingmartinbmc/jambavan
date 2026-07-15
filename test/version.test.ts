import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import pkg from '../package.json';
import lock from '../package-lock.json';
import plugin from '../plugins/jambavan/.claude-plugin/plugin.json';
import server from '../server.json';

test('first-party release metadata uses package.json version', () => {
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(plugin.version, pkg.version);
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages[0].version, pkg.version);
});
