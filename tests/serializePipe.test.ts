import { describe, expect, it } from 'vitest';

import { parseHtmlTable } from '../src/model/parseHtml';
import { parsePipeTable } from '../src/model/parsePipe';
import {
  canSerializePipe,
  chooseWriteFormat,
  serializePipeTable,
  serializePipeTableString,
} from '../src/model/serializePipe';
import { makeCell, type TableGrid } from '../src/model/types';

function grid(rows: string[][], overrides: Partial<TableGrid> = {}): TableGrid {
  return {
    cells: rows.map((row) => row.map((text) => makeCell(text))),
    colAlign: rows[0].map(() => 'default' as const),
    hasHeader: true,
    ...overrides,
  };
}

const texts = (g: TableGrid): string[][] => g.cells.map((row) => row.map((cell) => cell.text));

describe('canSerializePipe', () => {
  it('accepts a plain rectangular grid with a header', () => {
    expect(canSerializePipe(grid([['a', 'b'], ['1', '2']]))).toBe(true);
  });

  it('refuses a grid without a header row', () => {
    expect(canSerializePipe(grid([['a', 'b']], { hasHeader: false }))).toBe(false);
  });

  it('refuses merged cells and the slots they cover', () => {
    const merged = grid([['a', 'b'], ['c', 'd']]);
    merged.cells[0][0].colSpan = 2;
    merged.cells[0][1].covered = true;
    expect(canSerializePipe(merged)).toBe(false);
  });

  it('refuses row spans', () => {
    const spanned = grid([['a', 'b'], ['c', 'd']]);
    spanned.cells[0][0].rowSpan = 2;
    spanned.cells[1][0].covered = true;
    expect(canSerializePipe(spanned)).toBe(false);
  });

  it('refuses multi-line cell content', () => {
    expect(canSerializePipe(grid([['a\nb', 'c']]))).toBe(false);
  });

  it('refuses a backslash run immediately before a pipe', () => {
    // `splitRow` only understands `\|`; `\\|` cannot be round-tripped faithfully.
    expect(canSerializePipe(grid([['a\\|b', 'c']]))).toBe(false);
    expect(canSerializePipe(grid([['a\\\\|b', 'c']]))).toBe(false);
  });

  it('refuses raw HTML that contains a pipe anywhere', () => {
    const g = grid([['a', 'b']]);
    g.cells[0][0] = { ...g.cells[0][0], raw: '<span data-x="a|b">x</span>' };
    expect(canSerializePipe(g)).toBe(false);
  });

  it('accepts raw inline markup without pipes', () => {
    const g = grid([['a', 'b']]);
    g.cells[0][0] = { ...g.cells[0][0], raw: '<b>甲</b>' };
    expect(canSerializePipe(g)).toBe(true);
  });
});

describe('serializePipeTable', () => {
  it('emits header, delimiter and body and round-trips through parsePipeTable', () => {
    const parsed = parsePipeTable(['| a | b |', '| :-- | ---: |', '| 1 | 2 |']);
    expect(parsed).not.toBeNull();

    const out = serializePipeTable(parsed!);
    expect(out).toEqual(['| a | b |', '| :--- | ---: |', '| 1 | 2 |']);

    const again = parsePipeTable(out)!;
    expect(texts(again)).toEqual(texts(parsed!));
    expect(again.colAlign).toEqual(parsed!.colAlign);
    expect(again.hasHeader).toBe(true);
  });

  it('maps all four alignments to GFM delimiter markers', () => {
    const g = grid([['a', 'b', 'c', 'd']], {
      colAlign: ['left', 'center', 'right', 'default'],
    });
    expect(serializePipeTable(g)[1]).toBe('| :--- | :---: | ---: | --- |');
  });

  it('escapes pipes inside cell text', () => {
    const g = grid([['a|b', 'c'], ['d', 'e']]);
    const out = serializePipeTable(g);
    expect(out[0]).toBe('| a\\|b | c |');

    const parsed = parsePipeTable(out)!;
    expect(texts(parsed)).toEqual([['a|b', 'c'], ['d', 'e']]);
  });

  it('keeps empty cells and joins with padding', () => {
    const g = grid([['', 'x'], ['', '']]);
    expect(serializePipeTable(g)).toEqual(['|  | x |', '| --- | --- |', '|  |  |']);
  });

  it('handles a single-column table', () => {
    const g = grid([['a'], ['1']]);
    expect(serializePipeTable(g)).toEqual(['| a |', '| --- |', '| 1 |']);
  });

  it('prefixes every line with the given indent', () => {
    const g = grid([['a', 'b'], ['1', '2']]);
    expect(serializePipeTable(g, '> ')).toEqual([
      '> | a | b |',
      '> | --- | --- |',
      '> | 1 | 2 |',
    ]);
    expect(serializePipeTable(g, '> > ')[0]).toBe('> > | a | b |');
    expect(serializePipeTable(g, '  ')[0]).toBe('  | a | b |');
  });

  it('keeps untouched raw inline HTML in the cell', () => {
    const g = grid([['a', 'b']]);
    g.cells[0][0] = { ...g.cells[0][0], raw: '<b>甲</b>' };
    expect(serializePipeTable(g)[0]).toBe('| <b>甲</b> | b |');
  });

  it('returns an empty list when the grid is not pipe-serializable', () => {
    const g = grid([['a', 'b']], { hasHeader: false });
    expect(serializePipeTable(g)).toEqual([]);
    expect(serializePipeTableString(g)).toBe('');
  });

  it('round-trips a simple HTML table into pipe syntax', () => {
    const html = [
      '<table>',
      '  <tr><th align="left">甲</th><th>乙</th></tr>',
      '  <tr><td>1</td><td>2</td></tr>',
      '</table>',
    ];
    const parsed = parseHtmlTable(html)!;
    expect(canSerializePipe(parsed)).toBe(true);

    const out = serializePipeTable(parsed);
    const again = parsePipeTable(out)!;
    expect(texts(again)).toEqual([['甲', '乙'], ['1', '2']]);
    expect(again.colAlign).toEqual(['left', 'default']);
  });
});

describe('chooseWriteFormat', () => {
  const plain = grid([['a'], ['1']]);
  const merged = grid([['a'], ['1']]);
  merged.cells[0][0].rowSpan = 2;
  merged.cells[1][0].covered = true;

  it('keeps pipe-origin tables as pipe when possible', () => {
    expect(chooseWriteFormat('pipe', plain)).toBe('pipe');
  });

  it('falls back to HTML when a pipe table can no longer be represented', () => {
    expect(chooseWriteFormat('pipe', merged)).toBe('html');
  });

  it('keeps HTML-origin tables as HTML by default', () => {
    expect(chooseWriteFormat('html', plain)).toBe('html');
  });

  it('honours an explicit pipe request for HTML-origin tables', () => {
    expect(chooseWriteFormat('html', plain, { forcePipe: true })).toBe('pipe');
  });

  it('refuses an explicit pipe request that cannot be honoured', () => {
    expect(chooseWriteFormat('html', merged, { forcePipe: true })).toBeNull();
    expect(chooseWriteFormat('pipe', merged, { forcePipe: true })).toBeNull();
  });
});
