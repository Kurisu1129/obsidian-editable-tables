import { escapeHtml } from './html';
import type { Align, Cell, TableGrid } from './types';

function cellInner(cell: Cell): string {
  // Prefer the original markup so untouched cells round-trip byte-for-byte (R1).
  return cell.raw !== undefined ? cell.raw : escapeHtml(cell.text);
}

function attrs(cell: Cell, align: Align | undefined): string {
  const parts: string[] = [];
  if (cell.colSpan > 1) parts.push(` colspan="${cell.colSpan}"`);
  if (cell.rowSpan > 1) parts.push(` rowspan="${cell.rowSpan}"`);
  // `align` survives GitHub's sanitiser, unlike `style`. Emitted on header cells too,
  // so Reading view aligns the header exactly the way the widget does (R5).
  if (align && align !== 'default') parts.push(` align="${align}"`);
  return parts.join('');
}

/**
 * Renders a grid as an HTML <table>.
 *
 * Every emitted line is prefixed with `indent` so a table nested inside a list item
 * keeps its original indentation context (contract invariant 3 / AC2).
 *
 * Rows in the covered slots of a span are skipped, which is what makes the output
 * well-formed rather than repeating placeholders.
 */
export function serializeHtmlTable(grid: TableGrid, indent = ''): string[] {
  const lines: string[] = [];
  const rows = grid.cells;
  if (rows.length === 0) return lines;

  lines.push(`${indent}<table>`);
  const bodyIndent = `${indent}  `;

  for (let r = 0; r < rows.length; r++) {
    const isHeaderRow = r === 0 && grid.hasHeader;
    const cells: string[] = [];

    for (let c = 0; c < rows[r].length; c++) {
      const cell = rows[r][c];
      if (cell.covered) continue;
      const tag = isHeaderRow ? 'th' : 'td';
      cells.push(`<${tag}${attrs(cell, grid.colAlign[c])}>${cellInner(cell)}</${tag}>`);
    }

    lines.push(`${bodyIndent}<tr>${cells.join('')}</tr>`);
  }

  lines.push(`${indent}</table>`);
  return lines;
}

/** Serializes to a single string, newline-terminated, for tests and bulk use. */
export function serializeHtmlTableString(grid: TableGrid, indent = ''): string {
  return serializeHtmlTable(grid, indent).join('\n');
}
