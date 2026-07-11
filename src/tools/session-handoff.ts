/**
 * Session Handoff — export/import session state as a compact portable document.
 *
 * Produces a single markdown document containing:
 * - Memories in scope (latest)
 * - Active rin markers (technical debt)
 * - Current git status (dirty files + recent commits)
 *
 * This document is enough for a fresh session in a new host to resume work
 * without calling recall/index/search again.
 */

import { execFileSync } from 'child_process';
import * as path from 'path';
import { MemoryStore, type MemoryDoc } from '../memory/store';
import type { JambavanConfig } from '../config/jambavan.config';
import { projectScope, redactForSharing } from './jambavan';
import { harvestRin } from './vibhishana-niti';
import { countTokens } from '../context/token-counter';

/**
 * Run a git subcommand as an argv array — no shell, no string interpolation.
 * Does NOT trim: porcelain output is line-structured and a whole-string trim
 * would eat the leading status-code space of just the first line. Callers
 * that want a single trimmed value (branch name, counts, log) trim themselves.
 */
function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Decode a `git status --porcelain -b` status code into a short human label. */
function describeStatusCode(code: string): string {
  const map: Record<string, string> = {
    'M ': 'modified (staged)', ' M': 'modified', 'A ': 'added', ' D': 'deleted',
    'D ': 'deleted (staged)', '??': 'untracked', 'R ': 'renamed', 'AM': 'added+modified',
    'UU': 'conflict',
  };
  return map[code] ?? (code.trim() || 'changed');
}

/** One `### ` block for a memory doc — shared by every memory-derived section. */
function renderMemoryBlock(doc: MemoryDoc, redact: (value: string) => string = value => value): string {
  const typeBadge = doc.frontmatter.type && doc.frontmatter.type !== 'Memory'
    ? ` [${redact(doc.frontmatter.type)}]` : '';
  return [
    `### ${redact(doc.frontmatter.title)}`,
    `*${doc.frontmatter.timestamp.slice(0, 10)}*` +
    typeBadge +
    (doc.frontmatter.tags.length ? ` · tags: ${redact(doc.frontmatter.tags.join(', '))}` : ''),
    '',
    redact(doc.body.trim()),
  ].join('\n');
}

/** Pull the `→ **Next path:** ...` line failure-memory.ts embeds in a FailureRecord body. */
function extractNextPath(doc: MemoryDoc): string | undefined {
  const match = doc.body.match(/→ \*\*Next path:\*\*\s*(.+)/);
  return match?.[1]?.trim();
}

export const SESSION_HANDOFF_TOOL_DEFS = [
  {
    name: 'jambavan_session_export',
    description: [
      'Export current session context as a portable handoff document.',
      'Contains: recent memories, rin debt markers, and git status.',
      'Use to transfer context to a new session, different host, or a colleague.',
      'The output is self-contained markdown — paste it into a new session to resume.',
    ].join(' '),
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope:         { type: 'string',  description: 'Memory scope to export. Defaults to project scope.' },
        include_rin:   { type: 'boolean', description: 'Include rin debt markers (default: true).' },
        include_git:   { type: 'boolean', description: 'Include git status/recent commits (default: true).' },
        max_memories:  { type: 'number',  description: 'Max memories to include (default: 15).' },
        share_safe:     { type: 'boolean', description: 'Redact local paths/secrets and omit git-sensitive data for sharing (default: false).' },
      },
      required: [],
    },
  },
  {
    name: 'jambavan_session_import',
    description: [
      'Import a session handoff document into the memory store.',
      'Parses the handoff markdown and stores key items as memories if they are not already present.',
      'Idempotent — re-importing the same document does not create duplicates.',
    ].join(' '),
    inputSchema: {
      type: 'object' as const,
      properties: {
        text:  { type: 'string', description: 'The handoff document markdown to import.' },
        scope: { type: 'string', description: 'Target memory scope. Defaults to project scope.' },
      },
      required: ['text'],
    },
  },
] as const;

