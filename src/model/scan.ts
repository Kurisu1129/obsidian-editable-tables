import type { TableBlock } from './types';

/**
 * Locates table blocks in a document, given as raw lines.
 *
 * Deliberately line-based rather than relying on CodeMirror's syntax tree:
 * Obsidian's Live Preview fails to recognise tables nested inside list items
 * (verified empirically — see research/spike-cdp-findings.md), which is precisely
 * the case this plugin exists to fix.
 *
 * Pipe tables are anchored on their delimiter row (`| --- |`), which avoids
 * false positives on prose that merely contains a `|`.
 */

const DELIM_CELL_RE = /^\s*:?-+:?\s*$/;

function isDelimiterRow(text: string): boolean {
  const t = text.trim();
  if (!t.includes('-')) return false;
  // A delimiter row must actually look like a pipe-table row. A bare `---` satisfies the
  // one-cell grammar, so without this check YAML front-matter fences, thematic breaks and
  // setext underlines all parse as tables — and any edit would rewrite them as HTML,
  // silently destroying front matter.
  if (!t.includes('|')) return false;
  let body = t;
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|')) body = body.slice(0, -1);
  if (body.trim() === '') return false;
  return body.split('|').every((c) => DELIM_CELL_RE.test(c));
}

/** Index of the closing front-matter fence, or -1 when the document has no front matter. */
function frontMatterEnd(lines: string[]): number {
  if (lines.length === 0 || lines[0].trim() !== '---') return -1;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '---' || t === '...') return i;
  }
  return -1;
}

function isDataRow(text: string): boolean {
  const t = text.trim();
  return t !== '' && t.includes('|');
}

/**
 * Whether a row opens and closes with a pipe.
 *
 * Obsidian ends a table at the first row whose pipe shape differs from the header's
 * (verified at runtime): a table whose header is `| a | b |` does NOT absorb a following
 * `1 | 2`, while one whose header is `a | b` does. Without this check a paragraph that
 * merely mentions a pipe — `Use \`x | y\` for a pipe.` — is swallowed, rendered as a row,
 * and rewritten as `<td>` on the first edit.
 */
interface RowShape {
  lead: boolean;
  trail: boolean;
}

function shapeOf(text: string): RowShape {
  const t = text.trim();
  return { lead: t.startsWith('|'), trail: t.endsWith('|') };
}

function sameShape(a: RowShape, b: RowShape): boolean {
  return a.lead === b.lead && a.trail === b.trail;
}

function isHtmlTableStart(text: string): boolean {
  return /^\s*<table[\s>]/i.test(text);
}

function isHtmlTableEnd(text: string): boolean {
  return /<\/table>/i.test(text);
}

/** Marks lines that sit inside a fenced code block so they are never treated as tables. */
function computeFenceMask(lines: string[]): boolean[] {
  const mask: boolean[] = new Array(lines.length).fill(false);
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(```+|~~~+)/);
    if (m) {
      if (fence === null) {
        fence = m[1][0];
        mask[i] = true;
        continue;
      }
      if (m[1][0] === fence) {
        fence = null;
        mask[i] = true;
        continue;
      }
    }
    mask[i] = fence !== null;
  }
  return mask;
}

function leadingWhitespace(text: string): string {
  const m = text.match(/^[ \t]*/);
  return m ? m[0] : '';
}

export function scanTableLines(lines: string[]): TableBlock[] {
  const blocks: TableBlock[] = [];
  const inFence = computeFenceMask(lines);
  const fmEnd = frontMatterEnd(lines);

  /** Lines the scanner must never interpret as table content. */
  const excluded = (i: number): boolean => inFence[i] || (fmEnd >= 0 && i <= fmEnd);

  // --- HTML tables: <table ...> ... </table> ---
  for (let i = 0; i < lines.length; i++) {
    if (excluded(i) || !isHtmlTableStart(lines[i])) continue;
    let end = i;
    while (end < lines.length && !isHtmlTableEnd(lines[end])) end++;
    if (end >= lines.length) continue; // unterminated — refuse to guess
    blocks.push({
      startLine: i,
      endLine: end,
      indent: leadingWhitespace(lines[i]),
      kind: 'html',
    });
    i = end;
  }

  // --- Pipe tables: anchored on the delimiter row ---
  for (let i = 1; i < lines.length; i++) {
    if (excluded(i) || excluded(i - 1)) continue;
    if (!isDelimiterRow(lines[i])) continue;
    if (!isDataRow(lines[i - 1])) continue; // a delimiter row needs a header above it.

    const headerShape = shapeOf(lines[i - 1]);
    if (!sameShape(headerShape, shapeOf(lines[i]))) continue; // delimiter must match the header

    let end = i;
    while (
      end + 1 < lines.length &&
      !excluded(end + 1) &&
      isDataRow(lines[end + 1]) &&
      sameShape(headerShape, shapeOf(lines[end + 1]))
    ) {
      end++;
    }

    const start = i - 1;
    blocks.push({
      startLine: start,
      endLine: end,
      indent: leadingWhitespace(lines[start]),
      kind: 'pipe',
    });
    i = end;
  }

  blocks.sort((a, b) => a.startLine - b.startLine);
  return blocks;
}
