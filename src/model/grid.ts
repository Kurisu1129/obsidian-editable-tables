import { makeCell, type Align, type Cell, type TableGrid } from './types';

export function cloneGrid(grid: TableGrid): TableGrid {
  return {
    hasHeader: grid.hasHeader,
    colAlign: [...grid.colAlign],
    cells: grid.cells.map((row) => row.map((c) => ({ ...c }))),
  };
}

export function rowCount(grid: TableGrid): number {
  return grid.cells.length;
}

export function colCount(grid: TableGrid): number {
  return grid.cells.length > 0 ? grid.cells[0].length : 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Recomputes `covered` from the anchor spans and clamps spans to the grid bounds.
 * Every structural operation funnels through this, so the grid is never left in a
 * state with overlapping or out-of-bounds spans (AC4).
 */
export function normalizeGrid(grid: TableGrid): TableGrid {
  const h = rowCount(grid);
  const w = colCount(grid);
  if (h === 0 || w === 0) return grid;

  for (const row of grid.cells) {
    for (const cell of row) cell.covered = false;
  }

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const cell = grid.cells[r][c];
      if (cell.covered) continue;
      cell.rowSpan = clamp(cell.rowSpan, 1, h - r);
      cell.colSpan = clamp(cell.colSpan, 1, w - c);
      for (let dr = 0; dr < cell.rowSpan; dr++) {
        for (let dc = 0; dc < cell.colSpan; dc++) {
          if (dr === 0 && dc === 0) continue;
          const target = grid.cells[r + dr][c + dc];
          target.covered = true;
          target.rowSpan = 1;
          target.colSpan = 1;
        }
      }
    }
  }
  return grid;
}

/** Collapses the anchors of any merge touching rows [from..to] back to single cells. */
export function dissolveSpansInRows(grid: TableGrid, from: number, to: number): void {
  const w = colCount(grid);
  for (let r = 0; r < rowCount(grid); r++) {
    for (let c = 0; c < w; c++) {
      const cell = grid.cells[r][c];
      if (cell.covered || cell.rowSpan === 1) continue;
      const last = r + cell.rowSpan - 1;
      if (last >= from && r <= to) {
        cell.rowSpan = 1;
        if (last - r > 0 && r + cell.rowSpan - 1 < from) cell.rowSpan = Math.max(1, from - r);
      }
    }
  }
}

/** Collapses the anchors of any merge touching columns [from..to] back to single cells. */
export function dissolveSpansInCols(grid: TableGrid, from: number, to: number): void {
  const h = rowCount(grid);
  const w = colCount(grid);
  for (let c = 0; c < w; c++) {
    for (let r = 0; r < h; r++) {
      const cell = grid.cells[r][c];
      if (cell.covered || cell.colSpan === 1) continue;
      const last = c + cell.colSpan - 1;
      if (last >= from && c <= to) {
        cell.colSpan = 1;
        if (last - c > 0 && c + cell.colSpan - 1 < from) cell.colSpan = Math.max(1, from - c);
      }
    }
  }
}

// ---------------------------------------------------------------- row operations

export function insertRow(grid: TableGrid, at: number): TableGrid {
  const next = cloneGrid(grid);
  const w = colCount(next);
  const blank = Array.from({ length: w }, () => makeCell(''));
  next.cells.splice(clamp(at, 0, rowCount(next)), 0, blank);
  return normalizeGrid(next);
}

export function deleteRow(grid: TableGrid, at: number): TableGrid {
  const next = cloneGrid(grid);
  if (rowCount(next) <= 1) return grid; // never delete the last row

  const w = colCount(next);
  // Merges reaching into the deleted row from above shrink by one.
  for (let r = 0; r < at; r++) {
    for (let c = 0; c < w; c++) {
      const cell = next.cells[r][c];
      if (!cell.covered && r + cell.rowSpan > at) cell.rowSpan -= 1;
    }
  }
  next.cells.splice(at, 1);
  return normalizeGrid(next);
}

export function moveRow(grid: TableGrid, from: number, to: number): TableGrid {
  if (from === to) return grid;
  const next = cloneGrid(grid);
  dissolveSpansInRows(next, Math.min(from, to), Math.max(from, to));
  normalizeGrid(next);
  const [row] = next.cells.splice(from, 1);
  next.cells.splice(clamp(to, 0, next.cells.length), 0, row);
  return normalizeGrid(next);
}

// ------------------------------------------------------------- column operations

export function insertCol(grid: TableGrid, at: number): TableGrid {
  const next = cloneGrid(grid);
  const index = clamp(at, 0, colCount(next));
  for (const row of next.cells) row.splice(index, 0, makeCell(''));
  next.colAlign.splice(index, 0, 'default');
  return normalizeGrid(next);
}

