/**
 * jambavan gui — local, dependency-free interactive visualizer.
 *
 * Upgrades from v1:
 *   • Click any graph node → side panel shows code snippet, callers, callees
 *   • Rin debt markers overlay: nodes with open rin debt glow amber
 *   • Failure heatmap: nodes associated with failure records glow red / sized larger
 *   • Search filter: type to highlight matching nodes
 *   • Tabs: Graph | Rin Debt | Failures (unchanged sidebar)
 *
 * Zero external dependencies. Vanilla JS + canvas. No build step.
 * Binds to loopback only — never reachable off the machine.
 */

import * as http from 'http';
import * as fs   from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import type { JambavanConfig } from '../config/jambavan.config';
import type { JambavanIndex }  from '../index/indexer';
import { buildSymbolGraph, type KnowledgeGraph, type GraphNode } from '../knowledge/graph';
import { harvestRin } from './vibhishana-niti';
import { MemoryArchive } from '../memory/archive';
import { projectScope } from './jambavan';

export interface GuiFailure {
  title:     string;
  status:    string;
  timestamp: string;
}

export interface GuiNodeDetail {
  id:       string;
  label:    string;
  type:     string;
  filePath: string | undefined;
  line:     number  | undefined;
  snippet:  string;        // up to 60 lines of source
  callers:  string[];      // labels of nodes with edges → this node
  callees:  string[];      // labels of nodes this node → points to
  rinCount: number;
  failureCount: number;
}

export interface GuiData {
  projectRoot:   string;
  generatedAt:   string;
  graph:         KnowledgeGraph;
  rin:           { file: string; line: number; comment: string; hasUpgrade: boolean }[];
  failures:      GuiFailure[];
  truncatedNodes: boolean;
  /** node id → rin marker count (for heatmap) */
  rinByNode:     Record<string, number>;
  /** node id → failure record count (for heatmap) */
  failuresByNode: Record<string, number>;
  /** node id → detail (populated on /api/node/:id) */
}

const MAX_GUI_NODES = 400;

export function buildGuiData(config: JambavanConfig, index: JambavanIndex): GuiData {
  const symbols   = index.getAllSymbols(5000);
  const fullGraph = buildSymbolGraph(symbols, config, index.getAllReExports());

  const degree = new Map<string, number>();
  for (const e of fullGraph.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to,   (degree.get(e.to)   ?? 0) + 1);
  }
  const truncatedNodes = fullGraph.nodes.length > MAX_GUI_NODES;
  const topIds = new Set(
    [...fullGraph.nodes]
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
      .slice(0, MAX_GUI_NODES)
      .map(n => n.id),
  );
  const graph: KnowledgeGraph = {
    nodes: fullGraph.nodes.filter(n => topIds.has(n.id)),
    edges: fullGraph.edges.filter(e => topIds.has(e.from) && topIds.has(e.to)),
  };

  const { markers } = harvestRin(config);
  const rin = markers.map(m => ({ file: m.file, line: m.line, comment: m.comment, hasUpgrade: m.hasUpgrade }));

  const scope    = projectScope(config);
  const allDocs  = new MemoryArchive(config).list(scope);
  const failures: GuiFailure[] = allDocs
    .filter(d => d.frontmatter.type === 'FailureRecord')
    .map(d => ({
      title:     d.frontmatter.title,
      status:    d.frontmatter.tags.find(t => ['unresolved', 'resolved', 'wontfix'].includes(t)) ?? 'unresolved',
      timestamp: d.frontmatter.timestamp,
    }))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  // ── Heatmap: map rin markers → graph nodes by file path ──────────────────────
  const rinByNode: Record<string, number> = {};
  for (const marker of markers) {
    const relFile = marker.file.replace(/^\.\//, '');
    for (const node of graph.nodes) {
      if (node.filePath && node.filePath.endsWith(relFile)) {
        rinByNode[node.id] = (rinByNode[node.id] ?? 0) + 1;
      }
    }
  }

  // ── Heatmap: map failure records → graph nodes by file path mention ───────────
  const failureDocs = allDocs.filter(d => d.frontmatter.type === 'FailureRecord');
  const failuresByNode: Record<string, number> = {};
  for (const doc of failureDocs) {
    for (const node of graph.nodes) {
      if (node.filePath && doc.body.includes(node.filePath.split('/').pop() ?? '')) {
        failuresByNode[node.id] = (failuresByNode[node.id] ?? 0) + 1;
      }
    }
  }

  return {
    projectRoot: config.projectRoot,
    generatedAt: new Date().toISOString(),
    graph,
    rin,
    failures,
    truncatedNodes,
    rinByNode,
    failuresByNode,
  };
}

