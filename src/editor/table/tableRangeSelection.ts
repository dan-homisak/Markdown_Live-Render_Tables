import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getParsedTables, ParsedTable } from "../../shared/tableModel";
import {
  CellRectangle,
  MLRT_CLIPBOARD_VERSION,
} from "../../shared/clipboardModel";
import {
  findCell,
  focusCellAtEnd,
  readCellDisplayValue,
  TABLE_CELL_SELECTOR,
} from "./cellSelection";

export const TABLE_SELECTION_CHANGE_EVENT = "mlrt:table-selection-change";
export const TABLE_SELECTION_CLEAR_EVENT = "mlrt:table-selection-clear";

export interface TableCellAddress {
  /** Header is row 0; body rows begin at 1. */
  row: number;
  column: number;
}

export interface TableRangeSelectionState {
  version: typeof MLRT_CLIPBOARD_VERSION;
  wrapper: HTMLElement;
  tableFrom: number;
  anchor: TableCellAddress;
  head: TableCellAddress;
  pendingCutToken?: string;
}

interface SelectionDocumentState {
  selection: TableRangeSelectionState | null;
  pointerAnchor: TableCellAddress | null;
  pointerId: number | null;
  pointerCrossedCells: boolean;
}

const states = new WeakMap<Document, SelectionDocumentState>();

