/*
 * THROWAWAY SPIKE HARNESS — not a product, not part of the plugin build.
 *
 * Answers the two open questions in .trellis/tasks/10-10-nested-block-quote-list/implement.md
 * 阶段 0, by injecting decorations into the live editor and measuring the result.
 *
 *   0.1  Can our own decoration take over a whole blockquote without Prec.highest?
 *   0.2  Can a CM6 line decoration add padding-left to a native code block inside a
 *        list item, without fighting Obsidian's own line decorations?   <-- the D9 gate
 *
 * Exposes window.__spike with enable/disable/measure hooks so CDP can drive it.
 *
 * CM6 modules are required (not bundled) so the Decoration/StateField class identity
 * matches Obsidian's own copy — see esbuild.config.mjs for why that matters.
 */

const { Plugin, MarkdownRenderer, Component } = require('obsidian');
const { StateField, StateEffect, Compartment } = require('@codemirror/state');
const { Decoration, WidgetType, EditorView } = require('@codemirror/view');

// ------------------------------------------------------------------ scanning

/** Ranges we must never touch: YAML front matter and fenced code blocks. */
function excludedRanges(doc) {
  const out = [];
  const lines = [];
  for (let i = 1; i <= doc.lines; i++) lines.push(doc.line(i));

  // front matter
  if (lines[0] && lines[0].text.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      const t = lines[i].text.trim();
      if (t === '---' || t === '...') { out.push([lines[0].from, lines[i].to]); break; }
    }
  }
  // fenced code
  let open = null;
  for (const l of lines) {
    const m = /^\s*(```|~~~)/.exec(l.text);
    if (!m) continue;
    if (open === null) open = l;
    else { out.push([open.from, l.to]); open = null; }
  }
  return out;
}

const overlaps = (ranges, from, to) => ranges.some(([a, b]) => from <= b && to >= a);

/**
 * Contiguous blockquote runs. A run starts at a line whose content begins with '>'
 * and continues through lazy continuation lines and blank '>' lines.
 * Blank lines with no '>' end the run.
 */
function scanQuotes(state) {
  const doc = state.doc;
  const excluded = excludedRanges(doc);
  const regions = [];
  let start = null;
  let last = null;

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const isQuote = /^\s*>/.test(line.text);
    const isBlank = line.text.trim() === '';
    if (isQuote && !overlaps(excluded, line.from, line.to)) {
      if (start === null) start = line;
      last = line;
      continue;
    }
    // lazy continuation: a non-quote, non-blank line directly after a quote line
    if (start !== null && !isBlank && !overlaps(excluded, line.from, line.to)) {
      last = line;
      continue;
    }
    if (start !== null) {
      regions.push({ from: start.from, to: last.to, source: doc.sliceString(start.from, last.to) });
      start = null; last = null;
    }
  }
  if (start !== null) {
    regions.push({ from: start.from, to: last.to, source: doc.sliceString(start.from, last.to) });
  }
  return regions;
}

// ------------------------------------------------------------------ widgets

class QuoteWidget extends WidgetType {
  constructor(region) { super(); this.region = region; }
  eq(o) {
    return o.region.from === this.region.from
      && o.region.to === this.region.to
      && o.region.source === this.region.source;
  }
  ignoreEvent() { return true; }
  toDOM(view) {
    const wrap = document.createElement('div');
    wrap.className = 'spike-quote';
    const host = document.createElement('div');
    wrap.appendChild(host);
    const comp = new Component();
    comp.load();
    this.comp = comp;
    MarkdownRenderer.render(window.app, this.region.source, host, 'spike.md', comp)
      .then(() => view.requestMeasure())
      .catch(() => {});
    return wrap;
  }
  destroy() { if (this.comp) this.comp.unload(); }
}

class CodeIndentWidgetless {} // placeholder, unused

// ------------------------------------------------------------------ fields

const quoteCompartment = new Compartment();

const quoteField = StateField.define({
  create(state) { return buildQuoteDecos(state); },
  update(deco, tr) { return tr.docChanged ? buildQuoteDecos(tr.state) : deco; },
  provide: (f) => EditorView.decorations.from(f),
});

function buildQuoteDecos(state) {
  const regions = scanQuotes(state);
  const ranges = regions.map((r) =>
    Decoration.replace({ widget: new QuoteWidget(r), block: true }).range(r.from, r.to));
  return Decoration.set(ranges, true);
}

/** Line decoration adding padding-left to native code-block lines inside list items. */
const indentCompartment = new Compartment();
const INDENT_PX = 40; // deliberately oversized so the effect is unambiguous

function buildIndentDecos(state, px, prop) {
  const doc = state.doc;
  const ranges = [];
  /**
   * Push right every line of an INDENTED fenced block — i.e. a code block in a list item.
   * `prop` selects padding-left (moves the TEXT only, leaving the line's own background box
   * where it was) vs margin-left (moves the whole line box, background included).
   */
  // `prop` may be a bare property name (padded with px) or a full declaration string.
  const decl = /^[a-z-]+$/.test(prop || '') ? `${prop}:${px}px`
    : (prop || `padding-left:${px}px`);
  const pad = (line) => ranges.push(
    Decoration.line({ attributes: { style: decl } }).range(line.from));

  let open = null;
  let openIndented = false;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const fence = /^(\s*)(```|~~~)/.exec(line.text);
    if (open === null) {
      if (fence) { open = line; openIndented = fence[1].length > 0; if (openIndented) pad(line); }
      continue;
    }
    // inside a fence
    if (openIndented) pad(line);
    if (fence) { open = null; openIndented = false; }
  }
  return Decoration.set(ranges, true);
}

