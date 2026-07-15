import type { Symbol } from '../index/ast-parser';

export interface ChangedRange {
  start: number;
  end: number;
}

export interface ChangedFile {
  status: string;
  path: string;
  oldPath?: string;
  ranges: ChangedRange[];
  /** Old-side (merge-base) changed ranges — for attributing deleted symbols. */
  oldRanges?: ChangedRange[];
}

function decodeGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;

  const bytes: number[] = [];
  const quoted = value.slice(1, -1);
  const escapes: Record<string, number> = {
    a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92,
  };
  for (let i = 0; i < quoted.length; i++) {
    if (quoted[i] !== '\\') {
      bytes.push(...Buffer.from(quoted[i]));
      continue;
    }
    const next = quoted[++i];
    if (next === undefined) break;
    if (/[0-7]/.test(next)) {
      let octal = next;
      while (octal.length < 3 && /[0-7]/.test(quoted[i + 1] ?? '')) octal += quoted[++i];
      bytes.push(Number.parseInt(octal, 8));
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

export function parseNameStatus(raw: string): ChangedFile[] {
  return raw.split('\n').filter(Boolean).map(line => {
    const [status, first, second] = line.split('\t');
    if (status.startsWith('R') || status.startsWith('C')) {
      return { status, oldPath: decodeGitPath(first), path: decodeGitPath(second), ranges: [] };
    }
    return { status, path: decodeGitPath(first), ranges: [] };
  }).filter(file => Boolean(file.path));
}

export function parseChangedRanges(raw: string): Map<string, ChangedRange[]> {
  const ranges = new Map<string, ChangedRange[]>();
  let currentPath: string | undefined;
  for (const line of raw.split('\n')) {
    if (line.startsWith('+++ ')) {
      const value = decodeGitPath(line.slice(4));
      currentPath = value === '/dev/null' ? undefined : value.replace(/^b\//, '');
      continue;
    }
    if (!currentPath || !line.startsWith('@@ ')) continue;
    const match = /\+(\d+)(?:,(\d+))?/.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    // count === 0 is a pure deletion: no surviving new-side lines to intersect a
    // HEAD symbol. Deletions are attributed on the *old* side (parseOldRanges +
    // analyzeFileChange), never by guessing a new-side anchor, which previously
    // mis-tagged whatever HEAD symbol happened to sit at the deletion point.
    if (count === 0) continue;
    const fileRanges = ranges.get(currentPath) ?? [];
    fileRanges.push({ start, end: start + count - 1 });
    ranges.set(currentPath, fileRanges);
  }
  return ranges;
}

/**
 * Old-side (pre-image) changed line ranges, keyed by the `--- a/<path>` header.
 * These index into the *merge-base* version of the file, so they can attribute
 * symbols that were modified in place or fully deleted (and thus no longer exist
 * on the HEAD side at all). A new file's old side is /dev/null and is skipped.
 */
export function parseOldRanges(raw: string): Map<string, ChangedRange[]> {
  const ranges = new Map<string, ChangedRange[]>();
  let currentPath: string | undefined;
  for (const line of raw.split('\n')) {
    if (line.startsWith('--- ')) {
      const value = decodeGitPath(line.slice(4));
      currentPath = value === '/dev/null' ? undefined : value.replace(/^a\//, '');
      continue;
    }
    if (!currentPath || !line.startsWith('@@ ')) continue;
    const match = /-(\d+)(?:,(\d+))?/.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count === 0) continue; // pure addition: nothing removed on the old side
    const fileRanges = ranges.get(currentPath) ?? [];
    fileRanges.push({ start, end: start + count - 1 });
    ranges.set(currentPath, fileRanges);
  }
  return ranges;
}

export function changedSymbols(symbols: Symbol[], ranges: ChangedRange[]): Symbol[] {
  if (ranges.length === 0) return [];
  return symbols.filter(symbol =>
    ranges.some(range => symbol.startLine <= range.end && symbol.endLine >= range.start),
  );
}

export interface FileChangeSymbols {
  /** Symbols present in HEAD that were touched (added or modified). */
  changed: Symbol[];
  /** Symbols present in the merge-base but gone from HEAD (fully deleted). */
  deleted: Symbol[];
}

/**
 * Attribute a file's diff to concrete symbols, correctly separating modified
 * from deleted.
 *
 *   • A HEAD symbol overlapping a new-side range → changed (added/modified).
 *   • A base symbol overlapping an old-side range that STILL exists in HEAD
 *     (by name) → changed — catches interior-only deletions that leave no
 *     new-side lines to intersect.
 *   • A base symbol overlapping an old-side range that is GONE from HEAD
 *     (by name) → deleted.
 *
 * Pure and independently testable: callers supply HEAD symbols (from the index),
 * base symbols (parsed from `git show <base>:<path>`), and both range sets.
 */
export function analyzeFileChange(
  headSymbols: Symbol[],
  baseSymbols: Symbol[],
  newRanges: ChangedRange[],
  oldRanges: ChangedRange[],
): FileChangeSymbols {
  const headByName = new Map<string, Symbol>();
  for (const s of headSymbols) if (!headByName.has(s.name)) headByName.set(s.name, s);

  const changed = new Map<string, Symbol>();
  for (const s of changedSymbols(headSymbols, newRanges)) changed.set(s.name, s);

  const deleted: Symbol[] = [];
  for (const baseSym of changedSymbols(baseSymbols, oldRanges)) {
    const survivor = headByName.get(baseSym.name);
    if (survivor) changed.set(survivor.name, survivor); // modified in place
    else deleted.push(baseSym);                         // fully removed
  }

  return { changed: [...changed.values()], deleted };
}
