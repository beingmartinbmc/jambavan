const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'src/mcp/server.ts'), 'utf8');
const aliases = fs.readFileSync(path.join(root, 'src/mcp/tool-aliases.ts'), 'utf8');
const architecture = fs.readFileSync(path.join(root, 'ARCHITECTURE.md'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const pluginJson = JSON.parse(fs.readFileSync(path.join(root, 'plugins/jambavan/.claude-plugin/plugin.json'), 'utf8'));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const registryJson = JSON.parse(fs.readFileSync(path.join(root, 'server.json'), 'utf8'));

function markdownFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', '.jambavan', 'dist', 'node_modules'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...markdownFiles(full));
    else if (entry.name.endsWith('.md')) results.push(full);
  }
  return results;
}

const allMarkdownFiles = markdownFiles(root);
const allMarkdown = allMarkdownFiles
  .map(file => fs.readFileSync(file, 'utf8'))
  .join('\n');

// --- 1. All jambavan_ tool names from NATIVE_TOOLS in server.ts ---
const nativeToolsMatch = server.match(/const NATIVE_TOOLS: Tool\[\] = \[([\s\S]*?)\n\];/);
if (!nativeToolsMatch) throw new Error('Could not find NATIVE_TOOLS in src/mcp/server.ts');
const nativeTools = [...nativeToolsMatch[1].matchAll(/name:\s*'([^']+)'/g)].map(m => m[1]);

// --- 2. All jambavan_ tool names from the four spread def files ---
const defFiles = [
  'src/tools/memory.ts',
  'src/tools/failure-memory.ts',
  'src/tools/session-handoff.ts',
  'src/tools/review-pack.ts',
  'src/tools/impact.ts',
];
const defTools = [];
for (const f of defFiles) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  for (const m of src.matchAll(/name:\s*['"]([^'"]+)['"]/g)) {
    if (m[1].startsWith('jambavan_')) defTools.push(m[1]);
  }
}

const allJambavanTools = [...new Set([...nativeTools, ...defTools])].filter(n => n.startsWith('jambavan_'));
const aliasTools = [...aliases.matchAll(/^\s*([a-z][a-z0-9_]*):\s*'jambavan_[a-z0-9_]+'/gm)].map(m => m[1]);
const documentedTools = [...new Set([...allJambavanTools, ...aliasTools])];

// --- 3. Check ARCHITECTURE.md documents every tool ---
const missingFromArch = documentedTools.filter(tool => !architecture.includes('`' + tool + '`'));
if (missingFromArch.length) {
  throw new Error(`ARCHITECTURE.md is missing MCP tools:\n  ${missingFromArch.join('\n  ')}`);
}

// --- 4. Check README.md documents every tool ---
const missingFromReadme = documentedTools.filter(tool => !readme.includes(tool));
if (missingFromReadme.length) {
  throw new Error(`README.md is missing MCP tools:\n  ${missingFromReadme.join('\n  ')}`);
}

// --- 5. Check plugin.json description enumerates every tool ---
const pluginDesc = pluginJson.description || '';
const missingFromPlugin = documentedTools.filter(tool => !pluginDesc.includes(tool));
if (missingFromPlugin.length) {
  throw new Error(`plugins/jambavan/.claude-plugin/plugin.json description is missing tools:\n  ${missingFromPlugin.join('\n  ')}`);
}

// --- 6. Keep release and MCP Registry metadata aligned ---
const expectedMcpName = 'io.github.beingmartinbmc/jambavan';
const expectedNodeRange = '>=20.19.0 <27';
const versions = [
  ['package-lock.json', packageLock.version],
  ['package-lock.json root package', packageLock.packages?.['']?.version],
  ['plugin.json', pluginJson.version],
  ['server.json', registryJson.version],
  ['server.json npm package', registryJson.packages?.[0]?.version],
];
for (const [label, version] of versions) {
  if (version !== packageJson.version) {
    throw new Error(`${label} version ${version} does not match package.json ${packageJson.version}`);
  }
}
if (packageJson.mcpName !== expectedMcpName || registryJson.name !== expectedMcpName) {
  throw new Error(`package.json mcpName and server.json name must both be ${expectedMcpName}`);
}
if (registryJson.packages?.[0]?.identifier !== packageJson.name) {
  throw new Error('server.json npm identifier must match package.json name');
}
if (packageJson.engines?.node !== expectedNodeRange || packageLock.packages?.['']?.engines?.node !== expectedNodeRange) {
  throw new Error(`package.json and package-lock.json must require Node ${expectedNodeRange}`);
}
if (typeof registryJson.description !== 'string' || registryJson.description.length < 1 || registryJson.description.length > 100) {
  throw new Error('server.json description must be 1-100 characters');
}
const reviewExample = fs.readFileSync(path.join(root, 'examples/review-pack.md'), 'utf8');
if (!reviewExample.includes(`package_version: ${packageJson.version}`)) {
  throw new Error(`examples/review-pack.md package_version must match package.json ${packageJson.version}`);
}

