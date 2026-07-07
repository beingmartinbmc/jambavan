/**
 * jambavan gui — local, dependency-free visualizer.
 *
 * Serves a single static page (vanilla JS, no D3/React/build step) over
 * Node's built-in `http` module, backed by a `/api/data` JSON endpoint built
 * from data structures that already exist: the knowledge graph
 * (`buildSymbolGraph`), rin debt (`harvestRin`), and failure records
 * (`MemoryStore`). Binds to loopback only — never reachable off the machine.
 */

import * as http from 'http';
import { spawn } from 'child_process';
import type { JambavanConfig } from '../config/jambavan.config';
import type { JambavanIndex } from '../index/indexer';
import { buildSymbolGraph, type KnowledgeGraph } from '../knowledge/graph';
import { harvestRin } from './vibhishana-niti';
import { MemoryStore } from '../memory/store';
import { projectScope } from './jambavan';

export interface GuiFailure {
  title: string;
  status: string;
  timestamp: string;
}

export interface GuiData {
  projectRoot: string;
  generatedAt: string;
  graph: KnowledgeGraph;
  rin: { file: string; line: number; comment: string; hasUpgrade: boolean }[];
  failures: GuiFailure[];
  truncatedNodes: boolean;
}

// Keeps the payload and the browser-side force layout responsive without
// pulling in a canvas/WebGL charting dependency for very large graphs.
const MAX_GUI_NODES = 400;

export function buildGuiData(config: JambavanConfig, index: JambavanIndex): GuiData {
  const symbols = index.getAllSymbols(5000);
  const fullGraph = buildSymbolGraph(symbols, config, index.getAllReExports());

  const degree = new Map<string, number>();
  for (const e of fullGraph.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
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

  const scope = projectScope(config);
  const failures: GuiFailure[] = new MemoryStore(config.memoryDir)
    .list(scope)
    .filter(d => d.frontmatter.type === 'FailureRecord')
    .map(d => ({
      title: d.frontmatter.title,
      status: d.frontmatter.tags.find(t => ['unresolved', 'resolved', 'wontfix'].includes(t)) ?? 'unresolved',
      timestamp: d.frontmatter.timestamp,
    }))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return { projectRoot: config.projectRoot, generatedAt: new Date().toISOString(), graph, rin, failures, truncatedNodes };
}

export function startGuiServer(config: JambavanConfig, index: JambavanIndex, port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/data') {
      const data = buildGuiData(config, index);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(GUI_HTML);
  });
  server.listen(port, '127.0.0.1');
  return server;
}

/** Best-effort: open the user's default browser. Silently no-ops if it fails (e.g. headless CI). */
export function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, process.platform === 'win32' ? ['', url] : [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref();
  } catch {
    // Headless environment or no opener available — the printed URL is enough.
  }
}

