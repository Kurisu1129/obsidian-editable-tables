import { Component, MarkdownRenderer, editorInfoField } from 'obsidian';
import { WidgetType, type EditorView } from '@codemirror/view';
import type { QuoteRegion } from '../editor/region';
import { applyBlockIndent } from '../editor/indent';

/** Per-widget render component, so `destroy` can release embedded children (F31). */
const components = new WeakMap<HTMLElement, Component>();
const observers = new WeakMap<HTMLElement, ResizeObserver>();
const destroyed = new WeakSet<HTMLElement>();
/** Removes the window-level drag listeners if the widget dies mid-drag. */
const dragCleanups = new WeakMap<HTMLElement, () => void>();

/** A caret position inside the rendered text. */
interface CaretPos {
  node: Text;
  offset: number;
}

interface CharBox {
  i: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Character boxes per text node, measured once (the rendered DOM is static). */
const charBoxes = new WeakMap<Text, CharBox[]>();

function boxesOf(node: Text): CharBox[] {
  let boxes = charBoxes.get(node);
  if (boxes) return boxes;
  boxes = [];
  const range = document.createRange();
  for (let i = 0; i < node.textContent!.length; i++) {
    range.setStart(node, i);
    range.setEnd(node, i + 1);
    const box = range.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) {
      boxes.push({ i, left: box.left, right: box.right, top: box.top, bottom: box.bottom });
    }
  }
  charBoxes.set(node, boxes);
  return boxes;
}

/**
 * Maps viewport coordinates to a caret position in the widget's rendered text.
 *
 * `document.caretRangeFromPoint` cannot be used here: inside a contenteditable=false
 * island within the editor it always returns a collapsed range at the block boundary
 * (verified). Measuring per-character boxes and clamping to the nearest line end gives
 * the same information without relying on that behaviour.
 */
function caretPositionAt(root: HTMLElement, x: number, y: number): CaretPos | null {
  const chars: { node: Text; box: CharBox }[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!text.textContent?.trim()) continue;
    for (const box of boxesOf(text)) chars.push({ node: text, box });
  }
  if (chars.length === 0) return null;

  // Group character boxes into rendered lines: inline elements (code, strong) share a
  // line and therefore share a rounded top.
  const lines = new Map<number, { top: number; bottom: number; items: typeof chars }>();
  for (const char of chars) {
    const key = Math.round(char.box.top);
    const line = lines.get(key);
    if (line) {
      line.top = Math.min(line.top, char.box.top);
      line.bottom = Math.max(line.bottom, char.box.bottom);
      line.items.push(char);
    } else {
      lines.set(key, { top: char.box.top, bottom: char.box.bottom, items: [char] });
    }
  }

  let chosenLine: { top: number; bottom: number; items: typeof chars } | null = null;
  let bestDy = Infinity;
  for (const line of lines.values()) {
    const dy = y < line.top ? line.top - y : y > line.bottom ? y - line.bottom : 0;
    if (dy < bestDy) {
      bestDy = dy;
      chosenLine = line;
    }
  }
  // A pointer far above or below the widget is not a caret request.
  if (!chosenLine || bestDy > 20) return null;

  const items = chosenLine.items.sort((a, b) => a.box.left - b.box.left);
  let chosen = items[items.length - 1];
  for (const item of items) {
    if (x < item.box.right) {
      chosen = item;
      break;
    }
  }
  const offset = x < (chosen.box.left + chosen.box.right) / 2 ? chosen.box.i : chosen.box.i + 1;
  return { node: chosen.node, offset };
}

/** Builds a Range from `a` → `b`, in document order (null when collapsed). */
function rangeBetween(a: CaretPos, b: CaretPos): Range | null {
  const start = document.createRange();
  start.setStart(a.node, a.offset);
  start.collapse(true);
  const end = document.createRange();
  end.setStart(b.node, b.offset);
  end.collapse(true);
  const forward = start.compareBoundaryPoints(Range.START_TO_START, end) <= 0;
  const from = forward ? a : b;
  const to = forward ? b : a;
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range.collapsed ? null : range;
}

/**
 * The rendered quote's own text selection.
 *
 * It deliberately does NOT use `window.getSelection()`: any DOM selection inside this
 * replace-widget is observed by CM6/Obsidian, mapped to a document position inside the
 * quote, and triggers a decoration rebuild that destroys the widget mid-drag (verified).
 * CSS Custom Highlight paints the same visual selection without touching the document
 * selection, so the widget stays put; a `copy` listener supplies the clipboard text.
 */
const HIGHLIGHT_NAME = 'mdft-quote-selection';

interface QuoteSelection {
  wrap: HTMLElement;
  text: string;
}

let activeSelection: QuoteSelection | null = null;

interface HighlightRegistryLike {
  set(name: string, value: object): void;
  delete(name: string): void;
}

const highlightApi = window as unknown as {
  CSS?: { highlights?: HighlightRegistryLike };
  Highlight?: new (range: Range) => object;
};

