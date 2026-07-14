import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorDragPosition } from "../dragPosition";
import {
  clearDocumentSelectionProjection,
  documentSelectionProjectionsEqual,
  documentSelectionProjectionTransaction,
  DocumentSelectionProjection,
  DocumentTableSelectionRegion,
  fullTableRectangle,
  getDocumentSelectionProjection,
  proseToTableRectangle,
  setDocumentSelectionProjection,
  tableToProseRectangle,
} from "../documentSelectionState";
import {
  getParsedTables,
  ParsedTable,
  positionAfterTable,
  positionBeforeTable,
} from "../../shared/tableModel";
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
import { getPendingClipboardCut } from "../clipboardCutState";
import { syncTableSelectionOverlay } from "./tableSelectionOverlay";
import { getTableWidgetTable } from "./tableWidgetState";

export const TABLE_SELECTION_CHANGE_EVENT = "mlrt:table-selection-change";
export const TABLE_SELECTION_CLEAR_EVENT = "mlrt:table-selection-clear";
export const TABLE_CUT_CANCEL_EVENT = "mlrt:table-cut-cancel";

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
  pointerCleanup: (() => void) | null;
  view: EditorView | null;
}

const states = new WeakMap<Document, SelectionDocumentState>();

export function bindTableRangeSelection(
  wrapper: HTMLElement,
  view: EditorView,
  table: ParsedTable,
): () => void {
  wrapper.tabIndex = -1;
  wrapper.setAttribute("role", "group");
  wrapper.setAttribute("aria-label", "Markdown table cell selection");
  let suppressNativeMouseDrag = false;
  let lastDocumentDragRange: { anchor: number; head: number } | null = null;
  let lastDocumentDragProjection: DocumentSelectionProjection | null = null;
  let lastDocumentDragDocument: EditorView["state"]["doc"] | null = null;
  let pointerCaptureId: number | null = null;
  let pointerCaptureGeneration: number | null = null;
  let ownsPointerCapture = false;
  let pointerCleanupTimer: ReturnType<typeof setTimeout> | null = null;
  let gestureGeneration = 0;
  let activeGestureGeneration: number | null = null;
  const currentTable = (): ParsedTable => getTableWidgetTable(wrapper) ?? table;
  stateFor(wrapper.ownerDocument).view = view;

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
    if (!event.isPrimary) {
      // Secondary touch/pen pointers must not replace or tear down the active
      // primary table-selection gesture.
      return;
    }
    const address = addressFromCell(cell);
    if (!address) {
      return;
    }
    const state = stateFor(wrapper.ownerDocument);
    // A missing release (for example, an iframe blur) must not leave an old
    // table widget's document listeners attached. A new gesture owns the
    // shared table-selection state only after the previous owner has safely
    // finalized its last projected range.
    state.pointerCleanup?.();
    if (!view.state.selection.main.empty) {
      view.dispatch({
        selection: EditorSelection.cursor(positionBeforeTable(currentTable()), 1),
      });
    }
    clearDocumentSelectionProjection(wrapper.ownerDocument);
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
      setTableRangeSelection(wrapper, currentTable().from, anchor, address, true);
      return;
    }
    state.pointerAnchor = address;
    state.pointerId = event.pointerId;
    state.pointerCrossedCells = false;
    activeGestureGeneration = ++gestureGeneration;
    suppressNativeMouseDrag = false;
    lastDocumentDragRange = null;
    lastDocumentDragProjection = null;
    lastDocumentDragDocument = null;
    wrapper.ownerDocument.addEventListener("pointermove", onPointerMove, true);
    wrapper.ownerDocument.addEventListener("pointerup", onPointerUp, true);
    wrapper.ownerDocument.addEventListener("pointercancel", onPointerUp, true);
    wrapper.ownerDocument.addEventListener("mousemove", onMouseMove, true);
    wrapper.ownerDocument.addEventListener("mouseup", onMouseUp, true);
    wrapper.ownerDocument.addEventListener("click", onClickAfterDrag, true);
    state.pointerCleanup = removeDocumentPointerListeners;
    if (state.selection?.wrapper === wrapper) {
      clearTableRangeSelection(wrapper.ownerDocument);
    }
  };

  const claimPointerCapture = (
    event: PointerEvent | MouseEvent,
  ): void => {
    if (!("pointerId" in event)) {
      return;
    }
    const state = stateFor(wrapper.ownerDocument);
    if (
      state.pointerCleanup !== removeDocumentPointerListeners ||
      state.pointerId !== event.pointerId ||
      ownsPointerCapture
    ) {
      return;
    }
    try {
      // Keep ordinary caret placement and same-cell text selection native.
      // The table takes ownership only after the gesture has become a cell or
      // mixed document selection.
      if (!wrapper.hasPointerCapture(event.pointerId)) {
        wrapper.setPointerCapture(event.pointerId);
      }
      ownsPointerCapture = wrapper.hasPointerCapture(event.pointerId);
      pointerCaptureId = ownsPointerCapture ? event.pointerId : null;
      pointerCaptureGeneration = ownsPointerCapture
        ? activeGestureGeneration
        : null;
    } catch {
      // Synthetic events do not necessarily represent a platform pointer.
      // The document-level pointer/mouse listeners remain the fallback.
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
      if (!address) {
        return;
      }
      if (
        sameAddress(address, state.pointerAnchor) &&
        !state.pointerCrossedCells &&
        !lastDocumentDragRange
      ) {
        return;
      }
      state.pointerCrossedCells = true;
      suppressNativeMouseDrag = true;
      claimPointerCapture(event);
      event.preventDefault();
      event.stopPropagation();
      const currentSelection = getTableRangeSelection(
        wrapper.ownerDocument,
      );
      const selectionUnchanged = Boolean(
        currentSelection?.wrapper === wrapper &&
          sameAddress(currentSelection.anchor, state.pointerAnchor) &&
          sameAddress(currentSelection.head, address) &&
          lastDocumentDragRange === null,
      );
      lastDocumentDragRange = null;
      lastDocumentDragProjection = null;
      lastDocumentDragDocument = null;
      clearDocumentSelectionProjection(wrapper.ownerDocument);
      if (!selectionUnchanged) {
        setTableRangeSelection(
          wrapper,
          currentTable().from,
          state.pointerAnchor,
          address,
          true,
        );
      }
      return;
    }

    const latestTable = currentTable();
    const tableRect =
      wrapper.querySelector<HTMLElement>(".mlrt-table")
        ?.getBoundingClientRect() ?? wrapper.getBoundingClientRect();

    // Horizontal excursions stay in cell-selection mode. Clamp the pointer to
    // the nearest edge cell instead of promoting through hidden source lines.
    if (event.clientY >= tableRect.top && event.clientY <= tableRect.bottom) {
      const clampedCell = nearestCellInWrapper(
        wrapper,
        event.clientX,
        event.clientY,
      );
      const address = clampedCell ? addressFromCell(clampedCell) : null;
      if (address) {
        state.pointerCrossedCells = true;
        suppressNativeMouseDrag = true;
        claimPointerCapture(event);
        event.preventDefault();
        event.stopPropagation();
        const currentSelection = getTableRangeSelection(
          wrapper.ownerDocument,
        );
        const selectionUnchanged = Boolean(
          currentSelection?.wrapper === wrapper &&
            sameAddress(currentSelection.anchor, state.pointerAnchor) &&
            sameAddress(currentSelection.head, address) &&
            lastDocumentDragRange === null,
        );
        lastDocumentDragRange = null;
        lastDocumentDragProjection = null;
        lastDocumentDragDocument = null;
        clearDocumentSelectionProjection(wrapper.ownerDocument);
        if (!selectionUnchanged) {
          setTableRangeSelection(
            wrapper,
            latestTable.from,
            state.pointerAnchor,
            address,
            true,
          );
        }
      }
      return;
    }

    const tableFrom = Number(wrapper.dataset.srcFrom ?? latestTable.from);
    const parsedTables = getParsedTables(view.state.doc);
    const parsedTable = parsedTables.find(
      (candidate) => candidate.from === tableFrom,
    );
    const tableTo =
      parsedTable?.to ?? tableFrom + (latestTable.to - latestTable.from);
    const movingBeforeTable = event.clientY < tableRect.top;
    const movingAfterTable = event.clientY > tableRect.bottom;
    if (!movingBeforeTable && !movingAfterTable) {
      return;
    }

    const targetCell = cell ?? documentCellAtPoint(
      wrapper.ownerDocument,
      event.clientX,
      event.clientY,
      wrapper,
    );
    let documentPosition: number | null = null;
    let targetTable: ParsedTable | null = null;
    let targetAddress: TableCellAddress | null = null;
    if (targetCell) {
      const targetFrom = Number(targetCell.dataset.tableFrom ?? "NaN");
      targetTable = parsedTables.find(
        (candidate) => candidate.from === targetFrom,
      ) ?? null;
      targetAddress = addressFromCell(targetCell);
      if (targetTable && targetAddress) {
        const sourceSpan = renderedCellSpan(targetCell, targetTable);
        documentPosition = movingAfterTable
          ? sourceSpan?.to ?? targetTable.to
          : sourceSpan?.from ?? targetTable.from;
      }
    }
    if (documentPosition === null) {
      documentPosition = editorDragPosition(
        view,
        event.clientX,
        event.clientY,
      );
    }
    if (documentPosition === null) {
      return;
    }

    state.pointerCrossedCells = true;
    suppressNativeMouseDrag = true;
    claimPointerCapture(event);
    event.preventDefault();
    event.stopPropagation();
    clearTableRangeSelection(wrapper.ownerDocument);
    clearNativeSelection(wrapper.ownerDocument);
    if (!view.hasFocus) {
      view.focus();
    }
    const anchorPosition = movingBeforeTable ? tableTo : tableFrom;
    const nextRange = {
      anchor: anchorPosition,
      head: documentPosition,
    };
    const nextProjection = {
      ...nextRange,
      tableRegions: regionsForTableToDocument(
        parsedTables,
        parsedTable ?? latestTable,
        state.pointerAnchor,
        movingBeforeTable ? "above" : "below",
        documentPosition,
        targetTable,
        targetAddress,
      ),
    };
    publishDocumentDragSelection(nextRange, nextProjection);
  };

  const publishDocumentDragSelection = (
    range: { anchor: number; head: number },
    projection: DocumentSelectionProjection,
  ): void => {
    const currentRange = view.state.selection.main;
    const currentProjection = getDocumentSelectionProjection(
      wrapper.ownerDocument,
      currentRange,
    );
    const rangeChanged =
      currentRange.anchor !== range.anchor || currentRange.head !== range.head;
    const projectionChanged = !documentSelectionProjectionsEqual(
      currentProjection,
      projection,
    );
    lastDocumentDragRange = range;
    lastDocumentDragProjection = projection;
    lastDocumentDragDocument = view.state.doc;
    setDocumentSelectionProjection(wrapper.ownerDocument, projection);
    if (!rangeChanged && !projectionChanged) {
      return;
    }
    view.dispatch({
      selection: EditorSelection.range(range.anchor, range.head),
      scrollIntoView: true,
      annotations: documentSelectionProjectionTransaction.of(true),
    });
  };

  const onPointerMove = (event: PointerEvent): void => {
    const state = stateFor(wrapper.ownerDocument);
    if (state.pointerCleanup !== removeDocumentPointerListeners) {
      return;
    }
    if (
      ownsPointerCapture &&
      pointerCaptureId !== null &&
      pointerCaptureGeneration === activeGestureGeneration &&
      !wrapper.hasPointerCapture(pointerCaptureId)
    ) {
      // Capture loss is observable before lostpointercapture is dispatched.
      // Do not let a move in that event-ordering gap mutate the finalized
      // selection.
      finishDocumentPointerGesture(true, activeGestureGeneration);
      return;
    }
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
    if (suppressNativeMouseDrag) {
      event.preventDefault();
      event.stopPropagation();
    }
    // A compatibility mouseup follows pointerup. Keep the capture listeners
    // through that event so CodeMirror cannot replace the atomic range with a
    // hidden-source selection, then release them at the end of the task.
    const generation = activeGestureGeneration;
    queueMicrotask(() => restoreLastDocumentDragRange(generation));
    schedulePointerCleanup();
  };

  const onMouseMove = (event: MouseEvent): void => {
    const state = stateFor(wrapper.ownerDocument);
    // A preceding PointerEvent may scroll the editor. The compatibility
    // MouseEvent intentionally re-resolves the same viewport coordinate;
    // the publish paths below no-op when the settled selection is identical.
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
      schedulePointerCleanup();
    }
    const generation = activeGestureGeneration;
    queueMicrotask(() => restoreLastDocumentDragRange(generation));
  };

  const onClickAfterDrag = (event: MouseEvent): void => {
    if (!suppressNativeMouseDrag) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    suppressNativeMouseDrag = false;
  };

  const restoreLastDocumentDragRange = (
    expectedGeneration: number | null = activeGestureGeneration,
  ): void => {
    if (
      expectedGeneration === null ||
      expectedGeneration !== activeGestureGeneration ||
      !lastDocumentDragRange
    ) {
      return;
    }
    restoreDocumentDragRange(
      lastDocumentDragRange,
      lastDocumentDragProjection,
      lastDocumentDragDocument,
    );
  };

  const restoreDocumentDragRange = (
    range: { anchor: number; head: number },
    projection: DocumentSelectionProjection | null,
    documentSnapshot: EditorView["state"]["doc"] | null,
  ): void => {
    // A widget can be destroyed while a pointer event is unwinding. Never
    // dispatch through a detached/destroyed editor or reapply source offsets
    // to a document that changed during the gesture.
    if (
      !view.dom.isConnected ||
      view.dom.ownerDocument !== wrapper.ownerDocument ||
      documentSnapshot === null ||
      view.state.doc !== documentSnapshot
    ) {
      return;
    }
    const documentLength = view.state.doc.length;
    const clampedRange = {
      anchor: Math.max(0, Math.min(documentLength, range.anchor)),
      head: Math.max(0, Math.min(documentLength, range.head)),
    };
    const clampedProjection = projection
      ? { ...projection, ...clampedRange }
      : null;
    if (clampedProjection) {
      setDocumentSelectionProjection(
        wrapper.ownerDocument,
        clampedProjection,
      );
    }
    view.dispatch({
      selection: EditorSelection.range(
        clampedRange.anchor,
        clampedRange.head,
      ),
      ...(clampedProjection
        ? {
            annotations: documentSelectionProjectionTransaction.of(true),
          }
        : {}),
    });
  };

  const schedulePointerCleanup = (): void => {
    const generation = activeGestureGeneration;
    if (generation === null) {
      return;
    }
    if (pointerCleanupTimer !== null) {
      clearTimeout(pointerCleanupTimer);
    }
    const timer = setTimeout(() => {
      if (pointerCleanupTimer !== timer) {
        return;
      }
      pointerCleanupTimer = null;
      if (activeGestureGeneration !== generation) {
        return;
      }
      finishDocumentPointerGesture(true, generation);
    }, 0);
    pointerCleanupTimer = timer;
  };

  const onMouseDown = (event: MouseEvent): void => {
    const state = stateFor(wrapper.ownerDocument);
    if (event.button !== 0) {
      return;
    }
    if (state.pointerAnchor) {
      if (state.pointerId !== -1) {
        // Compatibility mousedown after a real pointerdown belongs to the
        // active pointer gesture and must not replace its anchor.
        return;
      }
      // A mouse-only fallback has no capture guarantee. Recover from a missed
      // mouseup before beginning the next fallback gesture.
      state.pointerCleanup?.();
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
    activeGestureGeneration = ++gestureGeneration;
    suppressNativeMouseDrag = false;
    lastDocumentDragRange = null;
    lastDocumentDragProjection = null;
    lastDocumentDragDocument = null;
    if (!view.state.selection.main.empty) {
      view.dispatch({
        selection: EditorSelection.cursor(positionBeforeTable(currentTable()), 1),
      });
    }
    clearDocumentSelectionProjection(wrapper.ownerDocument);
    wrapper.ownerDocument.addEventListener("mousemove", onMouseMove, true);
    wrapper.ownerDocument.addEventListener("mouseup", onMouseUp, true);
    wrapper.ownerDocument.addEventListener("click", onClickAfterDrag, true);
    state.pointerCleanup = removeDocumentPointerListeners;
    if (state.selection?.wrapper === wrapper) {
      clearTableRangeSelection(wrapper.ownerDocument);
    }
  };

  const removeDocumentPointerListeners = (): void => {
    finishDocumentPointerGesture(true, activeGestureGeneration);
  };

  const finishDocumentPointerGesture = (
    restoreFinalRange: boolean,
    expectedGeneration: number | null,
  ): void => {
    const state = stateFor(wrapper.ownerDocument);
    const ownsGesture =
      expectedGeneration !== null &&
      expectedGeneration === activeGestureGeneration &&
      state.pointerCleanup === removeDocumentPointerListeners;
    const finalRange = ownsGesture && restoreFinalRange
      ? lastDocumentDragRange
      : null;
    const finalProjection = ownsGesture && restoreFinalRange
      ? lastDocumentDragProjection
      : null;
    const finalDocument = ownsGesture && restoreFinalRange
      ? lastDocumentDragDocument
      : null;
    const capturedPointerId = pointerCaptureId;
    if (pointerCleanupTimer !== null) {
      clearTimeout(pointerCleanupTimer);
      pointerCleanupTimer = null;
    }
    pointerCaptureId = null;
    pointerCaptureGeneration = null;
    ownsPointerCapture = false;
    wrapper.ownerDocument.removeEventListener("pointermove", onPointerMove, true);
    wrapper.ownerDocument.removeEventListener("pointerup", onPointerUp, true);
    wrapper.ownerDocument.removeEventListener("pointercancel", onPointerUp, true);
    wrapper.ownerDocument.removeEventListener("mousemove", onMouseMove, true);
    wrapper.ownerDocument.removeEventListener("mouseup", onMouseUp, true);
    wrapper.ownerDocument.removeEventListener("click", onClickAfterDrag, true);
    suppressNativeMouseDrag = false;
    lastDocumentDragRange = null;
    lastDocumentDragProjection = null;
    lastDocumentDragDocument = null;
    if (ownsGesture) {
      state.pointerAnchor = null;
      state.pointerId = null;
      state.pointerCrossedCells = false;
      state.pointerCleanup = null;
      activeGestureGeneration = null;
    }
    if (
      capturedPointerId !== null &&
      wrapper.hasPointerCapture(capturedPointerId)
    ) {
      try {
        wrapper.releasePointerCapture(capturedPointerId);
      } catch {
        // The browser may have released capture while teardown was running.
      }
    }
    if (finalRange) {
      clearNativeSelection(wrapper.ownerDocument);
      restoreDocumentDragRange(finalRange, finalProjection, finalDocument);
    }
  };

  const onLostPointerCapture = (event: PointerEvent): void => {
    const state = stateFor(wrapper.ownerDocument);
    if (
      event.pointerId !== pointerCaptureId ||
      pointerCaptureGeneration !== activeGestureGeneration ||
      state.pointerCleanup !== removeDocumentPointerListeners
    ) {
      return;
    }
    if (wrapper.hasPointerCapture(event.pointerId)) {
      // A delayed loss notification for an older gesture must not tear down a
      // newer capture that reused the platform mouse pointer id.
      return;
    }
    if (state.pointerId === null) {
      // Normal pointerup releases capture before the compatibility mouseup.
      // Keep the capture-phase mouse listeners until the scheduled teardown
      // so native cell editing cannot overwrite the projected final range.
      pointerCaptureId = null;
      pointerCaptureGeneration = null;
      ownsPointerCapture = false;
      return;
    }
    finishDocumentPointerGesture(true, activeGestureGeneration);
  };

  const onWindowBlur = (): void => {
    const state = stateFor(wrapper.ownerDocument);
    if (state.pointerCleanup === removeDocumentPointerListeners) {
      finishDocumentPointerGesture(true, activeGestureGeneration);
    }
  };

  const onFocusIn = (event: FocusEvent): void => {
    const cell = findCell(event.target);
    if (cell && wrapper.contains(cell)) {
      if (!view.state.selection.main.empty) {
        const latestTable = currentTable();
        view.dispatch({
          selection: EditorSelection.cursor(positionBeforeTable(latestTable), 1),
        });
      }
      clearDocumentSelectionProjection(wrapper.ownerDocument);
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
      const latestTable = currentTable();
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
          Number(wrapper.dataset.srcFrom ?? latestTable.from),
          address,
          address,
          true,
        );
        return;
      }
      if (isSelectAll(event)) {
        handleCellSelectAll(event, wrapper, latestTable, activeCell);
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
      if (
        selection.pendingCutToken ||
        getPendingClipboardCut(wrapper.ownerDocument)?.kind === "table"
      ) {
        wrapper.dispatchEvent(
          new CustomEvent(TABLE_CUT_CANCEL_EVENT, { bubbles: true }),
        );
      } else {
        const target = cellFromAddress(wrapper, selection.head);
        clearTableRangeSelection(wrapper.ownerDocument);
        if (target) {
          focusCellAtEnd(target);
        }
      }
      return;
    }
    const latestTable = currentTable();
    if (isSelectAll(event)) {
      event.preventDefault();
      event.stopPropagation();
      const rectangle = selectionRectangle(selection);
      const rowCount = latestTable.body.length + 1;
      if (
        rectangle.top === 0 &&
        rectangle.bottom === rowCount - 1 &&
        rectangle.left === 0 &&
        rectangle.right === latestTable.columnCount - 1
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
          { row: rowCount - 1, column: latestTable.columnCount - 1 },
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
      if (event.key === "Tab") {
        const nextHead = tabDestination(
          selection.head,
          latestTable,
          event.shiftKey,
        );
        if (nextHead) {
          setTableRangeSelection(
            wrapper,
            latestTable.from,
            nextHead,
            nextHead,
            true,
          );
        } else {
          clearTableRangeSelection(wrapper.ownerDocument);
          view.focus();
          view.dispatch({
            selection: EditorSelection.cursor(
              event.shiftKey
                ? positionBeforeTable(latestTable)
                : positionAfterTable(view.state.doc, latestTable),
              event.shiftKey ? -1 : 1,
            ),
            scrollIntoView: true,
          });
        }
        return;
      }
      if (
        isPlainKey(event) &&
        ((event.key === "ArrowUp" && selection.head.row === 0) ||
          (event.key === "ArrowDown" &&
            selection.head.row === latestTable.body.length))
      ) {
        const selectionAnchor =
          event.key === "ArrowUp"
            ? positionBeforeTable(latestTable)
            : view.state.doc.lineAt(
                positionAfterTable(view.state.doc, latestTable),
              ).to;
        clearTableRangeSelection(wrapper.ownerDocument);
        view.focus();
        view.dispatch({
          selection: EditorSelection.cursor(selectionAnchor, 1),
          scrollIntoView: true,
        });
        return;
      }
      const delta = keyDelta(event);
      const nextHead = clampAddress(
        {
          row: selection.head.row + delta.row,
          column: selection.head.column + delta.column,
        },
        latestTable,
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
  wrapper.addEventListener("lostpointercapture", onLostPointerCapture, true);
  wrapper.addEventListener("mousedown", onMouseDown);
  wrapper.addEventListener("focusin", onFocusIn);
  wrapper.addEventListener("keydown", onKeyDown);
  wrapper.ownerDocument.addEventListener(
    "pointerdown",
    onDocumentSelectionPointerDown,
    true,
  );
  wrapper.ownerDocument.defaultView?.addEventListener("blur", onWindowBlur);
  restoreSelectionClasses(wrapper);

  return () => {
    wrapper.removeEventListener("pointerdown", onPointerDown);
    wrapper.removeEventListener(
      "lostpointercapture",
      onLostPointerCapture,
      true,
    );
    wrapper.removeEventListener("mousedown", onMouseDown);
    finishDocumentPointerGesture(false, activeGestureGeneration);
    wrapper.removeEventListener("focusin", onFocusIn);
    wrapper.removeEventListener("keydown", onKeyDown);
    wrapper.ownerDocument.removeEventListener(
      "pointerdown",
      onDocumentSelectionPointerDown,
      true,
    );
    wrapper.ownerDocument.defaultView?.removeEventListener(
      "blur",
      onWindowBlur,
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
  if (state) {
    const currentFrom = Number(state.wrapper.dataset.srcFrom ?? "NaN");
    if (Number.isFinite(currentFrom)) {
      state.tableFrom = currentFrom;
    }
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
  const activeView = state.view;
  if (activeView && !activeView.state.selection.main.empty) {
    const activeTable = getTableWidgetTable(wrapper);
    activeView.dispatch({
      selection: EditorSelection.cursor(
        activeTable ? positionBeforeTable(activeTable) : tableFrom,
        1,
      ),
    });
  }
  clearDocumentSelectionProjection(doc);
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
  const selectedRowCount = rectangle.bottom - rectangle.top + 1;
  const selectedColumnCount = rectangle.right - rectangle.left + 1;
  selection.wrapper.classList.remove("mlrt-document-selection-mode");
  selection.wrapper.classList.add("mlrt-table-selection-mode");
  selection.wrapper.setAttribute(
    "aria-label",
    `${selectedRowCount} by ${selectedColumnCount} table cell selection`,
  );
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
    });
  syncTableSelectionOverlay(selection.wrapper);
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
  wrapper.setAttribute("aria-label", "Markdown table cell selection");
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
    });
  syncTableSelectionOverlay(wrapper);
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
    pointerCleanup: null,
    view: null,
  };
  states.set(doc, state);
  return state;
}

function tableDimensions(table: ParsedTable): {
  rowCount: number;
  columnCount: number;
} {
  return {
    rowCount: table.body.length + 1,
    columnCount: table.columnCount,
  };
}

function regionsForTableToDocument(
  tables: ParsedTable[],
  sourceTable: ParsedTable,
  sourceAnchor: TableCellAddress,
  direction: "above" | "below",
  documentPosition: number,
  targetTable: ParsedTable | null,
  targetAddress: TableCellAddress | null,
): DocumentTableSelectionRegion[] {
  const forward = direction === "below";
  const regions: DocumentTableSelectionRegion[] = [
    {
      tableFrom: sourceTable.from,
      ...tableToProseRectangle(
        direction,
        sourceAnchor,
        tableDimensions(sourceTable),
      ),
    },
  ];
  for (const table of tables) {
    if (table.from === sourceTable.from || table.from === targetTable?.from) {
      continue;
    }
    const between = forward
      ? table.from > sourceTable.from && table.from < documentPosition
      : table.from < sourceTable.from && table.to > documentPosition;
    if (between) {
      regions.push({
        tableFrom: table.from,
        ...fullTableRectangle(tableDimensions(table)),
      });
    }
  }
  if (targetTable && targetAddress && targetTable.from !== sourceTable.from) {
    regions.push({
      tableFrom: targetTable.from,
      ...proseToTableRectangle(
        forward ? "forward" : "backward",
        targetAddress,
        tableDimensions(targetTable),
      ),
    });
  }
  return regions;
}

function documentCellAtPoint(
  doc: Document,
  clientX: number,
  clientY: number,
  excludedWrapper: HTMLElement,
): HTMLElement | null {
  const direct = findCell(doc.elementFromPoint(clientX, clientY));
  if (direct && !excludedWrapper.contains(direct)) {
    return direct;
  }
  const wrapper = Array.from(
    doc.querySelectorAll<HTMLElement>(".mlrt-table-widget"),
  ).find((candidate) => {
    if (candidate === excludedWrapper) {
      return false;
    }
    const rect = candidate.querySelector<HTMLElement>(".mlrt-table")
      ?.getBoundingClientRect() ?? candidate.getBoundingClientRect();
    return clientY >= rect.top && clientY <= rect.bottom;
  });
  return wrapper
    ? nearestCellInWrapper(wrapper, clientX, clientY)
    : null;
}

function nearestCellInWrapper(
  wrapper: HTMLElement,
  clientX: number,
  clientY: number,
): HTMLElement | null {
  const cells = Array.from(
    wrapper.querySelectorAll<HTMLElement>(TABLE_CELL_SELECTOR),
  );
  if (cells.length === 0) {
    return null;
  }
  return cells.reduce((nearest, candidate) => {
    const distance = distanceToRect(
      candidate.getBoundingClientRect(),
      clientX,
      clientY,
    );
    const nearestDistance = distanceToRect(
      nearest.getBoundingClientRect(),
      clientX,
      clientY,
    );
    return distance < nearestDistance ? candidate : nearest;
  });
}

function distanceToRect(
  rect: DOMRect,
  clientX: number,
  clientY: number,
): number {
  const dx = Math.max(rect.left - clientX, 0, clientX - rect.right);
  const dy = Math.max(rect.top - clientY, 0, clientY - rect.bottom);
  return dx * dx + dy * dy;
}

function renderedCellSpan(
  cell: HTMLElement,
  table: ParsedTable,
): { from: number; to: number } | null {
  const directFrom = Number(cell.dataset.sourceFrom ?? "NaN");
  const directTo = Number(cell.dataset.sourceTo ?? "NaN");
  if (Number.isFinite(directFrom) && Number.isFinite(directTo)) {
    return { from: directFrom, to: Math.max(directFrom + 1, directTo) };
  }
  const row = cell.dataset.rowKind === "header"
    ? table.header
    : table.body[Number(cell.dataset.rowIndex ?? "0")];
  return row
    ? { from: row.from, to: Math.max(row.from + 1, row.to) }
    : null;
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
  if (event.key === "ArrowLeft") {
    return { row: 0, column: -1 };
  }
  return { row: 0, column: 1 };
}

function tabDestination(
  address: TableCellAddress,
  table: ParsedTable,
  reverse: boolean,
): TableCellAddress | null {
  const lastRow = table.body.length;
  const lastColumn = table.columnCount - 1;
  if (reverse) {
    if (address.column > 0) {
      return { row: address.row, column: address.column - 1 };
    }
    return address.row > 0
      ? { row: address.row - 1, column: lastColumn }
      : null;
  }
  if (address.column < lastColumn) {
    return { row: address.row, column: address.column + 1 };
  }
  return address.row < lastRow
    ? { row: address.row + 1, column: 0 }
    : null;
}

function isSelectAll(event: KeyboardEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    event.key.toLowerCase() === "a"
  );
}

function isPlainKey(event: KeyboardEvent): boolean {
  return !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
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
