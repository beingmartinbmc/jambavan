import * as path from 'path';
import { vibhishanaNitiInstructions } from './vibhishana-niti';
import { MemoryStore } from '../memory/store';
import type { JambavanConfig } from '../config/jambavan.config';

export function projectScope(config: JambavanConfig): string {
  return path.basename(config.projectRoot).toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'project';
}

export function jambavanInstructions(config: JambavanConfig): string {
  const scope = projectScope(config);
  return [
    'JAMBAVAN PROTOCOL — awaken the agent powers now.',
    '',
    `Project root: ${config.projectRoot}`,
    `Default memory scope: ${scope}`,
    '',
    'At session start:',
    `1. Call jambavan_awaken if you have not already read this protocol.`,
    `2. Call jambavan_memory_recall with scope "${scope}"; if empty, continue.`,
    '3. Call jambavan_diagnostics. If index is missing/stale for the task, call jambavan_index.',
    '4. After indexing, call jambavan_watch action=start so context stays live.',
    '',
    'Before code changes:',
    '5. Use jambavan_context before touching unfamiliar code; use search/read_file only to fill exact gaps.',
    '6. Grep every caller for bug fixes; fix root cause once.',
    '7. Prefer patch_file over write_file. Keep edits inside project root.',
    '8. Run the smallest relevant check with bash before final answer.',
    '',
    'After important decisions:',
    `9. Store durable facts/architecture decisions with jambavan_memory_store scope "${scope}".`,
    '10. Use jambavan_rin_mochan before releases/refactors.',
    '',
    vibhishanaNitiInstructions(process.env.JAMBAVAN_DEV_MODE),
  ].join('\n');
}

export function awakenReport(config: JambavanConfig, opts: { includeMemories?: boolean } = {}): string {
  const scope = projectScope(config);
  const parts = [jambavanInstructions(config)];

  if (opts.includeMemories ?? true) {
    const docs = new MemoryStore(config.memoryDir).list(scope)
      .sort((a, b) => b.frontmatter.timestamp.localeCompare(a.frontmatter.timestamp))
      .slice(0, 10);
    parts.push('', `# Recalled memories: ${scope} (${docs.length})`);
    parts.push(docs.length
      ? docs.map(d => `## ${d.frontmatter.title}\n${d.body}`).join('\n\n---\n\n')
      : 'No memories stored for this project yet.');
  }

  return parts.join('\n');
}
