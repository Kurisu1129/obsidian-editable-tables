import type { Align, TableGrid, TableKind } from './types';

/**
 * Whether every cell of `grid` can be represented losslessly as a GFM pipe table.
 *
 * Deliberately conservative. A false negative costs one HTML table; a false positive
 * would rewrite the user's data into a shape that no longer means the same thing.
 */
export function canSerializePipe(grid: TableGrid): boolean {
  if (!grid.hasHeader) return false; // A pipe table always has a header + delimiter row.

  const rows = grid.cells;
  if (rows.length === 0) return false;

  const width = rows[0].length;
  if (width === 0) return false;

  for (const row of rows) {
    if (row.length !== width) return false;
    for (const cell of row) {
      // Spans (and the placeholder slots they cover) have no pipe-table syntax.
      if (cell.covered || cell.rowSpan !== 1 || cell.colSpan !== 1) return false;

      const content = cell.raw !== undefined ? cell.raw : cell.text;
      // A cell is one source line by construction; a newline would split the row.
      if (/[\r\n]/.test(content)) return false;

      // `splitRow()` only understands `\|`; a backslash run before a pipe cannot be
      // round-tripped faithfully. Refuse instead of silently changing the text.
      if (/\\+\|/.test(content)) return false;

      // Raw HTML is copied into the cell verbatim. Escaping a pipe inside a tag or
      // attribute would corrupt the tag, so any pipe in raw markup disqualifies it.
      if (cell.raw !== undefined && cell.raw.includes('|')) return false;
    }
  }
  return true;
}

/** Escapes a cell's content so every `|` reads as text, not as a column separator. */
function escapeCell(content: string): string {
  // GFM escapes a literal pipe as `\|`. A backslash run before it must be doubled
  // first, otherwise `\|` (a literal backslash followed by a pipe) is misread.
  return content.replace(/(\\*)\|/g, (_match, backslashes: string) => {
    return backslashes + backslashes + '\\|';
  });
}

function delimiter(align: Align): string {
  switch (align) {
    case 'left':
      return ':---';
    case 'center':
      return ':---:';
    case 'right':
      return '---:';
    default:
      return '---';
  }
}

/**
 * Renders a grid as GFM pipe-table lines.
 *
 * Every line is prefixed with `indent` — the same contract as `serializeHtmlTable`:
 * a table inside a list item or a blockquote keeps its ownership after the rewrite.
 *
 * Returns `[]` when the grid is not pipe-serializable; callers must check
 * {@link canSerializePipe} first (this is the last line of defence, not the gate).
 */
export function serializePipeTable(grid: TableGrid, indent = ''): string[] {
  if (!canSerializePipe(grid)) return [];

  const rows = grid.cells;
  const width = rows[0].length;

  const renderRow = (row: TableGrid['cells'][number]): string => {
    const cells = row.map((cell) => escapeCell(cell.raw !== undefined ? cell.raw : cell.text));
    return `${indent}| ${cells.join(' | ')} |`;
  };

  const delimiterCells: string[] = [];
  for (let c = 0; c < width; c++) delimiterCells.push(delimiter(grid.colAlign[c] ?? 'default'));

  return [
    renderRow(rows[0]),
    `${indent}| ${delimiterCells.join(' | ')} |`,
    ...rows.slice(1).map(renderRow),
  ];
}

/** Serializes to a single string, newline-terminated, for tests and export. */
export function serializePipeTableString(grid: TableGrid, indent = ''): string {
  return serializePipeTable(grid, indent).join('\n');
}

/** Which storage format a write should produce. `null` means "refuse the write". */
export type WriteFormat = 'pipe' | 'html' | null;

/**
 * Picks the storage format for one write.
 *
 * - pipe-origin tables stay Markdown whenever the grid still allows it (the whole point
 *   of this feature: the rendered layer must not turn the document into HTML);
 * - html-origin tables stay HTML unless a toolbar action explicitly asks for Markdown;
 * - `forcePipe` is an explicit user request: if it cannot be honoured, refuse the write
 *   instead of silently falling back to HTML the user did not ask for.
 */
export function chooseWriteFormat(
  kind: TableKind,
  grid: TableGrid,
  opts: { forcePipe?: boolean } = {},
): WriteFormat {
  if (opts.forcePipe) return canSerializePipe(grid) ? 'pipe' : null;
  if (kind === 'pipe') return canSerializePipe(grid) ? 'pipe' : 'html';
  return 'html';
}
