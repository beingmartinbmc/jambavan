---
name: strict-reviewer
description: Use when reviewing a diff, PR, or set of changes — your own or someone else's. Applies a severe-senior-engineer review checklist (root cause vs. symptom, unrequested abstractions, missing tests/checks, unverified claims) instead of a superficial pass.
---

# Strict Reviewer

Reviewing is not skimming for typos. Find what a lazy pass would miss: the wrong root cause, the abstraction nobody asked for, the claim with no evidence behind it.

## Step 1 — Get the real diff, not a guess

If `jambavan_review_pack` is available, call it against the PR's base branch. It gives you touched files, indexed symbols changed in each, bounded extracted caller candidates, associated tests, past failure records mentioning the same files, and risk flags (open `// rin:` debt, no matching test). Treat graph and test associations as review leads, not proof of completeness.

Otherwise: `git diff --stat` first, then the full diff only for files that matter.

## Step 2 — Root cause, not symptom

- Is this a fix for the actual bug, or a patch on the path the ticket happened to name?
- If a shared function was touched, were the relevant callers and public entry points checked? A guard added to one call site while an identified sibling caller stays broken is a review-blocking finding, not a nit.
- Does the change explain *why*, not just *what*? A diff that only patches the symptom should be flagged even if it "works."

## Step 3 — Scope discipline

Flag, don't just note, when a diff contains:
- An abstraction with exactly one implementation (interface/factory for a single case).
- A new dependency where the stdlib or an already-installed package would do.
- Boilerplate or scaffolding nobody asked for.
- Changes broader than the stated problem — "while I was in there" edits to unrelated code.
- A shortcut with no `// rin:` marker naming its ceiling and upgrade path (or a `// rin:` marker used to excuse actual sloppiness rather than a conscious tradeoff).

Not negotiable, regardless of diff size: input validation at trust boundaries, error handling that prevents data loss, security, accessibility, and anything the original request explicitly asked for. A "small diff" is not an excuse to skip these.

## Step 4 — Demand evidence, not assertions

Treat every claim in the PR description or commit message as unverified until proven:

- "Tests pass" → did the author paste fresh test output, or is this an assertion? If code without a check accompanies the diff, non-trivial logic without any test/self-check is incomplete, not "fine for now."
- "Fixed the bug" → is there a red→green test pair (fails without the fix, passes with it), or just a claim?
- "No behavior change" → does the diff actually preserve public behavior, or does it silently change an edge case?
- Watch for the exact red flags: "should work", "probably fine", confidence stated instead of a pasted command + output.

## Step 5 — Say what's missing, precisely

Don't write "LGTM" or "looks fine" as a substitute for checking. If you approve, name what you actually verified (which command, which file, which caller). If you request changes, name the smallest fix — not a bigger rewrite than the problem needs.

## Jambavan workflow

- `jambavan_review_pack` — primary input for step 1.
- `jambavan_rin_mochan` — cross-check any new `// rin:` markers introduced by this diff have a real trigger, not a vague "later."
- `jambavan_failure_search` — check whether this diff's approach was already tried and failed in a prior session.
