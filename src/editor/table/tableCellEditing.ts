import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  ensureTableCellSeparatorSafe,
  formatMarkdownCell,
  formatTableCellSourceEdit,
  getCellPaddingWhitespace,
  parseMarkdownTableRow,
  ParsedRow,
  ParsedTable,
  tableCellLeadingPipePrefix,
  TableCellSourceEdit,
} from "../../shared/tableModel";
import { allowTableSourceChange } from "../../shared/tableSourceProtection";
import {
  CellTextEditSnapshot,
  CellTextSelection,
  computeCellBeforeInputDecision,
} from "../../shared/tableCellInput";
import {
  adjacentTableCell,
  TableCellArrowDirection,
} from "../../shared/tableKeyboardNavigation";
import {
  tableCellCommitSequenceAnnotation,
  tableCellLiveEditAnnotation,
} from "../tableEditAnnotations";
import { selectVisibleTableBoundary } from "../tableBoundaryInput";
import {
  extendCellSelectionVertically,
  findCell,
  focusCellAtEnd,
  focusCellAtStart,
  focusCellAtVerticalEdge,
  getCellCaretOffset,
  getCellSelectionOffsets,
  moveCellCaretVertically,
  moveCellSelectionToLineBoundary,
  readCellDisplayValue,
  requestElementAnimationFrame,
  setCellCaretOffset,
  setCellSelectionOffsets,
  setCellPlainText,
  TABLE_CELL_SELECTOR,
} from "./cellSelection";
import {
  getTableWidgetTable,
  preserveTableForLiveEdit,
  releaseTableLiveEditPreservation,
} from "./tableWidgetState";
import { syncTableSourceMetadata } from "./tableCellMetadata";
import {
  isTableNavigationModifierHeld,
  tableNavigationModifierFacet,
} from "../tableNavigation";

/** Event dispatched whenever a cell edit writes to the document source. */
export const TABLE_CELL_COMMIT_EVENT = "mlrt:table-cell-commit";

interface CellEditHistory {
  undoStack: CellEditSnapshot[];
  redoStack: CellEditSnapshot[];
  lastValue: string;
}

type CellEditSnapshot = CellTextEditSnapshot;

interface CellCommitValueStep {
  value: string;
  restoreCaretOffset: number;
}

interface CellSourceCommitStep {
  change: {
    from: number;
    to: number;
    text: string;
  };
  restoreCaretOffset: number;
}

interface CellTarget {
  rowKind: string;
  rowIndex: string;
  column: string;
}

type VerticalCellTarget = CellTarget | "before-table" | "after-table";

/**
 * Per-cell undo/redo history, keyed by table position and cell coordinates.
 * Kept at module level so history survives widget DOM rebuilds. Bounded so
 * long editing sessions cannot grow it without limit; the oldest (least
 * recently created) entries are evicted first.
 */
const cellEditHistories = new Map<string, CellEditHistory>();
const MAX_TRACKED_CELL_HISTORIES = 512;

/**
 * Attaches all editing behavior to a rendered table widget:
 *
 * - keystrokes are intercepted via `beforeinput`, applied as plain-text
 *   snapshots, and immediately written through to the markdown source as a
 *   live edit (annotated so decorations map instead of rebuilding),
 * - Cmd/Ctrl+Z/Y are handled against the per-cell history while the cell
 *   is focused,
 * - Enter commits and exits, Shift+Enter inserts a line break,
 * - Tab/Shift+Tab and boundary arrow keys commit and move between cells.
 */
