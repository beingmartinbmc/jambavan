/**
 * File Cache — SQLite-backed store of file hashes.
 * Enables incremental indexing: only re-index changed files.
 *
 * "Jaamvant didn't ask Hanuman to re-learn what he already knew."
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface CachedFile {
  filePath: string;
  contentHash: string;
  indexedAt: number;   // unix ms
  symbolCount: number;
}

export class FileCache {
  private db: Database.Database;

  constructor(indexDir: string) {
    fs.mkdirSync(indexDir, { recursive: true });
    this.db = new Database(path.join(indexDir, 'file-cache.db'));
    // Faster, safe-enough durability for a rebuildable cache (WAL + relaxed fsync).
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        file_path    TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        indexed_at   INTEGER NOT NULL,
        symbol_count INTEGER NOT NULL DEFAULT 0,
        mtime_ms     INTEGER NOT NULL DEFAULT 0,
        size         INTEGER NOT NULL DEFAULT 0
      );
    `);
    // Migrate older caches only when a metadata column is actually missing.
    const cols = new Set((this.db.pragma('table_info(files)') as { name: string }[]).map(c => c.name));
    if (!cols.has('mtime_ms')) this.db.exec('ALTER TABLE files ADD COLUMN mtime_ms INTEGER NOT NULL DEFAULT 0');
    if (!cols.has('size'))     this.db.exec('ALTER TABLE files ADD COLUMN size INTEGER NOT NULL DEFAULT 0');
  }

  /** SHA-256 hash of file content */
  static hashFile(filePath: string): string {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  isStale(filePath: string): boolean {
    let stat: fs.Stats;
    try { stat = fs.statSync(filePath); } catch { return false; }

    const row = this.db
      .prepare('SELECT content_hash, mtime_ms, size FROM files WHERE file_path = ?')
      .get(filePath) as { content_hash: string; mtime_ms: number; size: number } | undefined;
    if (!row) return true;

    // Fast path: unchanged size + mtime means unchanged content — skip the read+hash.
    // rin: mtime can miss same-second edits that preserve size; drop this branch if
    // sub-second re-saves must be caught (the watcher already re-indexes on save).
    if (row.size === stat.size && row.mtime_ms === Math.floor(stat.mtimeMs)) return false;

    return row.content_hash !== FileCache.hashFile(filePath);
  }

  markIndexed(filePath: string, symbolCount: number): void {
    let stat: fs.Stats;
    try { stat = fs.statSync(filePath); } catch { return; }
    const hash = FileCache.hashFile(filePath);
    this.db
      .prepare(`
        INSERT INTO files (file_path, content_hash, indexed_at, symbol_count, mtime_ms, size)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_path) DO UPDATE SET
          content_hash = excluded.content_hash,
          indexed_at   = excluded.indexed_at,
          symbol_count = excluded.symbol_count,
          mtime_ms     = excluded.mtime_ms,
          size         = excluded.size
      `)
      .run(filePath, hash, Date.now(), symbolCount, Math.floor(stat.mtimeMs), stat.size);
  }

  markDeleted(filePath: string): void {
    this.db.prepare('DELETE FROM files WHERE file_path = ?').run(filePath);
  }

  getAll(): CachedFile[] {
    return this.db.prepare('SELECT * FROM files').all() as CachedFile[];
  }

  /** Return files that have changed since last index.
   * rin: sequential metadata check; near-free per file, batch if >50k files ever stalls startup.
   */
  getStaleFiles(filePaths: string[]): string[] {
    return filePaths.filter(f => this.isStale(f));
  }

  stats(): { totalFiles: number; lastIndexed: number } {
    const row = this.db
      .prepare('SELECT COUNT(*) as count, MAX(indexed_at) as last FROM files')
      .get() as { count: number; last: number };
    return { totalFiles: row.count, lastIndexed: row.last };
  }

  close(): void {
    this.db.close();
  }
}
