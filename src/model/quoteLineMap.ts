import { leadingWhitespace } from './scan';

/**
 * A quote line's `>` chain, including the optional single space after each `>`.
 * Matches the same shape the quote scanner uses for content extraction.
 */
const QUOTE_PREFIX_RE = /^[ \t]*(?:>[ \t]?)+/;

/** A line that carries at least one `>` of the quote chain. */
const QUOTE_LINE_RE = /^ {0,3}>/;

const BLANK_RE = /^[ \t]*$/;
const ATX_HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]+|$)/;
/** Opening fence: three or more backticks or tildes, up to three spaces in. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const THEMATIC_BREAK_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
/** Setext underline (`===` / `---`); after a paragraph it makes a heading. */
const SETEXT_RE = /^ {0,3}(?:=+|-+)[ \t]*$/;
/** List item marker; group 1 is indentation, group 2 the marker. */
const LIST_ITEM_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;
/** Only bullets and `1.` may interrupt a paragraph (CommonMark). */
const LIST_INTERRUPT_RE = /^ {0,3}(?:[-*+]|1[.)])(?:[ \t]+|$)/;
const HTML_TABLE_RE = /^ {0,3}<table\b/i;
const HTML_BLOCK_RE = /^ {0,3}<(?:!--|\/?[a-zA-Z][\w-]*(?:\s|>|\/))/;

/** Indentation width in columns; tabs count as four (approximation, deliberately simple). */
function indentWidth(whitespace: string): number {
  let width = 0;
  for (const ch of whitespace) width += ch === '\t' ? 4 - (width % 4) : 1;
  return width;
}

function isBlank(line: string): boolean {
  return BLANK_RE.test(line);
}

/**
 * A quote's source projected to the lines the renderer actually sees: the list
 * indentation and the `>` chain are removed, everything else is untouched.
 *
 * `innerTable.ts` needs the same projection to locate tables and the prefix each line
 * must reproduce, so both features share this one implementation.
 */
export interface QuoteProjection {
  /** Content lines, with indentation and `>` chains stripped. */
  lines: string[];
  /** Everything before each line's content (indent + `>` chain + leading whitespace). */
  prefixes: string[];
  /** Offset of each line's start inside the original `source`. */
  starts: number[];
  /** Whether the line carried a `>` chain (a lazy continuation does not). */
  quoted: boolean[];
  /** How many `>` the line carried: 1 for the quoted block itself, 2+ for a nested quote. */
  depths: number[];
}

export function projectQuoteLines(source: string, indent: string): QuoteProjection {
  const rawLines = source.split('\n');
  const lines: string[] = [];
  const prefixes: string[] = [];
  const starts: number[] = [];
  const quoted: boolean[] = [];
  const depths: number[] = [];

  let offset = 0;
  for (const raw of rawLines) {
    starts.push(offset);
    offset += raw.length + 1; // + the '\n' that separated it from the next line

    // Same rule as QuoteWidget's stripIndent(): remove the list item's indentation.
    const base = indent !== '' && raw.startsWith(indent) ? indent.length : 0;
    const rest = raw.slice(base);

    const m = rest.match(QUOTE_PREFIX_RE);
    if (!m) {
      // A lazy continuation line: rendered inside the quote, but with no prefix of its
      // own, so it can never anchor a rewrite (see `quoted`).
      lines.push(rest);
      prefixes.push(raw.slice(0, base));
      quoted.push(false);
      depths.push(0);
      continue;
    }

    const content = rest.slice(m[0].length);
    // Leading whitespace on the content line carries list nesting inside the quote.
    const lead = leadingWhitespace(content);
    lines.push(content);
    prefixes.push(raw.slice(0, base + m[0].length + lead.length));
    quoted.push(true);
    depths.push(countQuotes(m[0]));
  }

  return { lines, prefixes, starts, quoted, depths };
}