/** Build detail for a single node (called on click). */
function buildNodeDetail(
  nodeId: string,
  data: GuiData,
  config: JambavanConfig,
): GuiNodeDetail | null {
  const node = data.graph.nodes.find(n => n.id === nodeId);
  if (!node) return null;

  // snippet: read source lines around the node's line
  let snippet = '';
  if (node.filePath && node.line) {
    const absPath = path.isAbsolute(node.filePath)
      ? node.filePath
      : path.join(config.projectRoot, node.filePath);
    try {
      const lines   = fs.readFileSync(absPath, 'utf-8').split('\n');
      const start   = Math.max(0, node.line - 1);
      const end     = Math.min(lines.length, node.line + 59);
      snippet = lines.slice(start, end).join('\n');
    } catch { /* file unreadable — leave snippet empty */ }
  }

  const callers = data.graph.edges
    .filter(e => e.to === nodeId && e.type !== 'contains')
    .map(e => data.graph.nodes.find(n => n.id === e.from)?.label ?? e.from)
    .filter(Boolean)
    .slice(0, 12);

  const callees = data.graph.edges
    .filter(e => e.from === nodeId && e.type !== 'contains')
    .map(e => data.graph.nodes.find(n => n.id === e.to)?.label ?? e.to)
    .filter(Boolean)
    .slice(0, 12);

  return {
    id:           node.id,
    label:        node.label,
    type:         node.type,
    filePath:     node.filePath,
    line:         node.line,
    snippet,
    callers,
    callees,
    rinCount:     data.rinByNode[nodeId] ?? 0,
    failureCount: data.failuresByNode[nodeId] ?? 0,
  };
}

export function startGuiServer(
  config: JambavanConfig,
  index:  JambavanIndex,
  port:   number,
): http.Server {
  // Build once per server start; /api/refresh re-builds on demand.
  let cached: GuiData = buildGuiData(config, index);

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';

    if (url === '/api/data') {
      cached = buildGuiData(config, index);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cached));
      return;
    }

    const nodeMatch = url.match(/^\/api\/node\/(.+)$/);
    if (nodeMatch) {
      let id: string;
      try {
        id = decodeURIComponent(nodeMatch[1]);
      } catch {
        // Malformed percent-encoding (e.g. a truncated %E0) — reject rather than
        // letting decodeURIComponent throw and crash the request handler.
        res.writeHead(400); res.end('{"error":"malformed URL"}'); return;
      }
      const detail = buildNodeDetail(id, cached, config);
      if (!detail) { res.writeHead(404); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(detail));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(GUI_HTML);
  });

  server.listen(port, '127.0.0.1');
  return server;
}

