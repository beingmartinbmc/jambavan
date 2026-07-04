/**
 * Context Assembler — packs the most relevant context into a token budget.
 *
 * "Hanuman carried only what was needed across the ocean.
 *  Not the whole forest — just the Sanjeevani."
 */

import { countTokens, truncateToTokenBudget } from './token-counter';
import { sankshiptaText } from '../tools/sankshipta';
import type { JambavanConfig } from '../config/jambavan.config';

export interface ContextChunk {
  filePath: string;
  content: string;
  score: number;       // relevance score (higher = more relevant)
  startLine?: number;
  endLine?: number;
  type: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'export' | 'file' | 'snippet';
}

export interface AssembledContext {
  contextBlock: string;   // the final string to inject into prompt
  usedTokens: number;
  includedChunks: number;
  droppedChunks: number;
}

export class ContextAssembler {
  constructor(private config: JambavanConfig) {}

  /**
   * Rank chunks by score, then pack greedily into token budget.
   * Each chunk gets a fair slice; high-score chunks get priority.
   * When compressProse is true, non-code content (comments, docstrings) is
   * compressed via sankshipta rules before budgeting.
   */
  assemble(chunks: ContextChunk[], opts: { compressProse?: boolean; budgetOverride?: number } = {}): AssembledContext {
    if (chunks.length === 0) {
      return { contextBlock: '', usedTokens: 0, includedChunks: 0, droppedChunks: 0 };
    }

    // Sort by relevance descending
    const sorted = [...chunks].sort((a, b) => b.score - a.score);

    const budget = opts.budgetOverride ?? this.config.contextTokenBudget;
    let usedTokens = 0;
    const included: ContextChunk[] = [];
    let dropped = 0;

    for (const chunk of sorted) {
      const content = opts.compressProse ? compressCodeComments(chunk.content) : chunk.content;
      const header = this.formatHeader(chunk);
      const chunkTokens = countTokens(header + content);

      if (usedTokens + chunkTokens <= budget) {
        included.push({ ...chunk, content });
        usedTokens += chunkTokens;
      } else {
        // Try truncating the chunk to fit remaining budget
        const remaining = budget - usedTokens;
        if (remaining > 100) { // at least 100 tokens worth including
          const truncated = truncateToTokenBudget(content, remaining - countTokens(header));
          if (truncated.length > 0) {
            included.push({ ...chunk, content: truncated });
            usedTokens = budget;
          }
        }
        dropped++;
        if (usedTokens >= budget) break;
      }
    }

    const contextBlock = this.formatContext(included);

    return {
      contextBlock,
      usedTokens,
      includedChunks: included.length,
      droppedChunks: dropped,
    };
  }

  private formatHeader(chunk: ContextChunk): string {
    const loc = chunk.startLine != null
      ? `:${chunk.startLine}-${chunk.endLine ?? chunk.startLine}`
      : '';
    return `### ${chunk.filePath}${loc} [${chunk.type}]\n`;
  }

  private formatContext(chunks: ContextChunk[]): string {
    if (chunks.length === 0) return '';

    return chunks
      .map(c => {
        const header = this.formatHeader(c);
        return `${header}\`\`\`\n${c.content}\n\`\`\``;
      })
      .join('\n\n');
  }
}

/**
 * Compress comments/docstrings in code content using sankshipta prose rules.
 * Preserves code lines verbatim; only compresses lines that look like comments.
 * // rin: heuristic comment detection; extend with per-language comment syntax if false positives appear.
 */
function compressCodeComments(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let inBlockComment = false;

  for (const line of lines) {
    const trimmed = line.trimStart();

    // Block comment start
    if (!inBlockComment && (trimmed.startsWith('/*') || trimmed.startsWith('/**'))) {
      inBlockComment = true;
      result.push(sankshiptaText(line));
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }

    // Block comment end
    if (inBlockComment) {
      result.push(sankshiptaText(line));
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }

    // Single-line comments: //, #, --
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('--')) {
      result.push(sankshiptaText(line));
      continue;
    }

    // Code line — keep verbatim
    result.push(line);
  }

  return result.join('\n');
}
