import * as fs from 'fs';

export interface TaskOutcome {
  taskId: string;
  success: boolean;
  attempts: number;
  repeatedFailures: number;
  durationMs: number;
  inputTokens: number;
}

export interface OutcomeMetrics {
  taskCount: number;
  completedCount: number;
  completionRate: number;
  firstPassSuccessCount: number;
  firstPassSuccessRate: number;
  repeatedFailureCount: number;
  repeatedFailureRate: number;
  medianCompletionTimeMs: number | null;
  averageInputTokens: number;
}

export interface OutcomeEvaluation {
  taskCount: number;
  baseline: OutcomeMetrics;
  jambavan: OutcomeMetrics;
  deltas: {
    completionRatePercentagePoints: number;
    firstPassSuccessRatePercentagePoints: number;
    repeatedFailureRatePercentagePoints: number;
    repeatedFailureCount: number;
    medianCompletionTimeMs: number | null;
    averageInputTokens: number;
  };
}

export type EvaluationFormat = 'json' | 'markdown';

const TASK_FIELDS = [
  'attempts',
  'durationMs',
  'inputTokens',
  'repeatedFailures',
  'success',
  'taskId',
];

function safeInteger(value: unknown, field: string, taskId: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${taskId}.${field} must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

function parseTask(value: unknown, index: number, source: string): TaskOutcome {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source}[${index}] must be an object`);
  }

  const record = value as Record<string, unknown>;
  const fields = Object.keys(record).sort();
  if (fields.length !== TASK_FIELDS.length || fields.some((field, i) => field !== TASK_FIELDS[i])) {
    throw new Error(`${source}[${index}] must contain exactly: ${TASK_FIELDS.join(', ')}`);
  }

  const taskId = record.taskId;
  if (typeof taskId !== 'string' || taskId.length === 0 || taskId.trim() !== taskId) {
    throw new Error(`${source}[${index}].taskId must be a non-empty string without surrounding whitespace`);
  }
  if (typeof record.success !== 'boolean') {
    throw new Error(`${taskId}.success must be a boolean`);
  }

  const attempts = safeInteger(record.attempts, 'attempts', taskId, 1);
  const repeatedFailures = safeInteger(record.repeatedFailures, 'repeatedFailures', taskId, 0);
  if (repeatedFailures > attempts - 1) {
    throw new Error(`${taskId}.repeatedFailures must be <= attempts - 1`);
  }

  return {
    taskId,
    success: record.success,
    attempts,
    repeatedFailures,
    durationMs: safeInteger(record.durationMs, 'durationMs', taskId, 0),
    inputTokens: safeInteger(record.inputTokens, 'inputTokens', taskId, 0),
  };
}

export function parseOutcomeJson(text: string, source = 'input'): TaskOutcome[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${source} must be a non-empty JSON array`);
  }

  const tasks = value.map((task, index) => parseTask(task, index, source));
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.taskId)) throw new Error(`${source} contains duplicate taskId "${task.taskId}"`);
    seen.add(task.taskId);
  }
  return tasks;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function calculateOutcomeMetrics(tasks: TaskOutcome[]): OutcomeMetrics {
  if (tasks.length === 0) throw new Error('Cannot evaluate an empty task set');

  const completed = tasks.filter(task => task.success);
  const firstPass = completed.filter(task => task.attempts === 1);
  const repeatedFailureTasks = tasks.filter(task => task.repeatedFailures > 0);
  const repeatedFailureCount = tasks.reduce((sum, task) => sum + task.repeatedFailures, 0);

  return {
    taskCount: tasks.length,
    completedCount: completed.length,
    completionRate: completed.length / tasks.length,
    firstPassSuccessCount: firstPass.length,
    firstPassSuccessRate: firstPass.length / tasks.length,
    repeatedFailureCount,
    repeatedFailureRate: repeatedFailureTasks.length / tasks.length,
    medianCompletionTimeMs: median(completed.map(task => task.durationMs)),
    averageInputTokens: tasks.reduce((sum, task) => sum + task.inputTokens, 0) / tasks.length,
  };
}

