---
name: release-checker
description: Use before claiming tests pass, a build succeeds, a bug is fixed, requirements are met, or a release/PR is ready to ship. Demands fresh verification evidence instead of assumptions, confidence, or previous runs.
---

# Release Checker

If the `jambavan_praman` MCP tool is available, call it with your claim (and `type`: tests/build/fix/requirements/general) and use its output as a verification checklist. Otherwise, follow the protocol below directly.

## Evidence rule

Match each completion claim to fresh evidence from the current working tree. If a relevant check is unavailable, unsafe, or disproportionate, report that limitation instead of presenting the result as verified.

## The Gate

Before making a success or completion claim:

1. **IDENTIFY:** What command proves this claim?
2. **RUN:** Execute the smallest complete command appropriate to the risk.
3. **READ:** Inspect the complete result, including exit code and failure count.
4. **VERIFY:** Does output confirm the claim?
   - YES → State the claim with concise evidence.
   - NO → State the actual status and the relevant failure.

Do not imply that an unrun check passed.

## Verification by claim type

**Tests** — Run the relevant test command and report its pass/fail summary. Claim the full suite passes only after running the full suite; a focused test proves only its own scope.

**Build** — Run the build command. Check exit code. "Build succeeds" requires build output showing exit 0. Linter passing ≠ build passing. Type-check passing ≠ bundle succeeding.

**Bug fix** — Prefer a reproducer that fails before the fix and passes after it. When a safe pre-fix run is impractical, explain the alternative evidence. Run regression checks in proportion to the change's blast radius.

**Requirements met** — Re-read the original requirements/plan. Create a line-by-line checklist. For each item: what proves it's done (test? output? demo?). Check each item with evidence. Report gaps honestly — "tests pass" ≠ "requirements met."

**Release / PR ready** — Apply the relevant checks above, inspect the final diff for scope and debug artifacts, and distinguish intended uncommitted work from unrelated user changes.

## Unsupported-claim indicators

- Using "should", "probably", "seems to."
- Expressing satisfaction before running verification.
- About to commit or open a PR without checking the final diff and relevant gates.
- Trusting a previous run or a partial check.
- Confidence offered in place of a check.

## Jambavan workflow (pre-release checklist)

- `jambavan_review_pack` — touched files, bounded extracted caller candidates, related tests, past failures on those files, and risk flags (open rin debt, no matching test) vs. the base branch.
- `jambavan_rin_mochan` — any `// rin:` markers with no upgrade trigger should be resolved or justified before release, not silently shipped.
- `jambavan_failure_search` — search relevant prior failures for regression risks; the search alone does not prove absence.
