import * as fs from 'fs';
import * as path from 'path';
import type { JambavanConfig } from '../config/jambavan.config';
import { legacyProjectScope, projectScope } from './project-scope';
import { MemoryStore, type MemoryDoc } from './store';
import { writeMigrationMarker } from './archive';

export interface MigrationConflict {
  title: string;
  scope: string;
  reason: string;
}

export interface MigrationReport {
  sourceDir: string;
  destinationDir: string;
  found: number;
  copied: number;
  skipped: number;
  conflicts: MigrationConflict[];
  applied: boolean;
}

function comparable(doc: MemoryDoc): string {
  const { scope: _scope, ...frontmatter } = doc.frontmatter;
  return JSON.stringify({ frontmatter, body: doc.body.trimEnd() });
}

function remapDoc(config: JambavanConfig, doc: MemoryDoc): MemoryDoc {
  const oldScope = legacyProjectScope(config);
  const targetScope = doc.frontmatter.scope === oldScope || doc.frontmatter.scope === 'general'
    ? projectScope(config)
    : doc.frontmatter.scope;
  let supersedes = doc.frontmatter.supersedes;
  if (supersedes && targetScope !== doc.frontmatter.scope) {
    for (const prefix of [`${oldScope}/`, 'general/']) {
      if (supersedes.startsWith(prefix)) supersedes = `${targetScope}/${supersedes.slice(prefix.length)}`;
    }
  }
  return {
    ...doc,
    id: `${targetScope}/${path.basename(doc.id)}`,
    frontmatter: {
      ...doc.frontmatter,
      scope: targetScope,
      ...(supersedes ? { supersedes } : {}),
    },
  };
}

export function migrateLegacyMemory(config: JambavanConfig, apply = false): MigrationReport {
  const sourceDir = path.join(config.projectRoot, '.jambavan', 'memory');
  const report: MigrationReport = {
    sourceDir,
    destinationDir: config.memoryDir,
    found: 0,
    copied: 0,
    skipped: 0,
    conflicts: [],
    applied: false,
  };
  if (!fs.existsSync(sourceDir) || path.resolve(sourceDir) === path.resolve(config.memoryDir)) return report;

  const source = new MemoryStore(sourceDir, { readOnly: true });
  const destination = new MemoryStore(config.memoryDir, { readOnly: true });
  const docs = source.list(undefined, { includeInvalidated: true }).map(doc => remapDoc(config, doc));
  report.found = docs.length;

  const plannedTitles = new Map<string, MemoryDoc>();
  const plannedIds = new Map<string, MemoryDoc>();
  const toCopy: MemoryDoc[] = [];
  for (const doc of docs) {
    const titleKey = `${doc.frontmatter.scope}\0${doc.frontmatter.title}`;
    const priorTitle = plannedTitles.get(titleKey);
    const priorId = plannedIds.get(doc.id);
    const existingId = destination.get(doc.id);
    const existing = destination.findByTitle(doc.frontmatter.scope, doc.frontmatter.title);
    if (priorTitle || priorId) {
      const prior = priorTitle ?? priorId!;
      if (comparable(prior) === comparable(doc)) report.skipped++;
      else report.conflicts.push({
        title: doc.frontmatter.title,
        scope: doc.frontmatter.scope,
        reason: priorId ? 'legacy scopes collapse to different documents at the same target ID' : 'legacy scopes collapse to different documents with the same title',
      });
      continue;
    }
    plannedTitles.set(titleKey, doc);
    plannedIds.set(doc.id, doc);
    if (existingId) {
      if (existingId.frontmatter.title === doc.frontmatter.title && comparable(existingId) === comparable(doc)) report.skipped++;
      else report.conflicts.push({ title: doc.frontmatter.title, scope: doc.frontmatter.scope, reason: 'destination contains different content at the target ID' });
      continue;
    }
    if (existing) {
      if (comparable(existing) === comparable(doc)) report.skipped++;
      else report.conflicts.push({ title: doc.frontmatter.title, scope: doc.frontmatter.scope, reason: 'destination contains different content with the same title' });
      continue;
    }
    toCopy.push(doc);
  }

  if (!apply || report.conflicts.length > 0) return report;
  const writer = new MemoryStore(config.memoryDir);
  for (const doc of toCopy) writer.importDoc(doc, doc.frontmatter.scope);
  report.copied = toCopy.length;
  report.applied = true;
  writeMigrationMarker(config, sourceDir);
  return report;
}

export function formatMigrationReport(report: MigrationReport): string {
  const lines = [
    report.applied ? 'Legacy memory migration applied.' : 'Legacy memory migration dry run.',
    `Found: ${report.found}`,
    `Would copy: ${report.applied ? 0 : Math.max(0, report.found - report.skipped - report.conflicts.length)}`,
    `Copied: ${report.copied}`,
    `Skipped identical: ${report.skipped}`,
    `Conflicts: ${report.conflicts.length}`,
  ];
  if (report.conflicts.length) {
    lines.push('', 'No documents were copied. Resolve these conflicts first:');
    for (const conflict of report.conflicts) {
      lines.push(`- ${conflict.scope}/${conflict.title}: ${conflict.reason}`);
    }
  } else if (!report.applied && report.found > 0) {
    lines.push('', 'Run again with --apply to copy without deleting the legacy store.');
  }
  return lines.join('\n');
}
