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
  const budget = Number.isFinite(maxTokens) ? Math.max(0, Math.floor(maxTokens)) : 0;
  if (tokens.length <= budget) return text;
  if (budget === 0) return '';

  let retained = budget;
  while (retained >= 0) {
    const marker = `\n… [${tokens.length - retained} tokens truncated] …\n`;
    const keepStart = Math.floor(retained * 0.6);
    const keepEnd = retained - keepStart;
    const startText = enc.decode(tokens.slice(0, keepStart)) as unknown as string;
    const endText = enc.decode(tokens.slice(tokens.length - keepEnd)) as unknown as string;
    const result = `${startText}${marker}${endText}`;
    const overBudget = countTokens(result) - budget;
    if (overBudget <= 0) return result;
    retained -= Math.max(1, overBudget);
  }

  return countTokens('…') <= budget ? '…' : '';
}
