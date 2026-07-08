import { Annotation } from "@codemirror/state";

/**
 * A single host-document change produced by a table cell edit, plus the
 * information needed to restore focus and caret into the rendered cell when
 * the change is undone or redone through the host history.
 */
export interface TableCellCommitStep {
  change: {
    from: number;
    to: number;
    text: string;
  };
  restore: TableCellCommitRestore;
}

/**
 * Ordered intermediate edit states of a committed cell edit. The host applies
 * each step as its own workspace edit so VS Code undo walks through the same
 * states the user typed.
 */
export interface TableCellCommitSequence {
  steps: TableCellCommitStep[];
}

/** Identifies a rendered table cell and the caret position to restore. */
export interface TableCellCommitRestore {
  tableFrom: number;
  rowKind: string;
  rowIndex: number;
  column: number;
  from: number;
  to: number;
  restoreCaretOffset: number;
}

/**
 * Marks a transaction as the final commit of a table cell edit (cell blur,
 * Enter, or cell navigation). Carries the undo/redo step sequence.
 */
export const tableCellCommitSequenceAnnotation =
  Annotation.define<TableCellCommitSequence>();

/**
 * Marks a transaction as an in-progress keystroke inside a rendered table
 * cell. Downstream extensions map their decorations through the change
 * instead of rebuilding, which keeps the widget DOM (and the user's caret)
 * untouched while typing.
 */
export const tableCellLiveEditAnnotation =
  Annotation.define<TableCellCommitStep>();
