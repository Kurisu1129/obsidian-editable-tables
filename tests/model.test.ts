import { describe, expect, it } from 'vitest';

import { scanTableLines } from '../src/model/scan';
import { parsePipeTable, parseAlign, splitRow } from '../src/model/parsePipe';
import { parseHtmlTable } from '../src/model/parseHtml';
import { serializeHtmlTable, serializeHtmlTableString } from '../src/model/serializeHtml';
import {
  colCount,
  deleteCol,
  deleteRow,
  insertCol,
  insertRow,
  mergeCells,
  moveCol,
  moveRow,
  normalizeGrid,
  rowCount,
  setColAlign,
  splitCell,
} from '../src/model/grid';
import { escapeHtml, stripTags, decodeEntities } from '../src/model/html';
import type { TableGrid } from '../src/model/types';

const lines = (...ls: string[]): string[] => ls;

// ------------------------------------------------------------------ scanning

describe('scanTableLines', () => {
  it('finds a top-level pipe table', () => {
    const blocks = scanTableLines(
      lines('# H', '', '| a | b |', '| --- | --- |', '| 1 | 2 |', '', 'after'),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ startLine: 2, endLine: 4, kind: 'pipe', indent: '' });
  });

  it('finds a table nested under a list item and keeps its indent', () => {
    const blocks = scanTableLines(
      lines('- item', '  - sub', '', '    | a | b |', '    | --- | --- |', '    | 1 | 2 |', '', '  - next'),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ startLine: 3, endLine: 5, indent: '    ', kind: 'pipe' });
  });

  it('ignores pipe tables inside fenced code blocks', () => {
    const blocks = scanTableLines(
      lines('```', '| a | b |', '| --- | --- |', '| 1 | 2 |', '```'),
    );
    expect(blocks).toHaveLength(0);
  });

  it('does not treat a delimiter row without a header above it as a table', () => {
    const blocks = scanTableLines(lines('', '| --- | --- |', '| 1 | 2 |'));
    expect(blocks).toHaveLength(0);
  });

  it('does not treat prose containing a pipe as a table', () => {
    const blocks = scanTableLines(lines('use `a | b` in a shell pipe', 'nothing here'));
    expect(blocks).toHaveLength(0);
  });

  it('finds an HTML table', () => {
    const blocks = scanTableLines(lines('# H', '', '<table>', '<tr><td>1</td></tr>', '</table>', ''));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ startLine: 2, endLine: 4, kind: 'html' });
  });

  it('ignores an unterminated HTML table', () => {
    expect(scanTableLines(lines('<table>', '<tr><td>1</td></tr>'))).toHaveLength(0);
  });

  it('never treats YAML front matter as a table', () => {
    // A bare `---` is a valid one-cell delimiter row by the cell grammar, so without an
    // explicit pipe requirement the front matter fence is parsed as a table — and editing
    // it would replace the closing `---`, leaving the note as unterminated YAML.
    const noTable = (ls: string[]): void => {
      expect(scanTableLines(ls)).toHaveLength(0);
    };
    noTable(lines('---', 'title: A | B', '---', '', 'body'));
    noTable(lines('---', 'tags: [x]', 'title: A | B', '---', '', 'body: hello'));

    // A real table *after* the front matter must still be found — the exclusion is a
    // region, not a blanket refusal to scan anything in a note that has front matter.
    const afterFm = scanTableLines(
      lines('---', 'title: A | B', '---', '', '| a | b |', '| --- | --- |'),
    );
    expect(afterFm).toHaveLength(1);
    expect(afterFm[0]).toMatchObject({ startLine: 4, endLine: 5 });
  });

  it('ignores a thematic break and a setext underline', () => {
    expect(scanTableLines(lines('some paragraph', '---', '', 'more text'))).toHaveLength(0);
    expect(scanTableLines(lines('Heading text', '===', '', '| a | b |', '| --- | --- |'))).toHaveLength(1);
  });

  it('never emits overlapping blocks for a trailing thematic break', () => {
    // The pipe block stops at a line without `|`, but a bare `---` after it used to be
    // picked up again as a one-cell table whose body overlapped the previous block.
    const blocks = scanTableLines(lines('| a | b |', '| --- | --- |', '| 1 | 2 |', '---'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ startLine: 0, endLine: 2 });
  });

  it('stops at a row whose pipe shape differs from the header (matches Obsidian)', () => {
    // A table opened with `|` only absorbs rows that also open with `|`. Without this,
    // prose that merely mentions a pipe is swallowed and later rewritten as table cells.
    const prose = scanTableLines(
      lines('| a | b |', '| --- | --- |', '| 1 | 2 |', 'Use `x | y` for a pipe.'),
    );
    expect(prose).toHaveLength(1);
    expect(prose[0]).toMatchObject({ startLine: 0, endLine: 2 });

    const midTable = scanTableLines(lines('| a | b |', '| --- | --- |', '1 | 2', '| 3 | 4 |'));
    expect(midTable).toHaveLength(1);
    expect(midTable[0]).toMatchObject({ startLine: 0, endLine: 1 });
  });

  it('accepts pipe-less rows when the header is also pipe-less', () => {
    const blocks = scanTableLines(lines('a | b', '--- | ---', '1 | 2'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ startLine: 0, endLine: 2 });
  });

  it('rejects a table when the delimiter row disagrees with the header on pipe shape', () => {
    expect(scanTableLines(lines('a | b', '| --- | --- |', '1 | 2'))).toHaveLength(0);
  });
});

