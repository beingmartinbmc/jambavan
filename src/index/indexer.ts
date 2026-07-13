/**
 * Jambavan Index — orchestrates full and incremental indexing.
 *
 * Index once. Remember forever. Update only what changed.
 *
 * Architecture:
 *   1. Scan project for source files (respecting .gitignore + jambavan ignore list)
 *   2. For each file: check hash cache → skip if unchanged
 *   3. Parse changed files with ASTParser → extract symbols (tree-sitter backed)
 *   4. Store symbols in SQLite
 *   5. Mark file as indexed in FileCache
 *
 * The watcher calls indexFile / deleteFile directly so a single-file edit
 * costs O(1) rather than re-scanning the whole project.
 */

import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import ignore from 'ignore';
import Database from 'better-sqlite3';
import { FileCache } from './file-cache';
import { ASTParser, type Symbol, type ParsedFile } from './ast-parser';
import { ensureGeneratedStateDir, type JambavanConfig } from '../config/jambavan.config';

export interface IndexStats {
  totalFiles: number;
  indexedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  indexedSymbols: number;
  totalSymbols: number;
  durationMs: number;
}

export interface IndexFailure {
  filePath: string;
  error: string;
  failedAt: number;
}

export interface SymbolSearchResult {
  symbol: Symbol;
  score: number;
}

export interface ReExportRow {
  filePath: string;
  specifier: string;
  imported: string;
  exported: string;
}

export class JambavanIndex {
  private cache:  FileCache;
  private parser: ASTParser;
  private db:     Database.Database;
  private failures = new Map<string, IndexFailure>();

  constructor(private config: JambavanConfig) {
    ensureGeneratedStateDir(config.indexDir);
    this.cache  = new FileCache(config.indexDir);
    this.parser = new ASTParser();
    this.db     = new Database(path.join(config.indexDir, 'symbols.db'));
    // Faster, safe-enough durability for a rebuildable index (WAL + relaxed fsync).
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.initSymbolDB();
  }

