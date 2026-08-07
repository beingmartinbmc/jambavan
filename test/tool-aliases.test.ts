import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  DEPRECATED_TOOLS,
  isDeprecatedTool,
  resolveToolAlias,
  resolveToolCall,
} from '../src/mcp/tool-aliases';
import { graphAction } from '../src/mcp/server';
import { PROMPTS, PROMPT_TOOL_HANDLERS } from '../src/mcp/prompts';

test('retired Sanskrit tool names resolve to their English replacements', () => {
  assert.equal(resolveToolAlias('jambavan_mool_kaaran'), 'jambavan_root_cause');
  assert.equal(resolveToolAlias('jambavan_praman'), 'jambavan_verify_gate');
  assert.equal(resolveToolAlias('jambavan_yukti'), 'jambavan_strategy_plan');
  assert.equal(resolveToolAlias('jambavan_vibhaajan'), 'jambavan_decompose_task');
  assert.equal(resolveToolAlias('jambavan_vibhishana_niti'), 'jambavan_dev_rules');
  assert.equal(resolveToolAlias('jambavan_rin_mochan'), 'jambavan_debt_ledger');
  assert.equal(resolveToolAlias('jambavan_sankshipta'), 'jambavan_compress_prompt');
});

test('pre-2.0 unprefixed aliases still resolve', () => {
  assert.equal(resolveToolAlias('root_cause'), 'jambavan_root_cause');
  assert.equal(resolveToolAlias('debt_ledger'), 'jambavan_debt_ledger');
});

test('current tool names pass through untouched', () => {
  assert.equal(resolveToolAlias('jambavan_context'), 'jambavan_context');
  assert.deepEqual(
    resolveToolCall('jambavan_context', { query: 'auth' }),
    { name: 'jambavan_context', input: { query: 'auth' } },
  );
});

test('merged graph tools carry their action', () => {
  for (const [old, action] of [
    ['jambavan_graph_report', 'report'],
    ['jambavan_graph_query', 'query'],
    ['jambavan_graph_path', 'path'],
  ] as const) {
    const resolved = resolveToolCall(old, {});
    assert.equal(resolved.name, 'jambavan_graph');
    assert.equal(resolved.input['action'], action);
  }
});

test('memory_invalidate never degrades into a delete', () => {
  // Both old names take only `id`, so an inference-based router would silently
  // turn an invalidate into a destructive delete. The mode must be pinned.
  const invalidate = resolveToolCall('jambavan_memory_invalidate', { id: 'x/y' });
  assert.equal(invalidate.name, 'jambavan_memory_forget');
  assert.equal(invalidate.input['mode'], 'invalidate');

  const remove = resolveToolCall('jambavan_memory_delete', { id: 'x/y' });
  assert.equal(remove.name, 'jambavan_memory_forget');
  assert.equal(remove.input['mode'], 'delete');
});

test('caller arguments override the defaults an old name implies', () => {
  const resolved = resolveToolCall('jambavan_graph_report', { action: 'path', from: 'a', to: 'b' });
  assert.equal(resolved.input['action'], 'path');
});

test('legacy compression aliases retain their pre-2.0 in-place default', () => {
  for (const name of ['jambavan_sankshipta', 'compress_prompt']) {
    assert.equal(resolveToolCall(name, { path: 'prompt.md' }).input['in_place'], true);
    assert.equal(resolveToolCall(name, { path: 'prompt.md', in_place: false }).input['in_place'], false);
  }
});

test('isDeprecatedTool distinguishes retired names from current ones', () => {
  assert.ok(isDeprecatedTool('jambavan_sankshipta'));
  assert.ok(!isDeprecatedTool('jambavan_compress_prompt'));
});

test('every deprecated target is a real canonical tool or prompt handler', () => {
  // A typo in the alias map would silently route a working old name into a
  // dead branch that reports "unknown tool", so pin the targets down.
  const canonical = new Set([
    'jambavan_awaken', 'jambavan_index', 'jambavan_context', 'jambavan_watch',
    'jambavan_doctor', 'jambavan_graph', 'jambavan_debt_ledger',
    'jambavan_compress_prompt', 'jambavan_impact', 'jambavan_review_pack',
    'jambavan_memory_store', 'jambavan_memory_read', 'jambavan_memory_forget',
    'jambavan_memory_mine_session', 'jambavan_memory_status',
    'jambavan_failure_store', 'jambavan_failure_search',
    'jambavan_session_handoff',
    ...Object.keys(PROMPT_TOOL_HANDLERS),
  ]);
  for (const [old, target] of Object.entries(DEPRECATED_TOOLS)) {
    assert.ok(canonical.has(target.name), `${old} -> unknown target ${target.name}`);
  }
});

test('graphAction infers the operation from arguments', () => {
  assert.equal(graphAction({}), 'report');
  assert.equal(graphAction({ query: 'greet' }), 'query');
  assert.equal(graphAction({ from: 'a', to: 'b' }), 'path');
  assert.equal(graphAction({ action: 'report', query: 'greet' }), 'report');
  assert.equal(graphAction({ action: 'nonsense' }), undefined);
});

test('every counsel prompt has a matching callable tool handler', () => {
  for (const prompt of PROMPTS) {
    assert.ok(
      resolveToolAlias(prompt.name) in PROMPT_TOOL_HANDLERS,
      `prompt ${prompt.name} has no tool handler`,
    );
  }
});
