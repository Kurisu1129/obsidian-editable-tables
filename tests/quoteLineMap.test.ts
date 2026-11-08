import { describe, expect, it } from 'vitest';

import {
  projectQuoteLines,
  resolveQuoteLine,
  scanQuoteBlocks,
  type QuoteBlock,
} from '../src/model/quoteLineMap';

describe('projectQuoteLines', () => {
  it('strips the "> " chain and keeps offsets into the original source', () => {
    const source = ['> 第一行', '> 第二行', '第三行'].join('\n');
    const projection = projectQuoteLines(source, '');

    expect(projection.lines).toEqual(['第一行', '第二行', '第三行']);
    expect(projection.prefixes).toEqual(['> ', '> ', '']);
    expect(projection.quoted).toEqual([true, true, false]);
    expect(projection.depths).toEqual([1, 1, 0]);
    // starts are line starts in `source`; prefixes give the content offset.
    expect(projection.starts).toEqual([0, 6, 12]);
    expect(source.slice(projection.starts[1] + projection.prefixes[1].length)).toBe('第二行\n第三行');
  });

  it('strips a nested "> > " chain and records the depth', () => {
    const projection = projectQuoteLines('> > 甲', '');
    expect(projection.lines).toEqual(['甲']);
    expect(projection.prefixes).toEqual(['> > ']);
    expect(projection.quoted).toEqual([true]);
    expect(projection.depths).toEqual([2]);
  });

  it('removes list indentation but keeps the ">" chain', () => {
    const projection = projectQuoteLines('  > 甲', '  ');
    expect(projection.lines).toEqual(['甲']);
    expect(projection.prefixes).toEqual(['  > ']);
    expect(projection.depths).toEqual([1]);
  });

  it('marks lazy continuation lines as unquoted with no prefix', () => {
    const projection = projectQuoteLines('> 第一行\n第二行', '');
    expect(projection.lines).toEqual(['第一行', '第二行']);
    expect(projection.prefixes).toEqual(['> ', '']);
    expect(projection.quoted).toEqual([true, false]);
    expect(projection.depths).toEqual([1, 0]);
  });

  it('keeps leading whitespace of the content in the prefix', () => {
    const projection = projectQuoteLines('>   | a | b |', '');
    expect(projection.lines).toEqual(['  | a | b |']);
    expect(projection.prefixes).toEqual(['>   ']);
  });
});

const fixtureSource = [
  '> # 标题',
  '> 第一段',
  '> 第二段 lazy 续行',
  '>',
  '> - 列表一',
  '> - 列表二',
  '>   - 嵌套项',
  '>',
  '> ```js',
  '> const a = 1;',
  '> ```',
  '>',
  '> > 嵌套引用',
  '>',
  '> 最后一段',
].join('\n');

const fixtureProjection = projectQuoteLines(fixtureSource, '');
const fixtureBlocks = scanQuoteBlocks(fixtureProjection.lines, fixtureProjection.depths);

describe('scanQuoteBlocks', () => {
  it('splits headings, lazy paragraphs, lists, fences, quotes and trailing paragraphs', () => {
    expect(fixtureBlocks.map((b) => [b.kind, b.startLine, b.endLine])).toEqual([
      ['heading', 0, 0],
      ['paragraph', 1, 2],
      ['list', 4, 6],
      ['code', 8, 10],
      ['blockquote', 12, 12],
      ['paragraph', 14, 14],
    ]);
    expect(fixtureBlocks[2].itemStarts).toEqual([4, 5]); // nested item is not a top-level item
  });

  it('treats a setext underline as part of the heading above', () => {
    const blocks = scanQuoteBlocks(['标题', '===']);
    expect(blocks).toEqual([{ startLine: 0, endLine: 1, kind: 'heading', itemStarts: [] }]);
  });

  it('recognises thematic breaks only when no paragraph precedes them', () => {
    expect(scanQuoteBlocks(['***'])).toEqual([
      { startLine: 0, endLine: 0, kind: 'hr', itemStarts: [] },
    ]);
    // `---` after a paragraph is a setext heading, not a break.
    expect(scanQuoteBlocks(['段落', '---'])[0].kind).toBe('heading');
  });

  it('keeps an HTML table together and an unterminated one to the end', () => {
    const blocks = scanQuoteBlocks(['<table>', '  <tr><td>1</td></tr>', '</table>']);
    expect(blocks).toEqual([{ startLine: 0, endLine: 2, kind: 'table', itemStarts: [] }]);

    const unterminated = scanQuoteBlocks(['<table>', '  <tr><td>1</td></tr>']);
    expect(unterminated[0]).toMatchObject({ kind: 'table', startLine: 0, endLine: 1 });
  });

  it('records ordered-list items and keeps a loose list in one block', () => {
    const loose = scanQuoteBlocks(['- a', '', '- b']);
    expect(loose).toEqual([{ startLine: 0, endLine: 2, kind: 'list', itemStarts: [0, 2] }]);

    const ordered = scanQuoteBlocks(['1. a', '2. b']);
    expect(ordered[0].itemStarts).toEqual([0, 1]);
  });

  it('ends a list at a blank line followed by a paragraph', () => {
    const blocks = scanQuoteBlocks(['- a', '', '段落']);
    expect(blocks.map((b) => b.kind)).toEqual(['list', 'paragraph']);
    expect(blocks[0]).toMatchObject({ startLine: 0, endLine: 0, itemStarts: [0] });
    expect(blocks[1]).toMatchObject({ startLine: 2, endLine: 2 });
  });

  it('absorbs a lazy continuation line into the list item', () => {
    const blocks = scanQuoteBlocks(['- a', '续行', '继续']);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('list');
    expect(blocks[0].endLine).toBe(2);
  });
});

describe('resolveQuoteLine', () => {
  it('maps a rendered block index to its first source line', () => {
    expect(resolveQuoteLine(fixtureBlocks, 6, 0)).toBe(0);
    expect(resolveQuoteLine(fixtureBlocks, 6, 1)).toBe(1);
    expect(resolveQuoteLine(fixtureBlocks, 6, 3)).toBe(8);
    expect(resolveQuoteLine(fixtureBlocks, 6, 4)).toBe(12); // nested quote
  });

  it('maps a list item to that item own line', () => {
    expect(resolveQuoteLine(fixtureBlocks, 6, 2, 0, 2)).toBe(4);
    expect(resolveQuoteLine(fixtureBlocks, 6, 2, 1, 2)).toBe(5);
  });

  it('falls back to the list start when the item counts disagree', () => {
    expect(resolveQuoteLine(fixtureBlocks, 6, 2, 1, 3)).toBe(4);
  });

  it('refuses to guess when the rendered block count differs', () => {
    expect(resolveQuoteLine(fixtureBlocks, 5, 1)).toBeNull();
    expect(resolveQuoteLine(fixtureBlocks, 7, 1)).toBeNull();
  });

  it('refuses out-of-range indices', () => {
    expect(resolveQuoteLine(fixtureBlocks, 6, -1)).toBeNull();
    expect(resolveQuoteLine(fixtureBlocks, 6, 6)).toBeNull();
    expect(resolveQuoteLine(fixtureBlocks, 6, 2, 5, 2)).toBe(4); // bad item index -> block start
  });
});

describe('QuoteBlock shape', () => {
  it('is exported for consumers that model rendered blocks', () => {
    const block: QuoteBlock = { startLine: 0, endLine: 0, kind: 'paragraph', itemStarts: [] };
    expect(block.kind).toBe('paragraph');
  });
});
