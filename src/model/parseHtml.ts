import { getAttr, getSpan, hasMarkup, stripTags } from './html';
import type { Align, Cell, TableGrid } from './types';

interface RawCell {
  /** Raw inner HTML, retained for lossless round-tripping when it carries markup. */
  inner: string;
  /** Plain-text projection of `inner`. */
  text: string;
  isHeader: boolean;
  rowSpan: number;
  colSpan: number;
  align: Align;
}

function parseAlign(tag: string): Align {
  const attr = (getAttr(tag, 'align') ?? '').toLowerCase();
  if (attr === 'center' || attr === 'right' || attr === 'left') return attr;
  const style = getAttr(tag, 'style') ?? '';
  const m = style.match(/text-align\s*:\s*(left|center|right)/i);
  return m ? (m[1].toLowerCase() as Align) : 'default';
}

/**
 * Splits the inside of a `<tr>` into cells.
 *
 * Tolerates unclosed `<td>`/`<th>`: a cell's content runs until the next cell-opening
 * tag or the end of the row, so hand-written and machine-generated HTML both parse.
 */
function splitCells(rowInner: string): RawCell[] {
  const starts: { index: number; end: number; tag: string; isHeader: boolean }[] = [];
  const openRe = /<(td|th)\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(rowInner)) !== null) {
    starts.push({
      index: m.index,
      end: m.index + m[0].length,
      tag: m[0],
      isHeader: m[1].toLowerCase() === 'th',
    });
  }

  const cells: RawCell[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const contentEnd = i + 1 < starts.length ? starts[i + 1].index : rowInner.length;
    const inner = rowInner.slice(start.end, contentEnd).replace(/<\/(td|th)\s*>/gi, '');
    const text = stripTags(inner);
    cells.push({
      inner: hasMarkup(inner) ? inner.trim() : '',
      text,
      isHeader: start.isHeader,
      rowSpan: getSpan(start.tag, 'rowspan'),
      colSpan: getSpan(start.tag, 'colspan'),
      align: parseAlign(start.tag),
    });
  }
  return cells;
}

/** Parses a raw `<table>…</table>` block into a dense grid, resolving spans. */
export function parseHtmlTable(lines: string[]): TableGrid | null {
  const html = lines.join('\n');

  // Row bodies run from a `<tr…>` to the next `<tr…>`, `</table…>`, or end of input.
  // Anchoring on the opening tag (rather than requiring `</tr>`) is what lets us
  // tolerate hand-written or minified HTML with omitted closing tags.
  const opens: { index: number; end: number }[] = [];
  const trOpen = /<tr\b[^>]*>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = trOpen.exec(html)) !== null) {
    opens.push({ index: rm.index, end: rm.index + rm[0].length });
  }
  if (opens.length === 0) return null;

  const tableClose = html.search(/<\/table\s*>/i);
  const rowInners: string[] = opens.map((open, i) => {
    let to = i + 1 < opens.length ? opens[i + 1].index : html.length;
    if (tableClose !== -1 && tableClose < to) to = tableClose;
    // Cut at this row's own `</tr>` when it has one, so the tag never leaks into
    // the last cell's content. Unclosed rows simply run to the boundary above.
    const close = html.slice(open.end).search(/<\/tr\s*>/i);
    if (close !== -1 && open.end + close < to) to = open.end + close;
    return html.slice(open.end, to);
  });

  const rawRows = rowInners.map(splitCells).filter((r) => r.length > 0);
  if (rawRows.length === 0) return null;

  const rows: Cell[][] = [];
  const occupied: boolean[][] = [];
  const ensure = (r: number): void => {
    if (!rows[r]) {
      rows[r] = [];
      occupied[r] = [];
    }
  };

  for (let r = 0; r < rawRows.length; r++) {
    ensure(r);
    let col = 0;

    for (const raw of rawRows[r]) {
      while (occupied[r][col]) col++;

      const cell: Cell = {
        text: raw.text,
        rowSpan: raw.rowSpan,
        colSpan: raw.colSpan,
        covered: false,
      };
      if (raw.inner !== '') cell.raw = raw.inner;

      rows[r][col] = cell;
      occupied[r][col] = true;

      for (let dr = 0; dr < raw.rowSpan; dr++) {
        for (let dc = 0; dc < raw.colSpan; dc++) {
          if (dr === 0 && dc === 0) continue;
          const rr = r + dr;
          const cc = col + dc;
          ensure(rr);
          rows[rr][cc] = { text: '', rowSpan: 1, colSpan: 1, covered: true };
          occupied[rr][cc] = true;
        }
      }
      col += raw.colSpan;
    }
  }

  // Rectangularise: pad every row out to the widest one.
  let width = 0;
  for (const row of rows) width = Math.max(width, row.length);
  if (width === 0) return null;
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < width; c++) {
      if (!rows[r][c]) rows[r][c] = { text: '', rowSpan: 1, colSpan: 1, covered: false };
    }
    rows[r].length = width;
  }

  // Column alignment: first non-default alignment seen in that column wins.
  const colAlign: Align[] = new Array(width).fill('default');
  for (let r = 0; r < rawRows.length; r++) {
    let col = 0;
    for (const raw of rawRows[r]) {
      while (col < width && rows[r] && rows[r][col] && rows[r][col].covered) col++;
      if (col < width && raw.align !== 'default' && colAlign[col] === 'default') {
        colAlign[col] = raw.align;
      }
      col += raw.colSpan;
    }
  }

  const hasHeader = rawRows[0].some((c) => c.isHeader);
  return { cells: rows, colAlign, hasHeader };
}
