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
}

export interface DiffRange {
  oldStart: number;
  oldCount: number;
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
    const fileRanges = ranges.get(currentPath) ?? [];
    if (count === 0) {
      // Pure deletion: no surviving new-side lines. Encode the deletion point as
      // an inverted (zero-width) range {start+1 .. start}, so changedSymbols'
      // overlap test degrades to strict containment — it tags only a symbol that
      // still *encloses* the gap (an interior deletion), never a top-level
      // neighbour whose body was removed whole (start === 0 encloses nothing).
      fileRanges.push({ start: start + 1, end: start });
    } else {
      fileRanges.push({ start, end: start + count - 1 });
    }
    ranges.set(currentPath, fileRanges);
  }
  return ranges;
}

export function parseDiffRanges(raw: string): Map<string, DiffRange[]> {
  const ranges = new Map<string, DiffRange[]>();
  let currentPath: string | undefined;
  for (const line of raw.split('\n')) {
    if (line.startsWith('--- ')) {
      const value = decodeGitPath(line.slice(4));
      currentPath = value === '/dev/null' ? undefined : value.replace(/^a\//, '');
      continue;
    }
    if (!currentPath || !line.startsWith('@@ ')) continue;
    const match = /-(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?/.exec(line);
    if (!match) continue;
    const fileRanges = ranges.get(currentPath) ?? [];
    fileRanges.push({
      oldStart: Number(match[1]),
      oldCount: match[2] === undefined ? 1 : Number(match[2]),
    });
    ranges.set(currentPath, fileRanges);
  }
  return ranges;
}

export function deletedSymbols(symbols: Symbol[], ranges: DiffRange[], currentSymbols: Symbol[] = []): Symbol[] {
  const baseByKey = new Map<string, Symbol[]>();
  for (const symbol of symbols) {
    const key = `${symbol.name}\0${symbol.type}`;
    const group = baseByKey.get(key) ?? [];
    group.push(symbol);
    baseByKey.set(key, group);
  }
  const matchedBase = new Set<Symbol>();
  for (const current of currentSymbols) {
    const candidates = (baseByKey.get(`${current.name}\0${current.type}`) ?? [])
      .filter(symbol => !matchedBase.has(symbol));
    if (candidates.length === 0) continue;
    const exact = candidates.filter(symbol => symbol.content === current.content);
    const match = (exact.length > 0 ? exact : candidates)
      .sort((a, b) => Math.abs(a.startLine - current.startLine) - Math.abs(b.startLine - current.startLine))[0];
    matchedBase.add(match);
  }
  return symbols.filter(symbol => {
    if (matchedBase.has(symbol)) return false;
    return ranges.some(range => {
      if (range.oldCount === 0) return false;
      const rangeEnd = range.oldStart + range.oldCount - 1;
      if (symbol.startLine >= range.oldStart && symbol.endLine <= rangeEnd) return true;
      const overlapping = symbols.filter(candidate => candidate.startLine <= rangeEnd && candidate.endLine >= range.oldStart);
      const innermost = overlapping.filter(candidate => !overlapping.some(other => other !== candidate
        && other.startLine >= candidate.startLine
        && other.endLine <= candidate.endLine));
      return innermost.length === 1 && innermost[0] === symbol;
    });
  });
}

export function changedSymbols(symbols: Symbol[], ranges: ChangedRange[]): Symbol[] {
  if (ranges.length === 0) return [];
  return symbols.filter(symbol =>
    ranges.some(range => symbol.startLine <= range.end && symbol.endLine >= range.start),
  );
}
