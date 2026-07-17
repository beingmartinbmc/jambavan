/**
 * Memory Bridge — Jambavan <-> MemPalace markdown conversion.
 *
 * Design note: the real MemPalace store on disk (`~/.mempalace/palace`) is a
 * Chroma vector index + SQLite, not plain markdown files — there is no folder
 * Jambavan can write into that MemPalace itself will pick up, and Jambavan
 * makes no network/API calls of its own (see ARCHITECTURE.md). So this bridge
 * produces/consumes a portable "MemPalace-shaped" wing/room/drawer.md folder
 * tree using Jambavan's own frontmatter format unchanged (`scope` doubles as
 * MemPalace's "wing"; `collection` picks the "room" subfolder).
 *
 * `jambavan bridge --to mempalace` writes that tree; a host model with real
 * mempalace_* tools then walks it and calls mempalace_add_drawer(wing, room,
 * title, content) per file. `--from mempalace` is the reverse: point it at a
 * tree written the same way (e.g. by a host model after mempalace_list_drawers
 * + mempalace_get_drawer) and it imports every file into Jambavan's store.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseFrontmatter, serializeFrontmatter } from '../memory/store';
import { MemoryArchive } from '../memory/archive';
import type { JambavanConfig } from '../config/jambavan.config';

const TYPE_TO_ROOM: Record<string, string> = {
  Decision: 'decisions',
  FailureRecord: 'problems',
};
const DEFAULT_ROOM = 'technical';

function roomForType(type: string): string {
  return TYPE_TO_ROOM[type] ?? DEFAULT_ROOM;
}

function walkMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdownFiles(full));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

export function exportToMemPalace(
  config: JambavanConfig,
  outDir: string,
  scope?: string,
): { files: number; wings: string[] } {
  const docs = new MemoryArchive(config).list(scope, { includeInvalidated: false });
  const wings = new Set<string>();

  for (const doc of docs) {
    const wing = doc.frontmatter.scope;
    const room = doc.frontmatter.collection || roomForType(doc.frontmatter.type);
    wings.add(wing);

    const dir = path.join(outDir, wing, room);
    fs.mkdirSync(dir, { recursive: true });
    const filename = path.basename(doc.filePath);
    fs.writeFileSync(
      path.join(dir, filename),
      `${serializeFrontmatter(doc.frontmatter)}\n\n${doc.body.trimEnd()}\n`,
      'utf-8',
    );
  }

  return { files: docs.length, wings: [...wings] };
}

export function importFromMemPalace(
  config: JambavanConfig,
  inDir: string,
): { imported: number; skipped: number } {
  const store = new MemoryArchive(config).primary;
  let imported = 0;
  let skipped = 0;

  if (!fs.existsSync(inDir)) return { imported, skipped };

  for (const file of walkMarkdownFiles(inDir)) {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = parseFrontmatter(raw);
    if (!parsed) { skipped++; continue; }

    const relative = path.relative(inDir, file).split(path.sep);
    const room = relative.length >= 3 ? relative[relative.length - 2] : undefined;
    const hasCollection = /^collection:\s*.+$/m.test(raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '');
    store.store({
      title:       parsed.frontmatter.title,
      body:        parsed.body,
      type:        parsed.frontmatter.type,
      description: parsed.frontmatter.description,
      tags:        parsed.frontmatter.tags,
      scope:       parsed.frontmatter.scope,
      collection:  hasCollection ? parsed.frontmatter.collection : room ?? roomForType(parsed.frontmatter.type),
      source:      parsed.frontmatter.source,
    });
    imported++;
  }

  return { imported, skipped };
}