/** Number of `>` characters in a matched quote prefix. */
function countQuotes(prefix: string): number {
  let depth = 0;
  for (const ch of prefix) if (ch === '>') depth++;
  return depth;
}

export type QuoteBlockKind =
  | 'paragraph'
  | 'heading'
  | 'list'
  | 'code'
  | 'table'
  | 'blockquote'
  | 'hr'
  | 'html';

/** One top-level block the renderer produces inside a quote. */
export interface QuoteBlock {
  /** 0-based index into the projected content lines. */
  startLine: number;
  /** Inclusive. */
  endLine: number;
  kind: QuoteBlockKind;
  /** Only for `list`: start lines of the list's top-level items. */
  itemStarts: number[];
}

/**
 * Splits a quote's projected content into the top-level blocks the renderer will
 * produce, top to bottom.
 *
 * This mirrors CommonMark closely enough for its only consumer: mapping a click to a
 * source line. It is deliberately conservative — when a construct is ambiguous it may
 * split blocks differently from the renderer, which makes the counts disagree and the
 * caller fall back to the quote's first line instead of guessing.
 */
export function scanQuoteBlocks(lines: string[], depths?: number[]): QuoteBlock[] {
  const blocks: QuoteBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    // A line still carrying two or more `>` belongs to a nested blockquote. The
    // renderer emits it as one <blockquote> child, so the whole run is one block.
    if (depths && (depths[i] ?? 0) > 1) {
      const start = i;
      while (i < lines.length && (depths[i] ?? 0) > 1) i++;
      blocks.push({ startLine: start, endLine: i - 1, kind: 'blockquote', itemStarts: [] });
      continue;
    }

    if (FENCE_RE.test(line)) {
      i = scanFence(lines, i, blocks);
      continue;
    }

    if (ATX_HEADING_RE.test(line)) {
      blocks.push({ startLine: i, endLine: i, kind: 'heading', itemStarts: [] });
      i++;
      continue;
    }

    // A thematic break or setext underline outside a paragraph: it can only be a break.
    if (THEMATIC_BREAK_RE.test(line) || SETEXT_RE.test(line)) {
      blocks.push({ startLine: i, endLine: i, kind: 'hr', itemStarts: [] });
      i++;
      continue;
    }

    if (LIST_ITEM_RE.test(line)) {
      i = scanList(lines, i, blocks);
      continue;
    }

    // A nested quote: consecutive `>` lines, including empty `>` ones.
    if (QUOTE_LINE_RE.test(line)) {
      const start = i;
      while (i < lines.length && QUOTE_LINE_RE.test(lines[i])) i++;
      blocks.push({ startLine: start, endLine: i - 1, kind: 'blockquote', itemStarts: [] });
      continue;
    }

    if (HTML_TABLE_RE.test(line)) {
      const start = i;
      while (i < lines.length) {
        const closed = /<\/table\s*>/i.test(lines[i]);
        i++;
        if (closed) break;
      }
      blocks.push({ startLine: start, endLine: i - 1, kind: 'table', itemStarts: [] });
      continue;
    }

    if (HTML_BLOCK_RE.test(line)) {
      const start = i;
      // CommonMark's most common HTML blocks (types 6/7) run until a blank line.
      while (i < lines.length && !isBlank(lines[i])) i++;
      blocks.push({ startLine: start, endLine: i - 1, kind: 'html', itemStarts: [] });
      continue;
    }

    i = scanParagraph(lines, i, blocks);
  }

  return blocks;
}

function scanFence(lines: string[], start: number, blocks: QuoteBlock[]): number {
  const opener = lines[start].match(FENCE_RE)!;
  const fenceChar = opener[1][0];
  const fenceLen = opener[1].length;
  let i = start + 1;
  while (i < lines.length) {
    const m = lines[i].match(FENCE_RE);
    if (m && m[1][0] === fenceChar && m[1].length >= fenceLen && m[2].trim() === '') {
      i++;
      break;
    }
    i++;
  }
  blocks.push({ startLine: start, endLine: i - 1, kind: 'code', itemStarts: [] });
  return i;
}