// -------------------------------------------------------------- pipe parsing

describe('parsePipeTable', () => {
  it('parses header, body and per-column alignment', () => {
    const grid = parsePipeTable([
      '| a | b | c |',
      '| :-- | :-: | --: |',
      '| 1 | 2 | 3 |',
    ])!;
    expect(grid.hasHeader).toBe(true);
    expect(grid.colAlign).toEqual(['left', 'center', 'right']);
    expect(grid.cells.map((r) => r.map((c) => c.text))).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('honours escaped pipes', () => {
    expect(splitRow('| a \\| b | c |')).toEqual(['a | b', 'c']);
  });

  it('pads short rows to the widest row rather than truncating long ones', () => {
    // Matches Obsidian's own renderer. Truncating to the header width would lose "3"
    // permanently, because this plugin writes the grid back to the file.
    const grid = parsePipeTable(['| a | b |', '| --- | --- |', '| 1 |', '| 1 | 2 | 3 |'])!;
    expect(colCount(grid)).toBe(3);
    expect(grid.cells[0].map((c) => c.text)).toEqual(['a', 'b', '']);
    expect(grid.cells[1].map((c) => c.text)).toEqual(['1', '', '']);
    expect(grid.cells[2].map((c) => c.text)).toEqual(['1', '2', '3']);
  });

  it('takes the width from the widest row even when the delimiter row is longer', () => {
    const grid = parsePipeTable(['| a | b |', '| --- | --- | --- |', '| 1 | 2 |'])!;
    expect(colCount(grid)).toBe(3);
    expect(grid.cells[1].map((c) => c.text)).toEqual(['1', '2', '']);
  });

  it('works without leading/trailing pipes', () => {
    const grid = parsePipeTable(['a | b', '--- | ---', '1 | 2'])!;
    expect(grid.cells[0].map((c) => c.text)).toEqual(['a', 'b']);
  });

  it('parses alignment tokens', () => {
    expect(parseAlign('---')).toBe('default');
    expect(parseAlign(':--')).toBe('left');
    expect(parseAlign('--:')).toBe('right');
    expect(parseAlign(':-:')).toBe('center');
  });
});

// -------------------------------------------------------------- html parsing

describe('parseHtmlTable', () => {
  it('parses a simple table with a header row', () => {
    const grid = parseHtmlTable([
      '<table>',
      '  <tr><th>a</th><th>b</th></tr>',
      '  <tr><td>1</td><td>2</td></tr>',
      '</table>',
    ])!;
    expect(grid.hasHeader).toBe(true);
    expect(grid.cells.map((r) => r.map((c) => c.text))).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('places colspan and rowspan anchors and marks covered slots', () => {
    const grid = parseHtmlTable([
      '<table>',
      '<tr><td colspan="2">wide</td></tr>',
      '<tr><td rowspan="2">tall</td><td>x</td></tr>',
      '<tr><td>y</td></tr>',
      '</table>',
    ])!;
    expect(grid.cells[0][0]).toMatchObject({ text: 'wide', colSpan: 2, covered: false });
    expect(grid.cells[0][1].covered).toBe(true);
    expect(grid.cells[1][0]).toMatchObject({ text: 'tall', rowSpan: 2 });
    expect(grid.cells[2][0].covered).toBe(true);
    expect(grid.cells[2][1].text).toBe('y');
  });

  it('tolerates unclosed cell tags', () => {
    const grid = parseHtmlTable(['<table>', '<tr><td>a<td>b', '</table>'])!;
    expect(grid.cells[0].map((c) => c.text)).toEqual(['a', 'b']);
  });

  it('retains raw markup so untouched cells survive a round trip', () => {
    const grid = parseHtmlTable([
      '<table>',
      '<tr><td><strong>bold</strong></td></tr>',
      '</table>',
    ])!;
    expect(grid.cells[0][0].text).toBe('bold');
    expect(grid.cells[0][0].raw).toContain('<strong>');
  });

  it('reads alignment from the align attribute', () => {
    const grid = parseHtmlTable([
      '<table>',
      '<tr><td align="center">a</td><td align="right">b</td></tr>',
      '</table>',
    ])!;
    expect(grid.colAlign).toEqual(['center', 'right']);
  });
});

// -------------------------------------------------------------- serialization

describe('serializeHtmlTable', () => {
  const grid: TableGrid = {
    hasHeader: true,
    colAlign: ['default', 'right'],
    cells: [
      [
        { text: 'a', rowSpan: 1, colSpan: 1, covered: false },
        { text: 'b', rowSpan: 1, colSpan: 1, covered: false },
      ],
      [
        { text: '1', rowSpan: 1, colSpan: 1, covered: false },
        { text: '2', rowSpan: 1, colSpan: 1, covered: false },
      ],
    ],
  };

  it('emits a header row with th and applies column alignment', () => {
    const out = serializeHtmlTableString(grid);
    expect(out).toContain('<th>a</th>');
    // Alignment is emitted on body cells; the header cell of an aligned column gets one
    // too, so Reading view aligns the header the way the widget does (R5).
    expect(out).toContain('<td align="right">2</td>');
    expect(out.startsWith('<table>\n')).toBe(true);
    expect(out.endsWith('</table>')).toBe(true);
  });

  it('prefixes every line with the region indent (AC2)', () => {
    const out = serializeHtmlTable(grid, '    ');
    for (const line of out) expect(line.startsWith('    ')).toBe(true);
  });

  it('skips slots covered by a span', () => {
    const merged: TableGrid = {
      hasHeader: false,
      colAlign: ['default', 'default'],
      cells: [
        [
          { text: 'wide', rowSpan: 1, colSpan: 2, covered: false },
          { text: '', rowSpan: 1, colSpan: 1, covered: true },
        ],
      ],
    };
    const out = serializeHtmlTableString(merged);
    expect(out).toContain('<td colspan="2">wide</td>');
    expect(out.match(/<td/g)).toHaveLength(1);
  });

  it('escapes text but preserves raw markup', () => {
    const g: TableGrid = {
      hasHeader: false,
      colAlign: ['default', 'default'],
      cells: [
        [
          { text: '<x>', rowSpan: 1, colSpan: 1, covered: false },
          { text: 'bold', raw: '<strong>bold</strong>', rowSpan: 1, colSpan: 1, covered: false },
        ],
      ],
    };
    const out = serializeHtmlTableString(g);
    expect(out).toContain('&lt;x&gt;');
    expect(out).toContain('<strong>bold</strong>');
  });
});

// ------------------------------------------------------------------ round trip

describe('round trip', () => {
  const cases: string[][] = [
    ['<table>', '<tr><th>a</th><th>b</th></tr>', '<tr><td>1</td><td>2</td></tr>', '</table>'],
    [
      '<table>',
      '<tr><td colspan="2">wide</td></tr>',
      '<tr><td rowspan="2">tall</td><td>x</td></tr>',
      '<tr><td>y</td></tr>',
      '</table>',
    ],
    ['<table>', '<tr><td>a &amp; b</td><td></td></tr>', '</table>'],
  ];

  it.each(cases)('parse → serialize → parse is idempotent (%#)', (...src) => {
    const g1 = parseHtmlTable(src)!;
    const s1 = serializeHtmlTableString(g1);
    const g2 = parseHtmlTable(s1.split('\n'))!;
    const s2 = serializeHtmlTableString(g2);
    expect(s2).toBe(s1);
  });

  it('keeps spans well-formed after every structural operation', () => {
    let g = parseHtmlTable([
      '<table>',
      '<tr><th>a</th><th>b</th><th>c</th></tr>',
      '<tr><td>1</td><td>2</td><td>3</td></tr>',
      '<tr><td>4</td><td>5</td><td>6</td></tr>',
      '</table>',
    ])!;

    g = insertRow(g, 1);
    g = insertCol(g, 1);
    g = mergeCells(g, 0, 0, 1, 1);
    expectGridSane(g);

    const s1 = serializeHtmlTableString(g);
    const g2 = parseHtmlTable(s1.split('\n'))!;
    expectGridSane(g2);
    expect(serializeHtmlTableString(g2)).toBe(s1);
  });
});

// ------------------------------------------------------------------ grid ops

function expectGridSane(g: TableGrid): void {
  const w = colCount(g);
  expect(w).toBeGreaterThan(0);
  for (const row of g.cells) expect(row).toHaveLength(w);

  const h = rowCount(g);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const cell = g.cells[r][c];
      expect(cell.rowSpan).toBeGreaterThanOrEqual(1);
      expect(cell.colSpan).toBeGreaterThanOrEqual(1);
      expect(r + cell.rowSpan).toBeLessThanOrEqual(h);
      expect(c + cell.colSpan).toBeLessThanOrEqual(w);
      if (cell.covered) {
        expect(cell.rowSpan).toBe(1);
        expect(cell.colSpan).toBe(1);
      }
    }
  }
}

const base = (): TableGrid =>
  parsePipeTable(['| a | b |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |'])!;

describe('grid operations', () => {
  it('inserts and deletes rows', () => {
    let g = insertRow(base(), 1);
    expect(rowCount(g)).toBe(4);
    expect(g.cells[1].map((c) => c.text)).toEqual(['', '']);
    expectGridSane(g);

    g = deleteRow(g, 1);
    expect(rowCount(g)).toBe(3);
    expect(g.cells[1].map((c) => c.text)).toEqual(['1', '2']);
    expectGridSane(g);
  });

  it('refuses to delete the last remaining row or column', () => {
    let g = parsePipeTable(['| a |', '| --- |'])!;
    expect(g).not.toBeNull();
    expect(deleteRow(g, 0)).toBe(g);
    expect(deleteCol(g, 0)).toBe(g);
  });

  it('inserts and deletes columns, keeping alignment in sync', () => {
    let g = setColAlign(base(), 0, 'center');
    g = insertCol(g, 1);
    expect(colCount(g)).toBe(3);
    expect(g.colAlign).toEqual(['center', 'default', 'default']);
    expectGridSane(g);

    g = deleteCol(g, 1);
    expect(colCount(g)).toBe(2);
    expect(g.colAlign).toEqual(['center', 'default']);
    expectGridSane(g);
  });

  it('moves rows and columns', () => {
    let g = moveRow(base(), 2, 1);
    expect(g.cells.map((r) => r[0].text)).toEqual(['a', '3', '1']);

    g = moveCol(base(), 0, 1);
    expect(g.cells[0].map((c) => c.text)).toEqual(['b', 'a']);
    expectGridSane(g);
  });

  it('merges a rectangle and keeps only the anchor uncovered', () => {
    const g = mergeCells(base(), 1, 0, 2, 1);
    expect(g.cells[1][0]).toMatchObject({ rowSpan: 2, colSpan: 2, covered: false });
    expect(g.cells[1][1].covered).toBe(true);
    expect(g.cells[2][0].covered).toBe(true);
    expect(g.cells[2][1].covered).toBe(true);
    expectGridSane(g);
  });

  it('concatenates text when merging so nothing is silently lost', () => {
    const g = mergeCells(base(), 1, 0, 1, 1);
    expect(g.cells[1][0].text).toBe('1 2');
  });

  it('keeps inline markup verbatim when a merge has a single source', () => {
    // Joining `raw` into a plain string would emit the tags as literal text.
    const g = parseHtmlTable([
      '<table>',
      '<tr><td><strong>bold</strong></td><td></td></tr>',
      '</table>',
    ])!;
    const merged = mergeCells(g, 0, 0, 0, 1);
    expect(merged.cells[0][0].raw).toContain('<strong>');
    expect(serializeHtmlTableString(merged)).toContain('<strong>bold</strong>');
  });

  it('falls back to plain text when merging several sources', () => {
    const g = parseHtmlTable([
      '<table>',
      '<tr><td><strong>a</strong></td><td>b</td></tr>',
      '</table>',
    ])!;
    const merged = mergeCells(g, 0, 0, 0, 1);
    const out = serializeHtmlTableString(merged);
    expect(out).not.toContain('<strong>');
    expect(out).toContain('a b');
  });

  it('splits a merged cell back into singles', () => {
    let g = mergeCells(base(), 1, 0, 2, 1);
    g = splitCell(g, 1, 0);
    expect(g.cells[1][0]).toMatchObject({ rowSpan: 1, colSpan: 1 });
    expect(g.cells[1][1].covered).toBe(false);
    expectGridSane(g);
  });

  it('shrinks a merge that reaches into a deleted row', () => {
    let g = mergeCells(base(), 1, 0, 2, 0);
    g = deleteRow(g, 2);
    expectGridSane(g);
    expect(g.cells[1][0].rowSpan).toBe(1);
  });

  it('normalizeGrid clamps out-of-bounds spans', () => {
    const g: TableGrid = {
      hasHeader: false,
      colAlign: ['default', 'default'],
      cells: [
        [
          { text: 'a', rowSpan: 9, colSpan: 9, covered: false },
          { text: '', rowSpan: 1, colSpan: 1, covered: false },
        ],
        [
          { text: '', rowSpan: 1, colSpan: 1, covered: false },
          { text: '', rowSpan: 1, colSpan: 1, covered: false },
        ],
      ],
    };
    normalizeGrid(g);
    expectGridSane(g);
  });
});

// ---------------------------------------------------------------- html helpers

describe('html helpers', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeEntities('a &amp; b &#65; &#x42;')).toBe('a & b A B');
  });

  it('never throws on out-of-range or surrogate code points', () => {
    // String.fromCodePoint throws RangeError past U+10FFFF. That exception would escape
    // the StateField that parses tables and render the whole note uneditable.
    for (const input of ['&#x110000;', '&#99999999;', '&#xD800;', '&#xFFFFFFFF;', '&#-1;']) {
      expect(() => decodeEntities(input)).not.toThrow();
      expect(typeof decodeEntities(input)).toBe('string');
    }
  });

  it('escapes the characters that would break markup', () => {
    expect(escapeHtml('<a href="x">&')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;');
  });

  it('strips tags and turns <br> into a newline', () => {
    expect(stripTags('a<br>b<strong>c</strong>')).toBe('a\nbc');
  });
});
