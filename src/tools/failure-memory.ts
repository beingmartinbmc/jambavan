/**
 * First-class failure memory — structured schema for recording what failed and why.
 *
 * Prevents retry loops across sessions by storing a searchable FailureRecord
 * in the OKF memory store. Models query past failures before re-attempting commands.
 */

import * as crypto from 'crypto';
import { MemoryStore } from '../memory/store';
import type { JambavanConfig } from '../config/jambavan.config';
import { projectScope } from './jambavan';

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
  const store = new MemoryStore(config.memoryDir);

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

      const body = formatFailureBody(record);

      // Title includes a content hash so distinct failures for the same command
      // are stored as separate records instead of silently overwriting each other.
      const contentKey = `${command}\n${symptom}`;
      const hash = crypto.createHash('sha256').update(contentKey).digest('hex').slice(0, 8);
      const title = `Failure: ${command.slice(0, 50)} [${hash}]`;
      const failScope = input['scope'] ? String(input['scope']) : projectScope(config);

      const id = store.store({
        title,
        body,
        scope: failScope,
        type: 'FailureRecord',
        description: `${record.status}: ${symptom.slice(0, 100)}`,
        tags: ['failure', record.status],
        source: 'failure-store',
      });

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
      const results = store.search(query, { scope, limit: limit * 2 })
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