function validateMatchingTaskIds(baseline: TaskOutcome[], jambavan: TaskOutcome[]): void {
  const baselineIds = new Set(baseline.map(task => task.taskId));
  const jambavanIds = new Set(jambavan.map(task => task.taskId));
  const missing = [...baselineIds].filter(id => !jambavanIds.has(id)).sort();
  const extra = [...jambavanIds].filter(id => !baselineIds.has(id)).sort();
  if (missing.length || extra.length) {
    const details = [
      missing.length ? `missing from Jambavan: ${missing.join(', ')}` : '',
      extra.length ? `only in Jambavan: ${extra.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    throw new Error(`Baseline and Jambavan task IDs do not match (${details})`);
  }
}

export function evaluateOutcomes(baselineTasks: TaskOutcome[], jambavanTasks: TaskOutcome[]): OutcomeEvaluation {
  validateMatchingTaskIds(baselineTasks, jambavanTasks);
  const baseline = calculateOutcomeMetrics(baselineTasks);
  const jambavan = calculateOutcomeMetrics(jambavanTasks);

  return {
    taskCount: baselineTasks.length,
    baseline,
    jambavan,
    deltas: {
      completionRatePercentagePoints: (jambavan.completionRate - baseline.completionRate) * 100,
      firstPassSuccessRatePercentagePoints: (jambavan.firstPassSuccessRate - baseline.firstPassSuccessRate) * 100,
      repeatedFailureRatePercentagePoints: (jambavan.repeatedFailureRate - baseline.repeatedFailureRate) * 100,
      repeatedFailureCount: jambavan.repeatedFailureCount - baseline.repeatedFailureCount,
      medianCompletionTimeMs: baseline.medianCompletionTimeMs === null || jambavan.medianCompletionTimeMs === null
        ? null
        : jambavan.medianCompletionTimeMs - baseline.medianCompletionTimeMs,
      averageInputTokens: jambavan.averageInputTokens - baseline.averageInputTokens,
    },
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function signed(value: number, suffix = ''): string {
  return `${value > 0 ? '+' : ''}${Number.isInteger(value) ? value : value.toFixed(1)}${suffix}`;
}

function numeric(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function formatOutcomeEvaluation(report: OutcomeEvaluation, format: EvaluationFormat): string {
  if (format === 'json') return `${JSON.stringify(report, null, 2)}\n`;

  const { baseline, jambavan, deltas } = report;
  const medianBaseline = baseline.medianCompletionTimeMs;
  const medianJambavan = jambavan.medianCompletionTimeMs;
  return [
    '# Jambavan outcome evaluation',
    '',
    `Paired tasks: ${report.taskCount}`,
    '',
    '| Metric | Baseline | Jambavan | Delta (Jambavan - baseline) | Better |',
    '|---|---:|---:|---:|---|',
    `| Completion rate | ${percent(baseline.completionRate)} | ${percent(jambavan.completionRate)} | ${signed(deltas.completionRatePercentagePoints, ' pp')} | Higher |`,
    `| First-pass success rate | ${percent(baseline.firstPassSuccessRate)} | ${percent(jambavan.firstPassSuccessRate)} | ${signed(deltas.firstPassSuccessRatePercentagePoints, ' pp')} | Higher |`,
    `| Repeated-failure rate | ${percent(baseline.repeatedFailureRate)} | ${percent(jambavan.repeatedFailureRate)} | ${signed(deltas.repeatedFailureRatePercentagePoints, ' pp')} | Lower |`,
    `| Repeated-failure count | ${baseline.repeatedFailureCount} | ${jambavan.repeatedFailureCount} | ${signed(deltas.repeatedFailureCount)} | Lower |`,
    `| Median completion time | ${medianBaseline === null ? 'n/a' : `${numeric(medianBaseline)} ms`} | ${medianJambavan === null ? 'n/a' : `${numeric(medianJambavan)} ms`} | ${deltas.medianCompletionTimeMs === null ? 'n/a' : signed(deltas.medianCompletionTimeMs, ' ms')} | Lower |`,
    `| Average input tokens | ${numeric(baseline.averageInputTokens)} | ${numeric(jambavan.averageInputTokens)} | ${signed(deltas.averageInputTokens)} | Lower |`,
    '',
    'Rates use all paired tasks. Median completion time uses successful tasks only.',
    '',
  ].join('\n');
}

function flagValue(args: string[], name: string): string | undefined {
  const indexes = args.flatMap((arg, index) => arg === name ? [index] : []);
  if (indexes.length > 1) throw new Error(`${name} may be provided only once`);
  if (indexes.length === 0) return undefined;
  const value = args[indexes[0] + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

export function runEvaluationCommand(args: string[]): string {
  const allowed = new Set(['--baseline', '--jambavan', '--format']);
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i])) throw new Error(`Unknown evaluate option: ${args[i] ?? ''}`);
  }

  const baselinePath = flagValue(args, '--baseline');
  const jambavanPath = flagValue(args, '--jambavan');
  const format = flagValue(args, '--format') ?? 'markdown';
  if (!baselinePath || !jambavanPath) {
    throw new Error('Usage: jambavan evaluate --baseline <json> --jambavan <json> [--format json|markdown]');
  }
  if (format !== 'json' && format !== 'markdown') {
    throw new Error('--format must be json or markdown');
  }

  const read = (file: string, arm: string): string => {
    try {
      return fs.readFileSync(file, 'utf-8');
    } catch (error) {
      throw new Error(`Cannot read ${arm} file "${file}": ${error instanceof Error ? error.message : error}`);
    }
  };
  const baseline = parseOutcomeJson(read(baselinePath, 'baseline'), 'baseline');
  const jambavan = parseOutcomeJson(read(jambavanPath, 'Jambavan'), 'Jambavan');
  return formatOutcomeEvaluation(evaluateOutcomes(baseline, jambavan), format);
}