function clearQuoteSelection(): void {
  if (!activeSelection) return;
  activeSelection.wrap.dataset.mdftSelection = '';
  activeSelection = null;
  try {
    highlightApi.CSS?.highlights?.delete(HIGHLIGHT_NAME);
  } catch {
    /* API unavailable — nothing was registered */
  }
}

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'TABLE', 'TR', 'TD', 'TH',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'HR',
]);

/**
 * Plain text for a range that spans blocks.
 *
 * `Range.toString()` concatenates text nodes without separators, so a selection crossing
 * two paragraphs would paste as one run-on line. Walking the cloned fragment and emitting
 * a newline at block boundaries and `<br>` gives the text the user actually sees.
 */
function plainTextOf(range: Range): string {
  let out = '';
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (el.tagName === 'BR') {
      out += '\n';
      return;
    }
    if (el.tagName === 'IMG') {
      out += el.getAttribute('alt') ?? '';
      return;
    }
    for (const child of Array.from(el.childNodes)) walk(child);
    if (BLOCK_TAGS.has(el.tagName)) out += '\n';
  };
  for (const child of Array.from(range.cloneContents().childNodes)) walk(child);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

function applyQuoteSelection(wrap: HTMLElement, range: Range): void {
  clearQuoteSelection();
  const text = plainTextOf(range);
  if (text === '') return;
  const registry = highlightApi.CSS?.highlights;
  const HighlightCtor = highlightApi.Highlight;
  if (!registry || !HighlightCtor) return;
  try {
    registry.set(HIGHLIGHT_NAME, new HighlightCtor(range));
  } catch {
    return;
  }
  activeSelection = { wrap, text };
  // Exposed for the acceptance suite, which cannot read the Highlight's ranges back.
  wrap.dataset.mdftSelection = text;
}

let handlersInstalled = false;

/**
 * Document-level handlers shared by every quote widget:
 *
 * - `copy`: writes the highlighted text to the clipboard. The highlight never moves the
 *   native selection, so the browser would otherwise copy nothing.
 * - `mousedown`: a press anywhere outside the highlighted block clears it, like a normal
 *   selection would.
 * - `keydown`: Escape clears it.
 */
function ensureQuoteHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  document.addEventListener('copy', (ev) => {
    const selection = activeSelection;
    if (!selection) return;
    const native = window.getSelection();
    // Never hijack a copy that comes from a real editable selection (a table cell, the
    // source view) — only our own highlight, which never moves the native selection.
    if (native && !native.isCollapsed && native.anchorNode && !selection.wrap.contains(native.anchorNode)) {
      return;
    }
    ev.clipboardData?.setData('text/plain', selection.text);
    ev.preventDefault();
  });

  document.addEventListener(
    'mousedown',
    (ev) => {
      const selection = activeSelection;
      if (!selection) return;
      if (ev.target instanceof Node && selection.wrap.contains(ev.target)) return;
      clearQuoteSelection();
    },
    true,
  );

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') clearQuoteSelection();
  });

  // Keyboard selection elsewhere (e.g. Shift+arrows in a table cell) must not leave the
  // quote's highlight stealing the next copy. Our own drag never touches the native
  // selection, so any non-collapsed native selection outside the block is someone else's.
  document.addEventListener('selectionchange', () => {
    const selection = activeSelection;
    if (!selection) return;
    const native = window.getSelection();
    if (!native || native.isCollapsed) return;
    if (native.anchorNode && selection.wrap.contains(native.anchorNode)) return;
    clearQuoteSelection();
  });
}

/**
 * Removes the list-item indentation from a quote's source before rendering.
 *
 * The widget supplies that indentation visually via `padding-left`. Passing the raw source
 * would be worse than redundant: Markdown treats four spaces of leading whitespace as an
 * indented code block, so a deeply nested `> …` would render as code instead of a quote.
 */
function stripIndent(source: string, indent: string): string {
  if (indent === '') return source;
  return source
    .split('\n')
    .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
    .join('\n');
}

/**
 * Block widget that renders a blockquote through Obsidian's own MarkdownRenderer.
 *
 * Read-only by design: the rendered DOM is never inspected or written back. Editing always
 * happens in the source view, which `field.ts` reveals whenever the selection touches the
 * region (AC22).
 */
export class QuoteWidget extends WidgetType {
  constructor(readonly region: QuoteRegion) {
    super();
  }

  /**
   * Unlike `TableWidget`, this widget holds no state keyed to document offsets: its click
   * handler resolves the position from the DOM at event time. So a shift caused by an edit
   * above leaves the rendered content valid, and comparing the source is enough — comparing
   * offsets here would rebuild (and asynchronously re-render) every quote on every keystroke
   * above it.
   */
  eq(other: QuoteWidget): boolean {
    return other.region.source === this.region.source && other.region.indent === this.region.indent;
  }

