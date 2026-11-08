import type { TableGrid, TableKind } from '../model/types';

/** What a rendered block *is*. The discriminator of the region union. */
export type RegionKind = 'table' | 'quote';

/** Fields every rendered block shares. */
interface RegionBase {
  kind: RegionKind;
  /** Document offset of the first character of the block's first line. */
  from: number;
  /** Document offset of the end of the block's last line. */
  to: number;
  /**
   * The line prefix reproduced byte-for-byte on write-back. For a top-level table it is
   * leading whitespace; for a table inside a quote it is the whole prefix up to the
   * table's Markdown content (`> `, `  > `, `> > `, `>   `), so the rewrite stays inside
   * the same quote and list context.
   */
  indent: string;
  /** Exact source text of the block, used as the widget's equality key. */
  source: string;
}

export interface TableRegion extends RegionBase {
  kind: 'table';
  /** Storage flavour. `kind` is taken by the Region union, so this is `tableKind`. */
  tableKind: TableKind;
  grid: TableGrid;
}

/**
 * A contiguous blockquote, `>` prefix included.
 *
 * The quote's own text is read-only: the widget hands `source` to Obsidian's
 * MarkdownRenderer, and there is deliberately no parsed model of the quote itself, so the
 * quote can never become a write path. Tables the renderer produces inside it are the
 * exception: they get their own `TableRegion` (built relative to the quote's position)
 * and are written through the same `commitGrid` as any other table.
 */
export interface QuoteRegion extends RegionBase {
  kind: 'quote';
}

export type Region = TableRegion | QuoteRegion;
