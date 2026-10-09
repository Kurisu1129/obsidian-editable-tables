import type { TableGrid, TableKind } from '../model/types';

/** A table block resolved to concrete document offsets, ready to render or replace. */
export interface TableRegion {
  /** Document offset of the first character of the block's first line. */
  from: number;
  /** Document offset of the end of the block's last line. */
  to: number;
  /** Leading whitespace of the first line — reproduced byte-for-byte on write-back. */
  indent: string;
  kind: TableKind;
  grid: TableGrid;
  /** Exact source text of the block, used as the widget's equality key. */
  source: string;
}
