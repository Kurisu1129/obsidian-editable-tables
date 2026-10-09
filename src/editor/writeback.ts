import { Notice } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { serializeHtmlTable } from '../model/serializeHtml';
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
 * The first time a pipe table is rewritten as HTML, the user is told that inline
 * Markdown inside cells degrades to literal text. Shown once, then persisted.
 */
function discloseHtmlConversion(): void {
  if (noticeSeen) return;
  noticeSeen = true;
  persistNotice();
  new Notice(
    '表格已改写为 HTML 存储。\n' +
      '代价：单元格内的 Markdown 行内格式（**粗体**、[链接] 等）会变成字面文本。\n' +
      '只有你实际编辑过的表格会被改写，其余笔记内容不受影响。',
    10000,
  );
}

/**
 * Replaces a table's source range with the serialized form of `grid`.
 *
 * This is the only place the plugin writes to a document. It is always a
 * targeted range replacement of a single block, so:
 *  - everything outside the edited table is left byte-for-byte intact (R1/AC3),
 *  - a table the user never touches is never rewritten (R7/AC9).
 *
 * Per D3 the output is always an HTML <table>, so a pipe table becomes HTML the
 * first time it is edited. That is the documented, deliberate cost of the
 * uniform storage model.
 */
export function commitGrid(view: EditorView, region: TableRegion, grid: TableGrid): boolean {
  const current = view.state.doc.sliceString(region.from, region.to);

  // The captured offsets must still describe the block we rendered. `WidgetType.eq`
  // already rebuilds the widget when they drift, but this is the last gate before a
  // write: if it does not match, whatever now lives at those coordinates is not ours
  // to replace.
  if (current !== region.source) return false;

  const insert = serializeHtmlTable(grid, region.indent).join('\n');
  if (current === insert) return false; // no-op edits must not dirty the document

  if (region.kind === 'pipe') discloseHtmlConversion();

  view.dispatch({
    changes: { from: region.from, to: region.to, insert },
    scrollIntoView: false,
  });
  return true;
}
