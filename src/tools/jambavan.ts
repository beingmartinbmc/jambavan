import * as os from 'os';
import * as path from 'path';
import { vibhishanaNitiInstructions } from './vibhishana-niti';
import { MemoryArchive } from '../memory/archive';
import { legacyDaemonNotice } from './daemon';
import { isUnsafeFallbackRoot, type JambavanConfig } from '../config/jambavan.config';
export { projectScope, legacyProjectScope, normalizedRemotePath } from '../memory/project-scope';
import { projectScope } from '../memory/project-scope';

/** Best-effort removal of local paths and common credential shapes before sharing. */
export function redactForSharing(value: string, config: JambavanConfig): string {
  let redacted = value;
  const roots = [
    config.memoryDir,
    config.indexDir,
    config.projectRoot,
    os.homedir(),
  ].filter((root, i, all) => root.length > 1 && all.indexOf(root) === i)
    .sort((a, b) => b.length - a.length);

  for (const root of roots) {
    redacted = redacted.split(root).join(root === os.homedir() ? '~' : '[REDACTED_PATH]');
  }

  redacted = redacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, '[REDACTED_SECRET]')
    .replace(/((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|authorization)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '$1[REDACTED]');

  return redacted;
}

export function jambavanInstructions(config: JambavanConfig): string {
  if (isUnsafeFallbackRoot(config)) {
    return [
      'JAMBAVAN PROTOCOL — project root required.',
      '',
      `Unresolved fallback root: ${config.projectRoot}`,
      `Rootless memory archive: ${config.memoryDir}`,
      'Memory tools remain available; code index, graph, impact, file, failure, and handoff tools are blocked.',
      'Pass an eligible root to jambavan_awaken or jambavan_index when project context is needed.',
      '',
      vibhishanaNitiInstructions(process.env.JAMBAVAN_DEV_MODE),
    ].join('\n');
  }
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
    '   Options: compress_prose=true for denser results, include_diff=true for recent git changes, include_tests=true for test coverage.',
    '6. Grep every caller for bug fixes; fix root cause once.',
    '7. Prefer patch_file over write_file. Keep edits inside project root.',
    '8. Run the smallest relevant check with bash before final answer; use quiet/no-color flags and inspect summaries before full logs.',
    '9. Before retrying a failing command, call jambavan_failure_search to check if it was already diagnosed.',
    '',
    'Discipline tools (counsel):',
    '10. Call jambavan_mool_kaaran before debugging — returns a root-cause investigation protocol. Escalates at 3+ failed attempts.',
    '11. Call jambavan_praman before claiming completion — returns a verification gate demanding fresh evidence.',
    '12. Call jambavan_yukti before multi-step tasks — returns an approach protocol scaled to task size.',
    '13. Call jambavan_vibhaajan when a task has independent sub-units — returns a parallel decomposition protocol.',
    '',
    'Token discipline:',
    '14. Every tool byte spends context: filter/project/count at the source; prefer line ranges, max_results, git --stat/name-only, jq/yq/awk/cut/head, and hash/mtime polling over dump-and-read loops.',
    '',
    'After important decisions:',
    `15. Store durable facts/architecture decisions with jambavan_memory_store scope "${scope}" type="Decision" (surfaces in jambavan_session_export's Decisions section).`,
    '16. After a command fails, store it with jambavan_failure_store (prevents retry loops in future sessions).',
    '17. Use jambavan_rin_mochan before releases/refactors.',
    '',
    'Session transfer:',
    '18. Use jambavan_session_export to hand off context to a new session or colleague.',
    '',
    vibhishanaNitiInstructions(process.env.JAMBAVAN_DEV_MODE),
  ].join('\n');
}

export function awakenReport(config: JambavanConfig, opts: { includeMemories?: boolean } = {}): string {
  const scope = isUnsafeFallbackRoot(config) ? 'global' : projectScope(config);
  const parts = [jambavanInstructions(config)];

  const legacy = legacyDaemonNotice(config);
  if (legacy) {
    parts.push('', `⚠ ${legacy}`);
  }

  if (opts.includeMemories ?? true) {
    const docs = new MemoryArchive(config).list(scope)
      .sort((a, b) => b.frontmatter.timestamp.localeCompare(a.frontmatter.timestamp))
      .slice(0, 10);
    parts.push('', `# Recalled memories: ${scope} (${docs.length})`);
    parts.push(docs.length
      ? docs.map(d => `## ${d.frontmatter.title}\n${d.body}`).join('\n\n---\n\n')
      : 'No memories stored for this project yet.');
  }

  return parts.join('\n');
}
