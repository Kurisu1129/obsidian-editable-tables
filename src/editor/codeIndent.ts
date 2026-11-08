import { RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { leadingWhitespace, scanFenceBlocks } from '../model/scan';
import { domLineAt, findOwningItemLine, firstContentLeft } from './indent';

/** Anything beyond this is a measurement accident, not an indent. */
const MAX_INDENT_PX = 400;

interface IndentRange {
  from: number;
  margin: number;
}

/**
 * Indent decorations for every rendered line of a list-nested fence.
 *
 * `cache` remembers the last good margin per fence start line. The measurement needs the
 * fence's *opening* line to be rendered (that is where the owning item is found); inside a
 * code block longer than the viewport the opening line scrolls away, and without the cache
 * the indentation would silently disappear mid-block.
 */
function buildIndents(view: EditorView, cache: Map<number, number>): IndentRange[] {
  const lines: string[] = [];
  for (let i = 1; i <= view.state.doc.lines; i++) lines.push(view.state.doc.line(i).text);

  const ranges: IndentRange[] = [];
  // Measure from the content edge, not from the line's own rect: the line may already
  // carry the margin we applied last time, which would make the difference collapse to 0
  // and drop the decoration on the next rebuild. This measurement is idempotent.
  const contentLeft = view.contentDOM.getBoundingClientRect().left;
  const blocks = scanFenceBlocks(lines);
  const alive = new Set<number>();

  for (const block of blocks) {
    alive.add(block.startLine);
    const startFrom = view.state.doc.line(block.startLine + 1).from;
    const beginLine = domLineAt(view, startFrom);
    let margin = cache.get(block.startLine);

    // `domAtPos` can map a position inside a replaced widget to a neighbouring line.
    // Only measure when the DOM line really is the line we scanned.
    let mapped = false;
    if (beginLine) {
      try {
        mapped =
          view.posAtDOM(beginLine, 0) === startFrom &&
          beginLine.classList.contains('HyperMD-codeblock');
      } catch {
        mapped = false;
      }
    }

    if (mapped) {
      const indent = leadingWhitespace(lines[block.startLine]);
      // A top-level fence has no item to align with; never reuse a stale margin for it.
      // A non-empty indent, though, does not prove the owner is *visible*: CM6 renders
      // only the viewport, and the owning list line may sit just above it. Dropping the
      // cached margin in that case made the indent blink away on scroll, so keep it —
      // `findOwningItemLine` can only be trusted when it actually finds a line.
      if (indent === '') {
        cache.delete(block.startLine);
        margin = undefined;
      } else {
        const item = findOwningItemLine(beginLine!, indent);
        if (item) {
          const textLeft = firstContentLeft(item);
          if (textLeft !== null) {
            margin = textLeft - contentLeft;
            cache.set(block.startLine, margin);
          }
        }
      }
    }

    if (margin === undefined) continue;
    if (!(margin > 0.5) || margin > MAX_INDENT_PX) continue;

    for (let i = block.startLine; i <= block.endLine; i++) {
      ranges.push({ from: view.state.doc.line(i + 1).from, margin });
    }
  }

  // Fences that no longer exist (deleted, or line numbers shifted) must not keep a margin.
  for (const key of cache.keys()) if (!alive.has(key)) cache.delete(key);

  return ranges;
}

function buildDecorations(ranges: IndentRange[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of ranges) {
    /*
     * `!important` is load-bearing, and this is the ONLY place the plugin is allowed to
     * use it against the host.
     *
     * Obsidian declares `margin: 0` on `.cm-line` inside a CSS cascade layer with
     * `!important`. A non-important inline style loses to a layered `!important`
     * declaration, so `margin-left` written without it computes to 0px even though the
     * attribute is present (spike 0.2, D9). With it, the whole line box — background
     * included — shifts instead of only the text, which is what makes the nesting visible.
     *
     * Scope: list-nested code-block lines only. The `margin` we override is a visual
     * default, not the host's `contain: paint` safety guarantee — never extend this
     * technique to that rule (see .trellis/spec/frontend/codemirror-widgets.md).
     */
    builder.add(
      range.from,
      range.from,
      Decoration.line({
        attributes: { style: `margin-left:${range.margin.toFixed(2)}px !important` },
      }),
    );
  }
  return builder.finish();
}

/**
 * Gives native fenced code blocks inside list items the indentation their `.cm-line`
 * never receives (Obsidian pads list lines, not block lines inside them).
 *
 * Native rendering is left untouched: this only adds a line decoration, so syntax
 * highlighting, language labels and folding all keep working (R22 / AC17c).
 *
 * Measurement needs the DOM, and the DOM is only trustworthy after the update has been
 * applied — hence the microtask and the follow-up empty transaction that makes CM6 re-read
 * this plugin's decoration set.
 */
class CodeIndentPlugin {
  decorations: DecorationSet = Decoration.none;
  private key = '';
  private scheduled = false;
  private destroyed = false;
  private waitingForComposition = false;
  /** Last measured indent per fence start line — survives the opening line scrolling away. */
  private readonly marginCache = new Map<number, number>();

  constructor(private readonly view: EditorView) {
    this.schedule();
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged) this.schedule();
  }

  destroy(): void {
    this.destroyed = true;
    this.view.contentDOM.removeEventListener('compositionend', this.onCompositionEnd);
  }

  private readonly onCompositionEnd = (): void => {
    this.waitingForComposition = false;
    this.schedule();
  };

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    // A microtask runs after the dispatch has applied its DOM changes, which is the
    // earliest moment the widget/line geometry can be measured. rAF was avoided
    // deliberately: Chromium throttles it in background windows, and an Obsidian window
    // driven over CDP is frequently not the foreground window.
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.destroyed) return;

      // Do not dispatch while an IME composition is in flight: the composition owns the
      // DOM and selection, and an extra transaction can end it early. Re-run once the
      // composition finishes; the decoration key is unchanged until then.
      if (this.view.composing) {
        if (!this.waitingForComposition) {
          this.waitingForComposition = true;
          this.view.contentDOM.addEventListener('compositionend', this.onCompositionEnd, {
            once: true,
          });
        }
        return;
      }

      const ranges = buildIndents(this.view, this.marginCache);
      const key = ranges.map((r) => `${r.from}:${r.margin.toFixed(2)}`).join('|');
      if (key === this.key) return;
      this.key = key;
      this.decorations = buildDecorations(ranges);
      // Decorations changed outside an update; an empty transaction is the documented way
      // to make CM6 pick them up. It carries no changes, so it is undo-neutral.
      this.view.dispatch({});
    });
  }
}

export const codeIndentExtension = ViewPlugin.fromClass(CodeIndentPlugin, {
  decorations: (plugin) => plugin.decorations,
});
