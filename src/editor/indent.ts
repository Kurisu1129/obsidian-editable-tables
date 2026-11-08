import {
  ViewPlugin,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view';

/**
 * Indentation for blocks rendered by our widgets.
 *
 * A block-level replace widget is a direct child of `.cm-content`, not of a `.cm-line`,
 * so it inherits none of the list's indentation (`closest('.cm-line') === null`). Obsidian
 * gives list lines a `padding-left`; block lines inside a list get none. We therefore read
 * the *actual* text position of the nearest preceding list item and pad the widget by the
 * same amount — copying measured pixels instead of hard-coding the host's CSS metrics.
 */

/** How many siblings to inspect when looking for the owning list item. */
const MAX_LIST_SCAN = 512;

/**
 * Last measured padding per source indent string.
 *
 * CM6 only renders the viewport, so a widget can be (re)created while the list item that
 * owns it is outside the rendered range: `previousElementSibling` then cannot reach it and
 * the widget would silently snap back to the content's left edge. Remembering the pixel
 * column keyed by the block's own indent keeps the nesting visible in that case.
 */
const indentCache = new Map<string, number>();

/** Leading whitespace, in characters (tabs count as one). */
function leadingLength(text: string): number {
  const m = text.match(/^[ \t]*/);
  return m ? m[0].length : 0;
}

/**
 * Column, in characters, where a list item's content starts.
 * `- Project` → 2, `  - Task` → 4, `10. item` → 4.
 */
function contentColumn(text: string): number {
  const m = text.match(/^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]*)/);
  if (!m) return leadingLength(text);
  return m[1].length + m[2].length + m[3].length;
}

/**
 * The list item that owns the block, or `null` when the block is top-level.
 *
 * Ownership is decided by **source indentation**, not by "nearest bullet": with
 * `- Project` / `  - Task A` / `  - Task B` followed by a block indented two spaces, the
 * nearest bullet is `Task B` (content column 4) but the owner is `Project` (column 2).
 * Picking the nearest bullet would over-indent the block by one level. So an item only
 * qualifies when its content column does not exceed the block's own indent; deeper items
 * are skipped while walking upward.
 *
 * The walk also stops at a non-item line shallower than the block's indent: at that point
 * the container has ended, and any list item above belongs to a different section.
 */
export function findOwningItemLine(el: Element, indent: string): HTMLElement | null {
  const target = indent.length;
  let node: Element | null = el.previousElementSibling;
  for (let i = 0; node && i < MAX_LIST_SCAN; i++, node = node.previousElementSibling) {
    if (!(node instanceof HTMLElement)) continue;
    if (!node.classList.contains('cm-line')) continue; // block widgets, gutters

    const text = node.textContent ?? '';
    if (text.trim() === '') continue;

    const isItem =
      node.classList.contains('HyperMD-list-line') &&
      !node.classList.contains('HyperMD-list-line-nobullet');

    if (isItem) {
      if (contentColumn(text) <= target) return node;
      continue; // deeper than the block: not an ancestor, keep walking up
    }

    if (leadingLength(text) < target) return null;
  }
  return null;
}

/**
 * The first visible glyph of a line, excluding markers and decorations.
 *
 * `.cm-line`'s own rect is useless here: it is the full row width. A Range over the first
 * character after the list marker gives the position the user perceives as "where the
 * item's text starts".
 */
export function firstContentLeft(line: HTMLElement): number | null {
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    if (text.trim() === '') continue;

    const parent = (node as Text).parentElement;
    if (!parent) continue;
    if (
      parent.closest(
        '.cm-formatting, .code-block-flair, .cm-fold-indicator, .cm-hmd-list-indent',
      )
    ) {
      continue;
    }

    const start = text.search(/\S/);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + 1);
    return range.getBoundingClientRect().left;
  }

  // A marker-only item (`-` with no text) has no glyph to measure; its padding box is
  // still a faithful anchor for the item's content column.
  const style = getComputedStyle(line);
  return line.getBoundingClientRect().left + parseFloat(style.paddingLeft);
}

/**
 * Pads a widget so its left edge lines up with the text of the list item containing it.
 *
 * Only applies to indented blocks: a top-level block must not be shifted. The measurement
 * needs the widget to be attached (its left edge is only known then), so it runs once the
 * current dispatch has finished; if the editor has not mounted it yet, one macrotask later.
 */
export function applyBlockIndent(wrap: HTMLElement, indent: string): void {
  if (indent === '') return;
  // Lets the viewport refresher below find this widget again without knowing its type.
  wrap.dataset.mdftIndent = indent;

  const measure = (): boolean => {
    if (!wrap.isConnected) return false;
    const item = findOwningItemLine(wrap, indent);
    if (!item) {
      // The owner may simply be outside the rendered viewport. Reuse the last measured
      // column for this indent instead of dropping the indentation.
      const cached = indentCache.get(indent);
      if (cached !== undefined) wrap.style.paddingLeft = `${cached.toFixed(2)}px`;
      return true;
    }
    const textLeft = firstContentLeft(item);
    if (textLeft === null) return true;
    const px = textLeft - wrap.getBoundingClientRect().left;
    if (px > 0.5 && px < 400) {
      wrap.style.paddingLeft = `${px.toFixed(2)}px`;
      indentCache.set(indent, px);
    }
    return true;
  };

  queueMicrotask(() => {
    // setTimeout, not rAF: background windows throttle animation frames, and the widget
    // must be indented as soon as its DOM is attached, not only when a frame is drawn.
    if (!measure()) setTimeout(measure, 0);
  });
}

/**
 * Re-runs `applyBlockIndent` for every mounted widget whenever the rendered viewport
 * changes.
 *
 * A widget's padding is computed once, at mount. If it mounts while the owning list line
 * is outside the rendered range (fast scrolling virtualizes it away), the padding is
 * missing and nothing re-measures it — the nested block stays flush left for as long as
 * the widget lives. Re-measuring on viewport changes closes that hole; the measurement is
 * idempotent, so doing it again costs one `getBoundingClientRect` per widget.
 */
export const widgetIndentRefresher = ViewPlugin.fromClass(
  class {
    private scheduled = false;

    constructor(private readonly view: EditorView) {}

    update(update: ViewUpdate): void {
      if (update.viewportChanged) this.schedule();
    }

    private schedule(): void {
      if (this.scheduled) return;
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        for (const el of Array.from(this.view.contentDOM.children)) {
          if (!(el instanceof HTMLElement)) continue;
          const indent = el.dataset.mdftIndent;
          if (indent !== undefined) applyBlockIndent(el, indent);
        }
      });
    }
  },
);

/** The `.cm-line` element rendering the document line that starts at `pos`. */
export function domLineAt(view: EditorView, pos: number): HTMLElement | null {
  try {
    const { node } = view.domAtPos(pos);
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
    return el?.closest<HTMLElement>('.cm-line') ?? null;
  } catch {
    return null;
  }
}