export function bindTableRangeSelection(
  wrapper: HTMLElement,
  view: EditorView,
  table: ParsedTable,
): () => void {
  wrapper.tabIndex = -1;
  let suppressNativeMouseDrag = false;
  let lastDocumentDragRange: { anchor: number; head: number } | null = null;

  const onPointerDown = (event: PointerEvent): void => {
    const cell = findCell(event.target);
    if (!cell || !wrapper.contains(cell)) {
      return;
    }
    if (event.button !== 0) {
      if (event.button === 2) {
        // Prevent contenteditable from stealing focus and collapsing either a
        // rectangular or document selection before contextmenu is dispatched.
        event.preventDefault();
      }
      return;
    }
    const address = addressFromCell(cell);
    if (!address) {
      return;
    }
    const state = stateFor(wrapper.ownerDocument);
    if (event.shiftKey) {
      const current = getTableRangeSelection(wrapper.ownerDocument);
      const focusedCell = findCell(wrapper.ownerDocument.activeElement);
      const focusedAddress =
        focusedCell && wrapper.contains(focusedCell)
          ? addressFromCell(focusedCell)
          : null;
      const anchor =
        current?.wrapper === wrapper
          ? current.anchor
          : focusedAddress ?? address;
      event.preventDefault();
      setTableRangeSelection(wrapper, table.from, anchor, address, true);
      return;
    }
    state.pointerAnchor = address;
    state.pointerId = event.pointerId;
    state.pointerCrossedCells = false;
    suppressNativeMouseDrag = false;
    lastDocumentDragRange = null;
    wrapper.ownerDocument.addEventListener("pointermove", onPointerMove, true);
    wrapper.ownerDocument.addEventListener("pointerup", onPointerUp, true);
    wrapper.ownerDocument.addEventListener("pointercancel", onPointerUp, true);
    wrapper.ownerDocument.addEventListener("mousemove", onMouseMove, true);
    wrapper.ownerDocument.addEventListener("mouseup", onMouseUp, true);
    wrapper.ownerDocument.addEventListener("click", onClickAfterDrag, true);
    if (state.selection?.wrapper === wrapper) {
      clearTableRangeSelection(wrapper.ownerDocument);
    }
  };

  const updateDragSelection = (event: PointerEvent | MouseEvent): void => {
    const state = stateFor(wrapper.ownerDocument);
    if (
      ("pointerId" in event &&
        state.pointerId !== -1 &&
        state.pointerId !== event.pointerId) ||
      !state.pointerAnchor ||
      (event.buttons & 1) === 0
    ) {
      return;
    }
    const target = wrapper.ownerDocument.elementFromPoint(
      event.clientX,
      event.clientY,
    );
    const cell = findCell(target);
    if (cell && wrapper.contains(cell)) {
      const address = addressFromCell(cell);
      if (!address || sameAddress(address, state.pointerAnchor)) {
        return;
      }
      state.pointerCrossedCells = true;
      suppressNativeMouseDrag = true;
      event.preventDefault();
      setTableRangeSelection(
        wrapper,
        table.from,
        state.pointerAnchor,
        address,
        true,
      );
      return;
    }

    // Controls and scrollbars are part of the table widget, not the document.
    // Wait until the pointer actually leaves the widget before promoting the
    // gesture to a linear CodeMirror selection.
    if (target && wrapper.contains(target)) {
      return;
    }

    let documentPosition = view.posAtCoords({
      x: event.clientX,
      y: event.clientY,
    });
    const wrapperRect = wrapper.getBoundingClientRect();
    if (documentPosition === null) {
      documentPosition = event.clientY < wrapperRect.top
        ? 0
        : view.state.doc.length;
    }
    const tableFrom = Number(wrapper.dataset.srcFrom ?? table.from);
    const parsedTables = getParsedTables(view.state.doc);
    const currentTable = parsedTables.find(
      (candidate) => candidate.from === tableFrom,
    );
    const tableTo = currentTable?.to ?? tableFrom + (table.to - table.from);
    const targetWrapper = target instanceof Element
      ? target.closest<HTMLElement>(".mlrt-table-widget")
      : null;
    if (targetWrapper && targetWrapper !== wrapper) {
      const targetFrom = Number(targetWrapper.dataset.srcFrom ?? "-1");
      const targetTable = parsedTables.find(
        (candidate) => candidate.from === targetFrom,
      );
      if (targetTable) {
        // Positions inside rendered tables map to zero-height hidden source
        // lines. Snap the head to the far table boundary so the second table
        // is selected atomically and cannot flicker between partial states.
        documentPosition = targetFrom >= tableFrom
          ? targetTable.to
          : targetTable.from;
      }
    }
    const movingBeforeTable =
      documentPosition <= tableFrom || event.clientY < wrapperRect.top;
    const movingAfterTable =
      documentPosition >= tableTo || event.clientY > wrapperRect.bottom;
    if (!movingBeforeTable && !movingAfterTable) {
      return;
    }

    state.pointerCrossedCells = true;
    suppressNativeMouseDrag = true;
    event.preventDefault();
    event.stopPropagation();
    clearTableRangeSelection(wrapper.ownerDocument);
    clearNativeSelection(wrapper.ownerDocument);
    if (!view.hasFocus) {
      view.focus();
    }
    lastDocumentDragRange = {
      anchor: movingBeforeTable ? tableTo : tableFrom,
      head: documentPosition,
    };
    view.dispatch({
      selection: EditorSelection.range(
        lastDocumentDragRange.anchor,
        lastDocumentDragRange.head,
      ),
      scrollIntoView: true,
    });
  };

  const onPointerMove = (event: PointerEvent): void => {
    updateDragSelection(event);
  };

  const onPointerUp = (event: PointerEvent): void => {
    const state = stateFor(wrapper.ownerDocument);
    if (state.pointerId !== event.pointerId) {
      return;
    }
    state.pointerAnchor = null;
    state.pointerId = null;
    state.pointerCrossedCells = false;
    // A compatibility mouseup follows pointerup. Keep the capture listeners
    // through that event so CodeMirror cannot replace the atomic range with a
    // hidden-source selection, then release them at the end of the task.
    queueMicrotask(restoreLastDocumentDragRange);
    setTimeout(removeDocumentPointerListeners, 0);
  };

  const onMouseMove = (event: MouseEvent): void => {
    const state = stateFor(wrapper.ownerDocument);
    if (state.pointerAnchor && (event.buttons & 1) !== 0) {
      updateDragSelection(event);
    }
    if (suppressNativeMouseDrag) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const onMouseUp = (event: MouseEvent): void => {
    const state = stateFor(wrapper.ownerDocument);
    if (suppressNativeMouseDrag) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (state.pointerId === -1) {
      state.pointerAnchor = null;
      state.pointerId = null;
      state.pointerCrossedCells = false;
      setTimeout(removeDocumentPointerListeners, 0);
    }
    queueMicrotask(restoreLastDocumentDragRange);
  };

  const onClickAfterDrag = (event: MouseEvent): void => {
    if (!suppressNativeMouseDrag) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    suppressNativeMouseDrag = false;
  };

  const restoreLastDocumentDragRange = (): void => {
    if (!lastDocumentDragRange) {
      return;
    }
    view.dispatch({
      selection: EditorSelection.range(
        lastDocumentDragRange.anchor,
        lastDocumentDragRange.head,
      ),
    });
  };

  const onMouseDown = (event: MouseEvent): void => {
    const state = stateFor(wrapper.ownerDocument);
    if (event.button !== 0 || state.pointerAnchor) {
      return;
    }
    const cell = findCell(event.target);
    const address = cell && wrapper.contains(cell)
      ? addressFromCell(cell)
      : null;
    if (!address) {
      return;
    }
    state.pointerAnchor = address;
    state.pointerId = -1;
    state.pointerCrossedCells = false;
    suppressNativeMouseDrag = false;
    wrapper.ownerDocument.addEventListener("mousemove", onMouseMove, true);
    wrapper.ownerDocument.addEventListener("mouseup", onMouseUp, true);
    wrapper.ownerDocument.addEventListener("click", onClickAfterDrag, true);
    if (state.selection?.wrapper === wrapper) {
      clearTableRangeSelection(wrapper.ownerDocument);
    }
  };

  const removeDocumentPointerListeners = (): void => {
    const finalRange = lastDocumentDragRange;
    wrapper.ownerDocument.removeEventListener("pointermove", onPointerMove, true);
    wrapper.ownerDocument.removeEventListener("pointerup", onPointerUp, true);
    wrapper.ownerDocument.removeEventListener("pointercancel", onPointerUp, true);
    wrapper.ownerDocument.removeEventListener("mousemove", onMouseMove, true);
    wrapper.ownerDocument.removeEventListener("mouseup", onMouseUp, true);
    wrapper.ownerDocument.removeEventListener("click", onClickAfterDrag, true);
    suppressNativeMouseDrag = false;
    lastDocumentDragRange = null;
    if (finalRange) {
      clearNativeSelection(wrapper.ownerDocument);
      view.dispatch({
        selection: EditorSelection.range(finalRange.anchor, finalRange.head),
      });
    }
  };

  const onFocusIn = (event: FocusEvent): void => {
    const cell = findCell(event.target);
    if (cell && wrapper.contains(cell)) {
      clearTableRangeSelection(wrapper.ownerDocument);
    }
  };

  const onDocumentSelectionPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return;
    }
    const selection = getTableRangeSelection(wrapper.ownerDocument);
    if (
      selection?.wrapper === wrapper &&
      event.target instanceof Node &&
      !wrapper.contains(event.target)
    ) {
      clearTableRangeSelection(wrapper.ownerDocument);
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const activeCell = findCell(event.target);
    if (activeCell && wrapper.contains(activeCell)) {
      if (event.key === "Escape") {
        const address = addressFromCell(activeCell);
        if (!address) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        activeCell.blur();
        setTableRangeSelection(
          wrapper,
          Number(wrapper.dataset.srcFrom ?? table.from),
          address,
          address,
          true,
        );
        return;
      }
      if (isSelectAll(event)) {
        handleCellSelectAll(event, wrapper, table, activeCell);
      }
      return;
    }

    const selection = getTableRangeSelection(wrapper.ownerDocument);
    if (!selection || selection.wrapper !== wrapper) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (selection.pendingCutToken) {
        setPendingCutToken(wrapper.ownerDocument, undefined);
      } else {
        clearTableRangeSelection(wrapper.ownerDocument);
      }
      return;
    }
    if (isSelectAll(event)) {
      event.preventDefault();
      event.stopPropagation();
      const rectangle = selectionRectangle(selection);
      const rowCount = table.body.length + 1;
      if (
        rectangle.top === 0 &&
        rectangle.bottom === rowCount - 1 &&
        rectangle.left === 0 &&
        rectangle.right === table.columnCount - 1
      ) {
        clearTableRangeSelection(wrapper.ownerDocument);
        view.focus();
        view.dispatch({
          selection: EditorSelection.range(0, view.state.doc.length),
          scrollIntoView: true,
        });
      } else {
        setTableRangeSelection(
          wrapper,
          selection.tableFrom,
          { row: 0, column: 0 },
          { row: rowCount - 1, column: table.columnCount - 1 },
          true,
        );
      }
      return;
    }
    if (
      event.key === "ArrowUp" ||
      event.key === "ArrowDown" ||
      event.key === "ArrowLeft" ||
      event.key === "ArrowRight" ||
      event.key === "Tab"
    ) {
      event.preventDefault();
      event.stopPropagation();
      const delta = keyDelta(event);
      const nextHead = clampAddress(
        {
          row: selection.head.row + delta.row,
          column: selection.head.column + delta.column,
        },
        table,
      );
      const nextAnchor = event.shiftKey ? selection.anchor : nextHead;
      setTableRangeSelection(
        wrapper,
        selection.tableFrom,
        nextAnchor,
        nextHead,
        true,
      );
      return;
    }
    if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      event.stopPropagation();
      const target = cellFromAddress(wrapper, selection.head);
      clearTableRangeSelection(wrapper.ownerDocument);
      if (target) {
        focusCellAtEnd(target);
      }
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      event.stopPropagation();
      wrapper.dispatchEvent(
        new CustomEvent(TABLE_SELECTION_CLEAR_EVENT, { bubbles: true }),
      );
      return;
    }
    if (isPrintableKey(event)) {
      const target = cellFromAddress(wrapper, selection.head);
      event.preventDefault();
      event.stopPropagation();
      clearTableRangeSelection(wrapper.ownerDocument);
      if (target) {
        target.focus();
        const nativeSelection = wrapper.ownerDocument.defaultView?.getSelection();
        const range = wrapper.ownerDocument.createRange();
        range.selectNodeContents(target);
        nativeSelection?.removeAllRanges();
        nativeSelection?.addRange(range);
        wrapper.ownerDocument.execCommand("insertText", false, event.key);
      }
    }
  };

  wrapper.addEventListener("pointerdown", onPointerDown);
  wrapper.addEventListener("mousedown", onMouseDown);
  wrapper.addEventListener("focusin", onFocusIn);
  wrapper.addEventListener("keydown", onKeyDown);
  wrapper.ownerDocument.addEventListener(
    "pointerdown",
    onDocumentSelectionPointerDown,
    true,
  );
  restoreSelectionClasses(wrapper);

  return () => {
    wrapper.removeEventListener("pointerdown", onPointerDown);
    wrapper.removeEventListener("mousedown", onMouseDown);
    removeDocumentPointerListeners();
    wrapper.removeEventListener("focusin", onFocusIn);
    wrapper.removeEventListener("keydown", onKeyDown);
    wrapper.ownerDocument.removeEventListener(
      "pointerdown",
      onDocumentSelectionPointerDown,
      true,
    );
  };
}

