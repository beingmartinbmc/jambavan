---
name: root-cause-debugger
description: Use when investigating a bug, test failure, or unexpected behavior — before proposing any fix. Enforces observe/compare/hypothesize/fix phases to prevent guess-and-check thrashing. Escalates after 3+ failed fix attempts.
---

# Root Cause Debugger

If the `jambavan_mool_kaaran` MCP tool is available, call it with the symptom (and `attempts_so_far` if this isn't the first try) and follow its output verbatim — it returns this same protocol tailored to the specific symptom. Otherwise, follow the protocol below directly.

## The Iron Law

NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.

If you have not completed Phase 1, you cannot propose fixes.
If you have already tried 3+ fixes without success, STOP — the architecture is wrong, not the code.

## Phase 1: Observe (before touching anything)

1. **Read the error completely.** Stack traces, line numbers, error codes — do not skim.
2. **Reproduce consistently.** Can you trigger it reliably? What are the exact steps?
3. **Check recent changes.** What changed? `git diff`, recent commits, new deps, config.
4. **Trace data flow.** Where does the bad value originate? Trace backward, not forward.

At multi-component boundaries, add diagnostic instrumentation FIRST:
- Log what enters each component.
- Log what exits each component.
- Run once to gather evidence showing WHERE it breaks.
- THEN investigate that specific component.

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

## Escalation: Architecture Problem Detected (3+ failed fixes)

This pattern indicates:
- Each fix reveals new shared state / coupling / problem elsewhere.
- Fixes require "massive refactoring" to implement.
- Each fix creates new symptoms.

STOP fixing. Question fundamentals — is this pattern/approach sound, or should the architecture change instead of continuing to patch symptoms? Discuss with your human partner before attempting more fixes.

## Red Flags — return to Phase 1

- "Quick fix for now, investigate later."
- "Just try changing X and see."
- "I don't fully understand but this might work."
- Proposing solutions before tracing data flow.
- Each fix reveals a new problem in a different place.

## Jambavan workflow

- Call `jambavan_failure_search` before retrying anything — a prior session may have already diagnosed this exact symptom.
- After resolving (or giving up on) the bug, call `jambavan_failure_store` with the root cause and do-not-retry advice so the next session doesn't repeat the investigation.
