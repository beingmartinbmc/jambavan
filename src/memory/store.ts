/**
 * Jambavan Memory Store
 *
 * Persistent agent memory as an Open Knowledge Format (OKF) bundle.
 * Each memory is a markdown file with Jambavan-written YAML frontmatter —
 * human-readable and git-diffable without a bespoke SDK.
 *
 * OKF spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
 *
 * Bundle layout (inside .jambavan/memory/):
 *   <scope>/             ← scope is a slug (project name, "general", etc.)
 *     <id>.md            ← one OKF concept document per memory
 *   index.md             ← auto-generated bundle directory
 *   log.md               ← chronological update history
 *
 * Search: BM25 over title + tags + body — no embeddings, no external services.
 */

import * as fs   from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ── OKF document shape ────────────────────────────────────────────────────────

export interface MemoryFrontmatter {
  type:        string;           // OKF required
  title:       string;
  description: string;
  tags:        string[];
  scope:       string;           // maps to bundle subdirectory
  timestamp:   string;           // ISO 8601
  source?:     string;           // optional: which file/session this came from
  supersedes?: string;           // optional: older OKF concept ID this memory replaces
  invalidated?: boolean;         // true when superseded/obsolete
}

export interface MemoryDoc {
  id:          string;           // derived from file path: scope/name
  frontmatter: MemoryFrontmatter;
  body:        string;
  filePath:    string;
}

// ── Serialisation ─────────────────────────────────────────────────────────────

function serializeFrontmatter(fm: MemoryFrontmatter): string {
  const tags = fm.tags.length > 0
    ? `[${fm.tags.map(t => JSON.stringify(t)).join(', ')}]`
    : '[]';
  const lines = [
    '---',
    `type: ${fm.type}`,
    `title: ${JSON.stringify(fm.title)}`,
    `description: ${JSON.stringify(fm.description)}`,
    `tags: ${tags}`,
    `scope: ${fm.scope}`,
    `timestamp: ${fm.timestamp}`,
  ];
  if (fm.source) lines.push(`source: ${JSON.stringify(fm.source)}`);
  if (fm.supersedes) lines.push(`supersedes: ${JSON.stringify(fm.supersedes)}`);
  if (fm.invalidated) lines.push('invalidated: true');
  lines.push('---');
  return lines.join('\n');
}

function parseFrontmatter(raw: string): { frontmatter: MemoryFrontmatter; body: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;

  const yaml = match[1];
  const body = match[2].trimStart();

  // Minimal reader — only the fields we write. Values were produced by
  // JSON.stringify, so decode them the same way (handles embedded quotes,
  // backslashes, and colons) and fall back to raw text if the value is unquoted.
  const get = (key: string): string | undefined => {
    const line = yaml.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim();
    if (line === undefined) return undefined;
    if (line.startsWith('"')) {
      try { return JSON.parse(line) as string; } catch { /* fall through */ }
    }
    return line;
  };

  const rawTags = yaml.match(/^tags:\s*(\[[^\]]*\])/m)?.[1] ?? '[]';
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(rawTags);
    if (Array.isArray(parsed)) tags = parsed.map(String);
  } catch { /* leave tags empty on malformed input */ }

  const type        = get('type');
  const title       = get('title') ?? '';
  const description = get('description') ?? '';
  const scope       = get('scope') ?? 'general';
  const timestamp   = get('timestamp') ?? new Date().toISOString();
  const source      = get('source');
  const supersedes  = get('supersedes');
  const invalidated = get('invalidated') === 'true';

  if (!type) return null;

  return {
    frontmatter: {
      type, title, description, tags, scope, timestamp,
      ...(source ? { source } : {}),
      ...(supersedes ? { supersedes } : {}),
      ...(invalidated ? { invalidated } : {}),
    },
    body,
  };
}

// ── BM25 search ───────────────────────────────────────────────────────────────
// rin: in-process BM25 over loaded docs; fine for <10k memories, add SQLite FTS5 if slower.

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/\w{2,}/g) ?? [];
}

