import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { moolKaaranProtocol } from '../src/tools/mool-kaaran';
import { pramanProtocol } from '../src/tools/praman';
import { yuktiProtocol } from '../src/tools/yukti';
import { vibhaajanProtocol } from '../src/tools/vibhaajan';

// ── Mool Kaaran (Root Cause) ──────────────────────────────────────────────────

test('moolKaaranProtocol: rejects missing symptom', () => {
  const result = moolKaaranProtocol({});
  assert.match(result, /Error: symptom is required/);
});

test('moolKaaranProtocol: returns basic protocol for single attempt', () => {
  const result = moolKaaranProtocol({ symptom: 'Test suite crashed on startup', context: 'After upgrading Node.js' });
  assert.match(result, /# Mool Kaaran/);
  assert.match(result, /Symptom:.*Test suite crashed/);
  assert.match(result, /Context:.*Node.js/);
  assert.doesNotMatch(result, /Escalation: Architecture Problem/);
});

test('moolKaaranProtocol: escalates on 3+ attempts', () => {
  const result = moolKaaranProtocol({ symptom: 'Memory leak in watcher', attempts_so_far: 3 });
  assert.match(result, /Escalation: Architecture Problem Detected/);
  assert.match(result, /Attempts so far:\*\*\s*3/);
});

// ── Praman (Proof) ────────────────────────────────────────────────────────────

test('pramanProtocol: rejects missing claim', () => {
  const result = pramanProtocol({});
  assert.match(result, /Error: claim is required/);
});

test('pramanProtocol: returns base protocol and general guidance for default type', () => {
  const result = pramanProtocol({ claim: 'all files indexed' });
  assert.match(result, /# Praman/);
  assert.match(result, /Your claim:.*all files indexed/);
  assert.match(result, /Verification: General/);
});

test('pramanProtocol: returns specific guidance for tests/build/fix types', () => {
  const types = ['tests', 'build', 'fix', 'requirements'] as const;
  for (const t of types) {
    const result = pramanProtocol({ claim: 'done', type: t });
    assert.match(result, new RegExp(`Verification:.*${t}`, 'i'));
  }
});

// ── Yukti (Strategy) ──────────────────────────────────────────────────────────

test('yuktiProtocol: rejects missing task', () => {
  const result = yuktiProtocol({});
  assert.match(result, /Error: task is required/);
});

test('yuktiProtocol: returns small scale protocol for simple tasks', () => {
  const result = yuktiProtocol({ task: 'fix typo' });
  assert.match(result, /Yukti — Approach \(small task\)/);
  assert.match(result, /Scale:\*\*\s*small/);
});

test('yuktiProtocol: returns large scale protocol for complex tasks or explicit choice', () => {
  const resultA = yuktiProtocol({ task: 'refactor the entire database package' });
  assert.match(resultA, /Yukti — Approach \(large task\)/);
  assert.match(resultA, /Scale:\*\*\s*large/);

  const resultB = yuktiProtocol({ task: 'simple change', scale: 'large' });
  assert.match(resultB, /Yukti — Approach \(large task\)/);
  assert.match(resultB, /Scale:\*\*\s*large/);
});

test('yuktiProtocol: returns medium scale protocol for moderate tasks', () => {
  const result = yuktiProtocol({ task: 'implement validation rules for controller requests' });
  assert.match(result, /Yukti — Approach \(medium task\)/);
  assert.match(result, /Scale:\*\*\s*medium/);
});

// ── Vibhaajan (Parallel Decomposition) ────────────────────────────────────────

test('vibhaajanProtocol: rejects missing task', () => {
  const result = vibhaajanProtocol({});
  assert.match(result, /Error: task is required/);
});

test('vibhaajanProtocol: returns decomposition protocol', () => {
  const result = vibhaajanProtocol({ task: 'build payment gateway and user profile modules', units: 2, constraints: 'no shared database tables' });
  assert.match(result, /# Vibhaajan/);
  assert.match(result, /Task:.*build payment gateway/);
  assert.match(result, /Target units:\*\*\s*2/);
  assert.match(result, /Constraints:.*no shared database/);
});

test('vibhaajanProtocol: ignores invalid units (negative, fractional, < 2)', () => {
  const neg = vibhaajanProtocol({ task: 'split into modules', units: -2 });
  assert.doesNotMatch(neg, /Target units/);

  const frac = vibhaajanProtocol({ task: 'split into modules', units: 2.5 });
  assert.doesNotMatch(frac, /Target units/);

  const one = vibhaajanProtocol({ task: 'split into modules', units: 1 });
  assert.doesNotMatch(one, /Target units/);

  const zero = vibhaajanProtocol({ task: 'split into modules', units: 0 });
  assert.doesNotMatch(zero, /Target units/);

  // Valid values still work
  const two = vibhaajanProtocol({ task: 'split into modules', units: 2 });
  assert.match(two, /Target units:\*\*\s*2/);

  const ten = vibhaajanProtocol({ task: 'split into modules', units: 10 });
  assert.match(ten, /Target units:\*\*\s*10/);
});