export function getTableRangeSelection(
  doc: Document,
): TableRangeSelectionState | null {
  const state = states.get(doc)?.selection ?? null;
  if (state && !state.wrapper.isConnected) {
    const replacement = Array.from(
      doc.querySelectorAll<HTMLElement>(".mlrt-table-widget"),
    ).find(
      (candidate) =>
        Number(candidate.dataset.srcFrom ?? "-1") === state.tableFrom,
    );
    if (replacement) {
      state.wrapper = replacement;
      applySelectionClasses(state);
      return state;
    }
    return null;
  }
  return state;
}

export function setTableRangeSelection(
  wrapper: HTMLElement,
  tableFrom: number,
  anchor: TableCellAddress,
  head: TableCellAddress,
  focusWrapper: boolean,
): TableRangeSelectionState {
  const doc = wrapper.ownerDocument;
  const state = stateFor(doc);
  if (state.selection?.wrapper !== wrapper) {
    clearSelectionClasses(state.selection?.wrapper);
  }
  const selection: TableRangeSelectionState = {
    version: MLRT_CLIPBOARD_VERSION,
    wrapper,
    tableFrom,
    anchor,
    head,
  };
  state.selection = selection;
  applySelectionClasses(selection);
  clearNativeSelection(doc);
  if (focusWrapper) {
    wrapper.focus({ preventScroll: true });
  }
  dispatchSelectionChange(wrapper);
  return selection;
}