export function buildSessionHandoffHandlers(config: JambavanConfig) {
  // Lazy per-call construction — see buildMemoryHandlers() in memory.ts for why
  // a build-time-captured store goes stale after roots/list root resolution.
  const store = () => new MemoryStore(config.memoryDir);
  const scope = () => projectScope(config);

  return {
    jambavan_session_export(input: Record<string, unknown>): string {
      const targetScope  = input['scope'] ? String(input['scope']) : scope();
      const includeRin   = input['include_rin'] !== false;
      const shareSafe    = input['share_safe'] === true;
      const includeGit   = !shareSafe && input['include_git'] !== false;
      const maxMemories  = input['max_memories'] ? Number(input['max_memories']) : 15;
      const redact       = (value: string) => shareSafe ? redactForSharing(value, config) : value;

      const sections: string[] = [
        `# Jambavan Session Handoff`,
        ...(shareSafe ? [
          '> ⚠️ **Review before sharing.** Automated redaction is best-effort; inspect this handoff for private data.',
          '',
        ] : []),
        `**Project:** ${shareSafe ? path.basename(config.projectRoot) : config.projectRoot}`,
        `**Scope:** ${redact(targetScope)}`,
        `**Exported:** ${new Date().toISOString().slice(0, 19)}`,
        '',
      ];

      // ── Memories, split into Decisions / Failures / Other for scanability ──
      const allDocs = store().list(targetScope)
        .sort((a, b) => b.frontmatter.timestamp.localeCompare(a.frontmatter.timestamp));

      const decisions = allDocs.filter(d => d.frontmatter.type === 'Decision').slice(0, maxMemories);
      const failures  = allDocs.filter(d => d.frontmatter.type === 'FailureRecord');
      const openFailures = failures.filter(d => !d.frontmatter.tags.includes('resolved') && !d.frontmatter.tags.includes('wontfix'));
      const resolvedFailures = failures.filter(d => d.frontmatter.tags.includes('resolved') || d.frontmatter.tags.includes('wontfix'));
      const shown = new Set([...decisions, ...failures].map(d => d.id));
      const otherDocs = allDocs.filter(d => !shown.has(d.id)).slice(0, maxMemories);

      sections.push(`## Decisions (${decisions.length})`);
      sections.push(decisions.length
        ? decisions.map(d => renderMemoryBlock(d, redact)).join('\n\n')
        : 'None recorded. Tag durable architecture decisions with jambavan_memory_store(type="Decision") so they surface here.');
      sections.push('');

      sections.push(`## Failures (${openFailures.length} open, ${resolvedFailures.length} resolved)`);
      if (failures.length === 0) {
        sections.push('None recorded.');
      } else {
        sections.push(...[...openFailures.slice(0, 10), ...resolvedFailures.slice(0, 5)].map(d => renderMemoryBlock(d, redact)).map(b => b + '\n'));
      }
      sections.push('');

      sections.push(`## Other Memories (${otherDocs.length})`);
      sections.push(otherDocs.length
        ? otherDocs.map(d => renderMemoryBlock(d, redact)).join('\n\n')
        : 'None.');
      sections.push('');

      // ── Rin debt ──
      if (includeRin) {
        const { markers: rinMarkers } = harvestRin(config);
        sections.push(`## Rin Debt (${rinMarkers.length} markers)`);
        if (rinMarkers.length > 0) {
          // Take first 10 for handoff compactness
          for (const marker of rinMarkers.slice(0, 10)) {
            sections.push(`- ${redact(marker.file)}:${marker.line}: ${redact(marker.comment)}`);
          }
          if (rinMarkers.length > 10) sections.push(`  … and ${rinMarkers.length - 10} more`);
        } else {
          sections.push('None.');
        }
        sections.push('');
      }

      // ── Git status ──
      let dirtyFiles: { code: string; path: string }[] = [];
      if (includeGit) {
        sections.push('## Git Status');
        try {
          const root = config.projectRoot;
          const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
          let aheadBehind = '';
          try {
            const counts = git(root, ['rev-list', '--left-right', '--count', '@{u}...HEAD']).trim();
            const [behind, ahead] = counts.split(/\s+/);
            aheadBehind = ` (ahead ${ahead}, behind ${behind} of upstream)`;
          } catch {
            // No upstream configured — branch line without ahead/behind is fine.
          }

          const porcelain = git(root, ['status', '--porcelain']);
          dirtyFiles = porcelain.split('\n').filter(Boolean).map(line => ({
            code: line.slice(0, 2),
            path: line.slice(3),
          }));

          const diffStat = git(root, ['diff', '--stat']).trim();
          const recentLog = git(root, ['log', '--oneline', '-5']).trim();

          sections.push(
            `**Branch:** ${branch}${aheadBehind}`,
            '',
            `**Dirty files (${dirtyFiles.length}):**`,
            dirtyFiles.length
              ? dirtyFiles.slice(0, 20).map(f => `- ${describeStatusCode(f.code)}: ${f.path}`).join('\n')
              : '(clean)',
            dirtyFiles.length > 20 ? `  … and ${dirtyFiles.length - 20} more` : '',
            '',
            ...(diffStat ? ['**Diff stat:**', '```', diffStat, '```', ''] : []),
            '**Recent commits:**',
            '```',
            recentLog,
            '```',
          );
        } catch {
          sections.push('Git not available or not a git repository.');
        }
        sections.push('');
      }

      // ── Next command ──
      sections.push('## Next Command');
      const openWithPath = openFailures.map(d => ({ doc: d, next: extractNextPath(d) })).find(x => x.next);
      if (openWithPath) {
        sections.push(
          `Suggested by the most recent open failure ("${redact(openWithPath.doc.frontmatter.title)}"):`,
          '```',
          redact(openWithPath.next!),
          '```',
        );
      } else if (dirtyFiles.length > 0) {
        sections.push(`No recorded next step — ${dirtyFiles.length} dirty file(s) above are the likely resume point.`);
      } else if (shareSafe) {
        sections.push('No recorded next step — inspect the local working tree before resuming.');
      } else {
        sections.push('No recorded next step and a clean working tree — start from jambavan_awaken.');
      }
      sections.push('');

      // ── Token budget note ──
      const output = sections.join('\n');
      const tokens = countTokens(output);
      sections.push(`---`, `*Handoff tokens: ${tokens}*`);

      return sections.join('\n');
    },

    jambavan_session_import(input: Record<string, unknown>): string {
      const text = String(input['text'] ?? '').trim();
      if (!text) return 'Error: text is required.';

      const targetScope = input['scope'] ? String(input['scope']) : scope();

      // Parse memory sections from handoff document.
      // Resilient: gathers EVERY `## ` heading containing memor/decision/failure
      // (case-insensitive) — e.g. "## Memories (3)", "## Decisions (2)",
      // "## Failures (1 open, 0 resolved)" — since export now splits memories
      // into named sections rather than one "## Memories" block.
      // Fallback: if no such heading found, scan the entire document for ### blocks.
      const memHeadingRe = /^## [^\n]*(?:memor|decision|failure)[^\n]*$/gim;
      const headingMatches = [...text.matchAll(memHeadingRe)];
      let memorySection: string;
      if (headingMatches.length > 0) {
        memorySection = headingMatches.map(m => {
          const start = m.index! + m[0].length;
          const rest = text.slice(start);
          // Section ends at next ## heading, horizontal rule, or end of doc
          const sectionEnd = rest.match(/\n## |\n---\n/);
          return sectionEnd ? rest.slice(0, sectionEnd.index!) : rest;
        }).join('\n');
      } else if (/^### /m.test(text)) {
        // No memory heading but document has ### blocks — try extracting them
        memorySection = text;
      } else {
        // No memory heading AND no ### blocks — not a handoff document
        memorySection = '';
      }

      const memoryBlocks = memorySection.split(/^### |(?:\n### )/m).filter(b => b.trim());

      let imported = 0;
      for (const block of memoryBlocks) {
        const lines = block.trim().split('\n');
        const title = lines[0]?.trim();
        if (!title) continue;
        // Skip lines that are clearly section headings, not memory titles
        if (/^memor/i.test(title)) continue;

        // Parse metadata line: *2024-01-01* [FailureRecord] · tags: failure, resolved
        const metaLine = lines[1] ?? '';
        const typeMatch = metaLine.match(/\[([A-Za-z]+)\]/);
        const docType = typeMatch?.[1] ?? 'Memory';
        const tagsMatch = metaLine.match(/tags:\s*(.+)$/);
        const tags = tagsMatch
          ? tagsMatch[1].split(',').map(t => t.trim()).filter(Boolean)
          : ['imported', 'handoff'];

        const body = lines.slice(2).join('\n').trim(); // skip title + metadata line
        if (!body) continue;

        store().store({
          title,
          body,
          scope: targetScope,
          type: docType,
          tags: [...new Set([...tags, 'imported', 'handoff'])],
          source: 'session-import',
        });
        imported++;
      }

      if (imported === 0 && headingMatches.length === 0) {
        return `Imported 0 memories into scope "${targetScope}". Warning: no heading matching "## …Memories…" found — document may not be a valid handoff format.`;
      }
      return `Imported ${imported} memories into scope "${targetScope}".`;
    },
  };
}
