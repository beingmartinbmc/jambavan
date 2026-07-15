import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ToolRegistry, boundedInt, capOutput, type RegisteredTool } from '../src/tools/registry';

function stubTool(name: string, handler: RegisteredTool['handler']): RegisteredTool {
  return { definition: { name, description: '', parameters: {} }, handler };
}

test('boundedInt: valid integer passes through', () => {
  assert.equal(boundedInt(42, { min: 1, max: 100, fallback: 10 }), 42);
});

test('boundedInt: non-numeric input (NaN via coercion) falls back', () => {
  const opts = { min: 1, max: 100, fallback: 10 };
  assert.equal(boundedInt(undefined, opts), 10);
  assert.equal(boundedInt('nope', opts), 10);
  assert.equal(boundedInt(NaN, opts), 10);
  assert.equal(boundedInt({}, opts), 10);
});

test('boundedInt: values that coerce to a finite number (null, []) clamp, not fall back', () => {
  // Documented edge: Number(null) === 0 and Number([]) === 0 — both finite, so
  // they clamp to min. Safe for trust-boundary use (result stays in range).
  const opts = { min: 1, max: 100, fallback: 10 };
  assert.equal(boundedInt(null, opts), 1);
  assert.equal(boundedInt([], opts), 1);
});

test('boundedInt: Infinity is not finite -> fallback', () => {
  assert.equal(boundedInt(Infinity, { min: 1, max: 100, fallback: 7 }), 7);
  assert.equal(boundedInt(-Infinity, { min: 1, max: 100, fallback: 7 }), 7);
});

test('boundedInt: clamps below min and above max', () => {
  assert.equal(boundedInt(-5, { min: 1, max: 100, fallback: 10 }), 1);
  assert.equal(boundedInt(0, { min: 1, max: 100, fallback: 10 }), 1);
  assert.equal(boundedInt(1e12, { min: 1, max: 100, fallback: 10 }), 100);
});

test('boundedInt: floors fractional input', () => {
  assert.equal(boundedInt(4.9, { min: 1, max: 100, fallback: 10 }), 4);
  assert.equal(boundedInt(1.0001, { min: 1, max: 100, fallback: 10 }), 1);
});

test('boundedInt: numeric string coerces', () => {
  assert.equal(boundedInt('25', { min: 1, max: 100, fallback: 10 }), 25);
});

test('boundedInt: blank / whitespace-only string falls back (not clamped to min)', () => {
  // Regression: Number('') and Number('   ') coerce to 0, which previously
  // clamped to min instead of using the documented default. An empty env var
  // (e.g. JAMBAVAN_TOKEN_BUDGET="") must yield the fallback.
  assert.equal(boundedInt('', { min: 100, max: 1_000_000, fallback: 8_000 }), 8_000);
  assert.equal(boundedInt('   ', { min: 100, max: 1_000_000, fallback: 8_000 }), 8_000);
  assert.equal(boundedInt('\t\n', { min: 1, max: 100, fallback: 30 }), 30);
});

test('capOutput: short output is untouched', () => {
  assert.equal(capOutput('small output'), 'small output');
  assert.equal(capOutput(''), '');
});

test('capOutput: oversized output is truncated and annotated', () => {
  const big = 'x'.repeat(200_000);
  const out = capOutput(big);
  assert.ok(out.length < big.length);
  assert.match(out, /output truncated/);
  // Truncated body must be a prefix of the original (no corruption).
  assert.ok(big.startsWith(out.slice(0, 100_000)));
});

test('ToolRegistry: unknown tool returns structured failure', async () => {
  const reg = new ToolRegistry();
  const r = await reg.execute('ghost', {});
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /Unknown tool/);
});

test('ToolRegistry: successful output is capped centrally', async () => {
  const reg = new ToolRegistry();
  reg.register(stubTool('flood', async () => ({ success: true, output: 'y'.repeat(200_000) })));
  const r = await reg.execute('flood', {});
  assert.equal(r.success, true);
  assert.ok(r.output.length < 200_000);
  assert.match(r.output, /output truncated/);
});

test('ToolRegistry: failed result error field is capped (flood guard)', async () => {
  const reg = new ToolRegistry();
  reg.register(stubTool('boom', async () => ({ success: false, output: '', error: 'z'.repeat(200_000) })));
  const r = await reg.execute('boom', {});
  assert.equal(r.success, false);
  assert.ok((r.error?.length ?? 0) < 200_000, 'error should be capped');
  assert.match(r.error ?? '', /output truncated/);
});

test('ToolRegistry: failed result output is also capped', async () => {
  const reg = new ToolRegistry();
  // Simulates bash tool returning megabytes of compiler errors in output field
  reg.register(stubTool('compile-fail', async () => ({
    success: false,
    output: 'error: '.repeat(50_000),
    error: 'Build failed',
  })));
  const r = await reg.execute('compile-fail', {});
  assert.equal(r.success, false);
  assert.ok(r.output.length < 'error: '.repeat(50_000).length, 'output on failure should be capped');
  assert.match(r.output, /output truncated/);
  // error field under cap passes through unchanged
  assert.equal(r.error, 'Build failed');
});

test('ToolRegistry: thrown handler error is caught and normalized', async () => {
  const reg = new ToolRegistry();
  reg.register(stubTool('throws', async () => { throw new Error('kaboom'); }));
  const r = await reg.execute('throws', {});
  assert.equal(r.success, false);
  assert.equal(r.error, 'kaboom');
});

test('ToolRegistry: non-Error throw is stringified', async () => {
  const reg = new ToolRegistry();
  reg.register(stubTool('throws-string', async () => { throw 'plain string'; }));
  const r = await reg.execute('throws-string', {});
  assert.equal(r.success, false);
  assert.equal(r.error, 'plain string');
});

test('ToolRegistry: register/get/definitions round-trip', () => {
  const reg = new ToolRegistry();
  reg.register(stubTool('a', async () => ({ success: true, output: '' })));
  reg.register(stubTool('b', async () => ({ success: true, output: '' })));
  assert.ok(reg.get('a'));
  assert.equal(reg.get('missing'), undefined);
  assert.deepEqual(reg.definitions().map(d => d.name).sort(), ['a', 'b']);
});
