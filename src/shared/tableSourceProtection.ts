import {
  Annotation,
  EditorSelection,
  EditorState,
  Extension,
  SelectionRange,
  Transaction,
} from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import {
  getParsedTables,
  ParsedTable,
  positionAfterTable,
  positionBeforeTable,
} from "./tableModel";

export const allowTableSourceChange = Annotation.define<boolean>();

export interface TableSourceSelectionGuardOptions {
  tableCellSelector: string;
}

export function createTableSourceChangeFilter(): Extension {
  return EditorState.changeFilter.of((transaction) => {
    if (
      !transaction.docChanged ||
      transaction.annotation(allowTableSourceChange) ||
      isUndoRedo(transaction)
    ) {
      return true;
    }

    const tables = getParsedTables(transaction.startState.doc);
    if (
      tables.length === 0 ||
      !selectionTouchesTableSource(
        transaction.startState,
        transaction.startState.selection,
        tables,
      )
    ) {
      return true;
    }

    let changeTouchesTable = false;
    transaction.changes.iterChangedRanges((from, to) => {
      if (
        tables.some((table) =>
          changeTouchesTableSource(transaction.startState, from, to, table),
        )
      ) {
        changeTouchesTable = true;
      }
    });

    return !changeTouchesTable;
  });
}

export function createTableSourceSelectionGuard(
  options: TableSourceSelectionGuardOptions,
): Extension {
  return ViewPlugin.fromClass(
    class {
      private scheduled = false;

      public constructor(view: EditorView) {
        this.scheduleIfNeeded(view);
      }

      public update(update: ViewUpdate): void {
        if (update.selectionSet || update.docChanged || update.focusChanged) {
          this.scheduleIfNeeded(update.view, update.startState.selection.main.head);
        }
      }

      private scheduleIfNeeded(
        view: EditorView,
        previousHead: number | undefined = undefined,
      ): void {
        if (
          this.scheduled ||
          isTableCellFocused(view, options.tableCellSelector) ||
          isApplyingHostDocument(view)
        ) {
          return;
        }

        const target = findSafeSelectionAnchor(view.state, previousHead);
        if (target === undefined) {
          return;
        }

        this.scheduled = true;
        queueMicrotask(() => {
          this.scheduled = false;
          if (
            isTableCellFocused(view, options.tableCellSelector) ||
            isApplyingHostDocument(view)
          ) {
            return;
          }

          const refreshedTarget = findSafeSelectionAnchor(view.state, previousHead);
          if (refreshedTarget === undefined) {
            return;
          }

          view.dispatch({
            selection: EditorSelection.cursor(refreshedTarget, 1),
            scrollIntoView: true,
          });
        });
      }
    },
  );
}

function isUndoRedo(transaction: Transaction): boolean {
  return transaction.isUserEvent("undo") || transaction.isUserEvent("redo");
}

function selectionTouchesTableSource(
  state: EditorState,
  selection: EditorSelection,
  tables: ParsedTable[],
): boolean {
  return selection.ranges.some((range) =>
    tables.some((table) => rangeTouchesTableSource(state, range, table)),
  );
}

function findSafeSelectionAnchor(
  state: EditorState,
  previousHead: number | undefined,
): number | undefined {
  const tables = getParsedTables(state.doc);
  const range = state.selection.main;
  const table = tables.find((candidate) =>
    rangeTouchesTableSource(state, range, candidate),
  );
  if (!table) {
    return undefined;
  }

  return resolveOutsideTableSource(state, table, range.head, previousHead);
}

function rangeTouchesTableSource(
  state: EditorState,
  range: SelectionRange,
  table: ParsedTable,
): boolean {
  if (range.empty) {
    return isPositionInTableSource(state, range.head, table);
  }

  return range.from < getTableReplacementTo(state, table) &&
    range.to > table.from;
}

function changeTouchesTableSource(
  state: EditorState,
  from: number,
  to: number,
  table: ParsedTable,
): boolean {
  if (from === to) {
    return isPositionInTableSource(state, from, table);
  }

  return from < getTableReplacementTo(state, table) &&
    to > table.from;
}

function isPositionInTableSource(
  state: EditorState,
  position: number,
  table: ParsedTable,
): boolean {
  return position >= table.from && position < getTableReplacementTo(state, table);
}

function resolveOutsideTableSource(
  state: EditorState,
  table: ParsedTable,
  position: number,
  previousHead: number | undefined,
): number {
  const before = positionBeforeTable(table);
  const after = positionAfterTable(state.doc, table);
  const hasBefore = before < table.from;
  const hasAfter = after >= table.to && after <= state.doc.length;

  if (position >= table.to && hasAfter) {
    return after;
  }
  if (previousHead !== undefined && previousHead < table.from && hasAfter) {
    return after;
  }
  if (previousHead !== undefined && previousHead >= after && hasBefore) {
    return before;
  }

  const midpoint = table.from + (table.to - table.from) / 2;
  if (position <= midpoint && hasBefore) {
    return before;
  }
  if (hasAfter) {
    return after;
  }
  if (hasBefore) {
    return before;
  }

  return Math.min(state.doc.length, Math.max(0, table.to));
}

function getTableReplacementTo(
  state: EditorState,
  table: ParsedTable,
): number {
  return positionAfterTable(state.doc, table);
}

function isTableCellFocused(
  view: EditorView,
  tableCellSelector: string,
): boolean {
  const activeElement = view.dom.ownerDocument.activeElement;
  return (
    activeElement instanceof HTMLElement &&
    Boolean(activeElement.closest(tableCellSelector))
  );
}

/**
 * A host document apply blurs and refocuses table cells across a couple of
 * animation frames. Guarding mid-apply would fight the pending focus restore
 * and visibly bounce the cursor, so corrections wait until the next update.
 */
function isApplyingHostDocument(view: EditorView): boolean {
  return (
    view.dom.ownerDocument.documentElement.dataset.mlrtApplyingHostDocument ===
    "true"
  );
}
