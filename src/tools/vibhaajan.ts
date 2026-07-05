/**
 * Vibhaajan (विभाजन) — Parallel Work Decomposition
 *
 * When a task has independent sub-units that can proceed in parallel,
 * this tool returns a decomposition protocol: identify boundaries,
 * verify independence, define contracts, and sequence the merge.
 *
 * Named for the Sanskrit word meaning division/decomposition.
 * Like Jambavan assigning different vanara squads to search different directions.
 *
 * Read-only. Returns a protocol the model follows to split and parallelize work.
 */

export interface VibhaajanInput {
  task: string;
  units?: number;
  constraints?: string;
}

const PROTOCOL = `
# Vibhaajan — Parallel Work Decomposition

## The Iron Law

PARALLEL UNITS MUST BE INDEPENDENT. If they share mutable state, they are not parallel — they are sequential with a bug waiting to happen.

## Phase 1: Identify Boundaries

1. **List every sub-task.** What are all the things that need to happen?
2. **Draw the dependency graph.** For each pair: does A need B's output? Does B need A's output?
3. **Mark independent sets.** Units with no edges between them can run in parallel.
4. **Mark sequential chains.** Units with edges must be ordered. No exceptions.

## Phase 2: Verify Independence

For each "parallel" pair, ask:
- Do they touch the same file? → NOT independent (merge conflicts).
- Do they touch the same data structure / table / state? → NOT independent (race condition).
- Does one define an interface the other consumes? → Sequential. Define interface FIRST, then parallelize implementations.
- Do they share a test fixture or config? → Fragile. Isolate fixtures or serialize.

If any pair fails this check, either:
- Re-draw the boundary so they don't overlap, OR
- Accept they are sequential and order them.

## Phase 3: Define Contracts

For each boundary between parallel units:
1. **Interface first.** Define the type/schema/API that connects them BEFORE implementing either side.
2. **Mock at boundaries.** Each unit should be testable with a stub of its neighbor.
3. **No shared mutable state.** If you need shared state, it goes in a separate sequential unit that runs first.

## Phase 4: Execute

- Start all independent units. Each is self-contained and verifiable.
- After all parallel units pass their own checks, integrate.
- Run the full suite after integration — parallel correctness ≠ integrated correctness.

## Phase 5: Merge

1. Integrate one unit at a time into the main branch.
2. After each merge: build + full test suite.
3. If merge conflicts arise, the boundary was wrong. Fix the decomposition, not just the conflict.

## Red Flags — you decomposed wrong

- Two "parallel" units keep needing changes in the same file
- You need to "coordinate" between parallel units mid-flight
- One unit is blocked waiting for the other's "partial output"
- The merge phase is more complex than any single unit
- Units share global state, singletons, or environment variables
`.trim();

const SOLO_GUIDANCE = `
## Solo Decomposition (single agent, multiple logical tracks)

Even without multiple agents, decomposition helps:
- Work on unit A until it passes its check. Commit.
- Context-switch to unit B with a clean state. Commit.
- Integrate. Never interleave uncommitted work across units.

Benefits: smaller diffs, easier rollback, clearer git history, less cognitive load per step.
`.trim();

export function vibhaajanProtocol(input: Record<string, unknown>): string {
  const task = String(input['task'] ?? '').trim();
  const rawUnits = input['units'];
  // Validate: must be a positive integer ≥ 2 (decomposing into 1 unit is not decomposition)
  const parsedUnits = Number(rawUnits);
  const units = (rawUnits != null && Number.isInteger(parsedUnits) && parsedUnits >= 2) ? parsedUnits : undefined;
  const constraints = input['constraints'] ? String(input['constraints']).trim() : '';

  if (!task) return 'Error: task is required. Describe what you need to decompose into parallel work.';

  const parts: string[] = [PROTOCOL, '', SOLO_GUIDANCE];

  parts.push('', '---', '');
  parts.push(`**Task:** ${task}`);
  if (units) parts.push(`**Target units:** ${units}`);
  if (constraints) parts.push(`**Constraints:** ${constraints}`);
  parts.push('', 'Begin Phase 1. List every sub-task. Draw the dependency graph. Do not start implementing until boundaries are verified.');

  return parts.join('\n');
}
