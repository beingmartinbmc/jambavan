/**
 * PR handoff — inject the Phase-3 session handoff card into a local
 * `.github/pull_request_template.md` as an HTML-comment-bounded block.
 *
 * Pure string transform (no filesystem, no network) so it's independently
 * testable; `jambavan handoff --write-pr-template` (src/index.ts) does the I/O.
 */

export const HANDOFF_START = '<!-- jambavan:handoff:start -->';
export const HANDOFF_END = '<!-- jambavan:handoff:end -->';

export function buildHandoffBlock(handoffText: string): string {
  return [
    HANDOFF_START,
    '',
    '<details>',
    '<summary>Jambavan session handoff (auto-generated — safe to collapse)</summary>',
    '',
    handoffText.trim(),
    '',
    '</details>',
    '',
    HANDOFF_END,
  ].join('\n');
}

/**
 * Insert or replace the handoff block in an existing PR template.
 * Idempotent: re-running with fresh handoff text replaces the prior block
 * in place instead of duplicating it. Templates with no existing block get
 * the block appended; an empty/missing template becomes just the block.
 */
export function injectHandoffBlock(existingTemplate: string, handoffText: string): string {
  const block = buildHandoffBlock(handoffText);
  const markerRe = new RegExp(`${HANDOFF_START}[\\s\\S]*?${HANDOFF_END}`);
  if (markerRe.test(existingTemplate)) return existingTemplate.replace(markerRe, block);
  return existingTemplate.trim() ? `${existingTemplate.trimEnd()}\n\n${block}\n` : `${block}\n`;
}
