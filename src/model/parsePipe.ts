import { makeCell, type Align, type Cell, type TableGrid } from './types';

/** Splits a pipe-table row into trimmed cell texts, honouring `\|` escapes. */
export function splitRow(text: string): string[] {
  let t = text.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);

  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '\\' && t[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

export function parseAlign(token: string): Align {
  const t = token.trim();
  const left = t.startsWith(':');
  const right = t.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return 'default';
}

/**
 * Parses a GFM pipe table into a dense grid.
 *
 * `lines` is the raw block including the header row and the delimiter row.
 *
 * The grid width is the maximum cell count over **all** rows — the same rule Obsidian's
 * own renderer follows (verified at runtime). Using the header width instead would
 * truncate longer body rows, and since this plugin writes the grid back to the file
 * that truncation would be permanent data loss (R1). Short rows are padded.
 */
export function parsePipeTable(lines: string[]): TableGrid | null {
  if (lines.length < 2) return null;

  const header = splitRow(lines[0]);
  if (header.length === 0) return null;

  const delim = splitRow(lines[1]);
  const body = lines.slice(2).map(splitRow);

  const width = Math.max(header.length, delim.length, ...body.map((r) => r.length));
  if (width === 0) return null;

  const pad = (raw: string[]): Cell[] => {
    const row: Cell[] = [];
    for (let c = 0; c < width; c++) row.push(makeCell(raw[c] ?? ''));
    return row;
  };

  const colAlign: Align[] = [];
  for (let c = 0; c < width; c++) colAlign.push(parseAlign(delim[c] ?? '---'));

  return { cells: [pad(header), ...body.map(pad)], colAlign, hasHeader: true };
}
