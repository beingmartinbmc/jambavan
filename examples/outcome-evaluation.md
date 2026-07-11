# Offline outcome evaluation

Jambavan's retrieval benchmark measures indexing, retrieval, and token compression. It does not prove that an agent finishes more tasks or makes fewer mistakes. The offline evaluator compares supplied baseline and Jambavan run evidence for those outcome claims. It makes no LLM calls and runs no agents.

## Input

Create one JSON file per arm. Each file must be a non-empty array with exactly one object per task:

```json
[
  {
    "taskId": "fix-001",
    "success": true,
    "attempts": 1,
    "repeatedFailures": 0,
    "durationMs": 84231,
    "inputTokens": 12640
  }
]
```

Every object must contain exactly these fields:

- `taskId`: non-empty string with no surrounding whitespace; unique within the file
- `success`: whether the task's acceptance criteria were met
- `attempts`: safe integer greater than or equal to 1
- `repeatedFailures`: safe integer from 0 through `attempts - 1`; count only failure occurrences that repeat an earlier failure in that task
- `durationMs`: non-negative safe integer for elapsed task time
- `inputTokens`: non-negative safe integer for all model input tokens used by the task

Both files must contain the same task IDs. Array order does not matter. Keep task definitions, acceptance criteria, stopping rules, model, and environment fixed between arms.

## Run

```bash
jambavan evaluate \
  --baseline baseline.json \
  --jambavan jambavan.json \
  --format markdown
```

Use `--format json` for machine-readable output. Deltas are always `Jambavan - baseline`; the markdown output labels whether higher or lower is better.

The report computes:

- completion rate: successful tasks divided by all paired tasks
- first-pass success rate: successful one-attempt tasks divided by all paired tasks
- repeated-failure count: sum of `repeatedFailures`
- repeated-failure rate: tasks with at least one repeated failure divided by all paired tasks
- median completion time: median `durationMs` among successful tasks only, or `null` when none succeeded
- average input tokens: mean `inputTokens` across all paired tasks

## Outcome proof card

Publish aggregate results only after reviewing the generated report:

```text
Jambavan outcome evidence
Harness: <package version or commit>
Run: <UTC date>
Design: paired tasks, fixed model/environment/acceptance criteria
Tasks: <taskCount>
Completion: <baseline>% baseline, <jambavan>% Jambavan
First pass: <baseline>% baseline, <jambavan>% Jambavan
Repeated failures: <baseline count/rate>, <jambavan count/rate>
Median completion time: <baseline ms>, <jambavan ms>
Average input tokens: <baseline>, <jambavan>
Method: https://github.com/beingmartinbmc/jambavan/blob/main/examples/outcome-evaluation.md
```

This harness scores evidence; it does not establish causality. Report task selection, failed runs, and protocol changes rather than filtering unfavorable outcomes.
