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

import { execSync } from 'child_process';
import { MemoryStore } from '../memory/store';
import type { JambavanConfig } from '../config/jambavan.config';
import { projectScope } from './jambavan';
import { harvestRin } from './vibhishana-niti';
import { countTokens } from '../context/token-counter';

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
  const store = new MemoryStore(config.memoryDir);
  const scope = projectScope(config);

  return {
    jambavan_session_export(input: Record<string, unknown>): string {
      const targetScope  = input['scope'] ? String(input['scope']) : scope;
      const includeRin   = input['include_rin'] !== false;
      const includeGit   = input['include_git'] !== false;
      const maxMemories  = input['max_memories'] ? Number(input['max_memories']) : 15;

      const sections: string[] = [
        `# Jambavan Session Handoff`,
        `**Project:** ${config.projectRoot}`,
        `**Scope:** ${targetScope}`,
        `**Exported:** ${new Date().toISOString().slice(0, 19)}`,
        '',
      ];

      // ── Memories ──
      const docs = store.list(targetScope)
        .sort((a, b) => b.frontmatter.timestamp.localeCompare(a.frontmatter.timestamp))
        .slice(0, maxMemories);

      sections.push(`## Memories (${docs.length})`);
      if (docs.length === 0) {
        sections.push('No memories in scope.');
      } else {
        for (const doc of docs) {
          const typeBadge = doc.frontmatter.type && doc.frontmatter.type !== 'Memory'
            ? ` [${doc.frontmatter.type}]` : '';
          sections.push(
            `### ${doc.frontmatter.title}`,
            `*${doc.frontmatter.timestamp.slice(0, 10)}*` +
            typeBadge +
            (doc.frontmatter.tags.length ? ` · tags: ${doc.frontmatter.tags.join(', ')}` : ''),
            '',
            doc.body.trim(),
            '',
          );
        }
      }
      sections.push('');

      // ── Rin debt ──
      if (includeRin) {
        const { markers: rinMarkers } = harvestRin(config);
        sections.push(`## Rin Debt (${rinMarkers.length} markers)`);
        if (rinMarkers.length > 0) {
          // Take first 10 for handoff compactness
          for (const marker of rinMarkers.slice(0, 10)) {
            sections.push(`- ${marker.file}:${marker.line}: ${marker.comment}`);
          }
          if (rinMarkers.length > 10) sections.push(`  … and ${rinMarkers.length - 10} more`);
        } else {
          sections.push('None.');
        }
        sections.push('');
      }

      // ── Git status ──
      if (includeGit) {
        sections.push('## Git Status');
        try {
          const gitOpts = { cwd: config.projectRoot, encoding: 'utf-8' as const, timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
          const status = execSync('git status --short', gitOpts).trim();
          const recentLog = execSync('git log --oneline -5', gitOpts).trim();

          sections.push(
            '```',
            status || '(clean)',
            '```',
            '',
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

      // ── Token budget note ──
      const output = sections.join('\n');
      const tokens = countTokens(output);
      sections.push(`---`, `*Handoff tokens: ${tokens}*`);

      return sections.join('\n');
    },

    jambavan_session_import(input: Record<string, unknown>): string {
      const text = String(input['text'] ?? '').trim();
      if (!text) return 'Error: text is required.';

      const targetScope = input['scope'] ? String(input['scope']) : scope;

      // Parse memory sections from handoff document.
      // Resilient: matches any ## heading containing "memor" (case-insensitive),
      // e.g. "## Memories (3)", "## Prior Memories", "## Stored memories".
      // Fallback: if no memory heading found, scan the entire document for ### blocks.
      const memHeadingRe = /^## [^\n]*memor[^\n]*/im;
      const headingMatch = text.match(memHeadingRe);
      let memorySection: string;
      if (headingMatch) {
        const start = headingMatch.index! + headingMatch[0].length;
        const rest = text.slice(start);
        // Section ends at next ## heading, horizontal rule, or end of doc
        const sectionEnd = rest.match(/\n## |\n---\n/);
        memorySection = sectionEnd ? rest.slice(0, sectionEnd.index!) : rest;
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

        store.store({
          title,
          body,
          scope: targetScope,
          type: docType,
          tags: [...new Set([...tags, 'imported', 'handoff'])],
          source: 'session-import',
        });
        imported++;
      }

      if (imported === 0 && !headingMatch) {
        return `Imported 0 memories into scope "${targetScope}". Warning: no heading matching "## …Memories…" found — document may not be a valid handoff format.`;
      }
      return `Imported ${imported} memories into scope "${targetScope}".`;
    },
  };
}
