import * as fs from 'fs';
import type { JambavanConfig } from '../config/jambavan.config';
import { countTokens } from '../context/token-counter';
import { resolveInsideRoot, projectRelative } from './path-guard';

const PROTECTED = /(`[^`]*`|https?:\/\/[^\s)]+|(?:\.{0,2}\/|~\/|[A-Za-z]:\\)[^\s)]+|[\w./-]+\.[A-Za-z0-9]{1,8}\b|v?\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?|[A-Z][A-Z0-9_]{2,})/g;

const PHRASES: Array<[RegExp, string]> = [
  [/\bplease\b/gi, ''],
  [/\bmake sure to\b/gi, ''],
  [/\byou should\b/gi, ''],
  [/\byou need to\b/gi, ''],
  [/\bit is important to\b/gi, ''],
  [/\bin order to\b/gi, 'to'],
  [/\bdue to the fact that\b/gi, 'because'],
  [/\bat this point in time\b/gi, 'now'],
  [/\bfor the purpose of\b/gi, 'for'],
  [/\bthe ability to\b/gi, 'can'],
  [/\butilize\b/gi, 'use'],
  [/\bapproximately\b/gi, '~'],
  [/\badditional\b/gi, 'more'],
  [/\bcurrently\b/gi, 'now'],
  [/\btherefore\b/gi, 'so'],
  [/\bhowever\b/gi, 'but'],
  [/\bbecause\b/gi, 'bc'],
  [/\bwithout\b/gi, 'w/o'],
  [/\bwith\b/gi, 'w/'],
  [/\band\b/gi, '&'],
  [/\bthat\b/gi, ''],
  [/\b(the|a|an)\b/gi, ''],
  [/\b(just|very|really|actually|basically|simply|probably|maybe|perhaps|kind of|sort of)\b/gi, ''],
];

function sankshiptaProse(text: string): string {
  const lead = text.match(/^\s*/)?.[0] ?? '';
  const trail = text.match(/\s*$/)?.[0] ?? '';
  let body = text.slice(lead.length, text.length - trail.length);
  if (!body.trim()) return text;

  for (const [from, to] of PHRASES) body = body.replace(from, to);
  body = body
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;:!?])\1+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+-\s+/g, ' — ')
    .trim();

  return body ? lead + body + trail : '';
}

function sankshiptaLine(line: string): string {
  const chunks: string[] = [];
  let last = 0;
  line.replace(PROTECTED, (match, _group, offset: number) => {
    chunks.push(sankshiptaProse(line.slice(last, offset)), match);
    last = offset + match.length;
    return match;
  });
  chunks.push(sankshiptaProse(line.slice(last)));
  return chunks.join('');
}

export function sankshiptaText(raw: string): string {
  const parts = raw.split(/(\r?\n)/);
  const out: string[] = [];
  let inFence = false;
  let frontmatter = raw.startsWith('---\n') || raw.startsWith('---\r\n');
  let frontmatterLine = 0;

  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i];
    const eol = parts[i + 1] ?? '';

    if (frontmatter) {
      out.push(line, eol);
      frontmatterLine++;
      if (frontmatterLine > 1 && line.trim() === '---') frontmatter = false;
      continue;
    }

    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line, eol);
      continue;
    }

    out.push(inFence ? line : sankshiptaLine(line), eol);
  }

  return out.join('');
}

export function sankshiptaFile(input: Record<string, unknown>, config: JambavanConfig): string {
  const filePath = resolveInsideRoot(String(input['path'] ?? ''), config);
  const inPlace = input['in_place'] === undefined ? true : Boolean(input['in_place']);
  const backup = input['backup'] === undefined ? true : Boolean(input['backup']);
  const raw = fs.readFileSync(filePath, 'utf-8');
  // rin: deterministic prose rules only; add LLM retry loop if users need semantic compression.
  const compressed = sankshiptaText(raw);
  const before = countTokens(raw);
  const after = countTokens(compressed);
  const saved = before - after;
  const pct = before ? Math.round((saved / before) * 100) : 0;
  const rel = projectRelative(filePath, config);

  if (!inPlace) {
    return [`# Jambavan Sankshipta: ${rel}`, `Tokens: ${before} → ${after} (${saved} saved, ${pct}%)`, '', compressed].join('\n');
  }

  let backupLine = 'Backup: skipped';
  if (backup) {
    const backupPath = `${filePath}.original.md`;
    if (!fs.existsSync(backupPath)) {
      fs.writeFileSync(backupPath, raw, 'utf-8');
      backupLine = `Backup: ${projectRelative(backupPath, config)}`;
    } else {
      backupLine = `Backup: ${projectRelative(backupPath, config)} (already existed)`;
    }
  }

  fs.writeFileSync(filePath, compressed, 'utf-8');
  return [`# Jambavan Sankshipta: ${rel}`, `Tokens: ${before} → ${after} (${saved} saved, ${pct}%)`, backupLine].join('\n');
}
