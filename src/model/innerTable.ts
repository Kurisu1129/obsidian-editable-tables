import { scanTableLines } from './scan';
import { parsePipeTable } from './parsePipe';
import { parseHtmlTable } from './parseHtml';
import { projectQuoteLines } from './quoteLineMap';
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
  // The renderer sees the quote's source with the list indentation and `>` chains
  // stripped. `projectQuoteLines` is the single implementation of that projection.
  const { lines: contentLines, prefixes, starts, quoted } = projectQuoteLines(source, indent);

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
