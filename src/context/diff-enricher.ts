/**
 * Context Diff-Enricher — git-aware recent changes for symbols.
 *
 * Before editing a symbol, shows the last N commits that touched it.
 * Prevents writing code that conflicts with recent refactors.
 */

import { execFileSync } from 'child_process';
import * as path from 'path';
import type { JambavanConfig } from '../config/jambavan.config';

export interface SymbolDiff {
  filePath: string;
  symbolName: string;
  startLine: number;
  endLine: number;
  recentChanges: CommitSummary[];
}

export interface CommitSummary {
  hash: string;
  date: string;
  author: string;
  message: string;
  diff: string;
}

/**
 * Get recent git log entries that touched lines [startLine, endLine] in a file.
 * Returns empty array if git is not available or file is untracked.
 */
export function getRecentSymbolChanges(
  config: JambavanConfig,
  filePath: string,
  startLine: number,
  endLine: number,
  maxCommits = 3,
): CommitSummary[] {
  const absPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(config.projectRoot, filePath);
  const relPath = path.relative(config.projectRoot, absPath);

  try {
    // git log -L shows changes to a specific line range
    const raw = execFileSync(
      'git',
      ['log', `-n`, `${maxCommits}`, `--format=---COMMIT---%n%h%n%ai%n%an%n%s`, `-L`, `${startLine},${endLine}:${relPath}`],
      {
        cwd: config.projectRoot,
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    return parseGitLogOutput(raw, maxCommits);
  } catch {
    // git not available, file untracked, or line range invalid — degrade gracefully
    return [];
  }
}

/**
 * Get a compact summary of recent changes to a file (not line-specific).
 * Cheaper than line-range log; use when symbol lines are unknown.
 */
export function getRecentFileChanges(
  config: JambavanConfig,
  filePath: string,
  maxCommits = 3,
): CommitSummary[] {
  const absPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(config.projectRoot, filePath);
  const relPath = path.relative(config.projectRoot, absPath);

  try {
    const raw = execFileSync(
      'git',
      ['log', `-n`, `${maxCommits}`, `--format=---COMMIT---%n%h%n%ai%n%an%n%s`, `-p`, `--`, relPath],
      {
        cwd: config.projectRoot,
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    return parseGitLogOutput(raw, maxCommits);
  } catch {
    return [];
  }
}

function parseGitLogOutput(raw: string, maxCommits: number): CommitSummary[] {
  const commits: CommitSummary[] = [];
  const parts = raw.split('---COMMIT---').filter(p => p.trim());

  for (const part of parts.slice(0, maxCommits)) {
    const lines = part.trim().split('\n');
    if (lines.length < 4) continue;

    const hash    = lines[0];
    const date    = lines[1].slice(0, 10); // date only
    const author  = lines[2];
    const message = lines[3];
    // Collect diff lines (everything after the header)
    const diffLines = lines.slice(4).filter(l =>
      l.startsWith('+') || l.startsWith('-') || l.startsWith('@')
    );
    // Cap diff at 20 lines to keep context lean
    const diff = diffLines.slice(0, 20).join('\n');

    commits.push({ hash, date, author, message, diff });
  }

  return commits;
}

/**
 * Format recent changes as a compact context block suitable for injection.
 */
export function formatRecentChanges(changes: CommitSummary[], symbolName?: string): string {
  if (changes.length === 0) return '';

  const header = symbolName
    ? `#### Recent changes to \`${symbolName}\``
    : '#### Recent changes';

  const body = changes.map(c =>
    `- ${c.hash} (${c.date}, ${c.author}): ${c.message}` +
    (c.diff ? `\n  \`\`\`diff\n  ${c.diff.split('\n').slice(0, 8).join('\n  ')}\n  \`\`\`` : '')
  ).join('\n');

  return `${header}\n${body}`;
}
