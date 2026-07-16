import { history } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { Compartment, Extension } from "@codemirror/state";
import {
  drawSelection,
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
import { createDocumentSelectionInputHandler } from "./documentClipboard";
import { createDocumentSelectionDecorations } from "./documentSelectionDecorations";
import { TABLE_CELL_SELECTOR } from "./table/cellSelection";
import { createTableBoundaryArrowNavigation } from "./tableBoundaryNavigation";
import { createTableBoundaryInputHandler } from "./tableBoundaryInput";
import { createTableCellFocusClassSync } from "./tableCellFocus";
import { createTableDecorations } from "./tableDecorations";

export interface LiveEditorOptions {
  lineWrapping: boolean;
}

export const lineWrappingCompartment = new Compartment();

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
    // CodeMirror owns the undo history so ⌘Z coalesces typing into
    // word/whitespace groups and stops at the initially loaded document,
    // matching the stock VS Code editor. Undo/redo are dispatched locally
    // (see installEditorCommandBridge) rather than delegated to the host.
    history(),
    createEditorTheme(),
    createTableBoundaryArrowNavigation(),
    createTableBoundaryInputHandler(),
    createDocumentSelectionInputHandler(),
    drawSelection(),
    createDocumentSelectionDecorations(),
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
    lineWrappingCompartment.of(
      options.lineWrapping ? EditorView.lineWrapping : [],
    ),
    createTableDecorations(),
  ];
}
