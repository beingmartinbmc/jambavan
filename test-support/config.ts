import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { JambavanConfig } from '../src/config/jambavan.config';

/** Create an isolated temp project root + matching config for a test. */
export function mkTempConfig(): { config: JambavanConfig; root: string; cleanup: () => void } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jambavan-test-')));
  const config: JambavanConfig = {
    projectRoot: root,
    indexDir: path.join(root, '.jambavan'),
    memoryDir: path.join(root, '.jambavan', 'memory'),
    contextTokenBudget: 8000,
    ignore: [],
  };
  return { config, root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Run `fn` with env vars temporarily set, restoring prior values afterwards. */
export async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): Promise<void> {
  const prior: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prior[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