  private initSymbolDB(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS symbols (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path  TEXT NOT NULL,
        name       TEXT NOT NULL,
        type       TEXT NOT NULL,
        start_line INTEGER,
        end_line   INTEGER,
        content    TEXT NOT NULL,
        refs       TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_symbols_name      ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_symbols_file_path ON symbols(file_path);

      CREATE TABLE IF NOT EXISTS reexports (
        file_path TEXT NOT NULL,
        specifier TEXT NOT NULL,
        imported  TEXT NOT NULL,
        exported  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reexports_file_path ON reexports(file_path);
    `);
    // Migrate pre-refs caches only when the column is actually missing (no throw-and-catch).
    const hasRefs = (this.db.pragma('table_info(symbols)') as { name: string }[])
      .some(c => c.name === 'refs');
    this.initFts();
    if (!hasRefs) this.db.exec(`ALTER TABLE symbols ADD COLUMN refs TEXT NOT NULL DEFAULT '[]'`);
  }

  /**
   * FTS5 external-content index over symbols(name, content), kept in sync via
   * triggers so every existing write path (storeSymbols, indexFile, deleteFile)
   * needs zero changes. search() catches any FTS5 query failure and falls back
   * to the LIKE path, so a tokenizer edge case here degrades, not breaks.
   */
  private initFts(): void {
    // Detect "did this table already exist" via sqlite_master rather than
    // COUNT(*) on symbols_fts after creation: for an external-content FTS5
    // table (content='symbols'), COUNT(*) with no MATCH clause can be
    // satisfied by the query planner straight from the content table's
    // rowids, silently returning a non-zero count even when the FTS
    // inverted index itself is still empty — making a "ftsCount === 0"
    // backfill gate unreliable.
    const ftsTableExisted = !!this.db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'symbols_fts'`)
      .get();

    const statements = [
      `CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(name, content, content='symbols', content_rowid='id')`,
      `CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
         INSERT INTO symbols_fts(rowid, name, content) VALUES (new.id, new.name, new.content);
       END`,
      `CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
         INSERT INTO symbols_fts(symbols_fts, rowid, name, content) VALUES('delete', old.id, old.name, old.content);
       END`,
      `CREATE TRIGGER IF NOT EXISTS symbols_au AFTER UPDATE ON symbols BEGIN
         INSERT INTO symbols_fts(symbols_fts, rowid, name, content) VALUES('delete', old.id, old.name, old.content);
         INSERT INTO symbols_fts(rowid, name, content) VALUES (new.id, new.name, new.content);
       END`,
    ];
    for (const sql of statements) this.db.prepare(sql).run();

    // First-run migration: back-fill symbols_fts for a DB that predates FTS5
    // (triggers only fire on writes after creation, not on pre-existing rows).
    // Uses FTS5's own 'rebuild' command rather than a manual INSERT...SELECT,
    // which is the documented, safe way to (re)populate an external-content
    // FTS5 table's inverted index from its content table — cheap no-op when
    // there are zero rows.
    if (!ftsTableExisted) {
      this.db.prepare(`INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild')`).run();
    }
  }

  /** Escape a raw term into an FTS5 double-quoted prefix token: `"term"*`. */
  private static ftsToken(term: string): string {
    return `"${term.replace(/"/g, '""')}"*`;
  }

  // ── Full / incremental scan ─────────────────────────────────────────────────

  /**
   * Run incremental index across the whole project.
   * First run: indexes everything.
   * Subsequent runs: only processes changed / new files; removes deleted ones.
   */
  async index(): Promise<IndexStats> {
    const start = Date.now();
    const files = await this.discoverFiles();
    const stale: string[] = [];
    let indexedSymbols = 0;
    let indexedFiles = 0;
    let staleCheckFailures = 0;

    for (const filePath of files) {
      try {
        if (this.cache.isStale(filePath)) stale.push(filePath);
        else this.failures.delete(filePath);
      } catch (err) {
        staleCheckFailures++;
        this.recordFailure(filePath, err);
      }
    }

    for (const filePath of stale) {
      indexedSymbols += this.indexFile(filePath);
      if (!this.failures.has(filePath)) indexedFiles++;
    }

    // Purge deleted files
    const currentFiles = new Set(files);
    for (const cached of this.cache.getAll()) {
      if (!currentFiles.has(cached.filePath)) {
        this.deleteFile(cached.filePath);
      }
    }
    for (const failedPath of this.failures.keys()) {
      if (!currentFiles.has(failedPath)) this.failures.delete(failedPath);
    }

    return {
      totalFiles:   files.length,
      indexedFiles,
      skippedFiles: files.length - stale.length - staleCheckFailures,
      failedFiles:  this.failures.size,
      indexedSymbols,
      totalSymbols: this.stats().symbols,
      durationMs:   Date.now() - start,
    };
  }

  // ── Per-file operations (used by FileWatcher) ───────────────────────────────

  /**
   * (Re-)index a single file. Skips if the file hash hasn't changed.
   * Returns the number of symbols extracted (0 for unchanged or unparseable files).
   */
  indexFile(filePath: string): number {
    try {
      if (!this.cache.isStale(filePath)) {
        this.failures.delete(filePath);
        return 0;
      }
      if (!fs.existsSync(filePath)) return 0;
      if (!ASTParser.canParse(filePath)) {
        this.cache.markIndexed(filePath, 0);
        this.failures.delete(filePath);
        return 0;
      }

      const parsed = this.parser.parseFile(filePath);
      this.replaceFile(parsed);
      this.cache.markIndexed(filePath, parsed.symbols.length);
      this.failures.delete(filePath);
      return parsed.symbols.length;
    } catch (err) {
      // Keep the last valid rows and cache hash. Explicit indexing will retry
      // because a failed file is never marked as indexed.
      this.recordFailure(filePath, err);
      return 0;
    }
  }

  /**
   * Remove all symbols, re-exports, and cache entry for a deleted file.
   */
  deleteFile(filePath: string): void {
    this.db.prepare('DELETE FROM symbols WHERE file_path = ?').run(filePath);
    this.db.prepare('DELETE FROM reexports WHERE file_path = ?').run(filePath);
    this.cache.markDeleted(filePath);
    this.failures.delete(filePath);
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  private static readonly STOP_WORDS = new Set([
    'a', 'an', 'and', 'are', 'for', 'from', 'in', 'is', 'of', 'on', 'or',
    'the', 'to', 'what', 'where', 'which', 'with',
  ]);

  private static nameScore(name: string, exactQuery: string, firstTerm: string): number {
    const lower = name.toLowerCase();
    return lower === exactQuery ? 100 : lower.includes(firstTerm) ? 50 : 0;
  }

  private static toResult(row: Symbol & { file_path: string; start_line: number; end_line: number; refs?: string }, nameScore: number): SymbolSearchResult {
    return {
      symbol: {
        name:       row.name,
        type:       row.type as Symbol['type'],
        startLine:  row.start_line,
        endLine:    row.end_line,
        content:    row.content,
        filePath:   row.file_path,
        references: JSON.parse(row.refs ?? '[]'),
      },
      score: nameScore + 1,
    };
  }

  /**
   * Search symbols by name or content.
   * Scores exact name match highest, prefix match second, substring last.
   * Ranks via FTS5 bm25() first (fast, relevance-aware); falls back to a plain
   * LIKE scan for queries FTS5 can't tokenize well (e.g. pure-punctuation terms)
   * or on any other FTS5 error, so a tokenizer edge case degrades, not breaks.
   */
  search(query: string, limit = 20): SymbolSearchResult[] {
    const exactQuery = query.trim().toLowerCase();
    const rawTerms = exactQuery
      .split(/\s+/)
      .map(term => term.replace(/^[^a-z0-9_$]+|[^a-z0-9_$]+$/g, ''))
      .filter(Boolean);
    const meaningfulTerms = rawTerms.filter(term => !JambavanIndex.STOP_WORDS.has(term));
    const terms = meaningfulTerms.length > 0 ? meaningfulTerms : rawTerms;
    if (terms.length === 0) return [];

    try {
      const exact = this.searchFts(terms, limit, exactQuery, 'AND');
      if (terms.length === 1 || exact.length >= limit) return exact;

      const seen = new Set(exact.map(r => `${r.symbol.filePath}:${r.symbol.startLine}:${r.symbol.name}`));
      const fallback = this.searchFts(terms, limit, exactQuery, 'OR')
        .filter(r => !seen.has(`${r.symbol.filePath}:${r.symbol.startLine}:${r.symbol.name}`));
      return [...exact, ...fallback].slice(0, limit);
    } catch {
      return this.searchLike(terms, limit, exactQuery);
    }
  }

  private searchFts(terms: string[], limit: number, exactQuery: string, operator: 'AND' | 'OR'): SymbolSearchResult[] {
    const matchQuery = terms.map(t => JambavanIndex.ftsToken(t)).join(` ${operator} `);
    // Over-fetch from FTS5's bm25 order, then re-rank by exact/prefix name
    // match (matching the old LIKE path's priority) while keeping bm25 order
    // as the stable secondary sort among equal name scores.
    const overFetch = Math.min(Math.max(limit * 5, 50), 500);
    const rows = this.db.prepare(`
      SELECT symbols.*
      FROM symbols_fts
      JOIN symbols ON symbols.id = symbols_fts.rowid
      WHERE symbols_fts MATCH ?
      ORDER BY bm25(symbols_fts)
      LIMIT ?
    `).all(matchQuery, overFetch) as (Symbol & { file_path: string; start_line: number; end_line: number; refs?: string })[];

    return rows
      .map(row => ({ row, nameScore: JambavanIndex.nameScore(row.name, exactQuery, terms[0]) }))
      .sort((a, b) => b.nameScore - a.nameScore)
      .slice(0, limit)
      .map(({ row, nameScore }) => JambavanIndex.toResult(row, nameScore));
  }

  private searchLike(terms: string[], limit: number, exactQuery: string): SymbolSearchResult[] {
    const rows = this.db.prepare(`
      SELECT *,
        (CASE WHEN LOWER(name) = ?        THEN 100
              WHEN LOWER(name) LIKE ?     THEN 50
              ELSE 0 END) AS name_score
      FROM symbols
      WHERE ${terms.map(() => '(LOWER(name) LIKE ? OR LOWER(content) LIKE ?)').join(' OR ')}
      ORDER BY name_score DESC, LENGTH(content) ASC
      LIMIT ?
    `).all(
      exactQuery,
      `%${terms[0]}%`,
      ...terms.flatMap(t => [`%${t}%`, `%${t}%`]),
      limit,
    ) as (Symbol & { name_score: number; file_path: string; start_line: number; end_line: number; refs?: string })[];

    return rows.map(row => JambavanIndex.toResult(row, row.name_score));
  }

  /** All re-export directives across the project (for cross-file graph resolution). */
  getAllReExports(limit = 20000): ReExportRow[] {
    return (this.db.prepare('SELECT * FROM reexports LIMIT ?').all(limit) as {
      file_path: string; specifier: string; imported: string; exported: string;
    }[]).map(row => ({
      filePath:  row.file_path,
      specifier: row.specifier,
      imported:  row.imported,
      exported:  row.exported,
    }));
  }

  /** All indexed symbols */
  getAllSymbols(limit = 5000): Symbol[] {
    return (this.db.prepare('SELECT * FROM symbols ORDER BY file_path, start_line LIMIT ?').all(limit) as any[])
      .map(row => ({
        name:       row.name       as string,
        type:       row.type       as Symbol['type'],
        startLine:  row.start_line as number,
        endLine:    row.end_line   as number,
        content:    row.content    as string,
        filePath:   row.file_path  as string,
        references: JSON.parse((row.refs as string | undefined) ?? '[]'),
      }));
  }

  /** All symbols in a file */
  getFileSymbols(filePath: string): Symbol[] {
    return (this.db.prepare('SELECT * FROM symbols WHERE file_path = ?').all(filePath) as any[])
      .map(row => ({
        name:       row.name      as string,
        type:       row.type      as Symbol['type'],
        startLine:  row.start_line as number,
        endLine:    row.end_line   as number,
        content:    row.content   as string,
        filePath:   row.file_path  as string,
        references: JSON.parse((row.refs as string | undefined) ?? '[]'),
      }));
  }

  stats(): { files: ReturnType<FileCache['stats']>; symbols: number; failures: IndexFailure[] } {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM symbols')
      .get() as { count: number };
    return { files: this.cache.stats(), symbols: row.count, failures: [...this.failures.values()] };
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private replaceFile(parsed: ParsedFile): void {
    const insert = this.db.prepare(`
      INSERT INTO symbols (file_path, name, type, start_line, end_line, content, refs)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertReExport = this.db.prepare(`
      INSERT INTO reexports (file_path, specifier, imported, exported)
      VALUES (?, ?, ?, ?)
    `);
    const replace = this.db.transaction(() => {
      this.db.prepare('DELETE FROM symbols WHERE file_path = ?').run(parsed.filePath);
      this.db.prepare('DELETE FROM reexports WHERE file_path = ?').run(parsed.filePath);
      for (const s of parsed.symbols) {
        insert.run(s.filePath, s.name, s.type, s.startLine, s.endLine, s.content, JSON.stringify(s.references ?? []));
      }
      for (const e of parsed.reExports) {
        insertReExport.run(parsed.filePath, e.specifier, e.imported, e.exported);
      }
    });
    replace();
  }

  private recordFailure(filePath: string, err: unknown): void {
    this.failures.set(filePath, {
      filePath,
      error: err instanceof Error ? err.message : String(err),
      failedAt: Date.now(),
    });
  }

  private async discoverFiles(): Promise<string[]> {
    const ig = this.buildIgnore();

    // Only discover files the parser can handle — never read/hash/cache assets
    // (PNG, CSV, sqlite, …) the indexer would just skip. Extensions come dot-less
    // from ASTParser so the brace-glob is valid: **/*.{ts,tsx,py,…}
    const exts = ASTParser.supportedExtensions();
    const pattern = `**/*.{${exts.join(',')}}`;
    const allFiles = await glob(pattern, {
      cwd:      this.config.projectRoot,
      nodir:    true,
      absolute: true,
      dot:      false,
    });

    return allFiles.filter(f => {
      const rel = path.relative(this.config.projectRoot, f);
      return !ig.ignores(rel);
    });
  }

  private buildIgnore(): ReturnType<typeof ignore> {
    const ig = ignore();
    const gitignorePath = path.join(this.config.projectRoot, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      ig.add(fs.readFileSync(gitignorePath, 'utf-8'));
    }
    ig.add(this.config.ignore);
    return ig;
  }

  /**
   * Whether a path should be indexed — same gate the full scan uses, so the
   * watcher can't sneak in files the full index deliberately excludes.
   * Rejects unsupported extensions, paths outside the root, and anything
   * matched by .gitignore or config.ignore.
   */
  shouldIndex(filePath: string): boolean {
    if (!ASTParser.canParse(filePath)) return false;
    const rel = path.relative(this.config.projectRoot, filePath);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    return !this.buildIgnore().ignores(rel);
  }

  close(): void {
    this.cache.close();
    this.db.close();
  }
}
