import type { EditorView } from '@codemirror/view';
import type { TableRegion } from '../editor/region';
import { applyBlockIndent } from '../editor/indent';
import { commitGrid } from '../editor/writeback';
import {
  cloneGrid,
  deleteCol,
  deleteRow,
  insertCol,
  insertRow,
  mergeCells,
  setColAlign,
  splitCell,
} from '../model/grid';
import type { Align, TableGrid } from '../model/types';

/** Inclusive cell rectangle, in logical grid coordinates. */
interface Selection {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/** The cell the user is currently editing, if any. */
interface EditingCell {
  r: number;
  c: number;
  el: HTMLElement;
  dirty: boolean;
}

/**
 * Mutable interaction state for one rendered table.
 *
 * `grid` lags the document: it holds cell edits that have been typed but not yet
 * committed. Folding it in before a structural action is what stops the toolbar from
 * discarding in-progress typing (the toolbar's `mousedown` suppresses the blur that
 * would otherwise commit the cell).
 */
interface EditorState {
  sel: Selection | null;
  grid: TableGrid;
  editing: EditingCell | null;
  /**
   * A left-button drag in progress, anchored on the cell where it started.
   * `moved` flips once the pointer enters a *different* cell: until then a press is
   * still a click (which focuses the cell for editing), not a range selection.
   */
  drag: { r: number; c: number; moved: boolean } | null;
}

export interface TableEditorOptions {
  /** Selection-memory key. Unique per table within one editor. */
  key: number;
  /** The region captured when this editor was created. */
  region: TableRegion;
  /**
   * Re-resolves the region's current document position immediately before a write.
   * Returning null aborts the write.
   *
   * Top-level tables omit this: `TableWidget.eq` rebuilds the DOM whenever the offsets
   * drift, so the captured region is always fresh. Tables embedded in a quote DO pass it,
   * because `QuoteWidget.eq` deliberately ignores offsets (they may shift while the
   * rendered DOM is reused); the quote's position is resolved from the DOM at write time.
   */
  resolve?: () => TableRegion | null;
  /**
   * Whether the root must carry the owning list item's indentation. True for top-level
   * block widgets; false inside a quote, where the quote itself already provides it.
   */
  applyIndent?: boolean;
}

/**
 * The interactive table: toolbar + editable grid + selection.
 *
 * Extracted from `TableWidget` so the exact same implementation serves tables rendered
 * as top-level block widgets and tables embedded in a rendered blockquote. The only
 * difference is how the current document range is resolved before writing.
 */
export class TableEditor {
  readonly element: HTMLElement;

  private readonly view: EditorView;
  private readonly key: number;
  private readonly region: TableRegion;
  private readonly resolver: (() => TableRegion | null) | null;
  private readonly state: EditorState;
  private readonly observer: ResizeObserver;
  private barEl: HTMLElement;
  private destroyed = false;

