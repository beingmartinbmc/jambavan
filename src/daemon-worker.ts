#!/usr/bin/env node
/**
 * Daemon worker — the detached process spawned by `jambavan daemon start`
 * (src/tools/daemon.ts). Builds/refreshes the index once, then runs the same
 * `FileWatcher` used in-process by `jambavan_watch start`, standalone.
 *
 * Never spawn or import this directly outside of src/tools/daemon.ts; it has
 * no MCP transport and exits as soon as it's asked to (SIGTERM/SIGINT).
 */

import { loadConfig } from './config/jambavan.config';
import { JambavanIndex } from './index/indexer';
import { FileWatcher } from './index/watcher';

async function main(): Promise<void> {
  const config = loadConfig();
  const index = new JambavanIndex(config);

  const stats = await index.index();
  console.log(
    `[jambavan:daemon] indexed ${stats.indexedFiles}/${stats.totalFiles} files `
    + `(${stats.indexedSymbols} symbols extracted; ${stats.totalSymbols} total) in ${stats.durationMs}ms`,
  );

  const watcher = new FileWatcher(index, config);
  watcher.start();
  console.log(`[jambavan:daemon] watching ${config.projectRoot} (pid ${process.pid})`);

  const shutdown = (signal: string): void => {
    console.log(`[jambavan:daemon] received ${signal}, stopping watcher`);
    watcher.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(`[jambavan:daemon] fatal: ${err instanceof Error ? err.stack ?? err.message : err}`);
  process.exit(1);
});
