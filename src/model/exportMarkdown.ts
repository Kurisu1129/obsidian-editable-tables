import { planInnerTables } from './innerTable';
import { parseHtmlTable } from './parseHtml';
import { scanTableLines } from './scan';
import { scanQuoteLines } from './scanQuote';
import { canSerializePipe, serializePipeTable } from './serializePipe';

export interface MarkdownExport {
  /** The transformed document. */
  text: string;
  /** Number of HTML tables rewritten as pipe tables. */
  converted: number;
  /** Number of recognizable HTML tables that cannot be represented as pipe tables. */
  skipped: number;
}

interface Edit {
  from: number;
  to: number;
  insert: string;
}

/**
 * Produces a Markdown-native copy of a note: every HTML table that a pipe table can
 * represent losslessly is rewritten as GFM pipe syntax. Everything else — merged tables,
 * front matter, fenced code, callouts, prose — is left exactly as written.
 *
 * Pure and read-only: the caller decides whether the result goes to the clipboard or a
 * downloaded file. This function never touches the vault.
 */
export function exportMarkdown(source: string): MarkdownExport {
  // Obsidian's editor model uses LF; normalize CRLF so offsets and lines agree.
  const text = source.replace(/\r\n/g, '\n');
  const lines = text.split('\n');

  const starts: number[] = new Array(lines.length);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    starts[i] = offset;
    offset += lines[i].length + 1; // + the '\n' that follows this line
  }

  const edits: Edit[] = [];
  let converted = 0;
  let skipped = 0;

  const lineEnd = (i: number): number => starts[i] + lines[i].length;

  // Top-level and list-indented tables.
  for (const block of scanTableLines(lines)) {
    if (block.tableKind !== 'html') continue;
    const grid = parseHtmlTable(lines.slice(block.startLine, block.endLine + 1));
    if (!grid || !canSerializePipe(grid)) {
      skipped++;
      continue;
    }
    edits.push({
      from: starts[block.startLine],
      to: lineEnd(block.endLine),
      insert: serializePipeTable(grid, block.indent).join('\n'),
    });
    converted++;
  }

  // Tables inside quotes: their lines start with `>`, so the top-level scanner cannot
  // see them. `planInnerTables` already knows how to strip the chain and reproduce it.
  for (const quote of scanQuoteLines(lines)) {
    const quoteFrom = starts[quote.startLine];
    const quoteSource = lines.slice(quote.startLine, quote.endLine + 1).join('\n');

    for (const plan of planInnerTables(quoteSource, quote.indent)) {
      if (plan.tableKind !== 'html') continue;
      if (!canSerializePipe(plan.grid)) {
        skipped++;
        continue;
      }
      edits.push({
        from: quoteFrom + plan.relFrom,
        to: quoteFrom + plan.relTo,
        insert: serializePipeTable(plan.grid, plan.prefix).join('\n'),
      });
      converted++;
    }
  }

  // Apply from the end so earlier offsets stay valid. Top-level tables and quotes are
  // disjoint blocks; the guard is a last defence against a future scanner overlap.
  edits.sort((a, b) => b.from - a.from);
  let out = text;
  let nextFrom = Infinity;
  for (const edit of edits) {
    if (edit.to > nextFrom) {
      converted--; // never splice overlapping ranges
      continue;
    }
    out = out.slice(0, edit.from) + edit.insert + out.slice(edit.to);
    nextFrom = edit.from;
  }

  return { text: out, converted, skipped };
}
