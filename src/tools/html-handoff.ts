/**
 * Interactive HTML handoff report.
 *
 * Self-contained single-file HTML (no external CDN) containing:
 *   - Memory timeline (decisions / failures / other)
 *   - Rin debt ledger with file/line links
 *   - Graph summary stats
 *   - Git status (dirty files + recent commits)
 *   - Collapsible sections, copy-to-clipboard, dark mode
 *
 * Zero runtime dependencies; vanilla JS only.
 */

import { execFileSync } from 'child_process';
import * as fs   from 'fs';
import * as path from 'path';
import type { JambavanConfig } from '../config/jambavan.config';
import type { JambavanIndex }  from '../index/indexer';
import type { MemoryDoc } from '../memory/store';
import { MemoryArchive } from '../memory/archive';
import { harvestRin } from './vibhishana-niti';
import { projectScope, redactForSharing } from './jambavan';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c as '&'] ?? c));
}

function renderMemorySection(docs: MemoryDoc[], title: string, redact: (value: string) => string): string {
  if (docs.length === 0) return `<details open><summary class="sec">${esc(title)} <span class="count">0</span></summary><p class="muted">None recorded.</p></details>`;
  const items = docs.map(d => {
    const type = d.frontmatter.type && d.frontmatter.type !== 'Memory' ? `<span class="badge type">${esc(redact(d.frontmatter.type))}</span>` : '';
    const tags = d.frontmatter.tags.map(t => `<span class="badge tag">${esc(redact(t))}</span>`).join(' ');
    return `<details class="memory-item">
      <summary><b>${esc(redact(d.frontmatter.title))}</b> ${type} <span class="muted">${d.frontmatter.timestamp.slice(0,10)}</span> ${tags}</summary>
      <pre class="body">${esc(redact(d.body.trim()))}</pre>
    </details>`;
  }).join('\n');
  return `<details open><summary class="sec">${esc(title)} <span class="count">${docs.length}</span></summary>${items}</details>`;
}

