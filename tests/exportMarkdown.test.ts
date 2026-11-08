import { describe, expect, it } from 'vitest';

import { exportMarkdown } from '../src/model/exportMarkdown';

const simpleHtml = [
  '<table>',
  '  <tr><th>甲</th><th>乙</th></tr>',
  '  <tr><td>1</td><td>2</td></tr>',
  '</table>',
].join('\n');

const mergedHtml = [
  '<table>',
  '  <tr><th colspan="2">合并</th></tr>',
  '  <tr><td>a</td><td>b</td></tr>',
  '</table>',
].join('\n');

describe('exportMarkdown', () => {
  it('converts a representable top-level HTML table to pipe syntax', () => {
    const source = ['# 标题', '', simpleHtml, '', '结尾'].join('\n');
    const result = exportMarkdown(source);

    expect(result.converted).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.text).not.toContain('<table>');
    expect(result.text).toContain('| 甲 | 乙 |');
    expect(result.text).toContain('| 1 | 2 |');
    expect(result.text.startsWith('# 标题\n\n')).toBe(true);
    expect(result.text.endsWith('\n结尾')).toBe(true);
  });

  it('leaves merged tables as HTML and counts them as skipped', () => {
    const source = ['前言', '', mergedHtml, '', '后记'].join('\n');
    const result = exportMarkdown(source);

    expect(result.converted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.text).toBe(source);
  });

  it('leaves front matter and fenced code untouched', () => {
    const source = [
      '---',
      'title: 测试',
      '---',
      '',
      '```md',
      simpleHtml,
      '```',
      '',
      simpleHtml,
    ].join('\n');
    const result = exportMarkdown(source);

    expect(result.converted).toBe(1);
    expect(result.text.startsWith('---\ntitle: 测试\n---\n')).toBe(true);
    expect(result.text).toContain('```md\n' + simpleHtml + '\n```');
  });

  it('converts a table inside a quote and keeps the "> " prefix', () => {
    const source = [
      '> 引用',
      '>',
      '> <table>',
      '>   <tr><th>甲</th></tr>',
      '>   <tr><td>1</td></tr>',
      '> </table>',
      '',
      '后文',
    ].join('\n');
    const result = exportMarkdown(source);

    expect(result.converted).toBe(1);
    expect(result.text).toContain('> | 甲 |\n> | --- |\n> | 1 |');
    expect(result.text).not.toContain('> <table>');
    expect(result.text.endsWith('\n\n后文')).toBe(true);
  });

  it('keeps list indentation when converting a table nested in a list item', () => {
    const source = ['- 项目', '  <table>', '    <tr><th>a</th></tr>', '    <tr><td>1</td></tr>', '  </table>'].join(
      '\n',
    );
    const result = exportMarkdown(source);

    expect(result.converted).toBe(1);
    expect(result.text).toContain('- 项目\n  | a |\n  | --- |\n  | 1 |');
  });

  it('converts several tables in one pass without shifting offsets', () => {
    const source = ['A', '', simpleHtml, '', 'B', '', simpleHtml, '', 'C'].join('\n');
    const result = exportMarkdown(source);

    expect(result.converted).toBe(2);
    expect(result.text).not.toContain('<table>');
    expect(result.text.match(/\| 甲 \| 乙 \|/g)).toHaveLength(2);
    expect(result.text.startsWith('A\n\n| 甲 | 乙 |')).toBe(true);
    expect(result.text.endsWith('| 1 | 2 |\n\nC')).toBe(true);
  });

  it('leaves callout content untouched', () => {
    const source = ['> [!note]', '> 提示', '> <table>', '>   <tr><th>a</th></tr>', '>   <tr><td>1</td></tr>', '> </table>'].join(
      '\n',
    );
    const result = exportMarkdown(source);

    expect(result.converted).toBe(0);
    expect(result.text).toBe(source);
  });

  it('does nothing when the document has no HTML tables', () => {
    const source = ['# 标题', '', '| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n');
    const result = exportMarkdown(source);

    expect(result.converted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.text).toBe(source);
  });

  it('normalizes CRLF to LF', () => {
    const source = ['# 标题', '', simpleHtml].join('\r\n');
    const result = exportMarkdown(source);

    expect(result.converted).toBe(1);
    expect(result.text).not.toContain('\r');
  });
});
