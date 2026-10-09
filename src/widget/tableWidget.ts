import type { EditorView } from '@codemirror/view';
import { WidgetType } from '@codemirror/view';
import type { TableRegion } from '../editor/region';
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
 * Mutable interaction state for one rendered widget.
 *
 * `grid` lags the document: it holds cell edits that have been typed but not yet
 * committed. Folding it in before a structural action is what stops the toolbar from
 * discarding in-progress typing (the toolbar's `mousedown` suppresses the blur that
 * would otherwise commit the cell).
 */
interface WidgetState {
  sel: Selection | null;
  grid: TableGrid;
  editing: EditingCell | null;
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

/**
 * Block widget that renders a TableGrid as an interactive <table>.
 *
 * DOM shape mirrors Obsidian's own table widget so the two are visually
 * indistinguishable: cell padding is carried by an inner wrapper, and empty
 * cells hold a <br> so their row keeps the same height as populated rows.
 *
 * Interaction model:
 *  - cells are individually editable (`contenteditable=plaintext-only`), committed
 *    on blur / Enter and reverted on Escape;
 *  - shift-click extends a cell range, which the toolbar's merge action consumes;
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
    const wrap = document.createElement('div');
    wrap.className = 'mdft-table';
    wrap.setAttribute('contenteditable', 'false');

    const state: WidgetState = {
      sel: selectionMap(view).get(this.region.from) ?? null,
      // A private copy: the region's grid is shared with the (cached) region field, so
      // mutating it would leak uncommitted cell text into later re-renders.
      grid: cloneGrid(this.region.grid),
      editing: null,
    };

    // The widget's own height can change without any document transaction (e.g. typing
    // wraps a cell). Without this, CM6's heightmap goes stale mid-edit and clicks below
    // the table land on the wrong line.
    const observer = new ResizeObserver(() => view.requestMeasure());
    observer.observe(wrap);
    observers.set(wrap, observer);

    // The toolbar is re-rendered whenever the selection changes, so its enabled /
    // active states track the current cell. Only the toolbar is replaced — re-rendering
    // the table would destroy the contenteditable the user just clicked into.
    let barEl = this.buildToolbar(view, state);
    const refreshToolbar = (): void => {
      const next = this.buildToolbar(view, state);
      barEl.replaceWith(next);
      barEl = next;
    };

    // `markdown-rendered` opts the table into Obsidian's canonical table rules, but it
    // also brings `contain: paint`, which CLIPS overflow. It therefore lives on an inner
    // wrapper: on the root it would clip away the toolbar that floats above the table.
    const body = document.createElement('div');
    body.className = 'mdft-table__body markdown-rendered';
    body.appendChild(this.buildTable(view, state, refreshToolbar));

    wrap.replaceChildren(barEl, body);
    rememberSelection(view, this.region.from, state.sel);
    return wrap;
  }

  destroy(dom: HTMLElement): void {
    observers.get(dom)?.disconnect();
    observers.delete(dom);
  }

  // ------------------------------------------------------------------ table DOM

  private buildTable(
    view: EditorView,
    state: WidgetState,
    onSelectionChange: () => void,
  ): HTMLElement {
    const grid = state.grid;
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
        if (state.sel && contains(state.sel, r, c)) el.classList.add('mdft-selected');

        const inner = document.createElement('div');
        inner.className = 'mdft-cell-wrapper';
        inner.setAttribute('contenteditable', 'plaintext-only');
        inner.spellcheck = false;
        paintCell(inner, cell);

        this.wireCell(inner, el, view, r, c, state, onSelectionChange);
        el.appendChild(inner);
        tr.appendChild(el);
      }
      table.appendChild(tr);
    }
    return table;
  }

  /** Folds an in-progress cell edit into `state.grid`. Returns true when it changed. */
  private foldPendingEdit(state: WidgetState): boolean {
    const editing = state.editing;
    if (!editing || !editing.dirty) return false;
    editing.dirty = false;

    const cell = state.grid.cells[editing.r]?.[editing.c];
    if (!cell) return false;

    const text = (editing.el.textContent ?? '').replace(/​/g, '').trim();
    if (cell.text === text && cell.raw === undefined) return false;

    cell.text = text;
    cell.raw = undefined; // an edited cell loses its original markup
    return true;
  }

  /** Editing, selection and commit handling for a single cell. */
  private wireCell(
    inner: HTMLElement,
    cellEl: HTMLElement,
    view: EditorView,
    r: number,
    c: number,
    state: WidgetState,
    onSelectionChange: () => void,
  ): void {
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
      if (ev.shiftKey && state.sel) {
        ev.preventDefault(); // keep the browser from starting a text selection drag
        state.sel = { ...state.sel, r2: r, c2: c };
      } else {
        state.sel = { r1: r, c1: c, r2: r, c2: c };
      }
      rememberSelection(view, this.region.from, state.sel);
      repaintHighlight();
      onSelectionChange();
    });

    const commit = (): void => {
      if (!this.foldPendingEdit(state)) return;
      commitGrid(view, this.region, state.grid);
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

  private buildToolbar(view: EditorView, state: WidgetState): HTMLElement {
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
      this.foldPendingEdit(state);
      selectionMap(view).delete(this.region.from);
      if (commitGrid(view, this.region, fn(state.grid))) view.focus();
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

    add(
      '合并',
      isMulti() ? '合并选中的单元格' : '先按住 Shift 点击以选中一片单元格',
      isMulti()
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
      view.dispatch({ selection: { anchor: this.region.from } });
      view.focus();
    });

    return bar;
  }
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
 * Cell selections, keyed per editor *and* per block offset.
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

function rememberSelection(view: EditorView, from: number, sel: Selection | null): void {
  const map = selectionMap(view);
  // Block offsets shift as the document is edited, so entries go stale rather than
  // being cleanly removed. Bound the map instead of letting it grow without limit.
  if (map.size > MAX_REMEMBERED_SELECTIONS) map.clear();
  map.set(from, sel);
}

/** Live ResizeObservers, so `destroy` can disconnect them when CM6 drops the widget. */
const observers = new WeakMap<HTMLElement, ResizeObserver>();
