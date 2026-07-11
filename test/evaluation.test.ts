import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'node:child_process';
import {
  calculateOutcomeMetrics,
  evaluateOutcomes,
  formatOutcomeEvaluation,
  parseOutcomeJson,
  runEvaluationCommand,
  type TaskOutcome,
} from '../src/evaluation';

const baseline: TaskOutcome[] = [
  { taskId: 'a', success: true, attempts: 1, repeatedFailures: 0, durationMs: 100, inputTokens: 1000 },
  { taskId: 'b', success: false, attempts: 3, repeatedFailures: 1, durationMs: 400, inputTokens: 2000 },
  { taskId: 'c', success: true, attempts: 2, repeatedFailures: 1, durationMs: 300, inputTokens: 3000 },
];

const jambavan: TaskOutcome[] = [
  { taskId: 'c', success: true, attempts: 1, repeatedFailures: 0, durationMs: 160, inputTokens: 1700 },
  { taskId: 'a', success: true, attempts: 1, repeatedFailures: 0, durationMs: 80, inputTokens: 700 },
  { taskId: 'b', success: true, attempts: 2, repeatedFailures: 1, durationMs: 200, inputTokens: 1200 },
];

test('calculateOutcomeMetrics measures completion, failures, time, and tokens', () => {
  assert.deepEqual(calculateOutcomeMetrics(baseline), {
    taskCount: 3,
    completedCount: 2,
    completionRate: 2 / 3,
    firstPassSuccessCount: 1,
    firstPassSuccessRate: 1 / 3,
    repeatedFailureCount: 2,
    repeatedFailureRate: 2 / 3,
    medianCompletionTimeMs: 200,
    averageInputTokens: 2000,
  });
});

test('evaluateOutcomes computes raw Jambavan-minus-baseline deltas', () => {
  const report = evaluateOutcomes(baseline, jambavan);
  assert.equal(report.jambavan.completionRate, 1);
  assert.ok(Math.abs(report.deltas.completionRatePercentagePoints - 100 / 3) < 1e-10);
  assert.ok(Math.abs(report.deltas.firstPassSuccessRatePercentagePoints - 100 / 3) < 1e-10);
  assert.ok(Math.abs(report.deltas.repeatedFailureRatePercentagePoints + 100 / 3) < 1e-10);
  assert.equal(report.deltas.repeatedFailureCount, -1);
  assert.equal(report.deltas.medianCompletionTimeMs, -40);
  assert.equal(report.deltas.averageInputTokens, -800);
});

test('parseOutcomeJson rejects duplicate task IDs and unknown fields', () => {
  assert.throws(
    () => parseOutcomeJson(JSON.stringify([baseline[0], baseline[0]]), 'baseline'),
    /duplicate taskId "a"/,
  );
  assert.throws(
    () => parseOutcomeJson(JSON.stringify([{ ...baseline[0], note: 'not allowed' }]), 'baseline'),
    /must contain exactly/,
  );
});

test('parseOutcomeJson rejects invalid JSON and numeric boundaries', () => {
  assert.throws(() => parseOutcomeJson('{', 'baseline'), /not valid JSON/);
  assert.throws(() => parseOutcomeJson('[]', 'baseline'), /non-empty JSON array/);

  for (const invalid of [
    { ...baseline[0], attempts: 0 },
    { ...baseline[0], durationMs: -1 },
    { ...baseline[0], inputTokens: 1.5 },
    { ...baseline[0], inputTokens: Number.MAX_SAFE_INTEGER + 1 },
    { ...baseline[0], repeatedFailures: 1 },
  ]) {
    assert.throws(() => parseOutcomeJson(JSON.stringify([invalid]), 'baseline'));
  }
});

test('calculateOutcomeMetrics reports no completion median when every task fails', () => {
  const metrics = calculateOutcomeMetrics([
    { taskId: 'failed', success: false, attempts: 1, repeatedFailures: 0, durationMs: 10, inputTokens: 20 },
  ]);
  assert.equal(metrics.medianCompletionTimeMs, null);
});

test('evaluateOutcomes rejects mismatched task IDs', () => {
  assert.throws(
    () => evaluateOutcomes(baseline, jambavan.filter(task => task.taskId !== 'b').concat({
      taskId: 'd', success: true, attempts: 1, repeatedFailures: 0, durationMs: 1, inputTokens: 1,
    })),
    /missing from Jambavan: b; only in Jambavan: d/,
  );
});

test('formatOutcomeEvaluation emits CLI-friendly JSON and directional markdown', () => {
  const report = evaluateOutcomes(baseline, jambavan);
  assert.deepEqual(JSON.parse(formatOutcomeEvaluation(report, 'json')), report);

  const markdown = formatOutcomeEvaluation(report, 'markdown');
  assert.match(markdown, /Delta \(Jambavan - baseline\)/);
  assert.match(markdown, /\| Completion rate .* \| Higher \|/);
  assert.match(markdown, /\| Repeated-failure rate .* -33\.3 pp \| Lower \|/);
  assert.match(markdown, /\| Median completion time .* -40 ms \| Lower \|/);
  assert.match(markdown, /successful tasks only/);
});

test('runEvaluationCommand reads paired evidence files and validates CLI options', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jambavan-evaluation-'));
  try {
    const baselinePath = path.join(directory, 'baseline.json');
    const jambavanPath = path.join(directory, 'jambavan.json');
    fs.writeFileSync(baselinePath, JSON.stringify(baseline));
    fs.writeFileSync(jambavanPath, JSON.stringify(jambavan));

    const output = runEvaluationCommand([
      '--baseline', baselinePath,
      '--jambavan', jambavanPath,
      '--format', 'json',
    ]);
    assert.equal(JSON.parse(output).taskCount, 3);

    const cliOutput = execFileSync(process.execPath, [
      '--require', 'ts-node/register/transpile-only',
      'src/index.ts', 'evaluate',
      '--baseline', baselinePath,
      '--jambavan', jambavanPath,
      '--format', 'json',
    ], { cwd: path.resolve(__dirname, '..'), encoding: 'utf-8' });
    assert.equal(JSON.parse(cliOutput).taskCount, 3);

    assert.throws(
      () => runEvaluationCommand(['--baseline', baselinePath, '--jambavan', jambavanPath, '--format', 'csv']),
      /--format must be json or markdown/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
