import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { aliasToolsFor, resolveToolAlias, TOOL_ALIASES } from '../src/mcp/tool-aliases';

function tool(name: string): Tool {
  return {
    name,
    description: `${name} canonical description`,
    inputSchema: { type: 'object', properties: {}, required: [] },
  };
}

test('resolveToolAlias maps functional aliases to canonical tool names', () => {
  assert.equal(resolveToolAlias('root_cause'), 'jambavan_mool_kaaran');
  assert.equal(resolveToolAlias('verify_gate'), 'jambavan_praman');
  assert.equal(resolveToolAlias('jambavan_context'), 'jambavan_context');
});

test('aliasToolsFor advertises aliases with canonical schemas and descriptions', () => {
  const canonical = tool('jambavan_mool_kaaran');
  const aliases = aliasToolsFor([
    canonical,
    tool('jambavan_praman'),
  ]);

  assert.deepEqual(aliases.map(t => t.name).sort(), ['root_cause', 'verify_gate']);
  assert.equal(aliases[0].inputSchema, canonical.inputSchema);
  assert.match(aliases[0].description ?? '', /Functional alias for jambavan_mool_kaaran/);
});

test('aliasToolsFor only lists aliases whose canonical tool is advertised', () => {
  const aliases = aliasToolsFor(Object.values(TOOL_ALIASES)
    .filter(name => name !== 'jambavan_sankshipta')
    .map(tool));

  assert.ok(!aliases.some(t => t.name === 'compress_prompt'));
  assert.ok(aliases.some(t => t.name === 'root_cause'));
});