export function deleteCol(grid: TableGrid, at: number): TableGrid {
  const next = cloneGrid(grid);
  if (colCount(next) <= 1) return grid; // never delete the last column

  // Merges reaching into the deleted column from the left shrink by one.
  for (let r = 0; r < rowCount(next); r++) {
    for (let c = 0; c < at; c++) {
      const cell = next.cells[r][c];
      if (!cell.covered && c + cell.colSpan > at) cell.colSpan -= 1;
    }
  }
  for (const row of next.cells) row.splice(at, 1);
  next.colAlign.splice(at, 1);
  return normalizeGrid(next);
}

export function moveCol(grid: TableGrid, from: number, to: number): TableGrid {
  if (from === to) return grid;
  const next = cloneGrid(grid);
  dissolveSpansInCols(next, Math.min(from, to), Math.max(from, to));
  normalizeGrid(next);
  for (const row of next.cells) {
    const [cell] = row.splice(from, 1);
    row.splice(clamp(to, 0, row.length), 0, cell);
  }
  const [align] = next.colAlign.splice(from, 1);
  next.colAlign.splice(clamp(to, 0, next.colAlign.length), 0, align);
  return normalizeGrid(next);
}

export function setColAlign(grid: TableGrid, col: number, align: Align): TableGrid {
  const next = cloneGrid(grid);
  if (col >= 0 && col < next.colAlign.length) next.colAlign[col] = align;
  return next;
}

// ---------------------------------------------------------------- merge and split

/**
 * Collapses any anchor overlapping the rectangle back to a single cell.
 * Used before merging so the result never contains nested/overlapping spans (AC4).
 */
function dissolveRect(grid: TableGrid, r1: number, c1: number, r2: number, c2: number): void {
  const h = rowCount(grid);
  const w = colCount(grid);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const cell = grid.cells[r][c];
      if (cell.covered) continue;
      const rEnd = r + cell.rowSpan - 1;
      const cEnd = c + cell.colSpan - 1;
      const overlaps = r <= r2 && rEnd >= r1 && c <= c2 && cEnd >= c1;
      if (overlaps && (cell.rowSpan > 1 || cell.colSpan > 1)) {
        cell.rowSpan = 1;
        cell.colSpan = 1;
      }
    }
  }
  normalizeGrid(grid);
}

/**
 * Merges the rectangle [r1,c1]-[r2,c2] into a single cell.
 *
 * Text from the merged cells is concatenated (space-separated) into the anchor rather
 * than discarded, so merging never silently destroys content.
 */
export function mergeCells(
  grid: TableGrid,
  r1: number,
  c1: number,
  r2: number,
  c2: number,
): TableGrid {
  const next = cloneGrid(grid);
  const h = rowCount(next);
  const w = colCount(next);

  const top = clamp(Math.min(r1, r2), 0, h - 1);
  const bottom = clamp(Math.max(r1, r2), 0, h - 1);
  const left = clamp(Math.min(c1, c2), 0, w - 1);
  const right = clamp(Math.max(c1, c2), 0, w - 1);
  if (top === bottom && left === right) return grid; // nothing to merge

  dissolveRect(next, top, left, bottom, right);

  const sources: Cell[] = [];
  for (let r = top; r <= bottom; r++) {
    for (let c = left; c <= right; c++) {
      const cell = next.cells[r][c];
      if (cell.covered) continue;
      if (cell.raw !== undefined || cell.text !== '') sources.push(cell);
    }
  }

  const anchor = next.cells[top][left];
  anchor.rowSpan = bottom - top + 1;
  anchor.colSpan = right - left + 1;

  if (sources.length === 1) {
    // A single source survives verbatim, including its inline markup. Joining `raw`
    // into a plain-text string would print the tags literally (e.g. `<strong>bold</strong>`).
    anchor.text = sources[0].text;
    anchor.raw = sources[0].raw;
  } else {
    // Multiple sources can only be represented as plain text.
    anchor.text = sources.map((c) => c.text).join(' ');
    anchor.raw = undefined;
  }

  return normalizeGrid(next);
}

export function splitCell(grid: TableGrid, r: number, c: number): TableGrid {
  const next = cloneGrid(grid);
  if (r < 0 || r >= rowCount(next) || c < 0 || c >= colCount(next)) return grid;
  const cell = next.cells[r][c];
  if (cell.covered) return grid;
  if (cell.rowSpan === 1 && cell.colSpan === 1) return grid;
  cell.rowSpan = 1;
  cell.colSpan = 1;
  return normalizeGrid(next);
}
