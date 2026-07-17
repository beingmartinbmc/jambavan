import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { JambavanConfig } from '../config/jambavan.config';
import { isUnsafeFallbackRoot } from '../config/jambavan.config';
import { legacyProjectScope, projectScope } from './project-scope';
import { MemoryStore, searchMemoryDocs, type MemoryDoc } from './store';

export type ArchiveSource = 'archive' | 'legacy';
export type ArchivedMemoryDoc = MemoryDoc & { archiveSource: ArchiveSource };

interface MigrationMarker {
  version: 1;
  destination: string;
  sourceCount: number;
  latestSourceMtimeMs: number;
  migratedAt: string;
}

export interface LegacyManifest {
  count: number;
  latestMtimeMs: number;
}

const MARKER_FILE = '.migrated-to-global.json';

function pathHash(value: string): string {
  return crypto.createHash('sha256').update(path.resolve(value)).digest('hex');
}

export function legacyMemoryDir(config: JambavanConfig): string | undefined {
  if (config.memorySource !== 'default' || isUnsafeFallbackRoot(config)) return undefined;
  const legacy = path.join(config.projectRoot, '.jambavan', 'memory');
  if (path.resolve(legacy) === path.resolve(config.memoryDir) || !fs.existsSync(legacy)) return undefined;
  return legacy;
}

export function legacyManifest(legacyDir: string): LegacyManifest {
  const docs = new MemoryStore(legacyDir, { readOnly: true })
    .list(undefined, { includeInvalidated: true });
  return {
    count: docs.length,
    latestMtimeMs: docs.reduce((latest, doc) => {
      try { return Math.max(latest, fs.statSync(doc.filePath).mtimeMs); } catch { return latest; }
    }, 0),
  };
}

export function migrationMarkerPath(legacyDir: string): string {
  return path.join(legacyDir, MARKER_FILE);
}

export function isLegacyMigrationCurrent(config: JambavanConfig, legacyDir: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(migrationMarkerPath(legacyDir), 'utf8')) as MigrationMarker;
    const manifest = legacyManifest(legacyDir);
    return parsed.version === 1
      && parsed.destination === pathHash(config.memoryDir)
      && parsed.sourceCount === manifest.count
      && parsed.latestSourceMtimeMs === manifest.latestMtimeMs;
  } catch {
    return false;
  }
}

export function writeMigrationMarker(config: JambavanConfig, legacyDir: string): void {
  const manifest = legacyManifest(legacyDir);
  const marker: MigrationMarker = {
    version: 1,
    destination: pathHash(config.memoryDir),
    sourceCount: manifest.count,
    latestSourceMtimeMs: manifest.latestMtimeMs,
    migratedAt: new Date().toISOString(),
  };
  fs.writeFileSync(migrationMarkerPath(legacyDir), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}

function fingerprint(doc: MemoryDoc): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify({
      id: doc.id,
      type: doc.frontmatter.type,
      title: doc.frontmatter.title,
      body: doc.body.trimEnd(),
    }))
    .digest('hex');
}

function mapLegacyDoc(config: JambavanConfig, doc: MemoryDoc): MemoryDoc {
  const oldScope = legacyProjectScope(config);
  if (doc.frontmatter.scope !== oldScope && doc.frontmatter.scope !== 'general') return doc;
  const scope = projectScope(config);
  const slug = doc.id.slice(doc.id.indexOf('/') + 1);
  let supersedes = doc.frontmatter.supersedes;
  for (const prefix of [`${oldScope}/`, 'general/']) {
    if (supersedes?.startsWith(prefix)) supersedes = `${scope}/${supersedes.slice(prefix.length)}`;
  }
  return {
    ...doc,
    id: `${scope}/${slug}`,
    frontmatter: {
      ...doc.frontmatter,
      scope,
      ...(supersedes ? { supersedes } : {}),
    },
  };
}

/** Global writable archive plus optional read-only access to one legacy repo store. */
export class MemoryArchive {
  readonly primary: MemoryStore;
  private readonly legacy?: MemoryStore;

  constructor(private readonly config: JambavanConfig) {
    this.primary = new MemoryStore(config.memoryDir);
    const legacyDir = legacyMemoryDir(config);
    if (legacyDir && !isLegacyMigrationCurrent(config, legacyDir)) {
      this.legacy = new MemoryStore(legacyDir, { readOnly: true });
    }
  }

  list(scope?: string, opts: { includeInvalidated?: boolean; collection?: string } = {}): ArchivedMemoryDoc[] {
    const primary = this.primary.list(scope, opts)
      .map(doc => ({ ...doc, archiveSource: 'archive' as const }));
    if (!this.legacy) return primary;

    const legacyDocs = this.legacy.list(undefined, opts)
      .map(doc => mapLegacyDoc(this.config, doc))
      .filter(doc => !scope || doc.frontmatter.scope === scope);

    const seen = new Set(primary.map(fingerprint));
    return [
      ...primary,
      ...legacyDocs
        .filter(doc => !seen.has(fingerprint(doc)))
        .map(doc => ({ ...doc, archiveSource: 'legacy' as const })),
    ];
  }

  get(id: string): ArchivedMemoryDoc | null {
    const primary = this.primary.get(id);
    if (primary) return { ...primary, archiveSource: 'archive' };
    if (!this.legacy) return null;

    const requestedScope = id.split('/')[0] ?? '';
    const activeScope = projectScope(this.config);
    const legacyIds = requestedScope === activeScope
      ? [id, `${legacyProjectScope(this.config)}/${id.slice(requestedScope.length + 1)}`, `general/${id.slice(requestedScope.length + 1)}`]
      : [id];
    for (const legacyId of legacyIds) {
      const doc = this.legacy.get(legacyId);
      if (doc) return { ...mapLegacyDoc(this.config, doc), id, archiveSource: 'legacy' };
    }
    return null;
  }

  search(query: string, opts: { scope?: string; collection?: string; limit?: number; includeInvalidated?: boolean } = {}) {
    const docs = this.list(opts.scope, {
      collection: opts.collection,
      includeInvalidated: opts.includeInvalidated,
    });
    return searchMemoryDocs(query, docs, opts.limit ?? 10)
      .map(result => ({ ...result, doc: result.doc as ArchivedMemoryDoc }));
  }

  legacyCount(): number {
    return this.legacy?.list().length ?? 0;
  }
}
