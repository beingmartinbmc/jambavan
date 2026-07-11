/**
 * First-class failure memory — structured schema for recording what failed and why.
 *
 * Prevents retry loops across sessions by storing a searchable FailureRecord
 * in the OKF memory store. Models query past failures before re-attempting commands.
 */

import * as crypto from 'crypto';
import { MemoryStore } from '../memory/store';
import type { JambavanConfig } from '../config/jambavan.config';
import { projectScope, redactForSharing } from './jambavan';

export interface FailureRecord {
  command: string;
  symptom: string;
  attempted_fix?: string;
  root_cause?: string;
  resolution?: string;
  status: 'unresolved' | 'resolved' | 'wontfix';
  do_not_retry?: string;
  next_path?: string;
}

export interface BlockingFailure {
  id: string;
  advice: string;
}

interface UnresolvedFailure {
  id: string;
  advice?: string;
}

function commandTag(command: string): string {
  return `command-${crypto.createHash('sha256').update(command).digest('hex').slice(0, 16)}`;
}

function legacyCommand(body: string): string | undefined {
  return body.match(/^\*\*Command:\*\* `(.*)`$/m)?.[1];
}

function doNotRetryAdvice(body: string): string | undefined {
  return body.match(/^⚠️ \*\*Do NOT retry:\*\* (.+)$/m)?.[1]?.trim();
}

function findUnresolvedFailure(config: JambavanConfig, command: string): UnresolvedFailure | undefined {
  const tag = commandTag(command);
  for (const doc of new MemoryStore(config.memoryDir).list(projectScope(config))) {
    const unresolved = doc.frontmatter.tags.includes('unresolved')
      || /^\*\*Status:\*\* unresolved$/m.test(doc.body);
    if (doc.frontmatter.type !== 'FailureRecord' || !unresolved) continue;
    const exactCommand = doc.frontmatter.tags.includes(tag) || legacyCommand(doc.body) === command;
    const advice = doNotRetryAdvice(doc.body);
    if (exactCommand) return { id: doc.id, advice };
  }
  return undefined;
}

/** Find a repeated project-local failure that now blocks this exact command. */
export function findBlockingFailure(config: JambavanConfig, command: string): BlockingFailure | undefined {
  const failure = findUnresolvedFailure(config, command);
  return failure?.advice ? { id: failure.id, advice: failure.advice } : undefined;
}

/** Apply the caller's explicit safe override before consulting failure memory. */
export function knownFailureBlock(
  config: JambavanConfig,
  input: Record<string, unknown>,
): BlockingFailure | undefined {
  if (input['retry_known_failure'] === true) return undefined;
  return findBlockingFailure(config, String(input['command'] ?? ''));
}

/** Clear an automatic/manual block after one deliberate retry succeeds. */
export function resolveBlockingFailure(config: JambavanConfig, command: string): string | undefined {
  const failure = findUnresolvedFailure(config, command);
  if (!failure) return undefined;
  return new MemoryStore(config.memoryDir).invalidate(
    failure.id,
    'Exact command succeeded on an explicit retry.',
  ) ? failure.id : undefined;
}

/**
 * Store one redacted local record per unresolved command. Repeated override
 * failures update nothing until the existing record is resolved.
 */
export function recordAutomaticBashFailure(
  config: JambavanConfig,
  command: string,
  symptom: string,
): { id: string; stored: boolean } {
  const existing = findUnresolvedFailure(config, command);
  if (existing?.advice) return { id: existing.id, stored: false };
  if (existing) {
    new MemoryStore(config.memoryDir).invalidate(existing.id, 'Same command failed again unchanged.');
  }

  const redactedCommand = redactForSharing(command, config);
  const conciseSymptom = redactForSharing(symptom, config).replace(/\s+/g, ' ').trim().slice(0, 300)
    || 'Command returned a failure.';
  const record: FailureRecord = {
    command: redactedCommand,
    symptom: conciseSymptom,
    status: 'unresolved',
    ...(existing ? {
      do_not_retry: 'Do not rerun this exact command unchanged; inspect the symptom or change the conditions first.',
      next_path: 'Fix the recorded cause, then set retry_known_failure=true for one deliberate retry.',
    } : {
      next_path: 'Inspect the symptom before retrying; an unchanged second failure will block later attempts.',
    }),
  };
  const id = storeFailureRecord(config, record, projectScope(config), 'bash-auto', command);
  return { id, stored: true };
}

