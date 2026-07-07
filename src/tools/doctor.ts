/**
 * jambavan_doctor — one-shot environment/config health check.
 *
 * Aggregates checks that would otherwise require several separate tool calls
 * (or silent confusion, e.g. root detection) into a single readable report.
 * Pure function: takes already-known runtime state as input rather than
 * reaching into server internals, so it works identically from the MCP tool
 * and the `jambavan doctor` CLI subcommand (which has no index/watcher yet).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ASTParser } from '../index/ast-parser';
import type { JambavanConfig } from '../config/jambavan.config';

export interface DoctorContext {
  allowWrite: boolean;
  allowBash: boolean;
  /** Present when an index has been built/loaded (MCP path); absent for the plain CLI check. */
  indexStats?: { files: number; symbols: number };
  watcherRunning?: boolean;
  /** Total tool count, when known (MCP path only). */
  toolCount?: number;
}

function checkRoot(config: JambavanConfig): string[] {
  const lines = [`Project root:     ${config.projectRoot} (source: ${config.rootSource})`];
  const looksLikeHome = config.projectRoot === os.homedir();
  if (config.rootSource === 'cwd-fallback' && looksLikeHome) {
    lines.push(
      '  \u26a0 Root fell back to $HOME — this MCP host likely spawned Jambavan with cwd=$HOME',
      '    and does not support the roots/list capability. Fix: set JAMBAVAN_ROOT=<project path>',
      '    in this project\'s MCP server config (see README "Fix first-run root confusion").',
    );
  } else if (config.rootSource === 'cwd-fallback') {
    lines.push('  Tip: set JAMBAVAN_ROOT explicitly if this is ever the wrong project.');
  }
  return lines;
}

function checkParsers(): string[] {
  const backends = ASTParser.diagnostics();
  const ts = backends.filter(b => b.backend === 'tree-sitter').map(b => b.language);
  const regex = backends.filter(b => b.backend === 'regex');
  const degraded = regex.filter(b => b.error);
  const lines = [
    `Parser backends:  tree-sitter (${ts.length}): ${ts.join(', ') || 'none'}`,
    `                  regex fallback (${regex.length}): ${regex.map(b => b.language).join(', ') || 'none'}`,
  ];
  if (degraded.length) {
    lines.push(
      '  \u26a0 Native parser DEGRADED to regex (native binding failed to load — run `npm rebuild`):',
      ...degraded.map(b => `    ${b.language}: ${b.error}`),
    );
  }
  return lines;
}

function checkGates(ctx: DoctorContext): string[] {
  return [
    `Write tools:      ${ctx.allowWrite ? 'ENABLED (JAMBAVAN_ALLOW_WRITE=1)' : 'disabled (default — set JAMBAVAN_ALLOW_WRITE=1 to enable)'}`,
    `Bash tool:        ${ctx.allowBash ? 'ENABLED (JAMBAVAN_ALLOW_BASH=1)' : 'disabled (default — set JAMBAVAN_ALLOW_BASH=1 to enable)'}`,
  ];
}

function checkMemoryDir(config: JambavanConfig): string[] {
  try {
    fs.mkdirSync(config.memoryDir, { recursive: true });
    fs.accessSync(config.memoryDir, fs.constants.W_OK);
    return [`Memory dir:       ${config.memoryDir} (writable)`];
  } catch (err) {
    return [`Memory dir:       ${config.memoryDir}`, `  \u26a0 NOT writable: ${err}`];
  }
}

function checkIgnoreAndCI(config: JambavanConfig): string[] {
  const hasGitignore = fs.existsSync(path.join(config.projectRoot, '.gitignore'));
  const hasCI = fs.existsSync(path.join(config.projectRoot, '.github', 'workflows'));
  return [
    `.gitignore:       ${hasGitignore ? 'found' : 'none — indexing may include build artifacts'}`,
    `CI config:        ${hasCI ? '.github/workflows found' : 'none found'}`,
  ];
}

export function doctorReport(config: JambavanConfig, ctx: DoctorContext): string {
  const sections: string[][] = [
    checkRoot(config),
    checkParsers(),
    checkGates(ctx),
    [`Token budget:     ${config.contextTokenBudget} tokens`],
    checkMemoryDir(config),
    checkIgnoreAndCI(config),
  ];

  if (ctx.indexStats) {
    sections.push([`Index:            ${ctx.indexStats.files} files, ${ctx.indexStats.symbols} symbols`]);
  } else {
    sections.push(['Index:            not built (call jambavan_index)']);
  }

  if (ctx.watcherRunning !== undefined) {
    sections.push([`Watcher:          ${ctx.watcherRunning ? 'running' : 'stopped'}`]);
  }

  if (ctx.toolCount !== undefined) {
    sections.push([`Tools available:  ${ctx.toolCount}`]);
  }

  return ['## Jambavan Doctor', '', ...sections.flat()].join('\n');
}
