import { describe, expect, it } from 'vitest';

import { planInnerTables } from '../src/model/innerTable';

const join = (...ls: string[]): string => ls.join('\n');

describe('planInnerTables', () => {
  it('finds a pipe table in a top-level quote and keeps the "> " prefix', () => {
    const source = join(
      '> 引用第一行',
      '> | a | b |',
      '> |---|---|',
      '> | 1 | 2 |',
    );
    const plans = planInnerTables(source, '');
    expect(plans).toHaveLength(1);
    const plan = plans[0];
    expect(plan.prefix).toBe('> ');
    expect(plan.tableKind).toBe('pipe');
    expect(plan.relFrom).toBe(source.indexOf('> | a | b |'));
    expect(plan.relTo).toBe(source.length);
    expect(plan.source).toBe(join('> | a | b |', '> |---|---|', '> | 1 | 2 |'));
    expect(plan.grid.cells.map((row) => row.map((c) => c.text))).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps the list indentation when the quote sits inside a list item', () => {
    const source = join(
      '  > | a | b |',
      '  > |---|---|',
      '  > | 1 | 2 |',
    );
    const plans = planInnerTables(source, '  ');
    expect(plans).toHaveLength(1);
    expect(plans[0].prefix).toBe('  > ');
    expect(plans[0].source.startsWith('  > | a | b |')).toBe(true);
  });

  it('keeps the double quote chain for a nested quote', () => {
    const source = join('> > | a | b |', '> > |---|---|');
    const plans = planInnerTables(source, '');
    expect(plans).toHaveLength(1);
    expect(plans[0].prefix).toBe('> > ');
    expect(plans[0].grid.cells[0].map((c) => c.text)).toEqual(['a', 'b']);
  });

  it('keeps the indentation of a list item inside the quote', () => {
    const source = join(
      '> - item',
      '>   | a | b |',
      '>   |---|---|',
    );
    const plans = planInnerTables(source, '');
    expect(plans).toHaveLength(1);
    expect(plans[0].prefix).toBe('>   ');
    expect(plans[0].source).toBe(join('>   | a | b |', '>   |---|---|'));
  });

  it('finds an HTML table and returns the parsed grid', () => {
    const source = join(
      '> 引用',
      '> <table>',
      '>   <tr><th>甲</th><th>乙</th></tr>',
      '>   <tr><td>1</td><td>2</td></tr>',
      '> </table>',
    );
    const plans = planInnerTables(source, '');
    expect(plans).toHaveLength(1);
    expect(plans[0].tableKind).toBe('html');
    expect(plans[0].prefix).toBe('> ');
    expect(plans[0].grid.cells[0].map((c) => c.text)).toEqual(['甲', '乙']);
  });

  it('returns every table in source order', () => {
    const source = join(
      '> | a | b |',
      '> |---|---|',
      '> 中间文字',
      '> | c | d |',
      '> |---|---|',
    );
    const plans = planInnerTables(source, '');
    expect(plans).toHaveLength(2);
    expect(plans[0].relFrom).toBeLessThan(plans[1].relFrom);
    expect(plans[0].grid.cells[0].map((c) => c.text)).toEqual(['a', 'b']);
    expect(plans[1].grid.cells[0].map((c) => c.text)).toEqual(['c', 'd']);
  });

  it('ignores pipes inside a fenced code block', () => {
    const source = join(
      '> ```',
      '> | a | b |',
      '> |---|---|',
      '> ```',
    );
    expect(planInnerTables(source, '')).toEqual([]);
  });

  it('bails out when a table starts on a lazy continuation line', () => {
    const source = join('> intro', 'a | b', '--- | ---');
    expect(planInnerTables(source, '')).toEqual([]);
  });

  it('returns an empty list when the quote has no tables', () => {
    const source = join('> 只有文字', '> 还有更多文字');
    expect(planInnerTables(source, '')).toEqual([]);
  });

  it('supports quote lines with extra spaces after the marker', () => {
    const source = join('>  | a | b |', '>  |---|---|');
    const plans = planInnerTables(source, '');
    expect(plans).toHaveLength(1);
    expect(plans[0].prefix).toBe('>  ');
  });
});