  constructor(view: EditorView, opts: TableEditorOptions) {
    this.view = view;
    this.key = opts.key;
    this.region = opts.region;
    this.resolver = opts.resolve ?? null;

    this.state = {
      sel: selectionMap(view).get(opts.key) ?? null,
      // A private copy: the region's grid is shared with the (cached) region field, so
      // mutating it would leak uncommitted cell text into later re-renders.
      grid: cloneGrid(opts.region.grid),
      editing: null,
      drag: null,
    };

    this.element = document.createElement('div');
    this.element.className = 'mdft-table';
    this.element.setAttribute('contenteditable', 'false');

    // The widget's own height can change without any document transaction (e.g. typing
    // wraps a cell). Without this, CM6's heightmap goes stale mid-edit and clicks below
    // the table land on the wrong line.
    this.observer = new ResizeObserver(() => view.requestMeasure());
    this.observer.observe(this.element);

    // The toolbar is re-rendered whenever the selection changes, so its enabled /
    // active states track the current cell. Only the toolbar is replaced — re-rendering
    // the table would destroy the contenteditable the user just clicked into.
    this.barEl = this.buildToolbar();
    const refreshToolbar = (): void => {
      const next = this.buildToolbar();
      this.barEl.replaceWith(next);
      this.barEl = next;
    };

    // `markdown-rendered` opts the table into Obsidian's canonical table rules, but it
    // also brings `contain: paint`, which CLIPS overflow. It therefore lives on an inner
    // wrapper: on the root it would clip away the toolbar that floats above the table.
    const body = document.createElement('div');
    body.className = 'mdft-table__body markdown-rendered';
    body.appendChild(this.buildTable(refreshToolbar));

    this.element.replaceChildren(this.barEl, body);
    rememberSelection(view, opts.key, this.state.sel);

    if (opts.applyIndent !== false) {
      // Unlike a `.cm-line`, a block widget inherits no list indentation; measure the
      // owning item and pad the widget to match it (AC17).
      applyBlockIndent(this.element, opts.region.indent);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.observer.disconnect();
  }

  // ------------------------------------------------------------------ table DOM

  private buildTable(onSelectionChange: () => void): HTMLElement {
    const grid = this.state.grid;
    const table = document.createElement('table');
    table.className = 'mdft-table__el';

    for (let r = 0; r < grid.cells.length; r++) {
      const tr = document.createElement('tr');
      const isHeaderRow = r === 0 && grid.hasHeader;

      for (let c = 0; c < grid.cells[r].length; c++) {
        const cell = grid.cells[r][c];
        if (cell.covered) continue;

        const el = document.createElement(isHeaderRow ? 'th' : 'td');
        el.className = 'mdft-cell';
        el.dir = isHeaderRow ? 'ltr' : 'auto';
        el.dataset.row = String(r);
        el.dataset.col = String(c);
        if (cell.rowSpan > 1) el.rowSpan = cell.rowSpan;
        if (cell.colSpan > 1) el.colSpan = cell.colSpan;

        const align = grid.colAlign[c];
        if (align && align !== 'default') el.style.textAlign = align;
        if (this.state.sel && contains(this.state.sel, r, c)) el.classList.add('mdft-selected');

        const inner = document.createElement('div');
        inner.className = 'mdft-cell-wrapper';
        inner.setAttribute('contenteditable', 'plaintext-only');
        inner.spellcheck = false;
        paintCell(inner, cell);

        this.wireCell(inner, el, r, c, onSelectionChange);
        el.appendChild(inner);
        tr.appendChild(el);
      }
      table.appendChild(tr);
    }
    return table;
  }

  /** Folds an in-progress cell edit into `state.grid`. Returns true when it changed. */
  private foldPendingEdit(): boolean {
    const editing = this.state.editing;
    if (!editing || !editing.dirty) return false;
    editing.dirty = false;

    const cell = this.state.grid.cells[editing.r]?.[editing.c];
    if (!cell) return false;

    const text = (editing.el.textContent ?? '').replace(/​/g, '').trim();
    if (cell.text === text && cell.raw === undefined) return false;

    cell.text = text;
    cell.raw = undefined; // an edited cell loses its original markup
    return true;
  }

  /** The region to write to right now, or null when its position can no longer be trusted. */
  private currentRegion(): TableRegion | null {
    return this.resolver ? this.resolver() : this.region;
  }

  /** Editing, selection and commit handling for a single cell. */
  private wireCell(
    inner: HTMLElement,
    cellEl: HTMLElement,
    r: number,
    c: number,
    onSelectionChange: () => void,
  ): void {
    const view = this.view;
    const state = this.state;

    inner.addEventListener('focus', () => {
      state.editing = { r, c, el: inner, dirty: false };
    });
    inner.addEventListener('input', () => {
      if (state.editing?.el === inner) state.editing.dirty = true;
      else state.editing = { r, c, el: inner, dirty: true };
    });

    /** Repaints the highlight in place — a table rebuild would drop the click-to-type focus. */
    const repaintHighlight = (): void => {
      const table = cellEl.closest('table');
      if (!table) return;
      for (const node of Array.from(table.querySelectorAll<HTMLElement>('.mdft-cell'))) {
        const cr = Number(node.dataset.row);
        const cc = Number(node.dataset.col);
        node.classList.toggle('mdft-selected', !!state.sel && contains(state.sel, cr, cc));
      }
    };

    cellEl.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      if (ev.shiftKey && state.sel) {
        ev.preventDefault(); // keep the browser from starting a text selection drag
        state.sel = { ...state.sel, r2: r, c2: c };
        state.drag = null;
      } else {
        state.sel = { r1: r, c1: c, r2: r, c2: c };
        // Not preventDefault: a plain press must still focus the cell so click-to-type
        // works. The press only becomes a range drag once the pointer enters another
        // cell while the button is held (see the mouseover handler below).
        state.drag = { r, c, moved: false };
        window.addEventListener('mouseup', endDrag, { once: true, capture: true });
      }
      rememberSelection(view, this.key, state.sel);
      repaintHighlight();
      onSelectionChange();
    });

