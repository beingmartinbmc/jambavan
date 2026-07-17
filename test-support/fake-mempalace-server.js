#!/usr/bin/env node
const fs = require('node:fs');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const required = [
  'mempalace_search',
  'mempalace_get_drawer',
  'mempalace_list_drawers',
  'mempalace_get_taxonomy',
  'mempalace_status',
];
const mode = process.env.MEMPALACE_FAKE_MODE || 'normal';
const server = new Server({ name: 'fake-mempalace', version: '3.5.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: (mode === 'missing' ? required.slice(0, -1) : required).map(name => ({
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
  })),
}));

function payload(name, args) {
  if (name === 'mempalace_search') return {
    results: [{ text: args.query === 'env' ? `secret=${process.env.SECRET_THING || 'absent'}` : `found ${args.query}`, wing: args.wing || 'project', room: args.room || 'general', source_file: 'notes.md', similarity: 0.91 }],
  };
  if (name === 'mempalace_get_drawer') {
    if (args.drawer_id === 'missing') return { error: 'Drawer not found: missing' };
    return { drawer_id: args.drawer_id, wing: 'project', room: 'general', content: 'full drawer content' };
  }
  if (name === 'mempalace_list_drawers') return {
    drawers: [{ drawer_id: 'drawer-1', wing: args.wing || 'project', room: args.room || 'general', content_preview: 'drawer preview' }],
    total: 1,
    count: 1,
  };
  if (name === 'mempalace_get_taxonomy') return { taxonomy: { project: { general: 1 } } };
  if (name === 'mempalace_status') return { total_drawers: 1, wings: { project: 1 }, rooms: { general: 1 } };
  return { error: 'unknown tool' };
}

server.setRequestHandler(CallToolRequestSchema, async request => {
  if (mode === 'timeout') return new Promise(() => {});
  if (mode === 'malformed') return { content: [{ type: 'text', text: '{' }] };
  if (mode === 'malformed-shape') return { content: [{ type: 'text', text: '{}' }] };
  if (mode === 'reconnect' && request.params.name === 'mempalace_search') {
    const stateFile = process.env.MEMPALACE_FAKE_STATE_FILE;
    if (stateFile && !fs.existsSync(stateFile)) {
      fs.writeFileSync(stateFile, 'closed once');
      setImmediate(() => process.exit(0));
      return new Promise(() => {});
    }
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(payload(request.params.name, request.params.arguments || {})) }],
  };
});

server.connect(new StdioServerTransport()).catch(() => process.exit(1));
