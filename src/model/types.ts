/**
 * Core data model. Kept free of Obsidian / CodeMirror imports so it can be unit-tested
 * in plain Node (see tests/).
 */

export type Align = 'left' | 'center' | 'right' | 'default';

export interface Cell {
  /** Plain-text content, used for display and for serialization once the cell is edited. */
  text: string;
  /**
   * Original inner HTML of the cell, when the source was an HTML table and the cell has
   * not been edited. Serialization prefers this so untouched cells round-trip byte-for-byte
   * (R1) even when they contain inline markup that plain `text` cannot represent.
   * Cleared as soon as the user edits the cell.
   */
  raw?: string;
  /** Always >= 1. */
  rowSpan: number;
  /** Always >= 1. */
  colSpan: number;
  /** True for placeholder slots covered by a span anchored above/left. */
  covered: boolean;
}

export interface TableGrid {
  /** cells[row][col] — a dense rectangle. Covered slots hold placeholder cells. */
  cells: Cell[][];
  /** Per logical column alignment; length === column count. */
  colAlign: Align[];
  /** True when the source had a header row (first row renders as <th>). */
  hasHeader: boolean;
}

export type TableKind = 'pipe' | 'html';

export interface TableBlock {
  /** 0-indexed inclusive line range in the document. */
  startLine: number;
  endLine: number;
  /** Leading whitespace of the first line. MUST be reproduced byte-for-byte on write-back. */
  indent: string;
  kind: TableKind;
}

export function makeCell(text: string): Cell {
  return { text, rowSpan: 1, colSpan: 1, covered: false };
}