// --- 7. Catch canonical repository and host-config drift on distribution surfaces ---
const surfaceFiles = [
  'README.md',
  'ARCHITECTURE.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'install.sh',
  'install.ps1',
  'package.json',
  'server.json',
  '.claude-plugin/marketplace.json',
  '.github/ISSUE_TEMPLATE/config.yml',
  'plugins/jambavan/.claude-plugin/plugin.json',
  'src/tools/doctor.ts',
  'src/tools/html-handoff.ts',
  ...fs.readdirSync(path.join(root, 'examples')).filter(f => f.endsWith('.md')).map(f => `examples/${f}`),
  ...fs.readdirSync(path.join(root, '.github/workflows')).filter(f => /\.ya?ml$/.test(f)).map(f => `.github/workflows/${f}`),
];
const wrongRepoLinks = [];
for (const file of surfaceFiles) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  for (const match of text.matchAll(/https:\/\/(?:github\.com|raw\.githubusercontent\.com)\/([^/\s)"']+)\/jambavan\b/g)) {
    if (match[1] !== 'beingmartinbmc') wrongRepoLinks.push(`${file}: ${match[0]}`);
  }
  for (const match of text.matchAll(/(?:marketplace add\s+|uses:\s*)([^/\s]+)\/jambavan\b/g)) {
    if (match[1] !== 'beingmartinbmc') wrongRepoLinks.push(`${file}: ${match[0]}`);
  }
}
if (wrongRepoLinks.length) {
  throw new Error(`Non-canonical Jambavan repository links:\n  ${wrongRepoLinks.join('\n  ')}`);
}

const docs = [readme, architecture, ...surfaceFiles
  .filter(file => file.startsWith('examples/'))
  .map(file => fs.readFileSync(path.join(root, file), 'utf8'))].join('\n');
const staleClaims = [
  ['Codex YAML config', /~\/\.codex\/config\.ya?ml/],
  ['deprecated Continue config.json', /~\/\.continue\/config\.json/],
  ['nonexistent bench subcommand', /\bnpx(?:\s+-y)?\s+jambavan\s+bench\b/],
  ['unsupported SSE transport', /\bstdio\s*\/\s*SSE\b/i],
  ['unsupported token-savings range', /\b44\s*[–-]\s*87%\b/],
  ['stale inferred name-mention edges', /INFERRED[^.\n]*name mention/i],
  ['unbounded caller claim', /\bfind all callers and callees\b/i],
  ['universal competitor claim', /\bevery existing AI coding tool\b/i],
  ['three failures prove architecture wrong', /\bSTOP\s*[—-]\s*the architecture is wrong\b/i],
  ['global read-only default claim', /\bread-only by default\b/i],
  ['failure immunity outcome guarantee', /\bfailure immunity\b/i],
  ['fact-preserving compression claim', /\bpreserv(?:e|es|ing)[^.\n]{0,80}\bfacts?\b/i],
];
for (const [label, pattern] of staleClaims) {
  if (pattern.test(allMarkdown)) throw new Error(`Documentation contains stale ${label} guidance`);
}
if (!docs.includes('[mcp_servers.jambavan]')) {
  throw new Error('Documentation must include the Codex config.toml [mcp_servers.jambavan] form');
}
if (!docs.includes('~/.continue/config.yaml')) {
  throw new Error('Documentation must include the current Continue config.yaml form');
}
if (!readme.includes('npm view jambavan version')) {
  throw new Error('README must document the supported current-version command');
}
if (!readme.includes(`Node ${expectedNodeRange}`)) {
  throw new Error(`README must document the package engine range: Node ${expectedNodeRange}`);
}

// --- 8. Every local Markdown/HTML link in Markdown must resolve ---
const brokenLinks = [];
for (const file of allMarkdownFiles) {
  const text = fs.readFileSync(file, 'utf8');
  const targets = [
    ...[...text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1]),
    ...[...text.matchAll(/<(?:a|img)\b[^>]*(?:href|src)="([^"]+)"/gi)].map(match => match[1]),
  ];
  for (const rawTarget of targets) {
    const target = rawTarget.trim().replace(/^<|>$/g, '').split(/\s+["']/)[0];
    if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue;
    const localPath = decodeURIComponent(target.split('#')[0]);
    if (!localPath) continue;
    const resolved = path.resolve(path.dirname(file), localPath);
    if (!fs.existsSync(resolved)) {
      brokenLinks.push(`${path.relative(root, file)} -> ${target}`);
    }
  }
}
if (brokenLinks.length) {
  throw new Error(`Broken local Markdown links:\n  ${brokenLinks.join('\n  ')}`);
}

const packageIncludes = target => packageJson.files.some(entry =>
  entry === target || target.startsWith(`${entry.replace(/\/$/, '')}/`));
for (const match of readme.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
  const target = match[1].trim().split('#')[0].replace(/^\.\//, '');
  if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
  if (!packageIncludes(target)) {
    throw new Error(`README local link ${target} is not in the npm payload; use a canonical absolute URL`);
  }
}

// README images rendered on npm must be present in the package payload.
for (const match of readme.matchAll(/<img\b[^>]*src="(\.\/assets\/[^"]+)"/gi)) {
  const asset = match[1].replace(/^\.\//, '');
  if (!packageJson.files.includes(asset)) {
    throw new Error(`README image ${asset} is missing from package.json files`);
  }
}

// Shipped SVGs must be valid XML text; control bytes make GitHub/npm renders fail.
for (const asset of packageJson.files.filter(file => file.endsWith('.svg'))) {
  const svg = fs.readFileSync(path.join(root, asset), 'utf8');
  const invalidControl = [...svg].find(char => {
    const code = char.charCodeAt(0);
    return code < 0x20 && char !== '\n' && char !== '\r' && char !== '\t';
  });
  if (!svg.trimStart().startsWith('<svg') || invalidControl !== undefined) {
    throw new Error(`Shipped SVG ${asset} is malformed or contains an XML-invalid control character`);
  }
}

// Keep the public demo readable, bounded, and aligned with current safety claims.
const demoSvg = fs.readFileSync(path.join(root, 'assets/30-second-demo.svg'), 'utf8');
for (const expected of [
  'jambavan_awaken',
  'jambavan_context',
  'jambavan_impact',
  'jambavan_review_pack',
  'source mutation and shell off by default',
]) {
  if (!demoSvg.includes(expected)) throw new Error(`Demo SVG is missing current claim: ${expected}`);
}
if (/\$\s+jambavan_(?:awaken|context|impact|review_pack)/.test(demoSvg) || demoSvg.includes('writes off')) {
  throw new Error('Demo SVG presents MCP tools as shell commands or contains stale safety wording');
}
if (!readme.includes('Illustrative storyboard; exact output depends on the repository, host, and enabled tools.')) {
  throw new Error('README must label the demo as illustrative');
}

const demoGif = fs.readFileSync(path.join(root, 'assets/30-second-demo.gif'));
if (demoGif.subarray(0, 6).toString('ascii') !== 'GIF89a'
    || demoGif.readUInt16LE(6) !== 1200
    || demoGif.readUInt16LE(8) !== 720) {
  throw new Error('Demo GIF must remain a 1200x720 GIF89a asset');
}
const frameDelays = [];
for (let i = 0; i <= demoGif.length - 8; i++) {
  if (demoGif[i] === 0x21 && demoGif[i + 1] === 0xf9 && demoGif[i + 2] === 0x04) {
    frameDelays.push(demoGif.readUInt16LE(i + 4));
  }
}
const totalDelay = frameDelays.reduce((sum, delay) => sum + delay, 0);
if (frameDelays.length !== 6 || frameDelays.some(delay => delay < 200)
    || totalDelay < 1500 || totalDelay > 3000) {
  throw new Error('Demo GIF must contain six readable frames and run for 15-30 seconds');
}

const reviewWorkflow = fs.readFileSync(path.join(root, '.github/workflows/jambavan-review.yml'), 'utf8');
if (!reviewWorkflow.includes('workflow_call:')
    || !reviewWorkflow.includes('package_version:')
    || !reviewWorkflow.includes('npx --yes "jambavan@$PACKAGE_VERSION" review-pack')) {
  throw new Error('Jambavan review workflow must remain reusable and support a validated published-package pin');
}

console.log(`docs-check: ${allMarkdownFiles.length} Markdown files, ${documentedTools.length} Jambavan/alias tools, links, claims, release metadata, and package assets verified`);
