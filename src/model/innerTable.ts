import { leadingWhitespace, scanTableLines } from './scan';
import { parsePipeTable } from './parsePipe';
import { parseHtmlTable } from './parseHtml';
import type { TableGrid, TableKind } from './types';

/**
 * A table found inside a blockquote's source, ready to be upgraded into an editor.
 *
 * Everything is expressed relative to the quote's own `source` string, so the plan stays
 * valid when the whole quote shifts in the document: the widget resolves its current
 * position from the DOM and adds these offsets back.
 */
export interface InnerTablePlan {
  /** Offset of the table's first line inside the quote's source. */
  relFrom: number;
  /** Offset just past the table's last line inside the quote's source. */
  relTo: number;
  /**
   * The string every serialized line must be prefixed with: the `>` chain plus any
   * indentation that carries list nesting (`> `, `  > `, `> > `, `>   `).
   */
  prefix: string;
  tableKind: TableKind;
  grid: TableGrid;
  /** The table's exact original source, prefixes included. */
  source: string;
}

/**
 * A quote line's `>` chain, including the optional single space after each `>`.
 * Matches the same shape the quote scanner uses for content extraction.
 */
const QUOTE_PREFIX_RE = /^[ \t]*(?:>[ \t]?)+/;

/**
 * Locates tables inside a rendered blockquote.
 *
 * The renderer sees the quote's source with the list indentation stripped; its
 * blockquote content is then everything after the `>` chain. Scanning that projection
 * gives exactly the tables the renderer produced, in source order.
 *
 * Returns an empty array — meaning "upgrade nothing" — whenever any table cannot be
 * rewritten safely. Pairing rendered `<table>` elements with plans by order is only
 * sound if the plan list is complete, so a single unsafe table disqualifies the whole
 * quote rather than being skipped silently.
 */
export function planInnerTables(source: string, indent: string): InnerTablePlan[] {
  const rawLines = source.split('\n');
  const contentLines: string[] = [];
  /** Prefix of each line: everything before its Markdown content. */
  const prefixes: string[] = [];
  /** Offset of each line's start inside `source`. */
  const starts: number[] = [];
  /** Whether the line actually carries a `>` chain (a lazy continuation does not). */
  const quoted: boolean[] = [];

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
      contentLines.push(rest);
      prefixes.push(raw.slice(0, base));
      quoted.push(false);
      continue;
    }

    const content = rest.slice(m[0].length);
    // Leading whitespace on the content line carries list nesting inside the quote
    // (`>   | a | b |` is a table inside a list item). Reproducing it is what keeps
    // the table owned by that item after the rewrite.
    const lead = leadingWhitespace(content);
    contentLines.push(content);
    prefixes.push(raw.slice(0, base + m[0].length + lead.length));
    quoted.push(true);
  }

  const plans: InnerTablePlan[] = [];
  for (const block of scanTableLines(contentLines)) {
    // Without a `>` prefix on the table's first line there is no prefix we could
    // reproduce, and emitting unprefixed HTML would pull the table out of the quote.
    if (!quoted[block.startLine]) return [];

    const blockLines = contentLines.slice(block.startLine, block.endLine + 1);
    const grid =
      block.tableKind === 'pipe' ? parsePipeTable(blockLines) : parseHtmlTable(blockLines);
    if (!grid) return [];

    const relFrom = starts[block.startLine];
    const relTo = starts[block.endLine] + rawLines[block.endLine].length;
    plans.push({
      relFrom,
      relTo,
      prefix: prefixes[block.startLine],
      tableKind: block.tableKind,
      grid,
      source: source.slice(relFrom, relTo),
    });
  }
  return plans;
}