    /**
     * Ends the drag even when the pointer is released outside the widget. `once` keeps
     * at most one live listener per press; a widget rebuild discards `state` anyway.
     */
    const endDrag = (): void => {
      state.drag = null;
      cellEl.closest('.mdft-table')?.classList.remove('is-dragging');
    };

    /**
     * Extends the range while the left button is held and the pointer moves to another
     * cell. `mouseover` (not `mouseenter`) bubbles, so the handler also fires when the
     * pointer passes over the cell's inner contenteditable.
     */
    cellEl.addEventListener('mouseover', (ev) => {
      const drag = state.drag;
      if (!drag || !(ev.buttons & 1)) return;

      if (!drag.moved) {
        drag.moved = true;
        // The press already started a text selection and focused the anchor cell.
        // Cancel both: from here on this is a cell-range drag, not click-to-edit.
        cellEl.closest('.mdft-table')?.classList.add('is-dragging');
        window.getSelection()?.removeAllRanges();
        const active = document.activeElement;
        if (
          active instanceof HTMLElement &&
          active.closest('.mdft-table') === cellEl.closest('.mdft-table')
        ) {
          active.blur();
        }
      }

      const next: Selection = { r1: drag.r, c1: drag.c, r2: r, c2: c };
      if (
        state.sel &&
        state.sel.r1 === next.r1 &&
        state.sel.c1 === next.c1 &&
        state.sel.r2 === next.r2 &&
        state.sel.c2 === next.c2
      ) {
        return; // same cell again — do not rebuild the toolbar on every mouseover
      }
      state.sel = next;
      rememberSelection(view, this.key, state.sel);
      repaintHighlight();
      onSelectionChange();
    });

    const commit = (): void => {
      if (!this.foldPendingEdit()) return;
      const region = this.currentRegion();
      if (!region) return;
      commitGrid(view, region, state.grid);
      // Hand focus back to the editor so undo/redo and other keymaps keep working.
      view.focus();
    };

    inner.addEventListener('blur', commit);

