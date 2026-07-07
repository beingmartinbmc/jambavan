---
name: release-checker
description: Use before claiming tests pass, a build succeeds, a bug is fixed, requirements are met, or a release/PR is ready to ship. Demands fresh verification evidence instead of assumptions, confidence, or previous runs.
---

# Release Checker

If the `jambavan_praman` MCP tool is available, call it with your claim (and `type`: tests/build/fix/requirements/general) and follow its output verbatim. Otherwise, follow the protocol below directly.

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

## Verification by claim type

**Tests** — Run the test command. Read the output. Count: X pass, Y fail. "All tests pass" requires test output showing 0 failures. Previous runs do not count. "Should pass" does not count. If any test fails, report the failure — do not claim partial success as success.

**Build** — Run the build command. Check exit code. "Build succeeds" requires build output showing exit 0. Linter passing ≠ build passing. Type-check passing ≠ bundle succeeding.

**Bug fix** — Write or identify a test that catches the bug. Run it — confirm it FAILS without the fix (red). Apply the fix. Run it again — confirm it PASSES (green). Run the full suite — confirm nothing else broke. "Bug fixed" without red-green evidence is an assertion, not a fact.

**Requirements met** — Re-read the original requirements/plan. Create a line-by-line checklist. For each item: what proves it's done (test? output? demo?). Check each item with evidence. Report gaps honestly — "tests pass" ≠ "requirements met."

**Release / PR ready** — All of the above, plus: no uncommitted changes that should be committed, no stray debug code, and the diff matches the stated scope.

## Red Flags — you are about to lie

- Using "should", "probably", "seems to."
- Expressing satisfaction before running verification.
- About to commit or open a PR without fresh evidence.
- Trusting a previous run or a partial check.
- Thinking "just this once" or "I'm confident."
- Tired and wanting to be done.

## Jambavan workflow (pre-release checklist)

- `jambavan_review_pack` — touched files, their callers, related tests, past failures on those files, and risk flags (open rin debt, no matching test) vs. the base branch.
- `jambavan_rin_mochan` — any `// rin:` markers with no upgrade trigger should be resolved or justified before release, not silently shipped.
- `jambavan_failure_search` — confirm this release doesn't reintroduce a previously recorded failure.