export function selectTableRow(
  wrapper: HTMLElement,
  tableFrom: number,
  row: number,
  columnCount: number,
): void {
  setTableRangeSelection(
    wrapper,
    tableFrom,
    { row, column: 0 },
    { row, column: Math.max(0, columnCount - 1) },
    true,
  );
}

export function selectTableColumn(
  wrapper: HTMLElement,
  tableFrom: number,
  column: number,
  rowCount: number,
): void {
  setTableRangeSelection(
    wrapper,
    tableFrom,
    { row: 0, column },
    { row: Math.max(0, rowCount - 1), column },
    true,
  );
}

export function selectionRectangle(
  selection: TableRangeSelectionState,
): CellRectangle {
  return {
    top: Math.min(selection.anchor.row, selection.head.row),
    bottom: Math.max(selection.anchor.row, selection.head.row),
    left: Math.min(selection.anchor.column, selection.head.column),
    right: Math.max(selection.anchor.column, selection.head.column),
  };
}

export function isCellInSelection(
  selection: TableRangeSelectionState,
  address: TableCellAddress,
): boolean {
  const rectangle = selectionRectangle(selection);
  return (
    address.row >= rectangle.top &&
    address.row <= rectangle.bottom &&
    address.column >= rectangle.left &&
    address.column <= rectangle.right
  );
}