function scanParagraph(lines: string[], start: number, blocks: QuoteBlock[]): number {
  let kind: QuoteBlockKind = 'paragraph';
  let i = start + 1;

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) break;
    // A setext underline belongs to this paragraph and turns it into a heading.
    if (SETEXT_RE.test(line)) {
      kind = 'heading';
      i++;
      break;
    }
    if (interruptsParagraph(line)) break;
    i++;
  }

  blocks.push({ startLine: start, endLine: i - 1, kind, itemStarts: [] });
  return i;
}

/** Whether a line ends the paragraph above it and starts a new block. */
function interruptsParagraph(line: string): boolean {
  return (
    ATX_HEADING_RE.test(line) ||
    FENCE_RE.test(line) ||
    QUOTE_LINE_RE.test(line) ||
    THEMATIC_BREAK_RE.test(line) ||
    LIST_INTERRUPT_RE.test(line) ||
    HTML_TABLE_RE.test(line) ||
    HTML_BLOCK_RE.test(line)
  );
}

function scanList(lines: string[], start: number, blocks: QuoteBlock[]): number {
  const first = lines[start].match(LIST_ITEM_RE)!;
  const baseIndent = indentWidth(first[1]);
  const itemStarts = [start];
  let i = start + 1;

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      let j = i + 1;
      while (j < lines.length && isBlank(lines[j])) j++;
      if (j >= lines.length) {
        i = j;
        break;
      }
      const next = lines[j];
      const nextIndent = indentWidth(leadingWhitespace(next));
      if (nextIndent >= baseIndent + 2 || LIST_ITEM_RE.test(next)) {
        // An indented continuation (possibly a nested list), or the next item after a
        // blank line — both keep the list going. The marker branch records the item.
        i = j;
        continue;
      }
      break;
    }

    const marker = line.match(LIST_ITEM_RE);
    if (marker) {
      const indent = indentWidth(marker[1]);
      if (indent <= baseIndent + 1) itemStarts.push(i);
      i++;
      continue;
    }

    const indent = indentWidth(leadingWhitespace(line));
    if (indent >= baseIndent + 2) {
      i++;
      continue;
    }

    // An unindented line right after an item is a lazy continuation of that item,
    // unless it starts a block of its own.
    if (
      ATX_HEADING_RE.test(line) ||
      FENCE_RE.test(line) ||
      QUOTE_LINE_RE.test(line) ||
      THEMATIC_BREAK_RE.test(line) ||
      HTML_TABLE_RE.test(line) ||
      HTML_BLOCK_RE.test(line)
    ) {
      break;
    }
    i++;
  }

  blocks.push({ startLine: start, endLine: i - 1, kind: 'list', itemStarts });
  return i;
}

/**
 * Maps a clicked rendered block to its line in the projected content.
 *
 * Returns `null` — meaning "keep the old behaviour, land on the quote's first line" —
 * when the mapping cannot be trusted: the renderer produced a different number of
 * top-level blocks than the scanner found, or the indices are out of range.
 */
export function resolveQuoteLine(
  blocks: QuoteBlock[],
  renderedCount: number,
  blockIndex: number,
  itemIndex?: number,
  itemCount?: number,
): number | null {
  if (renderedCount !== blocks.length) return null;
  if (!Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex >= blocks.length) {
    return null;
  }

  const block = blocks[blockIndex];
  if (
    block.kind === 'list' &&
    itemIndex !== undefined &&
    itemCount !== undefined &&
    Number.isInteger(itemIndex) &&
    itemIndex >= 0 &&
    itemIndex < itemCount &&
    itemCount === block.itemStarts.length
  ) {
    return block.itemStarts[itemIndex];
  }

  return block.startLine;
}
