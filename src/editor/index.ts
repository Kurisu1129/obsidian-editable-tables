import { Prec, type Extension } from '@codemirror/state';
import { tableExtensionFields } from './field';

/**
 * The extension injected into every editor via `Plugin.registerEditorExtension`.
 *
 * `Prec.highest` is load-bearing, not decoration: Obsidian's own Live Preview
 * renders top-level tables with its own block widget. We must outrank it so our
 * widget wins the overlapping replace-decoration slot. Gate: AC10.
 */
export const editableTablesExtension: Extension = Prec.highest(tableExtensionFields);
