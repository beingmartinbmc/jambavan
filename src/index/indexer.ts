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
import type { JambavanConfig } from '../config/jambavan.config';

export interface IndexStats {
  totalFiles: number;
  indexedFiles: number;
  skippedFiles: number;
  totalSymbols: number;
  durationMs: number;
}

export interface SymbolSearchResult {
  symbol: Symbol;
  score: number;
}

export class JambavanIndex {
  private cache:  FileCache;
  private parser: ASTParser;
  private db:     Database.Database;

  constructor(private config: JambavanConfig) {
    fs.mkdirSync(config.indexDir, { recursive: true });
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
    `);
    // Migrate pre-refs caches only when the column is actually missing (no throw-and-catch).
    const hasRefs = (this.db.pragma('table_info(symbols)') as { name: string }[])
      .some(c => c.name === 'refs');
    if (!hasRefs) this.db.exec(`ALTER TABLE symbols ADD COLUMN refs TEXT NOT NULL DEFAULT '[]'`);
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
    const stale = this.cache.getStaleFiles(files);
    let totalSymbols = 0;

    for (const filePath of stale) {
      totalSymbols += this.indexFile(filePath);
    }

    // Purge deleted files
    const currentFiles = new Set(files);
    for (const cached of this.cache.getAll()) {
      if (!currentFiles.has(cached.filePath)) {
        this.deleteFile(cached.filePath);
      }
    }

    return {
      totalFiles:   files.length,
      indexedFiles: stale.length,
      skippedFiles: files.length - stale.length,
      totalSymbols,
      durationMs:   Date.now() - start,
    };
  }

  // ── Per-file operations (used by FileWatcher) ───────────────────────────────

  /**
   * (Re-)index a single file. Skips if the file hash hasn't changed.
   * Returns the number of symbols extracted (0 for unchanged or unparseable files).
   */
  indexFile(filePath: string): number {
    if (!this.cache.isStale(filePath)) return 0;
    if (!fs.existsSync(filePath))      return 0;

    // Remove stale symbols for this file first
    this.db.prepare('DELETE FROM symbols WHERE file_path = ?').run(filePath);

    if (!ASTParser.canParse(filePath)) {
      this.cache.markIndexed(filePath, 0);
      return 0;
    }

    try {
      const parsed = this.parser.parseFile(filePath);
      this.storeSymbols(parsed);
      this.cache.markIndexed(filePath, parsed.symbols.length);
      return parsed.symbols.length;
    } catch {
      // Unparseable file — mark it to avoid re-trying on every watcher event
      this.cache.markIndexed(filePath, 0);
      return 0;
    }
  }

  /**
   * Remove all symbols and cache entry for a deleted file.
   */
  deleteFile(filePath: string): void {
    this.db.prepare('DELETE FROM symbols WHERE file_path = ?').run(filePath);
    this.cache.markDeleted(filePath);
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  /**
   * Search symbols by name or content.
   * Scores exact name match highest, prefix match second, substring last.
   * rin: SQLite LIKE scan, no FTS5; add fts5 virtual table if search feels slow on >100k symbols.
   */
  search(query: string, limit = 20): SymbolSearchResult[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    const rows = this.db.prepare(`
      SELECT *,
        (CASE WHEN LOWER(name) = ?        THEN 100
              WHEN LOWER(name) LIKE ?     THEN 50
              ELSE 0 END) AS name_score
      FROM symbols
      WHERE ${terms.map(() => '(LOWER(name) LIKE ? OR LOWER(content) LIKE ?)').join(' AND ')}
      ORDER BY name_score DESC, LENGTH(content) ASC
      LIMIT ?
    `).all(
      terms[0],
      `%${terms[0]}%`,
      ...terms.flatMap(t => [`%${t}%`, `%${t}%`]),
      limit,
    ) as (Symbol & { name_score: number; file_path: string; start_line: number; end_line: number })[];

    return rows.map(row => ({
      symbol: {
        name:       row.name,
        type:       row.type as Symbol['type'],
        startLine:  row.start_line,
        endLine:    row.end_line,
        content:    row.content,
        filePath:   row.file_path,
        references: JSON.parse((row as { refs?: string }).refs ?? '[]'),
      },
      score: row.name_score + 1,
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

  stats(): { files: ReturnType<FileCache['stats']>; symbols: number } {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM symbols')
      .get() as { count: number };
    return { files: this.cache.stats(), symbols: row.count };
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private storeSymbols(parsed: ParsedFile): void {
    const insert = this.db.prepare(`
      INSERT INTO symbols (file_path, name, type, start_line, end_line, content, refs)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMany = this.db.transaction((syms: Symbol[]) => {
      for (const s of syms) {
        insert.run(s.filePath, s.name, s.type, s.startLine, s.endLine, s.content, JSON.stringify(s.references ?? []));
      }
    });
    insertMany(parsed.symbols);
  }

  private async discoverFiles(): Promise<string[]> {
    const ig = ignore();

    const gitignorePath = path.join(this.config.projectRoot, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      ig.add(fs.readFileSync(gitignorePath, 'utf-8'));
    }

    ig.add(this.config.ignore);

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

  close(): void {
    this.cache.close();
    this.db.close();
  }
}
