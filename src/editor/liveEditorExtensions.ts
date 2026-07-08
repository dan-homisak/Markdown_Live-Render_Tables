import { markdown } from "@codemirror/lang-markdown";
import { Extension } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  lineNumbers,
} from "@codemirror/view";
import {
  createTableSourceChangeFilter,
  createTableSourceSelectionGuard,
} from "../shared/tableSourceProtection";
import { createEditorGeometrySync } from "./editorGeometrySync";
import { createEditorTheme } from "./editorTheme";
import { TABLE_CELL_SELECTOR } from "./table/cellSelection";
import { createTableBoundaryArrowNavigation } from "./tableBoundaryNavigation";
import { createTableCellFocusClassSync } from "./tableCellFocus";
import { createTableDecorations } from "./tableDecorations";

export interface LiveEditorOptions {
  lineWrapping: boolean;
}

/**
 * Assembles the complete CodeMirror extension set for the live markdown
 * editor:
 *
 * - VS Code-parity theme, line numbers, and active-line highlighting,
 * - rendered table widgets with source-line hiding and gutter suppression,
 * - protection that keeps the cursor and direct edits out of hidden table
 *   source (cell edits go through annotated transactions instead),
 * - geometry sync for table wrapping width and gutter alignment,
 * - arrow-key navigation across the source/table boundary.
 */
export function createLiveEditorExtensions(
  options: LiveEditorOptions,
): Extension[] {
  return [
    createEditorTheme(),
    createTableBoundaryArrowNavigation(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    lineNumbers(),
    createEditorGeometrySync(),
    createTableCellFocusClassSync(),
    createTableSourceChangeFilter(),
    createTableSourceSelectionGuard({
      tableCellSelector: TABLE_CELL_SELECTOR,
    }),
    markdown(),
    ...(options.lineWrapping ? [EditorView.lineWrapping] : []),
    createTableDecorations(),
  ];
}
