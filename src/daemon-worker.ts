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
import { writeHeartbeat, HEARTBEAT_INTERVAL_MS } from './tools/daemon';

async function main(): Promise<void> {
  const config = loadConfig();
  const instanceId = process.env.JAMBAVAN_DAEMON_INSTANCE;
  if (!instanceId) {
    console.error('[jambavan:daemon] missing JAMBAVAN_DAEMON_INSTANCE; refusing to run (spawn via "jambavan daemon start").');
    process.exit(1);
  }
  const index = new JambavanIndex(config);

  const stats = await index.index();
  console.log(
    `[jambavan:daemon] indexed ${stats.indexedFiles}/${stats.totalFiles} files `
    + `(${stats.indexedSymbols} symbols extracted; ${stats.totalSymbols} total) in ${stats.durationMs}ms`,
  );

  const watcher = new FileWatcher(index, config);
  watcher.start();
  console.log(`[jambavan:daemon] watching ${config.projectRoot} (pid ${process.pid})`);

  // Prove liveness so a reused PID after a crash can't be mistaken for us (see daemon.ts).
  writeHeartbeat(config, instanceId);
  const heartbeat = setInterval(() => writeHeartbeat(config, instanceId), HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  const shutdown = (signal: string): void => {
    console.log(`[jambavan:daemon] received ${signal}, stopping watcher`);
    clearInterval(heartbeat);
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