const indentField = (px, prop) => StateField.define({
  create(state) { return buildIndentDecos(state, px, prop); },
  update(deco, tr) { return tr.docChanged ? buildIndentDecos(tr.state, px, prop) : deco; },
  provide: (f) => EditorView.decorations.from(f),
});

// ------------------------------------------------------------------ plugin

module.exports = class extends Plugin {
  async onload() {
    const self = this;
    window.__spike = {
      /**
       * Get the live EditorView for the ACTIVE leaf.
       * There can be several `.cm-editor` instances (one per open leaf); a bare
       * querySelector picks the first, which may belong to a hidden background leaf
       * still holding an unrelated document. Scope to the active pane.
       */
      view() {
        const ae = window.app.workspace.activeEditor;
        if (ae && ae.editor && ae.editor.cm) return ae.editor.cm;
        const el = document.querySelector('.workspace-leaf.mod-active .cm-editor');
        return el ? EditorView.findFromDOM(el) : null;
      },
      /** Diagnostic: what the usual leaf-based accessors actually yield. */
      probePaths() {
        const leaf = window.app.workspace.getLeavesOfType('markdown')[0];
        const out = { leaves: window.app.workspace.getLeavesOfType('markdown').length };
        try { out['leaf.view.editor.cm'] = !!(leaf && leaf.view && leaf.view.editor && leaf.view.editor.cm); } catch (e) { out['leaf.view.editor.cm'] = 'err'; }
        try { out['activeEditor.editor.cm'] = !!(window.app.workspace.activeEditor && window.app.workspace.activeEditor.editor && window.app.workspace.activeEditor.editor.cm); } catch (e) { out['activeEditor.editor.cm'] = 'err'; }
        out['findFromDOM'] = !!window.__spike.view();
        out['cm-editor count'] = document.querySelectorAll('.cm-editor').length;
        return out;
      },
      enableQuotes() {
        const v = window.__spike.view();
        v.dispatch({ effects: quoteCompartment.reconfigure(quoteField) });
        return true;
      },
      disableQuotes() {
        const v = window.__spike.view();
        v.dispatch({ effects: quoteCompartment.reconfigure([]) });
        return true;
      },
      enableIndent(px, prop) {
        const v = window.__spike.view();
        v.dispatch({ effects: indentCompartment.reconfigure(indentField(px || INDENT_PX, prop)) });
        return true;
      },
      disableIndent() {
        const v = window.__spike.view();
        v.dispatch({ effects: indentCompartment.reconfigure([]) });
        return true;
      },
      scan() {
        const v = window.__spike.view();
        return scanQuotes(v.state);
      },
    };

    // Both default ON so newly created editors (file switch, reopen) exercise the
    // real-world case rather than the harness's reset-to-empty state.
    this.registerEditorExtension([
      quoteCompartment.of(quoteField),
      indentCompartment.of(indentField(INDENT_PX, 'margin-left:40px !important')),
    ]);
  }
};