const GUI_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Jambavan GUI</title>
<style>
  body { margin: 0; font: 13px -apple-system, sans-serif; background: #0f1115; color: #d8dee9; display: flex; height: 100vh; }
  #sidebar { width: 300px; overflow-y: auto; border-right: 1px solid #2a2e37; padding: 10px; box-sizing: border-box; }
  #main { flex: 1; position: relative; }
  canvas { width: 100%; height: 100%; display: block; }
  h2 { font-size: 13px; text-transform: uppercase; color: #7c8697; margin: 16px 0 6px; }
  button.tab { background: #1a1d24; color: #d8dee9; border: 1px solid #2a2e37; padding: 4px 10px; margin-right: 4px; cursor: pointer; border-radius: 4px; }
  button.tab.active { background: #3b6ea5; border-color: #3b6ea5; }
  .item { padding: 6px 4px; border-bottom: 1px solid #1e2129; font-size: 12px; word-break: break-all; }
  .muted { color: #7c8697; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; margin-right: 4px; }
  .badge.resolved { background: #2f6f4f; } .badge.unresolved { background: #7a3b3b; } .badge.wontfix { background: #4a4a4a; }
  #stats { position: absolute; top: 8px; left: 8px; font-size: 11px; color: #7c8697; pointer-events: none; }
</style>
</head>
<body>
  <div id="sidebar">
    <div>
      <button class="tab active" data-tab="graph">Graph</button>
      <button class="tab" data-tab="rin">Rin Debt</button>
      <button class="tab" data-tab="failures">Failures</button>
    </div>
    <div id="panel-graph"><h2>Nodes</h2><div id="node-list"></div></div>
    <div id="panel-rin" style="display:none"><h2>Rin Debt</h2><div id="rin-list"></div></div>
    <div id="panel-failures" style="display:none"><h2>Failures</h2><div id="failure-list"></div></div>
  </div>
  <div id="main">
    <div id="stats"></div>
    <canvas id="canvas"></canvas>
  </div>
<script>
const panels = ['graph', 'rin', 'failures'];
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    panels.forEach(p => { document.getElementById('panel-' + p).style.display = (p === btn.dataset.tab) ? '' : 'none'; });
  });
});

fetch('/api/data').then(r => r.json()).then(data => {
  document.getElementById('stats').textContent =
    data.projectRoot + ' — ' + data.graph.nodes.length + ' nodes, ' + data.graph.edges.length + ' edges' +
    (data.truncatedNodes ? ' (truncated to highest-degree nodes)' : '') + ' — generated ' + data.generatedAt;

  document.getElementById('node-list').innerHTML = data.graph.nodes
    .map(n => '<div class="item">' + n.type + ' · ' + esc(n.label) + '</div>').join('') || '<div class="muted">No graph data — run jambavan_index first.</div>';

  document.getElementById('rin-list').innerHTML = data.rin
    .map(m => '<div class="item">' + esc(m.file) + ':' + m.line + '<br><span class="muted">' + esc(m.comment) + '</span></div>').join('') || '<div class="muted">No rin markers.</div>';

  document.getElementById('failure-list').innerHTML = data.failures
    .map(f => '<div class="item"><span class="badge ' + f.status + '">' + f.status + '</span>' + esc(f.title) + '<br><span class="muted">' + f.timestamp + '</span></div>').join('') || '<div class="muted">No failure records.</div>';

  runForceLayout(data.graph);
});

function esc(s) { return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

// Minimal force-directed layout: spring edges + node repulsion, no dependency.
function runForceLayout(graph) {
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  function resize() { canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight; }
  window.addEventListener('resize', resize);
  resize();

  const nodes = graph.nodes.map(n => ({ ...n, x: Math.random() * canvas.width, y: Math.random() * canvas.height, vx: 0, vy: 0 }));
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  const edges = graph.edges.map(e => ({ a: idx.get(e.from), b: idx.get(e.to) })).filter(e => e.a !== undefined && e.b !== undefined);

  function tick() {
    const w = canvas.width, h = canvas.height;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[j].x - nodes[i].x, dy = nodes[j].y - nodes[i].y;
        const distSq = Math.max(dx * dx + dy * dy, 1);
        const force = 800 / distSq;
        const fx = force * dx, fy = force * dy;
        nodes[i].vx -= fx; nodes[i].vy -= fy;
        nodes[j].vx += fx; nodes[j].vy += fy;
      }
    }
    for (const e of edges) {
      const a = nodes[e.a], b = nodes[e.b];
      const dx = b.x - a.x, dy = b.y - a.y;
      a.vx += dx * 0.01; a.vy += dy * 0.01;
      b.vx -= dx * 0.01; b.vy -= dy * 0.01;
    }
    for (const n of nodes) {
      n.vx += (w / 2 - n.x) * 0.001; n.vy += (h / 2 - n.y) * 0.001; // gentle pull to center
      n.vx *= 0.85; n.vy *= 0.85;
      n.x += n.vx; n.y += n.vy;
      n.x = Math.max(10, Math.min(w - 10, n.x));
      n.y = Math.max(10, Math.min(h - 10, n.y));
    }

    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(124,134,151,0.25)';
    for (const e of edges) {
      const a = nodes[e.a], b = nodes[e.b];
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    for (const n of nodes) {
      ctx.fillStyle = n.type === 'file' ? '#3b6ea5' : '#5aa876';
      ctx.beginPath(); ctx.arc(n.x, n.y, n.type === 'file' ? 4 : 2.5, 0, Math.PI * 2); ctx.fill();
    }
    requestAnimationFrame(tick);
  }
  tick();
}
</script>
</body>
</html>
`;