export function clearTableRangeSelection(doc: Document): void {
  const state = states.get(doc);
  if (!state?.selection) {
    return;
  }
  const wrapper = state.selection.wrapper;
  clearSelectionClasses(wrapper);
  state.selection = null;
  dispatchSelectionChange(wrapper);
}

export function setPendingCutToken(
  doc: Document,
  token: string | undefined,
): void {
  const selection = getTableRangeSelection(doc);
  if (!selection) {
    return;
  }
  selection.pendingCutToken = token;
  applySelectionClasses(selection);
  dispatchSelectionChange(selection.wrapper);
}

export function ensureContextCellSelection(
  wrapper: HTMLElement,
  tableFrom: number,
  cell: HTMLElement,
): TableRangeSelectionState | null {
  const address = addressFromCell(cell);
  if (!address) {
    return null;
  }
  const current = getTableRangeSelection(wrapper.ownerDocument);
  if (
    current?.wrapper === wrapper &&
    isCellInSelection(current, address)
  ) {
    return current;
  }
  return setTableRangeSelection(wrapper, tableFrom, address, address, false);
}

export function addressFromCell(
  cell: HTMLElement,
): TableCellAddress | null {
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
  return { row: rowKind === "header" ? 0 : rowIndex + 1, column };
}

export function cellFromAddress(
  wrapper: HTMLElement,
  address: TableCellAddress,
): HTMLElement | null {
  const rowKind = address.row === 0 ? "header" : "body";
  const rowIndex = address.row === 0 ? 0 : address.row - 1;
  return wrapper.querySelector<HTMLElement>(
    `${TABLE_CELL_SELECTOR}[data-row-kind="${rowKind}"][data-row-index="${rowIndex}"][data-column="${address.column}"]`,
  );
}

