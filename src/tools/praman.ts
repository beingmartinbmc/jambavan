/**
 * Praman (प्रमाण) — Verification Gate
 *
 * Before claiming work is complete, the model must present evidence.
 * This tool returns a verification protocol demanding fresh proof —
 * not assumptions, not confidence, not previous runs.
 *
 * Named for the Sanskrit epistemological concept: valid means of knowledge.
 * Like Jambavan demanding Hanuman show the mountain, not merely describe it.
 *
 * Read-only. Returns a checklist the model must satisfy before claiming success.
 */

export interface PramanInput {
  claim: string;
  type?: 'tests' | 'build' | 'fix' | 'requirements' | 'general';
}

const BASE_PROTOCOL = `
# Praman — Evidence Before Claims

## The Iron Law

NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE.

If you have not run the verification command in THIS response, you cannot claim it passes.

## The Gate

Before making ANY success/completion claim:

1. **IDENTIFY:** What command proves this claim?
2. **RUN:** Execute the command fresh, complete (not partial).
3. **READ:** Full output — check exit code, count failures.
4. **VERIFY:** Does output confirm the claim?
   - YES → State claim WITH evidence (paste the proof).
   - NO  → State actual status with evidence. Do not spin.

Skip any step = assertion without proof.
`.trim();

const TYPE_GUIDANCE: Record<string, string> = {
  tests: `
## Verification: Tests

Run the test command. Read the output. Count: X pass, Y fail.
- "All tests pass" requires: test output showing 0 failures.
- Previous runs do not count. "Should pass" does not count.
- If any test fails, report the failure — do not claim partial success as success.
`.trim(),

  build: `
## Verification: Build

Run the build command. Check exit code.
- "Build succeeds" requires: build output showing exit 0.
- Linter passing ≠ build passing.
- Type-check passing ≠ bundle succeeding.
`.trim(),

  fix: `
## Verification: Bug Fix

1. Write or identify a test that catches the bug.
2. Run the test — confirm it FAILS without the fix (red).
3. Apply the fix.
4. Run the test — confirm it PASSES with the fix (green).
5. Run the full suite — confirm nothing else broke.

"Bug fixed" without red-green evidence is an assertion, not a fact.
`.trim(),

  requirements: `
## Verification: Requirements Met

1. Re-read the original requirements / plan.
2. Create a line-by-line checklist.
3. For each item: what proves it's done? (Test? Output? Demo?)
4. Check each item with evidence.
5. Report gaps honestly — "tests pass" ≠ "requirements met."
`.trim(),

  general: `
## Verification: General

Identify what proves your claim. Run it. Paste the output.
Do not use "should", "probably", or "seems to."
Confidence is not evidence. Exhaustion is not an excuse.
`.trim(),
};

const RED_FLAGS = `
## Red Flags — you are about to lie

- Using "should", "probably", "seems to"
- Expressing satisfaction before running verification
- About to commit without fresh evidence
- Trusting a previous run or a partial check
- Thinking "just this once" or "I'm confident"
- Tired and wanting to be done
`.trim();

export function pramanProtocol(input: Record<string, unknown>): string {
  const claim = String(input['claim'] ?? '').trim();
  const type = (['tests', 'build', 'fix', 'requirements', 'general'].includes(String(input['type'] ?? ''))
    ? String(input['type'])
    : 'general') as keyof typeof TYPE_GUIDANCE;

  if (!claim) return 'Error: claim is required. What are you about to assert is done?';

  const parts: string[] = [
    BASE_PROTOCOL,
    '',
    TYPE_GUIDANCE[type],
    '',
    RED_FLAGS,
    '',
    '---',
    '',
    `**Your claim:** "${claim}"`,
    '',
    'Now: what command proves it? Run it. Paste the evidence. Then — and only then — state the claim.',
  ];

  return parts.join('\n');
}