function bm25Score(
  query: string[],
  docTokens: string[],
  avgDocLen: number,
  dfMap: Map<string, number>,
  n: number,
  k1 = 1.5,
  b  = 0.75,
): number {
  const dl = docTokens.length;
  let score = 0;
  const freq = new Map<string, number>();
  for (const t of docTokens) freq.set(t, (freq.get(t) ?? 0) + 1);

  for (const term of query) {
    const df = dfMap.get(term) ?? 0;
    if (df === 0) continue;
    const idf = Math.log((n - df + 0.5) / (df + 0.5) + 1);
    const tf  = freq.get(term) ?? 0;
    score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgDocLen));
  }
  return score;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export class MemoryStore {
  private bundleRoot: string;

  constructor(memoryDir: string) {
    this.bundleRoot = memoryDir;
    fs.mkdirSync(this.bundleRoot, { recursive: true });
  }

  // ── Write ───────────────────────────────────────────────────────────────────

  /**
   * Store a memory. Returns the OKF concept ID (scope/filename-slug).
   * Deduplicates by title within scope — overwrites an existing doc with the same title.
   * If a different title produces a colliding slug, disambiguates with a numeric suffix.
   */
  store(opts: {
    title:       string;
    body:        string;
    type?:       string;
    description?: string;
    tags?:       string[];
    scope?:      string;
    source?:     string;
    supersedes?: string;
  }): string {
    const scope = slugify(opts.scope ?? 'general');
    let slug  = slugify(opts.title);

    const scopeDir = path.join(this.bundleRoot, scope);
    fs.mkdirSync(scopeDir, { recursive: true });

    // Collision check: if file exists with a different title, disambiguate
    let filePath = path.join(scopeDir, `${slug}.md`);
    if (fs.existsSync(filePath)) {
      const existing = this.readDoc(filePath);
      if (existing && existing.frontmatter.title !== opts.title) {
        // Different title produced the same slug — add suffix
        let n = 2;
        while (true) {
          const candidate = `${slug}-${n}`;
          const candidatePath = path.join(scopeDir, `${candidate}.md`);
          if (!fs.existsSync(candidatePath)) { slug = candidate; filePath = candidatePath; break; }
          const cDoc = this.readDoc(candidatePath);
          if (cDoc && cDoc.frontmatter.title === opts.title) { slug = candidate; filePath = candidatePath; break; }
          n++;
        }
      }
    }

    const id = `${scope}/${slug}`;

    const fm: MemoryFrontmatter = {
      type:        opts.type        ?? 'Memory',
      title:       opts.title,
      description: opts.description ?? opts.title,
      tags:        opts.tags        ?? [],
      scope,
      timestamp:   new Date().toISOString(),
      ...(opts.source ? { source: opts.source } : {}),
      ...(opts.supersedes ? { supersedes: opts.supersedes } : {}),
    };

    fs.writeFileSync(filePath, `${serializeFrontmatter(fm)}\n\n${opts.body}\n`, 'utf-8');

    this.appendLog({ action: 'store', id, title: opts.title });
    this.rebuildScopeIndex(scope);
    return id;
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  get(id: string): MemoryDoc | null {
    const safeId = id.split('/').map(slugify).join('/');
    const filePath = path.join(this.bundleRoot, `${safeId}.md`);
    return this.readDoc(filePath);
  }

  list(scope?: string, opts: { includeInvalidated?: boolean } = {}): MemoryDoc[] {
    if (scope) {
      const scopeDir = path.join(this.bundleRoot, slugify(scope));
      if (!fs.existsSync(scopeDir)) return [];
      return this.docsInDir(scopeDir, opts);
    }
    // All scopes
    const docs: MemoryDoc[] = [];
    if (!fs.existsSync(this.bundleRoot)) return docs;
    for (const entry of fs.readdirSync(this.bundleRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        docs.push(...this.docsInDir(path.join(this.bundleRoot, entry.name), opts));
      }
    }
    return docs;
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  search(query: string, opts: { scope?: string; limit?: number; includeInvalidated?: boolean } = {}): Array<{ doc: MemoryDoc; score: number }> {
    const all = this.list(opts.scope, { includeInvalidated: opts.includeInvalidated });
    if (all.length === 0) return [];

    const limit = opts.limit ?? 10;
    const qTerms = tokenize(query);
    if (qTerms.length === 0) return all.slice(0, limit).map(doc => ({ doc, score: 0 }));

    // Build corpus: title (x3 weight) + tags (x2) + description (x2) + body
    const corpus = all.map(doc => {
      const { frontmatter: fm, body } = doc;
      const text = [
        ...Array(3).fill(fm.title),
        ...Array(2).fill(fm.tags.join(' ')),
        ...Array(2).fill(fm.description),
        body,
      ].join(' ');
      return tokenize(text);
    });

    const n    = corpus.length;
    const avgL = corpus.reduce((s, t) => s + t.length, 0) / n || 1;

    // Document-frequency map
    const df = new Map<string, number>();
    for (const tokens of corpus) {
      for (const term of new Set(tokens)) df.set(term, (df.get(term) ?? 0) + 1);
    }

    const scored = all.map((doc, i) => ({
      doc,
      score: bm25Score(qTerms, corpus[i], avgL, df, n),
    }));

    return scored
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // ── Invalidate / delete ─────────────────────────────────────────────────────

  invalidate(id: string, reason?: string): boolean {
    const doc = this.get(id);
    if (!doc) return false;
    doc.frontmatter.invalidated = true;
    if (reason) doc.body = `${doc.body.trimEnd()}\n\n> Invalidated: ${reason}\n`;
    fs.writeFileSync(doc.filePath, `${serializeFrontmatter(doc.frontmatter)}\n\n${doc.body.trimEnd()}\n`, 'utf-8');
    this.appendLog({ action: 'invalidate', id, title: doc.frontmatter.title });
    this.rebuildScopeIndex(doc.frontmatter.scope);
    return true;
  }

  delete(id: string): boolean {
    const safeId = id.split('/').map(slugify).join('/');
    const filePath = path.join(this.bundleRoot, `${safeId}.md`);
    if (!fs.existsSync(filePath)) return false;
    const doc = this.readDoc(filePath);
    fs.rmSync(filePath);
    if (doc) {
      this.appendLog({ action: 'delete', id, title: doc.frontmatter.title });
      this.rebuildScopeIndex(doc.frontmatter.scope);
    }
    return true;
  }

  deleteByScope(scope: string): number {
    const scopeDir = path.join(this.bundleRoot, slugify(scope));
    if (!fs.existsSync(scopeDir)) return 0;
    const docs = this.docsInDir(scopeDir, { includeInvalidated: true });
    fs.rmSync(scopeDir, { recursive: true, force: true });
    this.appendLog({ action: 'delete-scope', id: scope, title: `all in ${scope}` });
    return docs.length;
  }

  // ── Status ──────────────────────────────────────────────────────────────────

  status(): { totalMemories: number; scopes: Array<{ scope: string; count: number }> } {
    if (!fs.existsSync(this.bundleRoot)) return { totalMemories: 0, scopes: [] };

    const scopes: Array<{ scope: string; count: number }> = [];
    let total = 0;

    for (const entry of fs.readdirSync(this.bundleRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const count = this.docsInDir(path.join(this.bundleRoot, entry.name)).length;
      scopes.push({ scope: entry.name, count });
      total += count;
    }

    return { totalMemories: total, scopes };
  }

  // ── OKF index.md + log.md ────────────────────────────────────────────────────

  private rebuildScopeIndex(scope: string): void {
    const scopeDir = path.join(this.bundleRoot, scope);
    if (!fs.existsSync(scopeDir)) return;
    const docs = this.docsInDir(scopeDir, { includeInvalidated: true });
    const lines = ['# Memory Index\n'];
    for (const doc of docs) {
      const slug = path.basename(doc.filePath, '.md');
      lines.push(`* [${doc.frontmatter.title}](./${slug}.md) - ${doc.frontmatter.description}`);
    }
    const indexPath = path.join(scopeDir, 'index.md');
    const tmpPath = indexPath + `.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, lines.join('\n') + '\n', 'utf-8');
    fs.renameSync(tmpPath, indexPath);
  }

  private appendLog(entry: { action: string; id: string; title: string }): void {
    const logPath = path.join(this.bundleRoot, 'log.md');
    const today   = new Date().toISOString().slice(0, 10);
    const line    = `\n## ${today}\n* **${entry.action}**: ${entry.title} (\`${entry.id}\`)\n`;

    // Atomic append — O_APPEND guarantees no interleaving on POSIX even
    // across concurrent processes writing to the same file.
    const fd = fs.openSync(logPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND);
    try {
      fs.writeSync(fd, line, null, 'utf-8');
    } finally {
      fs.closeSync(fd);
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private readDoc(filePath: string): MemoryDoc | null {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseFrontmatter(raw);
    if (!parsed) return null;

    const rel  = path.relative(this.bundleRoot, filePath);
    const id   = rel.replace(/\.md$/, '').replace(/\\/g, '/');

    return { id, frontmatter: parsed.frontmatter, body: parsed.body, filePath };
  }

  private docsInDir(dir: string, opts: { includeInvalidated?: boolean } = {}): MemoryDoc[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.md') && f !== 'index.md')
      .map(f => this.readDoc(path.join(dir, f)))
      .filter((d): d is MemoryDoc => d !== null)
      .filter(d => opts.includeInvalidated || !d.frontmatter.invalidated);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || crypto.randomBytes(4).toString('hex');
}
