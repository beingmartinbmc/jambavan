/**
 * Token Counter — exact counts using js-tiktoken.
 *
 * Every token must earn its place.
 * We count before we send. No surprises.
 */

import { getEncoding } from 'js-tiktoken';

// cl100k_base works for all modern models (GPT-4, Claude approximation)
// For Claude, tiktoken gives ~95% accurate estimates
const enc = getEncoding('cl100k_base');

/**
 * Count tokens in a string.
 * Use sparingly — encoding is CPU-bound. Batch where possible.
 */
export function countTokens(text: string): number {
  return enc.encode(text).length;
}

/**
 * Count tokens across multiple strings.
 */
export function countTokensMany(texts: string[]): number {
  return texts.reduce((sum, t) => sum + countTokens(t), 0);
}

/**
 * Truncate text to fit within a token budget.
 * Truncates from the middle (keeps start + end) to preserve file structure.
 */
export function truncateToTokenBudget(text: string, maxTokens: number): string {
  const tokens = enc.encode(text);
  if (tokens.length <= maxTokens) return text;

  // Keep first 60% and last 40% of budget
  const keepStart = Math.floor(maxTokens * 0.6);
  const keepEnd   = maxTokens - keepStart;

  const startTokens = tokens.slice(0, keepStart);
  const endTokens   = tokens.slice(tokens.length - keepEnd);

  const startText = enc.decode(startTokens) as unknown as string;
  const endText   = enc.decode(endTokens)   as unknown as string;

  return `${startText}\n... [${tokens.length - maxTokens} tokens truncated] ...\n${endText}`;
}