export const FAILURE_MEMORY_TOOL_DEFS = [
  {
    name: 'jambavan_failure_store',
    description: [
      'Store a structured failure record in the memory palace.',
      'Use after a command/approach fails to prevent repeating the same mistake in future sessions.',
      'Stores: command, symptom, attempted fix, root cause, resolution, status, and advice on what NOT to retry.',
    ].join(' '),
    inputSchema: {
      type: 'object' as const,
      properties: {
        command:       { type: 'string', description: 'The command or action that failed.' },
        symptom:       { type: 'string', description: 'What went wrong (error message, behavior).' },
        attempted_fix: { type: 'string', description: 'What was tried to fix it.' },
        root_cause:    { type: 'string', description: 'Why it failed (if known).' },
        resolution:    { type: 'string', description: 'What actually fixed it (if resolved).' },
        status:        { type: 'string', enum: ['unresolved', 'resolved', 'wontfix'], description: 'Current status. Default: unresolved.' },
        do_not_retry:  { type: 'string', description: 'What specifically should NOT be tried again.' },
        next_path:     { type: 'string', description: 'Suggested next approach if unresolved.' },
        scope:         { type: 'string', description: 'Memory scope / project name. Defaults to project scope derived from project root.' },
      },
      required: ['command', 'symptom'],
    },
  },
  {
    name: 'jambavan_failure_search',
    description: [
      'Search past failure records for a command, error, or symptom.',
      'Call BEFORE retrying a failing command to check if it was already diagnosed.',
      'Returns structured failure records with status and resolution info.',
    ].join(' '),
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Command name, error text, or symptom to search for.' },
        scope: { type: 'string', description: 'Restrict to this scope. Omit for all.' },
        limit: { type: 'number', description: 'Max results (default: 5).' },
      },
      required: ['query'],
    },
  },
] as const;

export function buildFailureHandlers(config: JambavanConfig) {
  // Lazy per-call construction — see buildMemoryHandlers() in memory.ts for why
  // a build-time-captured store goes stale after roots/list root resolution.
  const store = () => new MemoryStore(config.memoryDir);

  return {
    jambavan_failure_store(input: Record<string, unknown>): string {
      const command = String(input['command'] ?? '').trim();
      const symptom = String(input['symptom'] ?? '').trim();
      if (!command || !symptom) return 'Error: command and symptom are required.';

      const record: FailureRecord = {
        command,
        symptom,
        attempted_fix: input['attempted_fix'] ? String(input['attempted_fix']) : undefined,
        root_cause:    input['root_cause']    ? String(input['root_cause'])    : undefined,
        resolution:    input['resolution']    ? String(input['resolution'])    : undefined,
        status:        (['unresolved', 'resolved', 'wontfix'].includes(String(input['status'] ?? ''))
                         ? String(input['status']) as FailureRecord['status']
                         : 'unresolved'),
        do_not_retry:  input['do_not_retry']  ? String(input['do_not_retry'])  : undefined,
        next_path:     input['next_path']     ? String(input['next_path'])     : undefined,
      };
      const failScope = input['scope'] ? String(input['scope']) : projectScope(config);
      const id = storeFailureRecord(config, record, failScope, 'failure-store');

      return `Stored failure record. ID: ${id}\nStatus: ${record.status}`;
    },

    jambavan_failure_search(input: Record<string, unknown>): string {
      const query = String(input['query'] ?? '').trim();
      if (!query) return 'Error: query is required.';

      const scope = input['scope'] ? String(input['scope']) : undefined;
      const limit = input['limit'] ? Number(input['limit']) : 5;

      // Search with the user's query directly — do NOT prepend 'failure' which
      // would pollute BM25 scoring and cause false positives on any FailureRecord.
      // The type filter ensures only FailureRecords are returned; BM25 ranking
      // naturally pushes irrelevant results to the bottom.
      const results = store().search(query, { scope, limit: limit * 2 })
        .filter(r => r.doc.frontmatter.type === 'FailureRecord')
        .slice(0, limit);

      if (results.length === 0) return `No failure records found for: "${query}"`;

      return results.map(({ doc, score }) => {
        return [
          `## ${doc.frontmatter.title}`,
          `ID: ${doc.id} | score: ${score.toFixed(2)} | ${doc.frontmatter.timestamp.slice(0, 10)}`,
          '',
          doc.body.trim(),
        ].join('\n');
      }).join('\n\n---\n\n');
    },
  };
}

function storeFailureRecord(
  config: JambavanConfig,
  record: FailureRecord,
  scope: string,
  source: string,
  commandIdentity = record.command,
): string {
  const contentKey = `${record.command}\n${record.symptom}`;
  const hash = crypto.createHash('sha256').update(contentKey).digest('hex').slice(0, 8);
  return new MemoryStore(config.memoryDir).store({
    title: `Failure: ${record.command.slice(0, 50)} [${hash}]`,
    body: formatFailureBody(record),
    scope,
    type: 'FailureRecord',
    description: `${record.status}: ${record.symptom.slice(0, 100)}`,
    tags: ['failure', record.status, commandTag(commandIdentity)],
    source,
  });
}

function formatFailureBody(record: FailureRecord): string {
  const lines: string[] = [
    `**Command:** \`${record.command}\``,
    `**Symptom:** ${record.symptom}`,
    `**Status:** ${record.status}`,
  ];
  if (record.attempted_fix) lines.push(`**Attempted fix:** ${record.attempted_fix}`);
  if (record.root_cause)    lines.push(`**Root cause:** ${record.root_cause}`);
  if (record.resolution)    lines.push(`**Resolution:** ${record.resolution}`);
  if (record.do_not_retry)  lines.push(`\n⚠️ **Do NOT retry:** ${record.do_not_retry}`);
  if (record.next_path)     lines.push(`\n→ **Next path:** ${record.next_path}`);
  return lines.join('\n');
}