    inner.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        if (state.editing?.el === inner) state.editing = null;
        const original = state.grid.cells[r]?.[c];
        if (original) paintCell(inner, original); // restores markup, not just its text
        inner.blur();
        return;
      }
      // Cells are single-line by construction — Enter commits rather than breaking the row.
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        commit();
        inner.blur();
      }
    });
  }

  // ------------------------------------------------------------------- toolbar

  private buildToolbar(): HTMLElement {
    const view = this.view;
    const state = this.state;
    const bar = document.createElement('div');
    bar.className = 'mdft-toolbar';
    bar.setAttribute('contenteditable', 'false');

    const grid = state.grid;
    // Read the selection at click time — it may have changed since this bar was built.
    const anchor = (): Selection | null => (state.sel ? ordered(state.sel) : null);
    const row = (): number => anchor()?.r1 ?? 0;
    const col = (): number => anchor()?.c1 ?? 0;
    const isMulti = (): boolean => {
      const a = anchor();
      return !!a && (a.r1 !== a.r2 || a.c1 !== a.c2);
    };

    const apply = (fn: (g: TableGrid) => TableGrid): void => {
      // Carry any half-typed cell into the same dispatch, then drop the selection
      // *before* dispatching: the decoration rebuild happens synchronously inside the
      // dispatch, and the replacement widget would otherwise pick up a selection whose
      // cells may no longer exist.
      this.foldPendingEdit();
      selectionMap(view).delete(this.key);
      const region = this.currentRegion();
      if (region && commitGrid(view, region, fn(state.grid))) view.focus();
    };

    const add = (
      label: string,
      title: string,
      action: (() => void) | null,
      opts: { active?: boolean } = {},
    ): void => {
      const b = document.createElement('button');
      b.className = 'mdft-btn';
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-label', title);
      if (action === null) b.disabled = true;
      else {
        b.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          action();
        });
      }
      if (opts.active) b.classList.add('is-active');
      bar.appendChild(b);
    };

    const sep = (): void => {
      const s = document.createElement('span');
      s.className = 'mdft-sep';
      bar.appendChild(s);
    };

    add('↑行', '在上方插入行', () => apply((g) => insertRow(g, row())));
    add('↓行', '在下方插入行', () => apply((g) => insertRow(g, row() + 1)));
    add('−行', '删除本行', () => apply((g) => deleteRow(g, row())));
    sep();

    add('←列', '在左侧插入列', () => apply((g) => insertCol(g, col())));
    add('→列', '在右侧插入列', () => apply((g) => insertCol(g, col() + 1)));
    add('−列', '删除本列', () => apply((g) => deleteCol(g, col())));
    sep();

    const aligns: { a: Align; label: string; title: string }[] = [
      { a: 'left', label: '左', title: '本列左对齐' },
      { a: 'center', label: '中', title: '本列居中' },
      { a: 'right', label: '右', title: '本列右对齐' },
    ];
    for (const { a, label, title } of aligns) {
      add(label, title, () => apply((g) => setColAlign(g, col(), a)), {
        active: grid.colAlign[col()] === a,
      });
    }
    sep();

    const multi = isMulti();
    add(
      '合并',
      multi
        ? `合并选中的 ${anchor()!.r2 - anchor()!.r1 + 1}×${anchor()!.c2 - anchor()!.c1 + 1} 区域`
        : '拖拽框选，或按住 Shift 单击另一格，多选后可合并',
      multi
        ? () =>
            apply((g) => {
              const a = anchor()!;
              return mergeCells(g, a.r1, a.c1, a.r2, a.c2);
            })
        : null,
    );
    add('拆分', '把合并的单元格拆开', () => apply((g) => splitCell(g, row(), col())));
    sep();

    add('源码', '展开源码以便直接编辑 Markdown 文本', () => {
      const region = this.currentRegion();
      if (!region) return;
      view.dispatch({ selection: { anchor: region.from } });
      view.focus();
    });

    return bar;
  }
}

function ordered(sel: Selection): Selection {
  return {
    r1: Math.min(sel.r1, sel.r2),
    r2: Math.max(sel.r1, sel.r2),
    c1: Math.min(sel.c1, sel.c2),
    c2: Math.max(sel.c1, sel.c2),
  };
}

function contains(sel: Selection, r: number, c: number): boolean {
  const n = ordered(sel);
  return r >= n.r1 && r <= n.r2 && c >= n.c1 && c <= n.c2;
}

function paintCell(inner: HTMLElement, cell: { text: string; raw?: string }): void {
  if (cell.raw !== undefined) {
    inner.innerHTML = cell.raw;
  } else if (cell.text === '') {
    inner.replaceChildren(document.createElement('br'));
  } else {
    inner.textContent = cell.text;
  }
}

// --------------------------------------------------------------- widget-owned state

/**
 * Cell selections, keyed per editor *and* per table.
 *
 * Keying on the offset alone leaks across notes: a table at the same offset in another
 * file would inherit the previous file's selection, letting a merge action operate on
 * cells the user never picked. The WeakMap means a closed editor's state is collectable.
 */
const selectionMaps = new WeakMap<EditorView, Map<number, Selection | null>>();

function selectionMap(view: EditorView): Map<number, Selection | null> {
  let map = selectionMaps.get(view);
  if (!map) {
    map = new Map();
    selectionMaps.set(view, map);
  }
  return map;
}

const MAX_REMEMBERED_SELECTIONS = 64;

function rememberSelection(view: EditorView, key: number, sel: Selection | null): void {
  const map = selectionMap(view);
  // Block offsets shift as the document is edited, so entries go stale rather than
  // being cleanly removed. Bound the map instead of letting it grow without limit.
  if (map.size > MAX_REMEMBERED_SELECTIONS) map.clear();
  map.set(key, sel);
}
