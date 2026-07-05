/**
 * Mool Kaaran (मूल कारण) — Root Cause Investigation Protocol
 *
 * A structured debugging discipline tool. When the model encounters a bug,
 * test failure, or unexpected behavior, this tool returns a phased investigation
 * protocol that prevents guess-and-check thrashing.
 *
 * Named for the Sanskrit principle: find the root (mool) cause (kaaran),
 * not the surface symptom. Like Jambavan counseling patience before the leap.
 *
 * Read-only. Returns protocol text for the model to follow.
 */

export interface MoolKaaranInput {
  symptom: string;
  context?: string;
  attempts_so_far?: number;
}

const PROTOCOL = `
# Mool Kaaran — Root Cause Investigation

## The Iron Law

NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.

If you have not completed Phase 1, you cannot propose fixes.
If you have already tried 3+ fixes without success, STOP — the architecture is wrong, not the code.

## Phase 1: Observe (before touching anything)

1. **Read the error completely.** Stack traces, line numbers, error codes — do not skim.
2. **Reproduce consistently.** Can you trigger it reliably? What are the exact steps?
3. **Check recent changes.** What changed? git diff, recent commits, new deps, config.
4. **Trace data flow.** Where does the bad value originate? Trace backward, not forward.

At multi-component boundaries, add diagnostic instrumentation FIRST:
- Log what enters each component
- Log what exits each component
- Run once to gather evidence showing WHERE it breaks
- THEN investigate that specific component

## Phase 2: Compare

1. Find a **working example** of similar code in this codebase.
2. List every difference between working and broken — however small.
3. Do not assume "that can't matter."

## Phase 3: Hypothesize and Test

1. Form ONE hypothesis: "X is the root cause because Y."
2. Make the SMALLEST possible change to test it.
3. One variable at a time.
4. Did it work? → Phase 4. Did not? → NEW hypothesis. Do NOT stack fixes.

## Phase 4: Fix

1. Write a failing test that reproduces the bug.
2. Fix the root cause (not the symptom).
3. Verify: test passes, no other tests broken.
4. If 3+ fixes have failed: STOP. Question the architecture. Discuss with the human.

## Red Flags — return to Phase 1

- "Quick fix for now, investigate later"
- "Just try changing X and see"
- "I don't fully understand but this might work"
- Proposing solutions before tracing data flow
- Each fix reveals a new problem in a different place
`.trim();

const ESCALATION_PROTOCOL = `
## Escalation: Architecture Problem Detected

You have tried 3+ fixes. This pattern indicates:
- Each fix reveals new shared state / coupling / problem elsewhere
- Fixes require "massive refactoring" to implement
- Each fix creates new symptoms

STOP fixing. Question fundamentals:
- Is this pattern/approach sound?
- Are you persisting through inertia?
- Should the architecture change vs. continuing to patch symptoms?

Discuss with your human partner before attempting more fixes.
`.trim();

export function moolKaaranProtocol(input: Record<string, unknown>): string {
  const symptom = String(input['symptom'] ?? '').trim();
  const context = input['context'] ? String(input['context']).trim() : '';
  const attempts = typeof input['attempts_so_far'] === 'number'
    ? input['attempts_so_far']
    : (input['attempts_so_far'] ? Number(input['attempts_so_far']) : 0);

  if (!symptom) return 'Error: symptom is required. Describe what went wrong.';

  const parts: string[] = [];

  parts.push(PROTOCOL);

  if (attempts >= 3) {
    parts.push('', ESCALATION_PROTOCOL);
  }

  parts.push('', '---', '', '## Your Investigation');
  parts.push(`**Symptom:** ${symptom}`);
  if (context) parts.push(`**Context:** ${context}`);
  if (attempts > 0) parts.push(`**Attempts so far:** ${attempts}`);

  parts.push('', 'Begin Phase 1. Read the error. Reproduce. Trace. Do not propose a fix yet.');

  return parts.join('\n');
}
