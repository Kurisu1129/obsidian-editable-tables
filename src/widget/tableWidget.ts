import type { EditorView } from '@codemirror/view';
import { WidgetType } from '@codemirror/view';
import type { TableRegion } from '../editor/region';
import { TableEditor } from './tableEditor';

/**
 * Block widget that renders a TableGrid as an interactive <table>.
 *
 * The interaction model itself lives in `TableEditor`, which is shared with tables
 * embedded inside a rendered blockquote, so the two can never drift apart. This class is
 * only the CM6-facing shell: equality, event ownership, DOM lifecycle.
 *
 * Interaction model:
 *  - cells are individually editable (`contenteditable=plaintext-only`), committed
 *    on blur / Enter and reverted on Escape;
 *  - shift-click / dragging extends a cell range, which the toolbar's merge action consumes;
 *  - every structural action funnels through the pure ops in model/grid.ts and is
 *    written back by a single targeted range replacement (editor/writeback.ts).
 */
export class TableWidget extends WidgetType {
  constructor(readonly region: TableRegion) {
    super();
  }

  /**
   * CM6 reuses an existing widget's DOM — including the event handlers bound in
   * `toDOM`, which close over `this.region` — when `eq` returns true.
   *
   * Comparing the source alone is NOT enough: an edit above the table leaves the
   * source identical while shifting every offset, so the reused handlers would
   * dispatch a replacement over the wrong range and corrupt the document. Comparing
   * the offsets too means the DOM is only reused when the captured region is still
   * valid, and is rebuilt with fresh handlers otherwise.
   */
  eq(other: TableWidget): boolean {
    return (
      other.region.source === this.region.source &&
      other.region.from === this.region.from &&
      other.region.to === this.region.to
    );
  }

  /** CM6 must not move its own selection when the user interacts with the widget. */
  ignoreEvent(): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const editor = new TableEditor(view, {
      key: this.region.from,
      region: this.region,
    });
    editors.set(editor.element, editor);
    return editor.element;
  }

  destroy(dom: HTMLElement): void {
    editors.get(dom)?.destroy();
    editors.delete(dom);
  }
}

/** Live editors, so `destroy` can disconnect the ResizeObserver when CM6 drops the DOM. */
const editors = new WeakMap<HTMLElement, TableEditor>();
