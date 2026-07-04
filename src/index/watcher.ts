/**
 * File Watcher — keeps the index live as you edit code.
 *
 * Uses chokidar to watch the project root and calls indexFile / deleteFile
 * on the JambavanIndex directly. Each file change costs O(1): only the changed
 * file is re-parsed, never the whole project.
 *
 * Events are coalesced by chokidar's awaitWriteFinish (300 ms of write
 * stability) so rapid saves (format-on-save, autosave) collapse into a
 * single index operation — no second JS-level debounce needed.
 */

import chokidar from 'chokidar';
import * as path from 'path';
import type { JambavanIndex } from './indexer';
import type { JambavanConfig } from '../config/jambavan.config';

export interface WatcherStatus {
  running:        boolean;
  filesProcessed: number;
  lastEvent:      string | null;  // ISO timestamp of the last file event
  lastFile:       string | null;  // path of the last file processed
}

export class FileWatcher {
  private watcher?:       ReturnType<typeof chokidar.watch>;
  private status:         WatcherStatus = {
    running:        false,
    filesProcessed: 0,
    lastEvent:      null,
    lastFile:       null,
  };

  constructor(
    private index:  JambavanIndex,
    private config: JambavanConfig,
  ) {}

  start(): void {
    if (this.status.running) return;

    const ignored: (RegExp | string)[] = [
      /(^|[/\\])\../,   // dotfiles / dotdirs
      /node_modules/,
      /\.jambavan/,
      /[/\\]dist[/\\]/,
      /[/\\]build[/\\]/,
      /\.d\.ts$/,       // declaration files — generated, not authored
    ];

    this.watcher = chokidar.watch(this.config.projectRoot, {
      ignored,
      persistent:    true,
      ignoreInitial: true,   // existing files are already in the index
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval:       50,
      },
    });

    this.watcher
      .on('change', (fp: string) => this.processChange(fp))
      .on('add',    (fp: string) => this.processChange(fp))
      .on('unlink', (fp: string) => this.processDelete(fp));

    this.status.running = true;
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
    this.status.running = false;
  }

  getStatus(): WatcherStatus {
    return { ...this.status };
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private processChange(filePath: string): void {
    // Authoritative gate: same ignore rules the full index uses (.gitignore +
    // config.ignore + supported extensions), so the watcher can't index a file
    // the full scan would have excluded.
    // rin: shouldIndex re-reads .gitignore per event; fine at human edit rates,
    // add a cached matcher if a bulk generator ever floods the watcher.
    if (!this.index.shouldIndex(filePath)) return;
    try {
      this.index.indexFile(filePath);
      this.status.filesProcessed++;
      this.status.lastEvent = new Date().toISOString();
      this.status.lastFile  = path.relative(this.config.projectRoot, filePath);
    } catch (err) {
      process.stderr.write(`[jambavan:watch] error indexing ${filePath}: ${err}\n`);
    }
  }

  private processDelete(filePath: string): void {
    try {
      this.index.deleteFile(filePath);
      this.status.filesProcessed++;
      this.status.lastEvent = new Date().toISOString();
      this.status.lastFile  = path.relative(this.config.projectRoot, filePath);
    } catch (err) {
      process.stderr.write(`[jambavan:watch] error removing ${filePath}: ${err}\n`);
    }
  }
}
