import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const TOOL_ALIASES = {
  root_cause:      'jambavan_mool_kaaran',
  verify_gate:     'jambavan_praman',
  strategy_plan:   'jambavan_yukti',
  decompose_task:  'jambavan_vibhaajan',
  dev_rules:       'jambavan_vibhishana_niti',
  debt_ledger:     'jambavan_rin_mochan',
  compress_prompt: 'jambavan_sankshipta',
} as const satisfies Record<string, string>;

export function resolveToolAlias(name: string): string {
  return TOOL_ALIASES[name as keyof typeof TOOL_ALIASES] ?? name;
}

export function aliasToolsFor(tools: Tool[]): Tool[] {
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  return Object.entries(TOOL_ALIASES)
    .flatMap(([alias, canonical]) => {
      const tool = byName.get(canonical);
      if (!tool) return [];
      return [{
        ...tool,
        name: alias,
        description: `Functional alias for ${canonical}. ${tool.description ?? ''}`.trim(),
      }];
    });
}
