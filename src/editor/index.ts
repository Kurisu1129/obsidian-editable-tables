import { Prec, type Extension } from '@codemirror/state';
import { blockExtensionFields } from './field';
import { codeIndentExtension } from './codeIndent';

/**
 * The extension injected into every editor via `Plugin.registerEditorExtension`.
 *
 * `Prec.highest` is load-bearing for the *table* path, not decoration: Obsidian's Live
 * Preview renders top-level tables with its own block widget, and we must outrank it so
 * our widget wins the overlapping replace slot. Gate: AC10. Blockquotes have no native
 * widget to compete with, so the quote path would work without it.
 *
 * The code-indent plugin deliberately does NOT replace anything — it only adds line
 * decorations to native fenced code blocks (R22).
 */
export const editableTablesExtension: Extension = Prec.highest([
  blockExtensionFields,
  codeIndentExtension,
]);
