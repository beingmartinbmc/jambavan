#!/usr/bin/env node
/**
 * Jambavan benchmark — dogfoods the real pipeline on the current project.
 *
 * No LLM calls, no external services, deterministic. It measures the three
 * claims Jambavan makes:
 *
 *   1. Index    — cold build time + incremental (warm) re-index time.
 *   2. Context  — tokens shipped by jambavan_context vs. the naive baseline
 *                 an agent uses today: open every file that contains a match.
 *   3. Sankshipta — prose/prompt compression ratio.
 *
 * Runs against a throwaway index dir so it never touches your real
 * .jambavan/ index or memory.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig, type JambavanConfig } from './config/jambavan.config';
import { JambavanIndex } from './index/indexer';
import { ContextAssembler, type ContextChunk } from './context/assembler';
import { countTokens } from './context/token-counter';
import { sankshiptaText } from './tools/sankshipta';

/**
 * Auto-derive queries from the repo's own most common symbol names, so the
 * context benchmark is meaningful on any codebase (not just this one).
 */
function deriveQueries(index: JambavanIndex, n = 5): string[] {
  const freq = new Map<string, number>();
  for (const s of index.getAllSymbols(5000)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{4,}$/.test(s.name)) continue;
    freq.set(s.name, (freq.get(s.name) ?? 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(e => e[0]);
}

// A representative verbose instruction block — the kind of prose that pads prompts.
const PROSE_SAMPLE = `
Please make sure that you carefully go through the entire codebase in order to
understand how the authentication middleware actually works. It is really important
that we do not break any of the existing functionality. In the event that you find
a bug, please go ahead and fix the root cause rather than just patching the symptom.
Due to the fact that this service is used by a large number of downstream consumers,
we need to be absolutely certain that the changes are backwards compatible at all times.
`.trim();

const pad = (s: string, n: number) => s.padEnd(n);
const rpad = (s: string | number, n: number) => String(s).padStart(n);
const saved = (part: number, whole: number) =>
  whole === 0 ? '—' : `${Math.round((1 - part / whole) * 100)}%`;

async function main(): Promise<void> {
  const base = loadConfig();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jambavan-bench-'));
  const config: JambavanConfig = { ...base, indexDir: tmp, memoryDir: path.join(tmp, 'memory') };

  console.log(`Jambavan benchmark`);
  console.log(`project: ${config.projectRoot}\n`);

  const index = new JambavanIndex(config);
  const cold = await index.index();        // cold: parses everything
  const warm = await index.index();        // warm: nothing changed → all skipped

  console.log('## Index');
  console.log(`  files discovered  : ${cold.totalFiles}`);
  console.log(`  symbols extracted : ${cold.totalSymbols}`);
  console.log(`  cold build        : ${cold.durationMs} ms  (${cold.indexedFiles} files parsed)`);
  console.log(`  warm re-index     : ${warm.durationMs} ms  (${warm.skippedFiles} skipped)`);
  if (warm.durationMs > 0) {
    console.log(`  incremental speedup: ${(cold.durationMs / Math.max(warm.durationMs, 1)).toFixed(1)}x`);
  }

  const assembler = new ContextAssembler(config);
  const queries = deriveQueries(index);
  console.log('\n## Context — tokens to answer a query');
  console.log(`  queries  = the repo's most common symbols (auto-derived)`);
  console.log(`  baseline = full contents of every file containing a match`);
  console.log(`  budget   = ${config.contextTokenBudget} tokens\n`);
  console.log(`  ${pad('query', 24)} ${rpad('jambavan', 9)} ${rpad('baseline', 10)} ${rpad('saved', 7)}`);
  console.log(`  ${'-'.repeat(24)} ${'-'.repeat(9)} ${'-'.repeat(10)} ${'-'.repeat(7)}`);

  let totJ = 0, totB = 0, answered = 0;
  for (const q of queries) {
    const results = index.search(q, 30);
    if (results.length === 0) {
      console.log(`  ${pad(q, 24)} ${rpad('(no hit)', 9)}`);
      continue;
    }
    const chunks: ContextChunk[] = results.map(r => ({
      filePath:  r.symbol.filePath,
      content:   r.symbol.content,
      score:     r.score,
      startLine: r.symbol.startLine,
      endLine:   r.symbol.endLine,
      type:      (r.symbol.type === 'class' ? 'class' : 'function') as ContextChunk['type'],
    }));

    const { usedTokens } = assembler.assemble(chunks);

    const files = new Set(chunks.map(c => c.filePath));
    let baseline = 0;
    for (const f of files) if (fs.existsSync(f)) baseline += countTokens(fs.readFileSync(f, 'utf-8'));

    totJ += usedTokens; totB += baseline; answered++;
    console.log(`  ${pad(q, 24)} ${rpad(usedTokens, 9)} ${rpad(baseline, 10)} ${rpad(saved(usedTokens, baseline), 7)}`);
  }
  if (answered > 0) {
    console.log(`  ${'-'.repeat(24)} ${'-'.repeat(9)} ${'-'.repeat(10)} ${'-'.repeat(7)}`);
    console.log(`  ${pad('TOTAL', 24)} ${rpad(totJ, 9)} ${rpad(totB, 10)} ${rpad(saved(totJ, totB), 7)}`);
  }

  console.log('\n## Sankshipta — prose compression');
  const before = countTokens(PROSE_SAMPLE);
  const compact = sankshiptaText(PROSE_SAMPLE);
  const after = countTokens(compact);
  console.log(`  before : ${before} tokens`);
  console.log(`  after  : ${after} tokens`);
  console.log(`  saved  : ${saved(after, before)}`);

  index.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch(err => { console.error(err); process.exit(1); });
