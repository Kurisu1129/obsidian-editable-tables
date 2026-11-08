import { computeFenceMask, frontMatterEnd } from './scan';

/** A contiguous blockquote, 0-indexed and inclusive. */
export interface QuoteBlock {
  startLine: number;
  endLine: number;
  /** Leading whitespace before the first `>`; stripped before rendering. */
  indent: string;
}

/** A line that belongs to a blockquote: optional indent, then `>`. */
const QUOTE_LINE_RE = /^[ \t]*>/;

/**
 * A callout marker at the start of a blockquote's first content line: `[!note] …`.
 * Any number of `>` prefixes may precede it (`> [!note]`, `> > [!note]`).
 *
 * Callouts are deliberately left to Obsidian. Taking one over would replace its native
 * interactive title/collapse/type UI with a static MarkdownRenderer copy — a regression,
 * not a fix. Editable tables *inside* callouts are a separate, deferred task (D6).
 */
const CALLOUT_MARK_RE = /^\[![^\]]+\]/;

/**
 * The content of a quote line with every `>` prefix removed, or `null` when the line is
 * not a quote line. `> > text` yields `text` (hoisted out of nested quotes), because for
 * lazy-continuation purposes the innermost content is what determines paragraph-ness.
 */
function quoteContent(line: string): string | null {
  const m = line.match(/^[ \t]*(?:>[ \t]?)+(.*)$/);
  return m ? m[1] : null;
}

/** Constructs that can start a block, and therefore cannot be a lazy paragraph line. */
const BLOCK_START_RE =
  /^(?:#{1,6}(?:\s|$)|```|~~~|>|<\/?[A-Za-z!]|\||(?:\*\s*){3,}$|(?:-\s*){3,}$|(?:_\s*){3,}$)/;

/**
 * True when a quote line's content is paragraph-like enough to absorb a lazy continuation.
 *
 * Lazy continuation only exists for paragraphs: `> foo` followed by `bar` continues the
 * quote, but `> ## heading` followed by `bar` does not. List items count as paragraph-like
 * because their text is a paragraph — `> - item` followed by `  continuation` is one quote
 * in Obsidian (`HyperMD-quote-lazy`), so it must stay one region here too.
 *
 * Being conservative here can at worst split one quote block into two (both render
 * correctly); being liberal can swallow a heading/list Obsidian renders outside the quote.
 */
function isParagraphQuoteLine(line: string): boolean {
  const content = quoteContent(line);
  if (content === null) return false;
  const text = content.trimStart();
  if (text.trim() === '') return false;
  return !BLOCK_START_RE.test(text);
}

/** True when the block's first non-empty content is a callout marker (`[!note]`). */
function startsWithCallout(lines: string[], start: number, end: number): boolean {
  for (let i = start; i <= end; i++) {
    const content = quoteContent(lines[i]);
    if (content === null || content.trim() === '') continue;
    return CALLOUT_MARK_RE.test(content.trimStart());
  }
  return false;
}

function leadingWhitespace(text: string): string {
  const m = text.match(/^[ \t]*/);
  return m ? m[0] : '';
}

/**
 * Locates contiguous blockquotes, given as raw lines.
 *
 * A block starts at a `>` line and ends at the last line that still belongs to it:
 * following `>` lines, blank `>` lines, and *lazy* continuation lines (non-blank lines
 * that continue a paragraph without repeating the `>`). A blank line without `>` ends the
 * block, as does any non-lazy block construct.
 *
 * Fenced code and front matter are excluded up front, so a `>` that happens to sit inside
 * them is never mistaken for a quote.
 */
export function scanQuoteLines(lines: string[]): QuoteBlock[] {
  const inFence = computeFenceMask(lines);
  const fmEnd = frontMatterEnd(lines);
  const excluded = (i: number): boolean => inFence[i] || (fmEnd >= 0 && i <= fmEnd);

  const blocks: QuoteBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    if (excluded(i) || !QUOTE_LINE_RE.test(lines[i])) {
      i++;
      continue;
    }

    const start = i;
    let end = i;
    let paragraph = isParagraphQuoteLine(lines[i]);

    while (end + 1 < lines.length && !excluded(end + 1)) {
      const next = lines[end + 1];

      if (QUOTE_LINE_RE.test(next)) {
        end++;
        paragraph = isParagraphQuoteLine(next);
        continue;
      }

      // A blank line without `>` closes the blockquote.
      if (next.trim() === '') break;

      // Lazy continuation: only a paragraph can continue without its `>`.
      //
      // Indentation is deliberately NOT required here. "Lazy" means the continuation may
      // be *less* indented than the quote — including a quote nested in a list item
      // followed by a line at column 0, which Obsidian itself marks `HyperMD-quote-lazy`
      // and renders inside the quote. Requiring the container indent would split one quote
      // into two and leave the second half shown as raw source.
      if (!paragraph) break;
      if (BLOCK_START_RE.test(next.trimStart())) break;

      end++;
    }

    // Callouts keep Obsidian's native widget (D6), whichever `>` depth the marker sits at.
    if (!startsWithCallout(lines, start, end)) {
      blocks.push({ startLine: start, endLine: end, indent: leadingWhitespace(lines[start]) });
    }

    i = end + 1;
  }

  return blocks;
}
