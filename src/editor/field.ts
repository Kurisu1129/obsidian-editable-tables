import { StateField, type EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { scanTableLines } from '../model/scan';
import { scanQuoteLines } from '../model/scanQuote';
import { parsePipeTable } from '../model/parsePipe';
import { parseHtmlTable } from '../model/parseHtml';
import type { TableGrid, TableKind } from '../model/types';
import { TableWidget } from '../widget/tableWidget';
import { QuoteWidget } from '../widget/quoteWidget';
import type { Region, TableRegion } from './region';

type DecorationRange = Range<Decoration>;

function parseGrid(kind: TableKind, lines: string[]): TableGrid | null {
  return kind === 'pipe' ? parsePipeTable(lines) : parseHtmlTable(lines);
}

/** Blocks already reported, so a rebuild does not re-log the same refusal every keystroke. */
const reportedRefusals = new Set<string>();
const MAX_REPORTED = 64;

/**
 * A block we cannot parse is left exactly as written — never rendered, never rewritten.
 * Saying so out loud matters: silently doing nothing looks like the plugin is broken.
 */
function reportRefusal(kind: TableKind, firstLine: number, source: string): void {
  const key = `${kind}:${source}`;
  if (reportedRefusals.has(key)) return;
  if (reportedRefusals.size > MAX_REPORTED) reportedRefusals.clear();
  reportedRefusals.add(key);
  console.warn(
    `[md-formatter] 第 ${firstLine} 行起的表格无法解析，已跳过渲染并保持源码不变。`,
  );
}

/** Resolves every renderable block in the document to concrete offsets. */
function buildRegions(state: EditorState): Region[] {
  const lines: string[] = [];
  for (let i = 1; i <= state.doc.lines; i++) lines.push(state.doc.line(i).text);

  const regions: Region[] = [];

  for (const block of scanTableLines(lines)) {
    const from = state.doc.line(block.startLine + 1).from;
    const to = state.doc.line(block.endLine + 1).to;
    const blockLines = lines.slice(block.startLine, block.endLine + 1);
    const grid = parseGrid(block.tableKind, blockLines);
    if (!grid) {
      reportRefusal(block.tableKind, block.startLine + 1, blockLines.join('\n'));
      continue;
    }
    regions.push({
      kind: 'table',
      from,
      to,
      indent: block.indent,
      tableKind: block.tableKind,
      grid,
      source: state.doc.sliceString(from, to),
    } satisfies TableRegion);
  }

  for (const block of scanQuoteLines(lines)) {
    const from = state.doc.line(block.startLine + 1).from;
    const to = state.doc.line(block.endLine + 1).to;
    regions.push({
      kind: 'quote',
      from,
      to,
      indent: block.indent,
      source: state.doc.sliceString(from, to),
    });
  }

  // A `>` line inside an HTML table can be found by both scanners. Overlapping block
  // replacements are not valid CM6 input, so keep the earlier region and drop the one it
  // covers. (A table nested inside a blockquote is never produced by scanTableLines, so
  // this only guards the reverse, unusual direction.)
  regions.sort((a, b) => a.from - b.from);
  const disjoint: Region[] = [];
  for (const region of regions) {
    const previous = disjoint[disjoint.length - 1];
    if (previous && region.from < previous.to) continue;
    disjoint.push(region);
  }
  return disjoint;
}

function selectionTouches(state: EditorState, regions: Region[]): boolean {
  for (const region of regions) {
    for (const range of state.selection.ranges) {
      if (range.from <= region.to && range.to >= region.from) return true;
    }
  }
  return false;
}

function buildDecorations(state: EditorState, regions: Region[]): DecorationSet {
  const ranges: DecorationRange[] = [];

  for (const region of regions) {
    // Reveal the raw source whenever the selection touches the block, so Markdown
    // stays directly editable and the toolbar's 源码 action has something to land on.
    let touched = false;
    for (const range of state.selection.ranges) {
      if (range.from <= region.to && range.to >= region.from) {
        touched = true;
        break;
      }
    }
    if (touched) continue;

    const widget =
      region.kind === 'table' ? new TableWidget(region) : new QuoteWidget(region);
    ranges.push(Decoration.replace({ widget, block: true }).range(region.from, region.to));
  }

  return Decoration.set(ranges, true);
}

/**
 * Parsed regions. Recomputed only when the document changes — a cursor move must not
 * pay for re-scanning every block (AC8).
 */
const regionField = StateField.define<Region[]>({
  create: (state) => buildRegions(state),
  update: (regions, tr) => (tr.docChanged ? buildRegions(tr.state) : regions),
});

export const decorationField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state, state.field(regionField)),
  update: (deco, tr) => {
    if (!tr.docChanged && !tr.selection) return deco;

    const regions = tr.state.field(regionField);

    // Fast path: a selection move that stays clear of every block leaves the
    // decoration set identical, so keep the existing one.
    if (!tr.docChanged) {
      const wasTouching = selectionTouches(tr.startState, regions);
      const isTouching = selectionTouches(tr.state, regions);
      if (!wasTouching && !isTouching) return deco;
    }

    return buildDecorations(tr.state, regions);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const blockExtensionFields = [regionField, decorationField];