  ignoreEvent(): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'mdft-quote';
    wrap.setAttribute('contenteditable', 'false');

    // Single click is deliberately NOT intercepted: the rendered text stays selectable
    // for copying. Editing is entered with a double click — a plain click doing it made
    // selecting a sentence impossible, since the whole block reverted to source on press.
    // Native mouse selection cannot start inside a contenteditable=false island nested in
    // the editor: Chromium keeps the selection collapsed no matter how far the pointer
    // moves (verified; `caretRangeFromPoint` collapses to the block boundary too). Setting
    // `window.getSelection()` is no better — Obsidian maps it back to a document position
    // and rebuilds the widget mid-drag. So the widget maps pointer coordinates to text
    // offsets itself and paints with a CSS Custom Highlight (see `applyQuoteSelection`).
    // A press without movement selects nothing, so `dblclick` still works.
    const isInteractive = (target: EventTarget | null): boolean =>
      target instanceof Element &&
      !!target.closest('a, .internal-embed, .markdown-embed, button, input, textarea, select, img');

    ensureQuoteHandlers();

    let anchor: CaretPos | null = null;

    const onMove = (ev: MouseEvent): void => {
      if (!anchor || !(ev.buttons & 1)) return;
      const current = caretPositionAt(wrap, ev.clientX, ev.clientY);
      if (!current) return;
      const range = rangeBetween(anchor, current);
      if (!range) return;
      applyQuoteSelection(wrap, range);
    };
    const onUp = (): void => {
      anchor = null;
      wrap.classList.remove('is-selecting');
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
    };

    wrap.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0 || isInteractive(ev.target)) return;
      // A fresh press replaces whatever the previous drag highlighted.
      clearQuoteSelection();
      anchor = caretPositionAt(wrap, ev.clientX, ev.clientY);
      if (!anchor) return;
      wrap.classList.add('is-selecting');
      // Window-level: while the editor drags, pointer events do not reliably bubble
      // through the widget's ancestors.
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
    });
    dragCleanups.set(wrap, onUp);

    wrap.title = '拖拽选字复制，双击编辑源码';
    wrap.addEventListener('dblclick', (ev) => {
      if (ev.button !== 0) return;
      const target = ev.target as Element | null;
      // Links and embeds carry their own handlers; never steal those clicks.
      if (isInteractive(target)) {
        return;
      }
      ev.preventDefault();
      clearQuoteSelection();
      try {
        // Resolved from the DOM, not from a captured offset: the DOM may be reused after
        // an edit above (see `eq`), so a captured `from` could be stale.
        view.dispatch({ selection: { anchor: view.posAtDOM(wrap, 0) } });
        view.focus();
      } catch {
        /* widget detached between dblclick and dispatch */
      }
    });

    // `markdown-rendered` gives the output Obsidian's canonical typography and spacing.
    const body = document.createElement('div');
    body.className = 'mdft-quote__body markdown-rendered';
    wrap.appendChild(body);

    const comp = new Component();
    comp.load();
    components.set(wrap, comp);
    destroyed.delete(wrap);

    // Rendering is asynchronous (embeds resolve later) and can change height without a
    // document transaction; report the new height so CM6's heightmap stays accurate.
    const observer = new ResizeObserver(() => view.requestMeasure());
    observer.observe(wrap);
    observers.set(wrap, observer);

    const info = view.state.field(editorInfoField, false);
    const sourcePath = info?.file?.path ?? '';
    const markdown = stripIndent(this.region.source, this.region.indent);

    // render() appends (F31 pitfall 1), so every render starts from an empty container.
    body.replaceChildren();

    if (info) {
      MarkdownRenderer.render(info.app, markdown, body, sourcePath, comp)
        .then(() => {
          if (wrap.isConnected && !destroyed.has(wrap)) view.requestMeasure();
        })
        .catch((error: unknown) => {
          // A blank block would look like data loss. Fall back to the source text.
          console.warn('[md-formatter] 引用块渲染失败，已回退为源码。', error);
          if (destroyed.has(wrap)) return;
          body.replaceChildren();
          const pre = document.createElement('pre');
          pre.textContent = markdown;
          body.appendChild(pre);
          view.requestMeasure();
        });
    } else {
      const pre = document.createElement('pre');
      pre.textContent = markdown;
      body.appendChild(pre);
    }

    // The synchronous part of render() is already in the DOM; sync the height before paint.
    view.requestMeasure();
    applyBlockIndent(wrap, this.region.indent);
    return wrap;
  }

  destroy(dom: HTMLElement): void {
    destroyed.add(dom);
    if (activeSelection?.wrap === dom) clearQuoteSelection();
    dragCleanups.get(dom)?.();
    dragCleanups.delete(dom);
    // F31 pitfall 2: without unload, embedded content keeps global handlers alive.
    components.get(dom)?.unload();
    components.delete(dom);
    observers.get(dom)?.disconnect();
    observers.delete(dom);
  }
}
