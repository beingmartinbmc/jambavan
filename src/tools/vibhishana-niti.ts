/**
 * Dev mode tools for Jambavan MCP.
 *
 * Two tools:
 *
 *   jambavan_vibhishana_niti — serve the efficient-dev ruleset at a given intensity
 *                            (lite / full / ultra). Lets a host model activate the mode
 *                            mid-session without a separate plugin install.
 *
 *   jambavan_rin_mochan      — grep the codebase for rin markers and return a
 *                            debt ledger so deliberate simplifications don't rot into
 *                            "later means never".
 *
 * Both are read-only; neither touches the index, the filesystem, or any external service.
 */

import { execSync } from 'child_process';
import type { JambavanConfig } from '../config/jambavan.config';

// ── Ruleset ───────────────────────────────────────────────────────────────────

const BASE_RULES = `
You are Vibhishana-coded: efficient, truthful, and not careless.
The best code is the code never written.

## The ladder

Before any code, stop at the first rung that holds (run it *after* you understand the problem):

1. Does this need to exist at all? (YAGNI)
2. Already in this codebase? Reuse it — look before you write.
3. Stdlib does it? Use it.
4. Native platform feature covers it? Use it.
5. Already-installed dependency solves it? Use it.
6. Can it be one line? One line.
7. Only then: the minimum that works.

**Bug fix = root cause, not symptom.** Grep every caller of the function you touch and fix it once in the shared function. One guard there is a smaller diff than one per caller — and patching only the path the ticket names leaves every sibling caller still broken.

## Rules

- No unrequested abstractions (no interface with one implementation, no factory with one product).
- No new dependency if the stdlib or an already-installed package covers it.
- No boilerplate nobody asked for.
- Deletion over addition. Boring over clever. Fewest files possible.
- Shortest working diff wins — but only once you understand the problem. A small change in the wrong place is a second bug.
- Complex request? Ship the lean version and question it in the same response.
- Between two same-size stdlib options, take the edge-case-correct one. Efficient means less code, not the flimsier algorithm.
- Mark deliberate simplifications with a \`// rin:\` comment that names the ceiling and upgrade path: \`// rin: linear scan, index if count grows past ~10k\`.

## Sankshipta tool use

Every tool byte spends context. Before each read/search/bash call, ask: can I avoid it, or make the tool filter harder?

- Prefer \`jambavan_context\`, \`search\` with \`max_results\`, and \`read_file\` line ranges over whole-file dumps.
- Query structured data at the source: \`jq\`/\`yq\`, \`sqlite3\` SELECTs, \`awk\`/\`cut\`/\`head\` for tables and logs.
- Search precisely first; use filenames/counts/small path scopes before broad content reads.
- Git summary first: \`git diff --stat\`, \`git diff --name-only\`, then inspect only the files that matter.
- Suppress noise: quiet flags, \`--no-color\`/\`NO_COLOR=1\`, redirects to temp files, then read \`head\`/\`tail\`/targeted lines.
- Poll with hashes or mtimes, not repeated full reads. Use coreutils for one-step transforms; use Python only when logic needs it.

## Not compromising on

Understanding the problem (read fully, trace the real flow before picking a rung), input validation at trust boundaries, error handling that prevents data loss, security, accessibility, anything explicitly requested.

**Code without its check is unfinished.** Non-trivial logic leaves ONE runnable check behind — the smallest thing that fails if the logic breaks. No frameworks, no fixtures. Trivial one-liners need no test.

## Output

Code first. Then at most three short lines: what was skipped, when to add it.
If the explanation is longer than the code, delete the explanation.

Pattern: \`[code] → skipped: [X], add when [Y].\`
`.trim();

const LITE_SUFFIX = `
## Level: lite

Build what's asked, but name the leaner alternative in one line. User picks.
Example: "Done. FYI: \`Array.prototype.at(-1)\` covers this in one expression if you'd rather not own the helper."
`.trim();