/** Best-effort: open the user's default browser. */
export function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32'  ? 'start'
            : 'xdg-open';
  try {
    spawn(cmd, process.platform === 'win32' ? ['', url] : [url],
      { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref();
  } catch { /* headless env */ }
}

// ── HTML ─────────────────────────────────────────────────────────────────────

const GUI_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Jambavan GUI</title>
<style>
*{box-sizing:border-box}
body{margin:0;font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1117;color:#c9d1d9;display:flex;height:100vh;overflow:hidden}
#sidebar{width:320px;min-width:200px;display:flex;flex-direction:column;border-right:1px solid #21262d;background:#0d1117}
#sidebar-tabs{display:flex;padding:8px 8px 0;gap:4px;border-bottom:1px solid #21262d}
button.tab{background:#161b22;color:#8b949e;border:1px solid #30363d;padding:4px 12px;cursor:pointer;border-radius:6px;font-size:12px;transition:background .15s}
button.tab.active{background:#1f6feb;border-color:#1f6feb;color:#fff}
#sidebar-content{flex:1;overflow-y:auto;padding:8px}
#detail-panel{width:380px;min-width:200px;border-left:1px solid #21262d;background:#0d1117;display:flex;flex-direction:column;transform:translateX(100%);transition:transform .2s;position:absolute;right:0;top:0;bottom:0;z-index:10}
#detail-panel.open{transform:none;position:relative}
#detail-close{background:none;border:none;color:#8b949e;cursor:pointer;font-size:18px;padding:8px 12px;align-self:flex-end}
#detail-body{flex:1;overflow-y:auto;padding:12px;font-size:12px}
#main{flex:1;position:relative;min-width:0}
canvas{width:100%;height:100%;display:block;cursor:crosshair}
canvas.dragging{cursor:grabbing}
h2{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#8b949e;margin:12px 0 4px;padding-bottom:4px;border-bottom:1px solid #21262d}
.item{padding:6px 4px;border-bottom:1px solid #161b22;font-size:12px;word-break:break-all;cursor:pointer;border-radius:4px;transition:background .1s}
.item:hover{background:#161b22}
.item.active{background:#1f3a5f;border-color:#1f6feb}
.muted{color:#8b949e}
.badge{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;margin-right:4px;font-weight:600}
.badge.resolved{background:#196c2e;color:#56d364}
.badge.unresolved{background:#6e1a1a;color:#f85149}
.badge.wontfix{background:#2d2d2d;color:#8b949e}
.badge.file{background:#1a3a5e;color:#58a6ff}
.badge.symbol{background:#1a3e1a;color:#56d364}
.badge.rin{background:#4d3b00;color:#f0a500}
.badge.failure{background:#6e1a1a;color:#f85149}
#stats{position:absolute;top:8px;left:8px;font-size:11px;color:#8b949e;pointer-events:none;background:rgba(13,17,23,.75);padding:4px 8px;border-radius:6px;backdrop-filter:blur(4px)}
#search-wrap{padding:8px}
#search{width:100%;background:#161b22;border:1px solid #30363d;color:#c9d1d9;padding:6px 8px;border-radius:6px;font-size:12px;outline:none}
#search:focus{border-color:#1f6feb}
pre.snippet{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:10px;overflow-x:auto;font-size:11px;line-height:1.5;color:#c9d1d9;max-height:320px;white-space:pre;tab-size:2}
.callee-link{color:#58a6ff;cursor:pointer;text-decoration:underline;font-size:12px}
.detail-section{margin:10px 0}
.detail-section h3{font-size:11px;text-transform:uppercase;color:#8b949e;margin:0 0 4px}
.heat-bar{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;vertical-align:middle}
.heat-rin{background:#f0a500}
.heat-fail{background:#f85149}
#legend{position:absolute;bottom:12px;right:12px;font-size:11px;color:#8b949e;background:rgba(13,17,23,.85);padding:8px 12px;border-radius:8px;line-height:1.8;pointer-events:none}
.l-dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}
</style>
</head>
<body>
<div id="sidebar">
  <div id="search-wrap"><input id="search" placeholder="Filter nodes…" autocomplete="off"></div>
  <div id="sidebar-tabs">
    <button class="tab active" data-tab="graph">Graph</button>
    <button class="tab" data-tab="rin">Rin Debt</button>
    <button class="tab" data-tab="failures">Failures</button>
  </div>
  <div id="sidebar-content">
    <div id="panel-graph"><h2>Nodes</h2><div id="node-list"></div></div>
    <div id="panel-rin"      style="display:none"><h2>Rin Debt</h2><div id="rin-list"></div></div>
    <div id="panel-failures" style="display:none"><h2>Failures</h2><div id="failure-list"></div></div>
  </div>
</div>

<div id="main">
  <div id="stats"></div>
  <canvas id="canvas"></canvas>
  <div id="legend">
    <div><span class="l-dot" style="background:#388bfd"></span>File node</div>
    <div><span class="l-dot" style="background:#3fb950"></span>Symbol node</div>
    <div><span class="l-dot" style="background:#f0a500"></span>Rin debt</div>
    <div><span class="l-dot" style="background:#f85149"></span>Failure hotspot</div>
  </div>
</div>

<div id="detail-panel">
  <button id="detail-close" title="Close">×</button>
  <div id="detail-body"><p class="muted">Click a node to inspect it.</p></div>
</div>

<script>
(function(){
'use strict';

// ── Tab switching ────────────────────────────────────────────────────────────
const PANELS = ['graph','rin','failures'];
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    PANELS.forEach(p => {
      document.getElementById('panel-'+p).style.display = (p === btn.dataset.tab) ? '' : 'none';
    });
  });
});

document.getElementById('detail-close').addEventListener('click', () => {
  document.getElementById('detail-panel').classList.remove('open');
  selectedNode = null;
});

// ── Escape ────────────────────────────────────────────────────────────────────
function esc(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// ── Data fetch ────────────────────────────────────────────────────────────────
let DATA = null;
let nodes = [], edges = [], selectedNode = null, filterText = '';

fetch('/api/data').then(r => r.json()).then(data => {
  DATA = data;
  renderSidebar(data);
  document.getElementById('stats').textContent =
    data.projectRoot + '  ·  ' + data.graph.nodes.length + ' nodes, ' + data.graph.edges.length + ' edges' +
    (data.truncatedNodes ? ' (top '+data.graph.nodes.length+' by degree)' : '') +
    '  ·  ' + new Date(data.generatedAt).toLocaleTimeString();
  initGraph(data.graph, data.rinByNode, data.failuresByNode);
});

function renderSidebar(data) {
  document.getElementById('node-list').innerHTML = data.graph.nodes
    .map(n => '<div class="item" data-id="'+esc(n.id)+'"><span class="badge '+esc(n.type)+'">'+esc(n.type)+'</span>'+esc(n.label)+'</div>')
    .join('') || '<div class="muted">No graph data — run jambavan_index first.</div>';
  document.querySelectorAll('#node-list .item').forEach(el => {
    el.addEventListener('click', () => openNodeDetail(el.dataset.id));
  });

  document.getElementById('rin-list').innerHTML = data.rin
    .map(m => '<div class="item">'+esc(m.file)+':'+m.line+'<br><span class="muted">'+esc(m.comment)+'</span>'+(m.hasUpgrade?'':' <span class="badge rin">no trigger</span>')+'</div>')
    .join('') || '<div class="muted">No rin markers.</div>';

  document.getElementById('failure-list').innerHTML = data.failures
    .map(f => '<div class="item"><span class="badge '+esc(f.status)+'">'+esc(f.status)+'</span>'+esc(f.title)+'<br><span class="muted">'+esc(f.timestamp.slice(0,10))+'</span></div>')
    .join('') || '<div class="muted">No failure records.</div>';
}

// ── Node detail panel ─────────────────────────────────────────────────────────
function openNodeDetail(id) {
  selectedNode = id;
  document.getElementById('detail-panel').classList.add('open');
  document.getElementById('detail-body').innerHTML = '<p class="muted">Loading…</p>';

  // Highlight in sidebar
  document.querySelectorAll('#node-list .item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
  });

  fetch('/api/node/'+encodeURIComponent(id)).then(r => r.json()).then(d => {
    if (!d || !d.id) { document.getElementById('detail-body').innerHTML = '<p class="muted">Node not found.</p>'; return; }

    const heatBadges =
      (d.rinCount     > 0 ? '<span class="heat-bar heat-rin"></span> '+d.rinCount+' rin marker'+(d.rinCount>1?'s':'') : '') +
      (d.failureCount > 0 ? (d.rinCount>0?' &nbsp; ':'')+'<span class="heat-bar heat-fail"></span> '+d.failureCount+' failure ref'+(d.failureCount>1?'s':'') : '');

    let html = '<div class="detail-section">'
      + '<h3><span class="badge '+esc(d.type)+'">'+esc(d.type)+'</span> '+esc(d.label)+'</h3>'
      + (d.filePath ? '<div class="muted">'+esc(d.filePath)+(d.line?':'+d.line:'')+'</div>' : '')
      + (heatBadges ? '<div style="margin-top:6px">'+heatBadges+'</div>' : '')
      + '</div>';

    if (d.callers.length > 0) {
      html += '<div class="detail-section"><h3>Callers ('+d.callers.length+')</h3>'
        + d.callers.map(c => '<span class="callee-link" onclick="openNodeByLabel('+JSON.stringify(c)+')">'+esc(c)+'</span> ').join('')
        + '</div>';
    }
    if (d.callees.length > 0) {
      html += '<div class="detail-section"><h3>Calls ('+d.callees.length+')</h3>'
        + d.callees.map(c => '<span class="callee-link" onclick="openNodeByLabel('+JSON.stringify(c)+')">'+esc(c)+'</span> ').join('')
        + '</div>';
    }
    if (d.snippet) {
      html += '<div class="detail-section"><h3>Source'+(d.line?' (L'+d.line+')':'')+'</h3>'
        + '<pre class="snippet">'+esc(d.snippet)+'</pre></div>';
    } else {
      html += '<div class="detail-section muted">No source preview available.</div>';
    }

    document.getElementById('detail-body').innerHTML = html;
  });
}

window.openNodeByLabel = function(label) {
  if (!DATA) return;
  const node = DATA.graph.nodes.find(n => n.label === label);
  if (node) openNodeDetail(node.id);
};

// ── Search filter ─────────────────────────────────────────────────────────────
document.getElementById('search').addEventListener('input', function() {
  filterText = this.value.toLowerCase().trim();
  if (!nodes.length) return;
  nodes.forEach(n => { n.hidden = filterText && !n.label.toLowerCase().includes(filterText); });
  requestDraw();
});

// ── Force-directed graph ──────────────────────────────────────────────────────
const canvas = document.getElementById('canvas');
const ctx    = canvas.getContext('2d');
let animating = false, zoom = 1, panX = 0, panY = 0;
let dragNode = null, dragOffX = 0, dragOffY = 0;
let isPanning = false, panStartX = 0, panStartY = 0, panOriginX = 0, panOriginY = 0;

function resize() {
  canvas.width  = canvas.clientWidth  * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
}
window.addEventListener('resize', () => { resize(); requestDraw(); });
resize();

function initGraph(graph, rinByNode, failuresByNode) {
  const W = canvas.clientWidth, H = canvas.clientHeight;
  nodes = graph.nodes.map(n => ({
    ...n,
    x:  W * 0.1 + Math.random() * W * 0.8,
    y:  H * 0.1 + Math.random() * H * 0.8,
    vx: 0, vy: 0,
    hidden: false,
    rin:     rinByNode[n.id]      ?? 0,
    failures: failuresByNode[n.id] ?? 0,
  }));
  const idxMap = new Map(nodes.map((n, i) => [n.id, i]));
  edges = graph.edges
    .map(e => ({ a: idxMap.get(e.from), b: idxMap.get(e.to), type: e.type }))
    .filter(e => e.a !== undefined && e.b !== undefined);

  if (!animating) { animating = true; requestAnimationFrame(tick); }
}

let simStep = 0;
function tick() {
  if (!nodes.length) { requestAnimationFrame(tick); return; }
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const cooling = Math.max(0, 1 - simStep / 180);
  simStep++;

  if (cooling > 0) {
    // Repulsion
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[j].x - nodes[i].x, dy = nodes[j].y - nodes[i].y;
        const d2 = Math.max(dx*dx + dy*dy, 1);
        const f  = 1800 / d2;
        nodes[i].vx -= f*dx; nodes[i].vy -= f*dy;
        nodes[j].vx += f*dx; nodes[j].vy += f*dy;
      }
    }
    // Spring edges
    for (const e of edges) {
      const a = nodes[e.a], b = nodes[e.b];
      const dx = b.x - a.x, dy = b.y - a.y;
      a.vx += dx * 0.012; a.vy += dy * 0.012;
      b.vx -= dx * 0.012; b.vy -= dy * 0.012;
    }
    // Gravity to centre
    for (const n of nodes) {
      n.vx += (W/2 - n.x) * 0.0008;
      n.vy += (H/2 - n.y) * 0.0008;
      n.vx *= 0.82; n.vy *= 0.82;
      n.x  += n.vx; n.y += n.vy;
      n.x = Math.max(18, Math.min(W - 18, n.x));
      n.y = Math.max(18, Math.min(H - 18, n.y));
    }
  }

  draw();
  requestAnimationFrame(tick);
}

function requestDraw() {
  requestAnimationFrame(draw);
}

function worldToCanvas(x, y) {
  return [(x + panX) * zoom, (y + panY) * zoom];
}

function draw() {
  const W = canvas.clientWidth, H = canvas.clientHeight;
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  ctx.translate(panX * zoom + (W/2)*(1-zoom), panY * zoom + (H/2)*(1-zoom));
  ctx.scale(zoom, zoom);
  ctx.translate(-W/2*(1-1/zoom), -H/2*(1-1/zoom));

  // Edges
  ctx.lineWidth = 0.6;
  for (const e of edges) {
    const a = nodes[e.a], b = nodes[e.b];
    if (a.hidden || b.hidden) continue;
    ctx.strokeStyle = 'rgba(139,148,158,0.18)';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }

  // Nodes
  for (const n of nodes) {
    if (n.hidden) continue;
    const isSelected = n.id === selectedNode;
    const hasFail = n.failures > 0;
    const hasRin  = n.rin > 0;

    // Radius: base + heat bump
    const r = (n.type === 'file' ? 5 : 3.5) + Math.min(n.failures * 1.5, 5) + Math.min(n.rin, 3);

    // Glow for heatmap
    if (hasFail) {
      ctx.save();
      ctx.beginPath(); ctx.arc(n.x, n.y, r + 5, 0, Math.PI*2);
      ctx.fillStyle = 'rgba(248,81,73,0.22)'; ctx.fill();
      ctx.restore();
    } else if (hasRin) {
      ctx.save();
      ctx.beginPath(); ctx.arc(n.x, n.y, r + 4, 0, Math.PI*2);
      ctx.fillStyle = 'rgba(240,165,0,0.22)'; ctx.fill();
      ctx.restore();
    }

    // Node fill
    let fill = n.type === 'file' ? '#388bfd' : '#3fb950';
    if (hasFail)    fill = '#f85149';
    else if (hasRin) fill = '#f0a500';

    ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI*2);
    ctx.fillStyle = fill;
    ctx.fill();

    if (isSelected) {
      ctx.lineWidth = 2; ctx.strokeStyle = '#fff';
      ctx.beginPath(); ctx.arc(n.x, n.y, r + 3, 0, Math.PI*2); ctx.stroke();
    }

    // Label — show when zoomed in or filter matches
    if (zoom > 1.4 || filterText) {
      const matched = !filterText || n.label.toLowerCase().includes(filterText);
      if (matched) {
        ctx.font = '10px -apple-system,sans-serif';
        ctx.fillStyle = '#c9d1d9';
        ctx.fillText(n.label, n.x + r + 3, n.y + 3);
      }
    }
  }

  ctx.restore();
}

// ── Pointer interactions ──────────────────────────────────────────────────────
function hitTest(cx, cy) {
  const W = canvas.clientWidth, H = canvas.clientHeight;
  // Invert the transform applied in draw()
  const ox = (cx - panX * zoom - (W/2)*(1-zoom)) / zoom + W/2*(1-1/zoom);
  const oy = (cy - panY * zoom - (H/2)*(1-zoom)) / zoom + H/2*(1-1/zoom);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.hidden) continue;
    const r = (n.type === 'file' ? 5 : 3.5) + Math.min(n.failures*1.5,5) + Math.min(n.rin,3) + 4;
    const dx = n.x - ox, dy = n.y - oy;
    if (dx*dx + dy*dy <= r*r) return i;
  }
  return -1;
}

function clientXY(e) {
  const rect = canvas.getBoundingClientRect();
  if (e.touches) return [e.touches[0].clientX - rect.left, e.touches[0].clientY - rect.top];
  return [e.clientX - rect.left, e.clientY - rect.top];
}

canvas.addEventListener('mousedown', e => {
  const [cx, cy] = clientXY(e);
  const idx = hitTest(cx, cy);
  if (idx >= 0) {
    dragNode = idx; canvas.classList.add('dragging');
    const n = nodes[idx];
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const ox = (cx - panX*zoom - (W/2)*(1-zoom)) / zoom + W/2*(1-1/zoom);
    const oy = (cy - panY*zoom - (H/2)*(1-zoom)) / zoom + H/2*(1-1/zoom);
    dragOffX = n.x - ox; dragOffY = n.y - oy;
  } else {
    isPanning = true;
    panStartX = e.clientX; panStartY = e.clientY;
    panOriginX = panX; panOriginY = panY;
    canvas.classList.add('dragging');
  }
});

canvas.addEventListener('mousemove', e => {
  if (dragNode !== null) {
    const [cx, cy] = clientXY(e);
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const ox = (cx - panX*zoom - (W/2)*(1-zoom)) / zoom + W/2*(1-1/zoom);
    const oy = (cy - panY*zoom - (H/2)*(1-zoom)) / zoom + H/2*(1-1/zoom);
    nodes[dragNode].x = ox + dragOffX;
    nodes[dragNode].y = oy + dragOffY;
    nodes[dragNode].vx = 0; nodes[dragNode].vy = 0;
  } else if (isPanning) {
    panX = panOriginX + (e.clientX - panStartX) / zoom;
    panY = panOriginY + (e.clientY - panStartY) / zoom;
    requestDraw();
  }
});

canvas.addEventListener('mouseup', e => {
  if (dragNode !== null) {
    // click = mousedown+mouseup on same node without significant drag
    const [cx, cy] = clientXY(e);
    const idx = hitTest(cx, cy);
    if (idx === dragNode) openNodeDetail(nodes[dragNode].id);
    dragNode = null;
  }
  isPanning = false;
  canvas.classList.remove('dragging');
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const delta = e.deltaY > 0 ? 0.85 : 1.18;
  zoom = Math.max(0.15, Math.min(6, zoom * delta));
  requestDraw();
}, { passive: false });

// Double-click to reset view
canvas.addEventListener('dblclick', () => { zoom = 1; panX = 0; panY = 0; simStep = 0; requestDraw(); });

})();
</script>
</body>
</html>
`;
