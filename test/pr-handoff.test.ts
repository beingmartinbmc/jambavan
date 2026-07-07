import { test } from 'node:test';
import * as assert from 'node:assert';
import { HANDOFF_START, HANDOFF_END, buildHandoffBlock, injectHandoffBlock } from '../src/tools/pr-handoff';

test('injectHandoffBlock: creates the block when the template is empty', () => {
  const result = injectHandoffBlock('', '# Jambavan Session Handoff\n\nsome content');
  assert.match(result, new RegExp(HANDOFF_START.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')));
  assert.match(result, /Jambavan session handoff \(auto-generated/);
  assert.match(result, /some content/);
});

test('injectHandoffBlock: appends the block to an existing template with unrelated content', () => {
  const template = '## Summary\n\nDescribe your change here.\n';
  const result = injectHandoffBlock(template, 'handoff body');
  assert.match(result, /## Summary/);
  assert.match(result, /Describe your change here\./);
  assert.match(result, /handoff body/);
  // Original content preserved before the injected block.
  assert.ok(result.indexOf('## Summary') < result.indexOf(HANDOFF_START));
});

test('injectHandoffBlock: re-running replaces the prior block in place (idempotent, no duplication)', () => {
  const template = '## Summary\n\nDescribe your change here.\n';
  const first = injectHandoffBlock(template, 'first handoff');
  const second = injectHandoffBlock(first, 'second handoff');

  assert.equal((second.match(new RegExp(HANDOFF_START, 'g')) ?? []).length, 1, 'exactly one start marker after re-injection');
  assert.doesNotMatch(second, /first handoff/);
  assert.match(second, /second handoff/);
  assert.match(second, /## Summary/, 'unrelated template content survives re-injection');
});

test('buildHandoffBlock: wraps handoff text in a collapsible <details> block bounded by markers', () => {
  const block = buildHandoffBlock('  some handoff text  ');
  assert.ok(block.startsWith(HANDOFF_START));
  assert.ok(block.endsWith(HANDOFF_END));
  assert.match(block, /<details>/);
  assert.match(block, /some handoff text/);
});
