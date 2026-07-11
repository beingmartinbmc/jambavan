---
name: root-cause-debugger
description: Use when investigating a bug, test failure, or unexpected behavior — before proposing any fix. Enforces observe/compare/hypothesize/fix phases to prevent guess-and-check thrashing. Escalates after 3+ failed fix attempts.
---

# Root Cause Debugger

If the `jambavan_mool_kaaran` MCP tool is available, call it with the symptom (and `attempts_so_far` if this is not the first try) and use its output as an investigation checklist. Otherwise, follow the protocol below directly.

## Evidence before fixes

Gather enough evidence to explain the likely failure mechanism before proposing a durable fix. If an urgent containment step is needed, label it as mitigation rather than root-cause resolution. After three unsuccessful fixes, pause and reassess assumptions, reproduction quality, and design boundaries; repeated failures do not by themselves prove the architecture is wrong.

## Phase 1: Observe (before touching anything)

1. **Read the error completely.** Stack traces, line numbers, error codes — do not skim.
2. **Reproduce consistently.** Can you trigger it reliably? What are the exact steps?
3. **Check recent changes.** What changed? `git diff`, recent commits, new deps, config.
4. **Trace data flow.** Where does the bad value originate? Trace backward, not forward.

At multi-component boundaries, add the smallest safe diagnostic instrumentation needed:
- Log what enters each component.
- Log what exits each component.
- Run to gather evidence showing where it breaks.
- Remove temporary instrumentation when it is no longer needed, and do not log secrets.

## Phase 2: Compare

1. Find a **working example** of similar code in this codebase.
2. List every difference between working and broken — however small.
3. Do not assume "that can't matter."

## Phase 3: Hypothesize and Test

1. Form ONE hypothesis: "X is the root cause because Y."
2. Make the SMALLEST possible change to test it.
3. One variable at a time.
4. Did it work? → Phase 4. Did not? → form a new hypothesis rather than stacking unverified fixes.

## Phase 4: Fix

1. Where practical, write or identify a failing test that reproduces the bug.
2. Fix the root cause (not the symptom).
3. Verify: test passes, no other tests broken.
4. If 3+ fixes have failed, pause and discuss the evidence and next investigative step with the human.

## Reassessment after repeated failed fixes

Repeated failures can indicate a weak reproduction, an incorrect hypothesis, hidden shared state, or a design problem. Review which explanation the evidence supports.

Pause patching, summarize what each attempt disproved, and agree on the next experiment. Consider an architecture change only when the evidence points there.

## Red Flags — return to Phase 1

- "Quick fix for now, investigate later."
- "Just try changing X and see."
- "I don't fully understand but this might work."
- Proposing solutions before tracing data flow.
- Each fix reveals a new problem in a different place.

## Jambavan workflow

- Call `jambavan_failure_search` before retrying a failed command or approach; a prior record may contain useful evidence.
- After resolving or pausing the bug, call `jambavan_failure_store` with the known root cause and specific do-not-retry advice so a later session can consult it.