function handleCellSelectAll(
  event: KeyboardEvent,
  wrapper: HTMLElement,
  table: ParsedTable,
  activeCell: HTMLElement,
): void {
  const selection = wrapper.ownerDocument.defaultView?.getSelection();
  const valueLength = readCellDisplayValue(activeCell).length;
  const selectedLength = selection?.toString().replace(/\u00a0/g, " ").length ?? 0;
  if (selectedLength < valueLength) {
    event.preventDefault();
    event.stopPropagation();
    const range = wrapper.ownerDocument.createRange();
    range.selectNodeContents(activeCell);
    selection?.removeAllRanges();
    selection?.addRange(range);
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  activeCell.blur();
  setTableRangeSelection(
    wrapper,
    Number(wrapper.dataset.srcFrom ?? table.from),
    { row: 0, column: 0 },
    { row: table.body.length, column: table.columnCount - 1 },
    true,
  );
}

function applySelectionClasses(selection: TableRangeSelectionState): void {
  const rectangle = selectionRectangle(selection);
  selection.wrapper.classList.add("mlrt-table-selection-mode");
  selection.wrapper.classList.toggle(
    "mlrt-table-cut-pending",
    Boolean(selection.pendingCutToken),
  );
  selection.wrapper
    .querySelectorAll<HTMLElement>(TABLE_CELL_SELECTOR)
    .forEach((cell) => {
      const address = addressFromCell(cell);
      const selected = Boolean(
        address &&
          address.row >= rectangle.top &&
          address.row <= rectangle.bottom &&
          address.column >= rectangle.left &&
          address.column <= rectangle.right,
      );
      cell.classList.toggle("mlrt-table-cell-selected", selected);
      cell.classList.toggle(
        "mlrt-table-selection-top",
        selected && Boolean(address && address.row === rectangle.top),
      );
      cell.classList.toggle(
        "mlrt-table-selection-bottom",
        selected && Boolean(address && address.row === rectangle.bottom),
      );
      cell.classList.toggle(
        "mlrt-table-selection-left",
        selected && Boolean(address && address.column === rectangle.left),
      );
      cell.classList.toggle(
        "mlrt-table-selection-right",
        selected && Boolean(address && address.column === rectangle.right),
      );
      cell.classList.toggle(
        "mlrt-table-cell-selection-head",
        selected && Boolean(address && sameAddress(address, selection.head)),
      );
      cell.setAttribute("aria-selected", selected ? "true" : "false");
    });
  syncTableSelectionOutline(selection.wrapper);
}

function restoreSelectionClasses(wrapper: HTMLElement): void {
  const selection = states.get(wrapper.ownerDocument)?.selection;
  if (
    selection &&
    selection.tableFrom === Number(wrapper.dataset.srcFrom ?? "-1")
  ) {
    selection.wrapper = wrapper;
    applySelectionClasses(selection);
  }
}

function clearSelectionClasses(wrapper: HTMLElement | undefined): void {
  if (!wrapper) {
    return;
  }
  wrapper.classList.remove(
    "mlrt-table-selection-mode",
    "mlrt-table-cut-pending",
  );
  wrapper
    .querySelectorAll<HTMLElement>(TABLE_CELL_SELECTOR)
    .forEach((cell) => {
      cell.classList.remove(
        "mlrt-table-cell-selected",
        "mlrt-table-cell-selection-head",
        "mlrt-table-selection-top",
        "mlrt-table-selection-bottom",
        "mlrt-table-selection-left",
        "mlrt-table-selection-right",
      );
      cell.removeAttribute("aria-selected");
    });
  syncTableSelectionOutline(wrapper);
}

/**
 * The frame owns the selection perimeter. Individual cells own their inset
 * dividers, so every separator stays aligned to the real row height.
 */
export function syncTableSelectionOutline(wrapper: HTMLElement): void {
  const scroll = wrapper.querySelector<HTMLElement>(".mlrt-table-scroll");
  const existing = scroll?.querySelector<HTMLElement>(
    ":scope > .mlrt-table-selection-outline",
  );
  if (!scroll || wrapper.classList.contains("mlrt-table-cut-pending")) {
    existing?.remove();
    return;
  }

  const selected = Array.from(
    wrapper.querySelectorAll<HTMLElement>(
      `${TABLE_CELL_SELECTOR}.mlrt-table-cell-selected, ` +
        `${TABLE_CELL_SELECTOR}.mlrt-document-range-selected`,
    ),
  );
  if (selected.length === 0) {
    existing?.remove();
    return;
  }

  const scrollRect = scroll.getBoundingClientRect();
  const rectangles = selected.map((cell) => cell.getBoundingClientRect());
  const left = Math.min(...rectangles.map((rect) => rect.left));
  const top = Math.min(...rectangles.map((rect) => rect.top));
  const right = Math.max(...rectangles.map((rect) => rect.right));
  const bottom = Math.max(...rectangles.map((rect) => rect.bottom));
  const outline =
    existing ?? wrapper.ownerDocument.createElement("div");
  outline.className = "mlrt-table-selection-outline";
  outline.setAttribute("aria-hidden", "true");
  outline.style.left = `${left - scrollRect.left + scroll.scrollLeft}px`;
  outline.style.top = `${top - scrollRect.top + scroll.scrollTop}px`;
  outline.style.width = `${right - left}px`;
  outline.style.height = `${bottom - top}px`;
  if (!existing) {
    scroll.append(outline);
  }
}

function dispatchSelectionChange(wrapper: HTMLElement): void {
  wrapper.dispatchEvent(
    new CustomEvent(TABLE_SELECTION_CHANGE_EVENT, { bubbles: true }),
  );
}

function stateFor(doc: Document): SelectionDocumentState {
  const current = states.get(doc);
  if (current) {
    return current;
  }
  const state: SelectionDocumentState = {
    selection: null,
    pointerAnchor: null,
    pointerId: null,
    pointerCrossedCells: false,
  };
  states.set(doc, state);
  return state;
}

function clearNativeSelection(doc: Document): void {
  doc.defaultView?.getSelection()?.removeAllRanges();
}

function clampAddress(
  address: TableCellAddress,
  table: ParsedTable,
): TableCellAddress {
  return {
    row: Math.max(0, Math.min(table.body.length, address.row)),
    column: Math.max(0, Math.min(table.columnCount - 1, address.column)),
  };
}

function keyDelta(event: KeyboardEvent): TableCellAddress {
  if (event.key === "ArrowUp") {
    return { row: -1, column: 0 };
  }
  if (event.key === "ArrowDown") {
    return { row: 1, column: 0 };
  }
  if (event.key === "ArrowLeft" || (event.key === "Tab" && event.shiftKey)) {
    return { row: 0, column: -1 };
  }
  return { row: 0, column: 1 };
}

function isSelectAll(event: KeyboardEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    event.key.toLowerCase() === "a"
  );
}

function isPrintableKey(event: KeyboardEvent): boolean {
  return (
    event.key.length === 1 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  );
}

function sameAddress(
  left: TableCellAddress,
  right: TableCellAddress,
): boolean {
  return left.row === right.row && left.column === right.column;
}
