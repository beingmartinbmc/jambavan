/**
 * Yukti (युक्ति) — Strategic Approach Selection
 *
 * When facing a multi-step task, this tool returns a structured protocol
 * for breaking the work into phases, choosing approaches, and validating
 * each step before proceeding to the next.
 *
 * Named for the Sanskrit word meaning strategy, skillful means, or rational plan.
 * Like Jambavan laying out the reconnaissance before sending Hanuman across the sea.
 *
 * Read-only. Returns a planning protocol the model follows to decompose and sequence work.
 */

export interface YuktiInput {
  task: string;
  constraints?: string;
  scale?: 'small' | 'medium' | 'large';
}

const PROTOCOL_SMALL = `
# Yukti — Approach (small task)

## Before touching code:

1. **State the goal** in one sentence. If you cannot, the task is unclear — ask.
2. **Find the existing pattern.** Search the codebase for precedent. Match it.
3. **Identify the one file** (or two) that changes. If more, re-scope.
4. **Write the test first** (or identify the check that proves it works).
5. **Make the change.** One diff. Run the check.

No plan document needed. Execute.
`.trim();

const PROTOCOL_MEDIUM = `
# Yukti — Approach (medium task)

## Before touching code:

1. **State the goal** — what does "done" look like? What is out of scope?
2. **Explore context** — read the relevant code, recent commits, existing patterns.
3. **Propose 2-3 approaches** with tradeoffs. Pick the one with fewest moving parts.
4. **Sequence the steps** — order by dependency, not by what seems fun.
   Each step should be independently verifiable (test passes, build succeeds).
5. **Identify risks** — what could go wrong? What do you not understand yet?
   Investigate unknowns BEFORE committing to an approach.

## Execution discipline:

- One step at a time. Verify before proceeding.
- If a step takes 3+ attempts, stop. Re-evaluate the approach.
- Do not "while I'm here" — scope creep is the enemy of completion.
- After each step: does the project still build and pass tests?

## Completion:

- Re-read the original goal.
- Verify each acceptance criterion with evidence (jambavan_praman).
- Only then claim done.
`.trim();

const PROTOCOL_LARGE = `
# Yukti — Approach (large task)

## Phase 0: Understand before planning

1. **Restate the requirement** in your own words. Confirm with the human.
2. **Explore the codebase** — identify all subsystems touched.
3. **Map dependencies** — what depends on what? What order must things change?
4. **Identify unknowns** — what do you not understand? Investigate NOW, not during implementation.

## Phase 1: Decompose

Break the task into independent units. Each unit:
- Has one clear purpose
- Can be implemented and tested alone
- Has a definition of "done" (a command that proves it works)

If a unit touches more than 3 files, it is too large. Split further.

## Phase 2: Sequence

Order units by dependency:
- Foundation first (data models, interfaces, shared utilities)
- Then consumers of those foundations
- Then integration / wiring
- Then polish (error messages, edge cases, docs)

Each unit is a checkpoint. After each: full build, full test suite, review.

## Phase 3: Execute

For each unit:
1. Write the failing test(s).
2. Implement the minimum to pass.
3. Verify (jambavan_praman).
4. Commit.

If 3+ attempts on any unit fail, question the decomposition.

## Phase 4: Integrate

- Run full test suite.
- Re-read original requirements line by line.
- Verify each with evidence.
- Only then claim completion.

## Red Flags — stop and re-plan

- "I'll figure it out as I go"
- A unit touches 5+ files
- You're changing something you don't fully understand
- The plan has no checkpoints
- You're excited about the architecture (YAGNI alert)
`.trim();

export function yuktiProtocol(input: Record<string, unknown>): string {
  const task = String(input['task'] ?? '').trim();
  const constraints = input['constraints'] ? String(input['constraints']).trim() : '';
  const scale = (['small', 'medium', 'large'].includes(String(input['scale'] ?? ''))
    ? String(input['scale'])
    : undefined) as 'small' | 'medium' | 'large' | undefined;

  if (!task) return 'Error: task is required. Describe what you need to accomplish.';

  // Auto-detect scale if not provided
  const effectiveScale = scale ?? inferScale(task);

  const protocol = {
    small:  PROTOCOL_SMALL,
    medium: PROTOCOL_MEDIUM,
    large:  PROTOCOL_LARGE,
  }[effectiveScale];

  const parts: string[] = [
    protocol,
    '',
    '---',
    '',
    `**Task:** ${task}`,
  ];

  if (constraints) parts.push(`**Constraints:** ${constraints}`);
  parts.push(`**Scale:** ${effectiveScale}`);
  parts.push('', 'Begin. State the goal. Explore context. Then act.');

  return parts.join('\n');
}

/**
 * Heuristic scale inference from task description length and keywords.
 * rin: keyword heuristic; upgrade to LLM classification if accuracy matters.
 */
function inferScale(task: string): 'small' | 'medium' | 'large' {
  const words = task.split(/\s+/).length;
  const largeSignals = /\b(refactor|redesign|migrate|rewrite|architecture|multiple|system|platform|across|all)\b/i;
  const smallSignals = /\b(fix|typo|rename|add|update|change|one|single|simple)\b/i;

  if (words > 50 || largeSignals.test(task)) return 'large';
  if (words < 15 && smallSignals.test(task)) return 'small';
  return 'medium';
}
