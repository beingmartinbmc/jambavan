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
      // Pure deletion (git header e.g. `@@ -3 +2,0 @@`): no surviving new-side
      // lines, but `start` is the new-side line the removal sits *after*. Anchor
      // a range over that line and its successor so a deletion *inside or at the
      // leading edge of a symbol that still exists in HEAD* still intersects it.
      // Previously these hunks were dropped, so removing behavior from an existing
      // function reported no changed symbol.
      // rin: attributing a *fully deleted* symbol needs base-side parsing
      // (git show <base>:<path>); deferred to the 0.7 review-pack rework.
      const anchor = Math.max(1, start);
      fileRanges.push({ start: anchor, end: anchor + 1 });
      ranges.set(currentPath, fileRanges);
      continue;
    }
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
