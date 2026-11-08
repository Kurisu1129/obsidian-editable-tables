import { Notice } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { serializeHtmlTable } from '../model/serializeHtml';
import { chooseWriteFormat, serializePipeTable } from '../model/serializePipe';
import type { TableGrid } from '../model/types';
import type { TableRegion } from './region';

let noticeSeen = true;
let persistNotice = (): void => {};

/** Wired up once from the plugin's onload, so the disclosure survives restarts. */
export function configureWriteback(opts: {
  noticeSeen: boolean;
  onNoticeShown: () => void;
}): void {
  noticeSeen = opts.noticeSeen;
  persistNotice = opts.onNoticeShown;
}

/**
 * R8 — the D3 trade-off must never be silent.
 *
 * A pipe table can only fall back to HTML when its grid cannot be expressed as a pipe
 * table any more (a merge, or cell text the pipe syntax cannot carry). That is the
 * moment the user loses inline-Markdown rendering inside cells, so say so once.
 */
function discloseHtmlConversion(): void {
  if (noticeSeen) return;
  noticeSeen = true;
  persistNotice();
  new Notice(
    '表格里有合并单元格或管道语法无法表示的内容，已改用 HTML 存储。\n' +
      '代价：单元格内的 Markdown 行内格式（**粗体**、[链接] 等）会变成字面文本。\n' +
      '只有你实际编辑过的表格会被改写，其余笔记内容不受影响。',
    10000,
  );
}

export interface CommitOptions {
  /**
   * Explicitly ask for Markdown pipe syntax (the toolbar's 转 MD action). When the grid
   * cannot be represented as a pipe table, the write is refused instead of silently
   * falling back to HTML.
   */
  forcePipe?: boolean;
}

/**
 * Replaces a table's source range with the serialized form of `grid`.
 *
 * This is the only place the plugin writes to a document. It is always a
 * targeted range replacement of a single block, so:
 *  - everything outside the edited table is left byte-for-byte intact (R1/AC3),
 *  - a table the user never touches is never rewritten (R7/AC9).
 *
 * Format: a pipe table stays GFM pipe syntax whenever the edited grid still allows it,
 * so the rendered editor never turns the user's Markdown into HTML by itself. HTML is
 * reserved for structures pipe tables cannot express (merged cells). See
 * `chooseWriteFormat` for the exact policy.
 */
export function commitGrid(
  view: EditorView,
  region: TableRegion,
  grid: TableGrid,
  opts: CommitOptions = {},
): boolean {
  const current = view.state.doc.sliceString(region.from, region.to);

  // The captured offsets must still describe the block we rendered. `WidgetType.eq`
  // already rebuilds the widget when they drift, but this is the last gate before a
  // write: if it does not match, whatever now lives at those coordinates is not ours
  // to replace.
  if (current !== region.source) return false;

  const format = chooseWriteFormat(region.tableKind, grid, opts);
  if (format === null) return false; // explicit pipe request we cannot honour

  const lines =
    format === 'pipe'
      ? serializePipeTable(grid, region.indent)
      : serializeHtmlTable(grid, region.indent);
  if (lines.length === 0) return false; // defensive: serializer refused the grid

  const insert = lines.join('\n');
  if (current === insert) return false; // no-op edits must not dirty the document

  if (format === 'html' && region.tableKind === 'pipe') discloseHtmlConversion();

  view.dispatch({
    changes: { from: region.from, to: region.to, insert },
    scrollIntoView: false,
  });
  return true;
}
