import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { buildContextResponse } from '../src/mcp/server';
import { countTokens } from '../src/context/token-counter';
import { JambavanIndex } from '../src/index/indexer';
import { MemoryStore } from '../src/memory/store';
import { projectScope } from '../src/tools/jambavan';
import { mkTempConfig } from '../test-support/config';

test('jambavan_context injects project memory and extracted neighbors within one budget', async () => {
  const { config, root, cleanup } = mkTempConfig();
  try {
    config.contextTokenBudget = 800;
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'target.ts'), 'export function rareTarget() { return 1; }\n');
    fs.writeFileSync(
      path.join(root, 'src', 'caller.ts'),
      'import { rareTarget } from "./target";\nexport function invokeRare() { return rareTarget(); }\n',
    );
    new MemoryStore(config.memoryDir).store({
      scope: projectScope(config),
      title: 'Rare target decision',
      body: 'rareTarget must remain synchronous for compatibility.',
      type: 'Decision',
    });
    const index = new JambavanIndex(config);
    await index.index();

    const output = buildContextResponse(index, config, { query: 'rareTarget', limit: 1 });

    assert.match(output, /Project memory \(automatic project-scope matches\)/);
    assert.match(output, /Rare target decision/);
    assert.match(output, /invokeRare/);
    assert.match(output, /Structural candidates added before budgeting: 1/);
    assert.ok(countTokens(output) <= config.contextTokenBudget);
    index.close();
  } finally { cleanup(); }
});
