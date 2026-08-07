/**
 * Deprecated tool-name resolution.
 *
 * Jambavan 2.0 renamed every Sanskrit tool to an English one and merged
 * several near-duplicate tools into single action-based tools. Old names are
 * still dispatched so pre-2.0 host configs, skills, and scripts keep working —
 * they are simply no longer advertised in tools/list.
 *
 * That distinction is the whole point: every advertised tool costs the host
 * model tokens on every single request, whether or not it is ever called.
 * Resolving a hidden name costs nothing until someone actually calls it.
 */

export interface AliasTarget {
  /** Canonical tool name that handles the call. */
  name: string;
  /**
   * Arguments implied by the old name that the merged tool cannot infer.
   * Caller-supplied arguments always win over these.
   */
  defaults?: Record<string, unknown>;
}

export const DEPRECATED_TOOLS: Record<string, AliasTarget> = {
  // ── Sanskrit names retired in 2.0 ──────────────────────────────────────────
  jambavan_mool_kaaran:     { name: 'jambavan_root_cause' },
  jambavan_praman:          { name: 'jambavan_verify_gate' },
  jambavan_yukti:           { name: 'jambavan_strategy_plan' },
  jambavan_vibhaajan:       { name: 'jambavan_decompose_task' },
  jambavan_vibhishana_niti: { name: 'jambavan_dev_rules' },
  jambavan_rin_mochan:      { name: 'jambavan_debt_ledger' },
  jambavan_sankshipta:      { name: 'jambavan_compress_prompt', defaults: { in_place: true } },

  // ── Pre-2.0 unprefixed functional aliases ──────────────────────────────────
  root_cause:      { name: 'jambavan_root_cause' },
  verify_gate:     { name: 'jambavan_verify_gate' },
  strategy_plan:   { name: 'jambavan_strategy_plan' },
  decompose_task:  { name: 'jambavan_decompose_task' },
  dev_rules:       { name: 'jambavan_dev_rules' },
  debt_ledger:     { name: 'jambavan_debt_ledger' },
  compress_prompt: { name: 'jambavan_compress_prompt', defaults: { in_place: true } },

  // ── Tools merged into action-based tools in 2.0 ────────────────────────────
  // graph/session/memory-read actions are inferable from the arguments the old
  // names already passed, so only the genuinely ambiguous ones carry defaults.
  jambavan_diagnostics:   { name: 'jambavan_doctor' },
  jambavan_graph_report:  { name: 'jambavan_graph', defaults: { action: 'report' } },
  jambavan_graph_query:   { name: 'jambavan_graph', defaults: { action: 'query' } },
  jambavan_graph_path:    { name: 'jambavan_graph', defaults: { action: 'path' } },
  jambavan_session_export: { name: 'jambavan_session_handoff', defaults: { action: 'export' } },
  jambavan_session_import: { name: 'jambavan_session_handoff', defaults: { action: 'import' } },
  jambavan_memory_get:    { name: 'jambavan_memory_read', defaults: { action: 'get' } },
  jambavan_memory_search: { name: 'jambavan_memory_read', defaults: { action: 'search' } },
  jambavan_memory_recall: { name: 'jambavan_memory_read', defaults: { action: 'recall' } },
  // Both old names take only `id`, so the mode cannot be inferred — it must be
  // pinned here or an invalidate would silently become a delete.
  jambavan_memory_invalidate: { name: 'jambavan_memory_forget', defaults: { mode: 'invalidate' } },
  jambavan_memory_delete:     { name: 'jambavan_memory_forget', defaults: { mode: 'delete' } },
};

/** Canonical tool name for a possibly-deprecated name. */
export function resolveToolAlias(name: string): string {
  return DEPRECATED_TOOLS[name]?.name ?? name;
}

/**
 * Canonical name plus the arguments a deprecated name implies.
 * Caller arguments override the implied defaults.
 */
export function resolveToolCall(
  name: string,
  args: Record<string, unknown>,
): { name: string; input: Record<string, unknown> } {
  const target = DEPRECATED_TOOLS[name];
  if (!target) return { name, input: args };
  return { name: target.name, input: { ...target.defaults, ...args } };
}

/** True when `name` is a retired name kept only for backwards compatibility. */
export function isDeprecatedTool(name: string): boolean {
  return name in DEPRECATED_TOOLS;
}