export function bindTableEditing(
  wrapper: HTMLElement,
  view: EditorView,
  table: ParsedTable,
  scheduleTableLayout: () => void,
): void {
  const getCurrentTable = (): ParsedTable =>
    getTableWidgetTable(wrapper) ?? table;

  wrapper.addEventListener("focusin", (event) => {
    const cell = findCell(event.target);
    if (cell) {
      ensureCellEditHistory(cell);
      scheduleTableLayout();
    }
  });

  wrapper.addEventListener("beforeinput", (event) => {
    const cell = findCell(event.target);
    if (!cell || !(event instanceof InputEvent)) {
      return;
    }
    const currentTable = getCurrentTable();
    if (
      event.inputType === "historyUndo" ||
      event.inputType === "historyRedo"
    ) {
      const direction = event.inputType === "historyUndo" ? "undo" : "redo";
      if (!restoreCellEditHistory(cell, direction)) {
        scheduleNativeHistoryFallback(
          view,
          currentTable,
          cell,
          scheduleTableLayout,
        );
        return;
      }
      event.preventDefault();
      applyLiveCellEdit(view, currentTable, cell);
      scheduleTableLayout();
      return;
    }

    const cellSelection = getCellSelectionOffsets(cell);
    const inputDecision = computeCellBeforeInputDecision({
      value: readCellDisplayValue(cell),
      selection: cellSelection,
      // A target range confined to this editing host cannot make a DOM
      // selection that visibly crosses sibling cells safe. Fail closed when
      // the live selection itself is not wholly owned by the target cell.
      targetSelection:
        cellSelection === null
          ? null
          : getCellInputTargetSelection(cell, event),
      inputType: event.inputType,
      data: getCellInputData(event),
    });
    if (inputDecision.kind === "native") {
      recordCellEditHistory(cell);
      return;
    }

    event.preventDefault();
    if (inputDecision.kind === "block") {
      return;
    }
    applyCellEditSnapshotChange(
      view,
      currentTable,
      cell,
      inputDecision.snapshot,
      scheduleTableLayout,
    );
  });

  wrapper.addEventListener("input", (event) => {
    const cell = findCell(event.target);
    if (!cell) {
      return;
    }

    syncCellEditHistory(cell);
    applyLiveCellEdit(view, getCurrentTable(), cell);
    scheduleTableLayout();
  });

  wrapper.addEventListener("focusout", (event) => {
    const cell = findCell(event.target);
    if (cell) {
      setTimeout(() => {
        if (
          wrapper.ownerDocument.documentElement.dataset
            .mlrtApplyingHostDocument === "true"
        ) {
          return;
        }
        if (cell.isConnected) {
          commitCellEdit(view, getCurrentTable(), cell);
        }
      }, 0);
    }
  });

  wrapper.addEventListener("keydown", (event) => {
    const cell = findCell(event.target);
    if (!cell) {
      return;
    }

    // Enter accepts an IME candidate and arrow keys navigate candidate lists.
    // None of the table-level shortcuts may run until composition has ended.
    if (event.isComposing || event.key === "Process") {
      return;
    }

    const tableNavigationModifier = view.state.facet(
      tableNavigationModifierFacet,
    );
    if (event.key === tableNavigationModifier && isPlainKey(event)) {
      // The document-level tracker has already recorded the key in capture
      // phase. Keep its ordinary VS Code command from stealing focus while it
      // is acting as a held cell-navigation modifier.
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const directCellDirection = tableCellArrowDirection(event.key);
    if (
      directCellDirection &&
      isPlainKey(event) &&
      isTableNavigationModifierHeld(
        wrapper.ownerDocument,
        tableNavigationModifier,
      )
    ) {
      event.preventDefault();
      event.stopPropagation();
      const currentTable = getCurrentTable();
      const target = resolveAdjacentGridCell(
        cell,
        currentTable,
        directCellDirection,
      );
      if (!target) {
        // Grid arrows do not wrap. With no destination, preserve the current
        // caret or selection exactly as a standard directional no-op would.
        return;
      }
      commitCellEdit(view, currentTable, cell);
      focusCellAfterRender(currentTable.from, target);
      return;
    }

    const verticalArrow = isUnmodifiedVerticalArrow(event);
    const selectingVerticalArrow = isCellSelectionVerticalArrow(event);
    const horizontalArrow = isUnmodifiedHorizontalArrow(event);
    const selectingHorizontalArrow = isCellSelectionHorizontalArrow(event);
    // Let unhandled keys continue through the webview. VS Code's keyboard
    // command relay relies on that path for workbench commands such as Save,
    // Find, and user-defined keybindings. Stop propagation only when this
    // handler replaces the key's native behavior below.
    const currentTable = getCurrentTable();

    const historyDirection = getCellEditHistoryDirection(event);
    if (historyDirection) {
      if (!restoreCellEditHistory(cell, historyDirection)) {
        scheduleNativeHistoryFallback(
          view,
          currentTable,
          cell,
          scheduleTableLayout,
        );
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      applyLiveCellEdit(view, currentTable, cell);
      scheduleTableLayout();
      return;
    }

    if (isMetaOnlyCellArrow(event)) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        moveCellSelectionToLineBoundary(
          cell,
          event.key === "ArrowLeft" ? "start" : "end",
          event.shiftKey,
        );
      } else {
        const selection = getCellSelectionOffsets(cell);
        if (selection) {
          const target = event.key === "ArrowUp"
            ? 0
            : readCellDisplayValue(cell).length;
          setCellSelectionOffsets(
            cell,
            event.shiftKey ? selection.anchor : target,
            target,
          );
        }
      }
      return;
    }

    if (isModifiedCellArrow(event)) {
      const selection = getCellSelectionOffsets(cell);
      if (!selection) {
        return;
      }
      const valueLength = readCellDisplayValue(cell).length;
      const movingOutward =
        ((event.key === "ArrowLeft" || event.key === "ArrowUp") &&
          selection.head === 0) ||
        ((event.key === "ArrowRight" || event.key === "ArrowDown") &&
          selection.head === valueLength);
      if (movingOutward) {
        event.preventDefault();
        event.stopPropagation();
        if (selection.anchor !== selection.head && !event.shiftKey) {
          setCellCaretOffset(cell, selection.head);
        }
      }
      return;
    }

    if (isPrimaryModifiedCellHomeEnd(event)) {
      const selection = getCellSelectionOffsets(cell);
      if (!selection) {
        return;
      }
      const target = event.key === "Home"
        ? 0
        : readCellDisplayValue(cell).length;
      event.preventDefault();
      event.stopPropagation();
      setCellSelectionOffsets(
        cell,
        event.shiftKey ? selection.anchor : target,
        target,
      );
      return;
    }

    if (event.key === "Enter" && isPlainKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      exitCellToBoundary(view, currentTable, cell, "after");
      return;
    }

    if (
      event.key === "Enter" &&
      event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      if (!getCellSelectionOffsets(cell)) {
        focusCellAtEnd(cell);
      }
      const nextSnapshot = computeCellTextInsertionSnapshot(cell, "\n");
      if (!nextSnapshot) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      applyCellEditSnapshotChange(
        view,
        currentTable,
        cell,
        nextSnapshot,
        scheduleTableLayout,
      );
      return;
    }

    if (selectingVerticalArrow) {
      event.preventDefault();
      event.stopPropagation();
      extendCellSelectionVertically(
        cell,
        event.key === "ArrowUp" ? -1 : 1,
      );
      return;
    }

    if (verticalArrow) {
      const rowDelta = event.key === "ArrowUp" ? -1 : 1;
      event.preventDefault();
      event.stopPropagation();
      const verticalMove = moveCellCaretVertically(cell, rowDelta);
      if (verticalMove.movedWithinCell) {
        return;
      }

      const target = resolveVerticalCell(cell, rowDelta);
      if (target === "before-table") {
        exitCellToBoundary(view, currentTable, cell, "before");
        return;
      }
      if (target === "after-table") {
        exitCellToBoundary(view, currentTable, cell, "after");
        return;
      }

      commitCellEdit(view, currentTable, cell);
      focusCellAfterRender(currentTable.from, target, {
        rowDelta,
        preferredX: verticalMove.preferredX,
      });
      return;
    }

    if (selectingHorizontalArrow) {
      const selection = getCellSelectionOffsets(cell);
      const valueLength = readCellDisplayValue(cell).length;
      const extendingPastCell = Boolean(
        selection &&
          ((event.key === "ArrowLeft" && selection.head === 0) ||
            (event.key === "ArrowRight" && selection.head === valueLength)),
      );
      if (extendingPastCell) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    if (horizontalArrow) {
      const selection = getCellSelectionOffsets(cell);
      const valueLength = readCellDisplayValue(cell).length;
      const movingAcrossBoundary = Boolean(
        selection &&
          selection.anchor === selection.head &&
          ((event.key === "ArrowLeft" && selection.head === 0) ||
            (event.key === "ArrowRight" && selection.head === valueLength)),
      );
      if (movingAcrossBoundary) {
        event.preventDefault();
        event.stopPropagation();
        const delta = event.key === "ArrowLeft" ? -1 : 1;
        const target = resolveRelativeCell(cell, delta);
        if (target === "before-table") {
          exitCellToBoundary(view, currentTable, cell, "before");
          return;
        }
        if (target === "after-table") {
          exitCellToBoundary(view, currentTable, cell, "after");
          return;
        }
        commitCellEdit(view, currentTable, cell);
        focusCellAfterRender(
          currentTable.from,
          target,
          undefined,
          event.key === "ArrowRight" ? "start" : "end",
        );
        return;
      }
    }

    if (
      event.key === "Tab" &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      const target = resolveRelativeCell(cell, event.shiftKey ? -1 : 1);
      if (target === "before-table") {
        exitCellToBoundary(view, currentTable, cell, "before");
        return;
      }
      if (target === "after-table") {
        exitCellToBoundary(view, currentTable, cell, "after");
        return;
      }
      commitCellEdit(view, currentTable, cell);
      focusCellAfterRender(currentTable.from, target);
    }
  });

}

function resolveAdjacentGridCell(
  cell: HTMLElement,
  table: ParsedTable,
  direction: TableCellArrowDirection,
): CellTarget | null {
  const rowKind = cell.dataset.rowKind;
  const rowIndex = Number(cell.dataset.rowIndex ?? "0");
  const column = Number(cell.dataset.column ?? "0");
  if (
    (rowKind !== "header" && rowKind !== "body") ||
    !Number.isInteger(rowIndex) ||
    rowIndex < 0 ||
    !Number.isInteger(column) ||
    column < 0
  ) {
    return null;
  }

  const target = adjacentTableCell(
    { row: rowKind === "header" ? 0 : rowIndex + 1, column },
    direction,
    { rowCount: table.body.length + 1, columnCount: table.columnCount },
  );
  if (!target) {
    return null;
  }
  return {
    rowKind: target.row === 0 ? "header" : "body",
    rowIndex: String(target.row === 0 ? 0 : target.row - 1),
    column: String(target.column),
  };
}

function tableCellArrowDirection(
  key: string,
): TableCellArrowDirection | null {
  if (key === "ArrowUp") {
    return "up";
  }
  if (key === "ArrowDown") {
    return "down";
  }
  if (key === "ArrowLeft") {
    return "left";
  }
  return key === "ArrowRight" ? "right" : null;
}

/**
 * Fallback when the per-cell history has no snapshot for a native
 * undo/redo: let the browser apply its own history mutation, then sync the
 * result back into the source on the next tick.
 */
function scheduleNativeHistoryFallback(
  view: EditorView,
  table: ParsedTable,
  cell: HTMLElement,
  scheduleTableLayout: () => void,
): void {
  setTimeout(() => {
    if (!cell.isConnected) {
      return;
    }

    syncCellEditHistory(cell);
    applyLiveCellEdit(view, table, cell);
    scheduleTableLayout();
  }, 0);
}

/**
 * Commits the cell's current value to the markdown source as a sequence of
 * host undo steps (one per distinct value the user typed through), so VS Code
 * undo retraces the edit history instead of reverting the whole cell at once.
 */
function commitCellEdit(
  view: EditorView,
  table: ParsedTable,
  cell: HTMLElement,
  options: { selectionAnchor?: number } = {},
): void {
  const rowKind = cell.dataset.rowKind;
  const rowIndex = Number(cell.dataset.rowIndex ?? "0");
  const column = Number(cell.dataset.column ?? "0");
  if (rowKind !== "header" && rowKind !== "body") {
    dispatchSelection(view, options.selectionAnchor);
    return;
  }

  const sourceRow =
    rowKind === "header" ? table.header : (table.body[rowIndex] ?? null);
  if (!sourceRow || !Number.isInteger(column) || column < 0) {
    dispatchSelection(view, options.selectionAnchor);
    return;
  }

  const value = readCellDisplayValue(cell);
  if (value === getCellSourceValue(cell)) {
    dispatchSelection(view, options.selectionAnchor);
    return;
  }

  const originalValue = getCellSourceValue(cell);
  const caretOffset = getCellCaretOffset(cell);
  const restoreCaretOffset = Math.min(
    originalValue.length,
    caretOffset + Math.max(0, originalValue.length - value.length),
  );
  const valueSteps = buildCellCommitValueSteps(
    getCellEditHistory(cell),
    originalValue,
    value,
    restoreCaretOffset,
  );
  const sourceSteps = buildCellSourceCommitSteps(
    sourceRow,
    table.columnCount,
    column,
    valueSteps,
  );
  const finalSourceStep = sourceSteps[sourceSteps.length - 1];
  if (!finalSourceStep) {
    dispatchSelection(view, options.selectionAnchor);
    return;
  }
  const edit = formatTableCellSourceEdit(
    sourceRow,
    table.columnCount,
    column,
    value,
  );
  view.dom.dispatchEvent(
    new CustomEvent(TABLE_CELL_COMMIT_EVENT, {
      bubbles: true,
      detail: {
        tableFrom: table.from,
        rowKind,
        rowIndex,
        column,
        from: edit.from,
        to: edit.to,
        insertLength: edit.insert.length,
        valueLength: value.length,
        restoreCaretOffset: finalSourceStep.restoreCaretOffset,
      },
    }),
  );
  const selectionAnchor =
    options.selectionAnchor === undefined
      ? undefined
      : mapPositionThroughCellEdit(options.selectionAnchor, edit);
  view.dispatch({
    changes: {
      from: edit.from,
      to: edit.to,
      insert: edit.insert,
    },
    selection:
      selectionAnchor === undefined
        ? undefined
        : EditorSelection.cursor(selectionAnchor, 1),
    annotations: [
      allowTableSourceChange.of(true),
      tableCellCommitSequenceAnnotation.of({
        steps: sourceSteps.map((step) => ({
          change: step.change,
          restore: {
            tableFrom: table.from,
            rowKind,
            rowIndex,
            column,
            from: step.change.from,
            to: step.change.to,
            restoreCaretOffset: step.restoreCaretOffset,
          },
        })),
      }),
    ],
    scrollIntoView: true,
    userEvent: "input",
  });
}

/**
 * Writes the cell's in-progress value straight through to the markdown
 * source while the user types. The transaction carries the live edit
 * annotation, and the widget's parsed table copy plus cell metadata are
 * updated in place, so the rendered DOM never rebuilds mid-keystroke.
 *
 * Returns false when the cell has no backing row or the value is unchanged.
 */
function applyLiveCellEdit(
  view: EditorView,
  table: ParsedTable,
  cell: HTMLElement,
): boolean {
  const rowKind = cell.dataset.rowKind;
  const rowIndex = Number(cell.dataset.rowIndex ?? "0");
  const column = Number(cell.dataset.column ?? "0");
  if (
    (rowKind !== "header" && rowKind !== "body") ||
    !Number.isInteger(rowIndex) ||
    rowIndex < 0 ||
    !Number.isInteger(column) ||
    column < 0
  ) {
    return false;
  }

  const sourceRow =
    rowKind === "header" ? table.header : (table.body[rowIndex] ?? null);
  if (!sourceRow) {
    return false;
  }

  const value = readCellDisplayValue(cell);
  const originalValue = getCellSourceValue(cell);
  if (value === originalValue) {
    return false;
  }

  const caretOffset = getCellCaretOffset(cell);
  const restoreCaretOffset = Math.min(
    originalValue.length,
    caretOffset + Math.max(0, originalValue.length - value.length),
  );
  const currentRowText = readCurrentSourceRowText(view, sourceRow);
  const edit =
    formatLiveTableCellSourceEdit(
      view,
      sourceRow,
      table.columnCount,
      column,
      value,
    ) ?? formatTableCellSourceEdit(sourceRow, table.columnCount, column, value);
  const restore = {
    tableFrom: table.from,
    rowKind,
    rowIndex,
    column,
    from: edit.from,
    to: edit.to,
    restoreCaretOffset,
  };
  view.dom.dispatchEvent(
    new CustomEvent(TABLE_CELL_COMMIT_EVENT, {
      bubbles: true,
      detail: {
        ...restore,
        insertLength: edit.insert.length,
        valueLength: value.length,
      },
    }),
  );
  updateTableSourceAfterCellEdit(
    table,
    rowKind,
    rowIndex,
    edit,
    currentRowText,
  );
  const wrapper = cell.closest<HTMLElement>(".mlrt-table-widget");
  if (wrapper) {
    syncTableSourceMetadata(wrapper, table);
  }
  preserveTableForLiveEdit(table.from);
  view.dispatch({
    changes: {
      from: edit.from,
      to: edit.to,
      insert: edit.insert,
    },
    annotations: [
      allowTableSourceChange.of(true),
      tableCellLiveEditAnnotation.of({
        change: {
          from: edit.from,
          to: edit.to,
          text: edit.insert,
        },
        restore,
      }),
    ],
    userEvent: "input",
  });
  requestElementAnimationFrame(cell, () => {
    releaseTableLiveEditPreservation(table.from);
  });
  if (!cell.isConnected || cell.ownerDocument.activeElement !== cell) {
    focusCellAfterRenderAtOffset(
      table.from,
      { rowKind, rowIndex: String(rowIndex), column: String(column) },
      caretOffset,
    );
  }
  return true;
}

function getCellSourceValue(cell: HTMLElement): string {
  return cell.dataset.sourceValue ?? "";
}

/**
 * Source edit for a live keystroke, computed against the row text currently
 * in the document (which may already include earlier live edits) rather than
 * the widget's original parse.
 */
function formatLiveTableCellSourceEdit(
  view: EditorView,
  sourceRow: ParsedRow,
  columnCount: number,
  column: number,
  value: string,
): TableCellSourceEdit | null {
  const currentRowText = readCurrentSourceRowText(view, sourceRow);
  if (currentRowText === undefined) {
    return null;
  }

  const currentRow = parseMarkdownTableRow(
    sourceRow.lineIndex,
    sourceRow.from,
    currentRowText,
  );
  const sourceCell = currentRow.cells[column];
  if (!sourceCell) {
    return formatTableCellSourceEdit(currentRow, columnCount, column, value);
  }

  const { leadingWhitespace, trailingWhitespace } = getCellPaddingWhitespace(
    sourceCell.raw,
  );
  return {
    from: sourceCell.start,
    to: sourceCell.end,
    insert: ensureTableCellSeparatorSafe(
      `${tableCellLeadingPipePrefix(sourceRow, column)}${leadingWhitespace}${formatMarkdownCell(value, { trim: false })}${trailingWhitespace}`,
    ),
  };
}

function readCurrentSourceRowText(
  view: EditorView,
  sourceRow: ParsedRow,
): string | undefined {
  try {
    const line = view.state.doc.lineAt(sourceRow.from);
    return line.text;
  } catch {
    return undefined;
  }
}

/**
 * Updates the widget's parsed table copy in place after a live edit: the
 * edited row is re-parsed and every later row's offsets are shifted by the
 * edit delta, keeping the model aligned with the document without a full
 * reparse.
 */
function updateTableSourceAfterCellEdit(
  table: ParsedTable,
  rowKind: "header" | "body",
  rowIndex: number,
  edit: TableCellSourceEdit,
  currentRowText: string | undefined,
): void {
  const sourceRow = rowKind === "header" ? table.header : table.body[rowIndex];
  if (!sourceRow) {
    return;
  }

  const previousRowText = currentRowText ?? sourceRow.text;
  const previousRowLength = previousRowText.length;
  const nextRowText = `${previousRowText.slice(0, edit.from - sourceRow.from)}${edit.insert}${previousRowText.slice(edit.to - sourceRow.from)}`;
  const delta = nextRowText.length - previousRowLength;
  table.to += delta;
  const nextSourceRow = parseMarkdownTableRow(
    sourceRow.lineIndex,
    sourceRow.from,
    nextRowText,
  );
  sourceRow.to = nextSourceRow.to;
  sourceRow.text = nextSourceRow.text;
  sourceRow.cells = nextSourceRow.cells;

  for (const row of [table.delimiter, ...table.body]) {
    if (row === sourceRow || row.from <= sourceRow.from) {
      continue;
    }
    row.from += delta;
    row.to += delta;
    for (const cell of row.cells) {
      cell.start += delta;
      cell.end += delta;
    }
  }
}

/**
 * Converts the per-cell undo stack into the ordered list of distinct values
 * the commit should expose as individual host undo steps.
 */
function buildCellCommitValueSteps(
  history: CellEditHistory | undefined,
  originalValue: string,
  finalValue: string,
  fallbackRestoreCaretOffset: number,
): CellCommitValueStep[] {
  const snapshots = history?.undoStack ?? [];
  const steps: CellCommitValueStep[] = [];
  let currentValue = originalValue;

  for (let index = 1; index < snapshots.length; index++) {
    const snapshot = snapshots[index];
    if (snapshot.value === currentValue) {
      continue;
    }

    steps.push({
      value: snapshot.value,
      restoreCaretOffset: snapshots[index - 1]?.caretOffset ?? 0,
    });
    currentValue = snapshot.value;
  }

  if (finalValue !== currentValue) {
    steps.push({
      value: finalValue,
      restoreCaretOffset:
        snapshots[snapshots.length - 1]?.caretOffset ??
        fallbackRestoreCaretOffset,
    });
  }

  return steps;
}

/**
 * Maps value steps onto document change steps: the first step replaces the
 * original cell span; each following step replaces the previous insertion.
 */
function buildCellSourceCommitSteps(
  sourceRow: ParsedRow,
  columnCount: number,
  column: number,
  valueSteps: CellCommitValueStep[],
): CellSourceCommitStep[] {
  let currentEdit: TableCellSourceEdit | null = null;
  return valueSteps.map((step) => {
    const formattedEdit = formatTableCellSourceEdit(
      sourceRow,
      columnCount,
      column,
      step.value,
    );
    const change = currentEdit
      ? {
          from: currentEdit.from,
          to: currentEdit.from + currentEdit.insert.length,
          text: formattedEdit.insert,
        }
      : {
          from: formattedEdit.from,
          to: formattedEdit.to,
          text: formattedEdit.insert,
        };
    currentEdit = {
      from: change.from,
      to: change.from + change.text.length,
      insert: change.text,
    };
    return {
      change,
      restoreCaretOffset: step.restoreCaretOffset,
    };
  });
}

function dispatchSelection(
  view: EditorView,
  selectionAnchor: number | undefined,
): void {
  if (selectionAnchor === undefined) {
    return;
  }

  view.dispatch({
    selection: EditorSelection.cursor(selectionAnchor, 1),
    scrollIntoView: true,
  });
}

function mapPositionThroughCellEdit(
  position: number,
  edit: { from: number; to: number; insert: string },
): number {
  if (position <= edit.from) {
    return position;
  }
  if (position <= edit.to) {
    return edit.from + edit.insert.length;
  }

  return position + edit.insert.length - (edit.to - edit.from);
}

function resolveRelativeCell(
  cell: HTMLElement,
  delta: number,
): VerticalCellTarget {
  const cells = Array.from(
    cell
      .closest(".mlrt-table")
      ?.querySelectorAll<HTMLElement>(TABLE_CELL_SELECTOR) ?? [],
  );
  const index = cells.indexOf(cell);
  const next = cells[index + delta];
  if (!next) {
    return delta < 0 ? "before-table" : "after-table";
  }
  return {
    rowKind: next.dataset.rowKind ?? "body",
    rowIndex: next.dataset.rowIndex ?? "0",
    column: next.dataset.column ?? "0",
  };
}

function resolveVerticalCell(
  cell: HTMLElement,
  rowDelta: -1 | 1,
): VerticalCellTarget {
  const column = cell.dataset.column ?? "0";
  const columnCells = Array.from(
    cell
      .closest(".mlrt-table")
      ?.querySelectorAll<HTMLElement>(
        `${TABLE_CELL_SELECTOR}[data-column="${column}"]`,
      ) ?? [],
  );
  const index = columnCells.indexOf(cell);
  const next = columnCells[index + rowDelta];
  if (!next) {
    return rowDelta < 0 ? "before-table" : "after-table";
  }

  return {
    rowKind: next.dataset.rowKind ?? "body",
    rowIndex: next.dataset.rowIndex ?? "0",
    column: next.dataset.column ?? "0",
  };
}

function focusCellAfterRender(
  tableFrom: number,
  target: CellTarget,
  vertical?: { rowDelta: -1 | 1; preferredX: number | null },
  horizontalPlacement: "start" | "end" = "end",
): void {
  const focusTarget = (): boolean => {
    const cell = queryCell(tableFrom, target);
    if (!cell) {
      return false;
    }

    if (vertical) {
      focusCellAtVerticalEdge(
        cell,
        vertical.rowDelta,
        vertical.preferredX,
      );
    } else if (horizontalPlacement === "start") {
      focusCellAtStart(cell);
    } else {
      focusCellAtEnd(cell);
    }
    return true;
  };

  // CodeMirror dispatch is synchronous. A missing destination must not leave
  // behind a delayed focus write that can override a later user action.
  focusTarget();
}

function exitCellToBoundary(
  view: EditorView,
  table: ParsedTable,
  cell: HTMLElement,
  side: "before" | "after",
): void {
  commitCellEdit(view, table, cell);
  cell.blur();
  view.focus();
  selectVisibleTableBoundary(view, table, side);
}

function focusCellAfterRenderAtOffset(
  tableFrom: number,
  target: CellTarget,
  caretOffset: number,
): void {
  const focusTarget = (): boolean => {
    const cell = queryCell(tableFrom, target);
    if (!cell) {
      return false;
    }
    cell.focus();
    setCellCaretOffset(cell, caretOffset);
    return true;
  };
  focusTarget();
}

function queryCell(tableFrom: number, target: CellTarget): HTMLElement | null {
  const selector = [
    `${TABLE_CELL_SELECTOR}[data-table-from="${tableFrom}"]`,
    `[data-row-kind="${target.rowKind}"]`,
    `[data-row-index="${target.rowIndex}"]`,
    `[data-column="${target.column}"]`,
  ].join("");
  return document.querySelector<HTMLElement>(selector);
}

function ensureCellEditHistory(cell: HTMLElement): CellEditHistory {
  const key = getCellHistoryKey(cell);
  const existing = cellEditHistories.get(key);
  if (existing) {
    return existing;
  }

  if (cellEditHistories.size >= MAX_TRACKED_CELL_HISTORIES) {
    const oldestKey = cellEditHistories.keys().next().value;
    if (oldestKey !== undefined) {
      cellEditHistories.delete(oldestKey);
    }
  }

  const history: CellEditHistory = {
    undoStack: [],
    redoStack: [],
    lastValue: readCellDisplayValue(cell),
  };
  cellEditHistories.set(key, history);
  return history;
}

function getCellEditHistory(cell: HTMLElement): CellEditHistory | undefined {
  return cellEditHistories.get(getCellHistoryKey(cell));
}

function getCellHistoryKey(cell: HTMLElement): string {
  return [
    cell.dataset.tableFrom ?? "",
    cell.dataset.rowKind ?? "",
    cell.dataset.rowIndex ?? "",
    cell.dataset.column ?? "",
  ].join(":");
}

function recordCellEditHistory(cell: HTMLElement): void {
  const history = ensureCellEditHistory(cell);
  const snapshot = captureCellEditSnapshot(cell);
  const previousSnapshot = history.undoStack[history.undoStack.length - 1];
  if (
    previousSnapshot &&
    previousSnapshot.value === snapshot.value &&
    previousSnapshot.caretOffset === snapshot.caretOffset
  ) {
    return;
  }

  history.undoStack.push(snapshot);
  history.redoStack = [];
  history.lastValue = snapshot.value;
}

function syncCellEditHistory(cell: HTMLElement): void {
  ensureCellEditHistory(cell).lastValue = readCellDisplayValue(cell);
}

function restoreCellEditHistory(
  cell: HTMLElement,
  direction: "undo" | "redo",
): boolean {
  const history = ensureCellEditHistory(cell);
  const sourceStack =
    direction === "undo" ? history.undoStack : history.redoStack;
  const targetStack =
    direction === "undo" ? history.redoStack : history.undoStack;
  const snapshot = sourceStack.pop();
  if (!snapshot) {
    return false;
  }

  targetStack.push(captureCellEditSnapshot(cell));
  applyCellEditSnapshot(cell, snapshot);
  history.lastValue = snapshot.value;
  return true;
}

/**
 * Converts Chromium's platform-native target range to display-text offsets.
 * A non-empty range that crosses a cell boundary is reported as unsafe so the
 * pure input decision blocks it instead of allowing the browser to merge DOM
 * cells or rows.
 */
function getCellInputTargetSelection(
  cell: HTMLElement,
  event: InputEvent,
): CellTextSelection | null | undefined {
  let ranges: StaticRange[];
  try {
    ranges = event.getTargetRanges();
  } catch {
    return undefined;
  }
  if (ranges.length === 0) {
    return undefined;
  }
  if (ranges.length !== 1) {
    return null;
  }

  const [range] = ranges;
  if (
    !isNodeInsideCell(range.startContainer, cell) ||
    !isNodeInsideCell(range.endContainer, cell)
  ) {
    return null;
  }

  try {
    return {
      anchor: getCellDomPointOffset(
        cell,
        range.startContainer,
        range.startOffset,
      ),
      head: getCellDomPointOffset(
        cell,
        range.endContainer,
        range.endOffset,
      ),
    };
  } catch {
    return null;
  }
}

function getCellInputData(event: InputEvent): string | null {
  if (
    event.inputType === "insertFromPaste" ||
    event.inputType === "insertFromPasteAsQuotation" ||
    event.inputType === "insertFromDrop" ||
    event.inputType === "insertReplacementText" ||
    event.inputType === "insertFromYank" ||
    event.inputType === "insertTranspose"
  ) {
    const transferred = event.dataTransfer?.getData("text/plain");
    // Chromium can expose the transfer object while keeping its plain-text
    // slot empty for replacement-style events. Preserve a populated `data`
    // fallback instead of accidentally turning that replacement into delete.
    return transferred || event.data || null;
  }
  return event.data;
}

function getCellDomPointOffset(
  cell: HTMLElement,
  node: Node,
  offset: number,
): number {
  const range = cell.ownerDocument.createRange();
  range.selectNodeContents(cell);
  range.setEnd(node, offset);
  const measured = range.toString().replace(/\u00a0/g, " ").length;
  range.detach();
  return measured;
}

function isNodeInsideCell(node: Node, cell: HTMLElement): boolean {
  return node === cell || cell.contains(node);
}

function computeCellTextInsertionSnapshot(
  cell: HTMLElement,
  insert: string,
): CellEditSnapshot | null {
  const selection = getCellSelectionOffsets(cell);
  if (!selection) {
    return null;
  }

  const value = readCellDisplayValue(cell);
  return replaceCellTextRange(
    value,
    Math.min(selection.anchor, selection.head),
    Math.max(selection.anchor, selection.head),
    insert,
  );
}

function replaceCellTextRange(
  value: string,
  from: number,
  to: number,
  insert: string,
): CellEditSnapshot {
  return {
    value: `${value.slice(0, from)}${insert}${value.slice(to)}`,
    caretOffset: from + insert.length,
  };
}

function applyCellEditSnapshotChange(
  view: EditorView,
  table: ParsedTable,
  cell: HTMLElement,
  snapshot: CellEditSnapshot,
  scheduleTableLayout: () => void,
): void {
  recordCellEditHistory(cell);
  applyCellEditSnapshot(cell, snapshot);
  syncCellEditHistory(cell);
  applyLiveCellEdit(view, table, cell);
  scheduleTableLayout();
}

function captureCellEditSnapshot(cell: HTMLElement): CellEditSnapshot {
  return {
    value: readCellDisplayValue(cell),
    caretOffset: getCellCaretOffset(cell),
  };
}

function applyCellEditSnapshot(
  cell: HTMLElement,
  snapshot: CellEditSnapshot,
): void {
  setCellPlainText(cell, snapshot.value);
  setCellCaretOffset(cell, snapshot.caretOffset);
}

function getCellEditHistoryDirection(
  event: KeyboardEvent,
): "undo" | "redo" | null {
  const key = event.key.toLowerCase();
  const primaryModifier = event.metaKey || event.ctrlKey;
  if (!primaryModifier || event.altKey) {
    return null;
  }

  if (key === "z") {
    return event.shiftKey ? "redo" : "undo";
  }

  if (key === "y" && !event.shiftKey) {
    return "redo";
  }

  return null;
}

function isPlainKey(event: KeyboardEvent): boolean {
  return !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

function isUnmodifiedVerticalArrow(event: KeyboardEvent): boolean {
  return (
    (event.key === "ArrowUp" || event.key === "ArrowDown") && isPlainKey(event)
  );
}

function isUnmodifiedHorizontalArrow(event: KeyboardEvent): boolean {
  return (
    (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
    isPlainKey(event)
  );
}

function isModifiedCellArrow(event: KeyboardEvent): boolean {
  return (
    (event.key === "ArrowUp" ||
      event.key === "ArrowDown" ||
      event.key === "ArrowLeft" ||
      event.key === "ArrowRight") &&
    (event.altKey || event.ctrlKey || event.metaKey)
  );
}

function isMetaOnlyCellArrow(event: KeyboardEvent): boolean {
  return (
    (event.key === "ArrowUp" ||
      event.key === "ArrowDown" ||
      event.key === "ArrowLeft" ||
      event.key === "ArrowRight") &&
    event.metaKey &&
    !event.altKey &&
    !event.ctrlKey
  );
}

function isPrimaryModifiedCellHomeEnd(event: KeyboardEvent): boolean {
  return (
    (event.key === "Home" || event.key === "End") &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey
  );
}

function isCellSelectionVerticalArrow(event: KeyboardEvent): boolean {
  return (
    (event.key === "ArrowUp" || event.key === "ArrowDown") &&
    event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey
  );
}

function isCellSelectionHorizontalArrow(event: KeyboardEvent): boolean {
  return (
    (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
    event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey
  );
}
