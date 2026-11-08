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
  /** Leading whitespace of the first line — reproduced byte-for-byte on write-back. */
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
 * Rendering is read-only: the widget hands `source` to Obsidian's MarkdownRenderer.
 * There is deliberately no parsed model here, so a quote can never become a write path.
 */
export interface QuoteRegion extends RegionBase {
  kind: 'quote';
}

export type Region = TableRegion | QuoteRegion;