export function buildHtmlHandoff(
  config:  JambavanConfig,
  index:   JambavanIndex,
  opts:    { scope?: string; shareSafe?: boolean } = {},
): string {
  const scope    = opts.scope ?? projectScope(config);
  const redact   = (value: string) => opts.shareSafe ? redactForSharing(value, config) : value;
  const allDocs  = new MemoryArchive(config).list(scope)
    .sort((a, b) => b.frontmatter.timestamp.localeCompare(a.frontmatter.timestamp));

  const decisions  = allDocs.filter(d => d.frontmatter.type === 'Decision');
  const failures   = allDocs.filter(d => d.frontmatter.type === 'FailureRecord');
  const shown      = new Set([...decisions, ...failures].map(d => d.id));
  const other      = allDocs.filter(d => !shown.has(d.id));

  const { markers } = harvestRin(config);
  const noTrigger   = markers.filter(m => !m.hasUpgrade).length;

  const idxStats = index.stats();

  // Git
  let gitHtml = '<p class="muted">Git not available or not a git repository.</p>';
  if (!opts.shareSafe) try {
    const root   = config.projectRoot;
    const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const dirty  = git(root, ['status', '--porcelain']).split('\n').filter(Boolean);
    const log    = git(root, ['log', '--oneline', '-8']).trim();
    const dirtyHtml = dirty.length
      ? dirty.slice(0, 30).map(l => `<div><code>${esc(l)}</code></div>`).join('') +
        (dirty.length > 30 ? `<div class="muted">… and ${dirty.length - 30} more</div>` : '')
      : '<div class="muted">(clean)</div>';
    gitHtml = `<div class="git-stat"><b>Branch:</b> <code>${esc(branch)}</code></div>
<details><summary class="sec">Dirty files <span class="count">${dirty.length}</span></summary>${dirtyHtml}</details>
<details><summary class="sec">Recent commits</summary><pre class="body">${esc(log)}</pre></details>`;
  } catch { /* no git */ }

  // Rin ledger
  const rinHtml = markers.length === 0
    ? '<p class="muted">No rin markers — clean ledger.</p>'
    : markers.map(m => {
        const cls = m.hasUpgrade ? '' : ' class="no-trigger"';
        return `<div${cls}><code>${esc(redact(m.file))}:${m.line}</code> — ${esc(redact(m.comment))}${m.hasUpgrade ? '' : ' <span class="badge warn">no trigger</span>'}</div>`;
      }).join('');

  const generatedAt = new Date().toISOString();

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jambavan Handoff — ${esc(path.basename(config.projectRoot))}</title>
<style>
*{box-sizing:border-box}
body{margin:0;font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1117;color:#c9d1d9;padding:0 16px 40px;max-width:900px;margin:auto;line-height:1.6}
h1{font-size:22px;margin:24px 0 4px;color:#e6edf3}
.meta{color:#8b949e;font-size:12px;margin-bottom:24px}
details{margin:8px 0;border:1px solid #21262d;border-radius:8px;overflow:hidden}
summary.sec{background:#161b22;padding:10px 14px;cursor:pointer;font-weight:600;font-size:13px;list-style:none;display:flex;align-items:center;gap:8px;color:#e6edf3}
summary.sec::-webkit-details-marker{display:none}
details[open]>summary.sec{border-bottom:1px solid #21262d}
.memory-item>summary{padding:8px 14px;cursor:pointer;list-style:none;background:#0d1117}
.memory-item>summary::-webkit-details-marker{display:none}
.memory-item>summary:hover{background:#161b22}
pre.body{background:#161b22;padding:12px 14px;margin:0;font-size:12px;white-space:pre-wrap;word-break:break-word;color:#c9d1d9;overflow-x:auto}
.count{background:#21262d;color:#8b949e;font-size:11px;padding:1px 7px;border-radius:10px;font-weight:400;margin-left:auto}
.badge{display:inline-block;padding:1px 7px;border-radius:4px;font-size:11px;font-weight:600;margin:0 2px}
.badge.type{background:#1a3a5e;color:#58a6ff}
.badge.tag{background:#1a3a1a;color:#56d364}
.badge.warn{background:#4d3b00;color:#f0a500}
.muted{color:#8b949e;font-size:12px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:16px 0}
.stat-card{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:14px;text-align:center}
.stat-card .n{font-size:28px;font-weight:700;color:#e6edf3}
.stat-card .l{font-size:11px;color:#8b949e;margin-top:2px}
code{background:#21262d;border-radius:4px;padding:1px 5px;font-size:12px}
.git-stat{margin:8px 0;font-size:13px}
.no-trigger{color:#f0a500}
.share-warning{background:#4d3b00;border:1px solid #9e6a03;color:#f0c674;padding:10px 14px;border-radius:8px;margin:16px 0}
#copy-btn{float:right;background:#21262d;border:1px solid #30363d;color:#c9d1d9;padding:4px 12px;border-radius:6px;cursor:pointer;font-size:12px;margin-top:20px}
#copy-btn:hover{background:#30363d}
a{color:#58a6ff}
</style>
</head>
<body>
<button id="copy-btn" onclick="navigator.clipboard.writeText(document.body.innerText).then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy text',2000})">Copy text</button>
<h1>🐻 Jambavan Handoff</h1>
${opts.shareSafe ? '<div class="share-warning"><b>Review before sharing.</b> Automated redaction is best-effort; inspect this handoff for private data.</div>' : ''}
<div class="meta">
  Project: <code>${esc(opts.shareSafe ? path.basename(config.projectRoot) : config.projectRoot)}</code> &nbsp;·&nbsp;
  Scope: <code>${esc(redact(scope))}</code> &nbsp;·&nbsp;
  Generated: ${generatedAt.slice(0,19).replace('T',' ')} UTC
</div>

<div class="grid">
  <div class="stat-card"><div class="n">${allDocs.length}</div><div class="l">Memories</div></div>
  <div class="stat-card"><div class="n">${markers.length}</div><div class="l">Rin markers (${noTrigger} no trigger)</div></div>
  <div class="stat-card"><div class="n">${idxStats.symbols}</div><div class="l">Indexed symbols</div></div>
</div>

${renderMemorySection(decisions, 'Decisions', redact)}
${renderMemorySection(failures,  'Failure Records', redact)}
${renderMemorySection(other,     'Other Memories', redact)}

<details><summary class="sec">Rin Debt <span class="count">${markers.length}</span></summary>
<div style="padding:10px 14px;font-size:12px;line-height:2">${rinHtml}</div>
</details>

${opts.shareSafe ? '' : `<details><summary class="sec">Git Status</summary>
<div style="padding:10px 14px">${gitHtml}</div>
</details>`}

<p class="muted" style="margin-top:24px;font-size:11px">
  Generated by <a href="https://github.com/beingmartinbmc/jambavan" target="_blank">Jambavan</a> —
  local-first MCP memory for coding agents · no LLM calls · no telemetry
</p>
</body>
</html>
`;
}
