import {
  Annotation,
  EditorSelection,
  EditorState,
  Extension,
  SelectionRange,
  Transaction,
} from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { parseMarkdownTables, ParsedTable } from "./tableModel";

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

    const tables = parseMarkdownTables(transaction.startState.doc.toString());
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
          isTableCellFocused(view, options.tableCellSelector)
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
          if (isTableCellFocused(view, options.tableCellSelector)) {
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
  const tables = parseMarkdownTables(state.doc.toString());
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
  const before = getPositionBeforeTable(table);
  const after = getPositionAfterTable(state, table);
  const hasBefore = before < table.from;
  const hasAfter = after >= table.to && after <= state.doc.length;

  if (previousHead !== undefined && previousHead < table.from && hasAfter) {
    return after;
  }
  if (previousHead !== undefined && previousHead >= after && hasBefore) {
    return before;
  }
  if (position >= table.to && hasAfter) {
    return after;
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

function getPositionBeforeTable(table: ParsedTable): number {
  return Math.max(0, table.from - 1);
}

function getPositionAfterTable(
  state: EditorState,
  table: ParsedTable,
): number {
  return table.to < state.doc.length &&
    state.doc.sliceString(table.to, table.to + 1) === "\n"
    ? table.to + 1
    : table.to;
}

function getTableReplacementTo(
  _state: EditorState,
  table: ParsedTable,
): number {
  return table.to;
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
