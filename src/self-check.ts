#!/usr/bin/env node
import * as assert from 'assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { JambavanConfig } from './config/jambavan.config';
import { createReadFileTool } from './tools/read-file';
import { buildMemoryHandlers } from './tools/memory';
import { awakenReport, projectScope } from './tools/jambavan';
import { buildSymbolGraph, graphPath, graphQuery, graphReport } from './knowledge/graph';
import { harvestRin, vibhishanaNitiInstructions } from './tools/vibhishana-niti';
import { sankshiptaText } from './tools/sankshipta';
import { capLines } from './tools/search';
import { boundedInt, capOutput } from './tools/registry';
async function main(): Promise<void> {
  delete process.env.JAMBAVAN_ALLOW_OUTSIDE_ROOT;

  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jambavan-self-check-'));
  const config: JambavanConfig = {
    projectRoot,
    indexDir: path.join(projectRoot, '.jambavan'),
    memoryDir: path.join(projectRoot, '.jambavan', 'memory'),
    contextTokenBudget: 8000,
    ignore: [],
    rootSource: 'env',
  };

  fs.writeFileSync(path.join(projectRoot, 'inside.txt'), 'ok', 'utf-8');
  fs.writeFileSync(path.join(projectRoot, 'debt.ts'), '// rin: linear scan, index when this grows\n', 'utf-8');

  const readFile = createReadFileTool(config);
  assert.equal((await readFile.handler({ path: 'inside.txt' })).output, 'ok');
  await assert.rejects(
    () => readFile.handler({ path: path.join(os.tmpdir(), 'outside.txt') }),
    /escapes project root/,
  );
  // Secret files are denied by the shared path guard (read attempt rejects).
  await assert.rejects(() => readFile.handler({ path: '.env' }), /secret file/);
  await assert.rejects(() => readFile.handler({ path: 'server.key' }), /secret file/);

  const memory = buildMemoryHandlers(config);
  const mined = memory.jambavan_memory_mine_session({
    scope: projectScope(config),
    text: 'We weighed Postgres vs Mongo.\nDecision: keep checks tiny.\n\n\nnoise\n\n\nTODO: smoke-test MCP help.',
  });
  assert.match(mined, /Stored 2 mined memories/);
  // Context window keeps the preceding rationale line, not just the keyword line.
  assert.match(memory.jambavan_memory_recall({ scope: projectScope(config) }), /weighed Postgres vs Mongo/);
  assert.match(memory.jambavan_memory_recall({ scope: projectScope(config) }), /keep checks tiny/);
  assert.match(awakenReport(config), /keep checks tiny/);
  assert.match(awakenReport(config), /Every tool byte spends context/);
  const id = memory.jambavan_memory_store({ scope: 'self-check', title: 'Old fact', body: 'stale' }).match(/ID: (.+)$/)?.[1] ?? '';
  assert.match(memory.jambavan_memory_invalidate({ id, reason: 'newer fact' }), /Invalidated/);
  assert.doesNotMatch(memory.jambavan_memory_recall({ scope: 'self-check' }), /Old fact/);
  assert.doesNotMatch(memory.jambavan_memory_search({ query: 'stale', scope: 'self-check' }), /Old fact/);
  // Frontmatter must survive tricky values (colon + embedded quote) via JSON round-trip.
  const trickyTitle = 'GraphQL: "why" and trade-offs';
  memory.jambavan_memory_store({ scope: 'self-check', title: trickyTitle, body: 'x' });
  assert.match(memory.jambavan_memory_recall({ scope: 'self-check' }), /GraphQL: "why" and trade-offs/);
  assert.equal(harvestRin(config).markers.length, 1);
  assert.match(vibhishanaNitiInstructions('full'), /Sankshipta tool use/);
  assert.match(vibhishanaNitiInstructions('full'), /git diff --stat/);

  const sankshipta = sankshiptaText('Please make sure to utilize the important path `src/index.ts`.\n```ts\nconst keep = "because and the";\n```\n');
  assert.ok(sankshipta.length < 'Please make sure to utilize the important path `src/index.ts`.\n```ts\nconst keep = "because and the";\n```\n'.length);
  assert.match(sankshipta, /const keep = "because and the";/);
  // Ellipsis must survive prose compression (only repeated , ; : ! ? collapse).
  assert.match(sankshiptaText('Wait for it ...\n'), /\.\.\./);
  assert.match(sankshiptaText('Ship,, done!!\n'), /^Ship, done!/);

  // Global result cap: 5 files × 3 matches must truncate to the requested max.
  const flood = Array.from({ length: 15 }, (_, i) => `file${i % 5}.ts:${i}:hit`).join('\n');
  const capped = capLines(flood, 10).split('\n');
  assert.equal(capped.length, 11); // 10 matches + 1 truncation notice
  assert.match(capped[10], /5 more matches truncated/);
  assert.equal(capLines('', 10), '(no matches)');

  // Trust-boundary numeric guard: garbage/negative/huge coerce to safe range.
  assert.equal(boundedInt(undefined, { min: 1, max: 100, fallback: 30 }), 30);
  assert.equal(boundedInt('nope',    { min: 1, max: 100, fallback: 30 }), 30);
  assert.equal(boundedInt(-5,        { min: 1, max: 100, fallback: 30 }), 1);
  assert.equal(boundedInt(1e12,      { min: 1, max: 100, fallback: 30 }), 100);
  assert.equal(boundedInt(4.9,       { min: 1, max: 100, fallback: 30 }), 4);
  // Output flood guard truncates and annotates.
  const bigOut = capOutput('x'.repeat(200_000));
  assert.ok(bigOut.length < 200_000 && /output truncated/.test(bigOut));
  assert.equal(capOutput('small'), 'small');

  // read_file line bounds survive out-of-range input (no throw, clamps).
  fs.writeFileSync(path.join(projectRoot, 'lines.txt'), 'a\nb\nc\n', 'utf-8');
  assert.equal((await readFile.handler({ path: 'lines.txt', start_line: -3, end_line: 999 })).output, 'a\nb\nc\n');

  const graph = buildSymbolGraph([
    { name: 'alpha', type: 'function', filePath: path.join(projectRoot, 'a.ts'), startLine: 1, endLine: 1, content: 'function alpha() { return beta(); }', references: [{ name: 'beta', type: 'call' }] },
    { name: 'beta', type: 'function', filePath: path.join(projectRoot, 'b.ts'), startLine: 1, endLine: 1, content: 'function beta() { return 1; }' },
  ], config);
  assert.match(graphReport(graph), /EXTRACTED edges/);
  assert.ok(graph.edges.some(e => e.type === 'call' && e.confidence === 'EXTRACTED'));
  // Token-containment inference: gamma's body mentions `alpha` with no explicit ref.
  const inferGraph = buildSymbolGraph([
    { name: 'alpha', type: 'function', filePath: path.join(projectRoot, 'a.ts'), startLine: 1, endLine: 1, content: 'function alpha() { return 1; }' },
    { name: 'gamma', type: 'function', filePath: path.join(projectRoot, 'g.ts'), startLine: 1, endLine: 1, content: 'function gamma() { return alpha + 2; }' },
  ], config);
  assert.ok(inferGraph.edges.some(e => e.type === 'mentions' && e.confidence === 'INFERRED'));
  assert.match(graphQuery(graph, 'alpha'), /call\/EXTRACTED/);
  assert.match(graphPath(graph, 'alpha', 'beta'), /via call\/EXTRACTED/);

  fs.rmSync(projectRoot, { recursive: true, force: true });
  console.log('self-check ok');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
