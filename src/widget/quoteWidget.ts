import { Component, MarkdownRenderer, editorInfoField } from 'obsidian';
import { WidgetType, type EditorView } from '@codemirror/view';
import type { QuoteRegion } from '../editor/region';
import { applyBlockIndent } from '../editor/indent';

/** Per-widget render component, so `destroy` can release embedded children (F31). */
const components = new WeakMap<HTMLElement, Component>();
const observers = new WeakMap<HTMLElement, ResizeObserver>();
const destroyed = new WeakSet<HTMLElement>();

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

    // `ignoreEvent` keeps CM6 out of the widget, but it also means a click does nothing on
    // its own — and the rendered block offers no other way in. Clicking plain content does
    // what clicking a native callout does: put the cursor on the block's first line, which
    // reveals the source (AC22).
    wrap.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      const target = ev.target as Element | null;
      // Links and embeds carry their own handlers; never steal those clicks.
      if (
        target?.closest(
          'a, .internal-embed, .markdown-embed, button, input, textarea, select, img',
        )
      ) {
        return;
      }
      ev.preventDefault();
      try {
        // Resolved from the DOM, not from a captured offset: the DOM may be reused after
        // an edit above (see `eq`), so a captured `from` could be stale.
        view.dispatch({ selection: { anchor: view.posAtDOM(wrap, 0) } });
        view.focus();
      } catch {
        /* widget detached between mousedown and dispatch */
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
    // F31 pitfall 2: without unload, embedded content keeps global handlers alive.
    components.get(dom)?.unload();
    components.delete(dom);
    observers.get(dom)?.disconnect();
    observers.delete(dom);
  }
}
