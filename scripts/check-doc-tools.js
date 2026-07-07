const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'src/mcp/server.ts'), 'utf8');
const architecture = fs.readFileSync(path.join(root, 'ARCHITECTURE.md'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const pluginJson = JSON.parse(fs.readFileSync(path.join(root, 'plugins/jambavan/.claude-plugin/plugin.json'), 'utf8'));

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
];
const defTools = [];
for (const f of defFiles) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  for (const m of src.matchAll(/name:\s*['"]([^'"]+)['"]/g)) {
    if (m[1].startsWith('jambavan_')) defTools.push(m[1]);
  }
}

const allJambavanTools = [...new Set([...nativeTools, ...defTools])].filter(n => n.startsWith('jambavan_'));

// --- 3. Check ARCHITECTURE.md documents every tool ---
const missingFromArch = allJambavanTools.filter(tool => !architecture.includes('`' + tool + '`'));
if (missingFromArch.length) {
  throw new Error(`ARCHITECTURE.md is missing MCP tools:\n  ${missingFromArch.join('\n  ')}`);
}

// --- 4. Check README.md documents every tool ---
const missingFromReadme = allJambavanTools.filter(tool => !readme.includes(tool));
if (missingFromReadme.length) {
  throw new Error(`README.md is missing MCP tools:\n  ${missingFromReadme.join('\n  ')}`);
}

// --- 5. Check plugin.json description enumerates every tool ---
const pluginDesc = pluginJson.description || '';
const missingFromPlugin = allJambavanTools.filter(tool => !pluginDesc.includes(tool));
if (missingFromPlugin.length) {
  throw new Error(`plugins/jambavan/.claude-plugin/plugin.json description is missing tools:\n  ${missingFromPlugin.join('\n  ')}`);
}

console.log(`docs-check: ${allJambavanTools.length} jambavan_ tools verified across ARCHITECTURE.md, README.md, and plugin.json`);