const ULTRA_SUFFIX = `
## Level: ultra

YAGNI extremist. Deletion before addition. Ship the one-liner and challenge the rest of the requirement in the same breath.
Example for "add a cache": "No cache until a profiler says so. When it does: \`Map\` keyed on the request. A hand-rolled TTL cache class is a bug farm with a hit rate."
`.trim();

const LEVEL_INSTRUCTIONS: Record<string, string> = {
  lite:  `VIBHISHANA NITI ACTIVE — level: lite\n\n${BASE_RULES}\n\n${LITE_SUFFIX}`,
  full:  `VIBHISHANA NITI ACTIVE — level: full\n\n${BASE_RULES}`,
  ultra: `VIBHISHANA NITI ACTIVE — level: ultra\n\n${BASE_RULES}\n\n${ULTRA_SUFFIX}`,
};

// ── Mode resolution ───────────────────────────────────────────────────────────
// rin: env var + two fallbacks, no config-file reader needed yet; add per-project JSON config when users request persistent mode.

function resolveMode(requested?: string): 'lite' | 'full' | 'ultra' {
  const candidate = (requested ?? process.env.JAMBAVAN_DEV_MODE ?? 'full')
    .toLowerCase().trim();
  return (candidate === 'lite' || candidate === 'ultra') ? candidate : 'full';
}

// ── jambavan_vibhishana_niti ────────────────────────────────────────────────────

export function vibhishanaNitiInstructions(mode?: string): string {
  return LEVEL_INSTRUCTIONS[resolveMode(mode)];
}

// ── jambavan_rin_mochan ─────────────────────────────────────────────────────────

export interface RinMarker {
  file:       string;
  line:       number;
  comment:    string;
  hasUpgrade: boolean;
}

/**
 * Grep the project for rin comments and return a structured ledger.
 * Recognises `// rin:` markers.
 * rin: execSync + grep, good enough for <50k files; stream if it times out.
 */
export function harvestRin(config: JambavanConfig): { markers: RinMarker[]; raw: string } {
  const cmd = `grep -rnE '(#|//|\\*) ?rin:' . \
    --include='*.ts' --include='*.js' --include='*.py' \
    --include='*.go' --include='*.rs' --include='*.java' \
    --include='*.md' --include='*.mdc' \
    --exclude-dir=node_modules --exclude-dir=.git \
    --exclude-dir=dist --exclude-dir=build --exclude-dir=.jambavan \
    2>/dev/null || true`;

  let raw: string;
  try {
    raw = execSync(cmd, { cwd: config.projectRoot, encoding: 'utf8', timeout: 10_000 });
  } catch {
    raw = '';
  }

  if (!raw.trim()) return { markers: [], raw: '' };

  const markers: RinMarker[] = [];

  for (const line of raw.split('\n').filter(Boolean)) {
    const m = line.match(/^([^:]+):(\d+):[^`"]*(?:\/\/|#|\*)\s*rin:\s*(.+)$/i);
    if (!m) continue;
    const comment = m[3].trim();
    // A comment has an upgrade path if it names a trigger: comma, "if", "when", "until"
    const hasUpgrade = /,|if\s|when\s|until\s/i.test(comment);
    markers.push({ file: m[1], line: Number(m[2]), comment, hasUpgrade });
  }

  return { markers, raw };
}

export function formatRinReport(markers: RinMarker[], projectRoot: string): string {
  if (markers.length === 0) return 'No rin debt. Clean ledger.';

  const byFile = new Map<string, RinMarker[]>();
  for (const m of markers) {
    const key = m.file.replace(projectRoot, '').replace(/^\//, '');
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push(m);
  }

  const lines: string[] = [];
  for (const [file, marks] of byFile) {
    lines.push(`\n${file}`);
    for (const m of marks) {
      const tag = m.hasUpgrade ? '' : '  ⚠ no-trigger';
      lines.push(`  L${m.line}: ${m.comment}${tag}`);
    }
  }

  const noTrigger = markers.filter(m => !m.hasUpgrade).length;
  lines.push(`\n${markers.length} marker${markers.length === 1 ? '' : 's'}, ${noTrigger} with no trigger.`);
  return lines.join('\n').trimStart();
}
