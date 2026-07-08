import { EditorView } from "@codemirror/view";
import { MIN_COLUMN_WIDTH_CH } from "../../shared/tableColumnSizing";
import {
  getParsedTables,
  ParsedTable,
  TableCellSourceEdit,
} from "../../shared/tableModel";
import { allowTableSourceChange } from "../../shared/tableSourceProtection";
import {
  deleteTableColumnEdit,
  deleteTableRowEdit,
  insertTableColumnEdit,
  insertTableRowEdit,
} from "../../shared/tableStructureEdits";
import { focusCellAtEnd, TABLE_CELL_SELECTOR } from "./cellSelection";
import { measureChWidth } from "./tableLayout";
import { getTableWidgetTable } from "./tableWidgetState";

/**
 * Notion-style, proximity-driven structure controls for a rendered table.
 *
 * Instead of decorating every row and column, exactly one column indicator
 * (top border) and one row indicator (left border) follow the pointer:
 *
 * - hovering a cell marks its column and row with a short hairline that sits
 *   ON the table border (no reserved space),
 * - moving the pointer toward the border grows the hairline into a small
 *   three-dot handle that opens the flyout menu,
 * - while a cell is focused, its column and row keep accent hairlines even
 *   when the pointer is elsewhere; pointer-driven indicators appear alongside
 *   when the pointer targets a different column or row,
 * - thin "+" rails outside the right and bottom edges appear when the
 *   pointer approaches those edges (from either side) and append a column or
 *   row directly.
 *
 * Indicator length uses the width a freshly inserted (empty) column would
 * get, so on a minimum-width column the indicator spans the full column and
 * on wider columns it stays a compact centered mark.
 *
 * The controls are a pure overlay: they never affect table layout, and each
 * action resolves the table fresh from the current document, computes a
 * source edit via the pure functions in `shared/tableStructureEdits`, and
 * dispatches it as one annotated transaction. The resulting reparse rebuilds
 * the widget (and these controls) from the new table shape.
 */

const CONTROLS_OPEN_CLASS = "mlrt-table-controls-open";
const INDICATOR_ACTIVE_CLASS = "mlrt-table-indicator-active";

/** Hairline thickness: just past the 1px cell border, enough to read. */
const HAIRLINE_THICKNESS = 3;
/** Thickness of the grown three-dot handle. */
const DOT_THICKNESS = 13;
/** Depth inside the table edge where the hairline grows into the handle. */
const EDGE_GROW_ZONE = 22;
/** Reach outside the table edge that still counts as approaching it. */
const EDGE_APPROACH_ZONE = 26;
/** Reach beyond the right/bottom edge that reveals the append rails. */
const APPEND_PROXIMITY = 36;
const APPEND_RAIL_THICKNESS = 10;
const APPEND_RAIL_GAP = 2;
const MIN_INDICATOR_LENGTH = 12;

/**
 * Last pointer position over any live editor, shared across widget
 * instances so a rebuilt widget (after a structural edit) can restore its
 * proximity state without waiting for the next pointer move. This is what
 * lets the append rails survive consecutive clicks.
 */
let lastPointerPosition: { x: number; y: number } | null = null;

type IndicatorState = "line" | "dots";

interface StructureControlsOptions {
  wrapper: HTMLElement;
  view: EditorView;
  tableScroll: HTMLElement;
  tableElement: HTMLTableElement;
  table: ParsedTable;
}

interface StructureMenuEntry {
  emoji: string;
  label: string;
  action: string;
  disabled?: boolean;
  apply: () => void;
}

interface StructureFocusTarget {
  rowKind: "header" | "body";
  rowIndex: number;
  column: number;
}

interface RenderedRowRef {
  element: HTMLTableRowElement;
  rowKind: "header" | "body";
  rowIndex: number;
}

export function bindTableStructureControls(
  options: StructureControlsOptions,
): () => void {
  const { wrapper, view, tableScroll, tableElement, table } = options;
  const doc = wrapper.ownerDocument;

  const layer = doc.createElement("div");
  layer.className = "mlrt-table-controls-layer";
  layer.contentEditable = "false";

  let menu: HTMLElement | null = null;
  let menuAnchor: HTMLElement | null = null;
  let pendingFrame = 0;
  let indicatorColumn: number | null = null;
  let indicatorRow: RenderedRowRef | null = null;
  let minRowIndicatorLengthPx = 0;

  const currentTable = (): ParsedTable => {
    const widgetTable = getTableWidgetTable(wrapper) ?? table;
    return (
      getParsedTables(view.state.doc).find(
        (candidate) => candidate.from === widgetTable.from,
      ) ?? widgetTable
    );
  };

  const applyStructureEdit = (
    makeEdit: (current: ParsedTable) => TableCellSourceEdit | null,
    makeFocusTarget: (current: ParsedTable) => StructureFocusTarget | null,
  ): void => {
    const current = currentTable();
    const edit = makeEdit(current);
    closeMenu();
    if (!edit) {
      return;
    }

    const focusTarget = makeFocusTarget(current);
    view.dispatch({
      changes: { from: edit.from, to: edit.to, insert: edit.insert },
      annotations: [allowTableSourceChange.of(true)],
      userEvent: "input",
    });
    if (focusTarget) {
      focusCellAfterStructureEdit(doc, current.from, focusTarget);
    } else {
      view.focus();
    }
  };

  const closeMenu = (): void => {
    if (!menu) {
      return;
    }
    menu.remove();
    menu = null;
    menuAnchor?.classList.remove(INDICATOR_ACTIVE_CLASS);
    menuAnchor = null;
    wrapper.classList.remove(CONTROLS_OPEN_CLASS);
    doc.removeEventListener("pointerdown", onDocumentPointerDown, true);
    doc.removeEventListener("keydown", onDocumentKeyDown, true);
    scheduleUpdate();
  };

  const onDocumentPointerDown = (event: PointerEvent): void => {
    if (
      menu &&
      event.target instanceof Node &&
      !menu.contains(event.target) &&
      event.target !== menuAnchor &&
      !(menuAnchor?.contains(event.target) ?? false)
    ) {
      closeMenu();
    }
  };

  const onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeMenu();
    }
  };

  const openMenu = (
    anchor: HTMLElement,
    entries: StructureMenuEntry[],
  ): void => {
    closeMenu();
    menu = doc.createElement("div");
    menu.className = "mlrt-table-structure-menu";
    menu.setAttribute("role", "menu");
    for (const entry of entries) {
      const item = doc.createElement("button");
      item.type = "button";
      item.className = "mlrt-table-structure-menu-item";
      item.setAttribute("role", "menuitem");
      item.dataset.action = entry.action;
      item.disabled = entry.disabled === true;

      const emoji = doc.createElement("span");
      emoji.className = "mlrt-table-structure-menu-emoji";
      emoji.setAttribute("aria-hidden", "true");
      emoji.textContent = entry.emoji;
      const label = doc.createElement("span");
      label.className = "mlrt-table-structure-menu-label";
      label.textContent = entry.label;
      item.append(emoji, label);

      item.addEventListener("mousedown", preventFocusSteal);
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        entry.apply();
      });
      menu.append(item);
    }

    menuAnchor = anchor;
    anchor.classList.add(INDICATOR_ACTIVE_CLASS);
    wrapper.classList.add(CONTROLS_OPEN_CLASS);
    wrapper.append(menu);
    positionMenu(anchor);
    doc.addEventListener("pointerdown", onDocumentPointerDown, true);
    doc.addEventListener("keydown", onDocumentKeyDown, true);
  };

  const positionMenu = (anchor: HTMLElement): void => {
    if (!menu) {
      return;
    }

    const wrapperRect = wrapper.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const menuWidth = menu.offsetWidth;
    const isColumnAnchor = anchor.classList.contains(
      "mlrt-table-col-indicator",
    );
    let left: number;
    let top: number;
    if (isColumnAnchor) {
      left = anchorRect.left - wrapperRect.left;
      top = anchorRect.bottom - wrapperRect.top + 3;
    } else {
      left = anchorRect.right - wrapperRect.left + 3;
      top = anchorRect.top - wrapperRect.top;
    }

    const maxLeft = wrapperRect.width - menuWidth - 2;
    menu.style.left = `${Math.max(Math.min(left, maxLeft), -DOT_THICKNESS)}px`;
    menu.style.top = `${top}px`;
  };

  const openColumnMenu = (anchor: HTMLElement, column: number): void => {
    const canDelete = currentTable().columnCount > 1;
    openMenu(anchor, [
      {
        emoji: "⬅️",
        label: "Insert column left",
        action: "insert-column-left",
        apply: () =>
          applyStructureEdit(
            (current) => insertTableColumnEdit(current, column),
            () => ({ rowKind: "header", rowIndex: 0, column }),
          ),
      },
      {
        emoji: "➡️",
        label: "Insert column right",
        action: "insert-column-right",
        apply: () =>
          applyStructureEdit(
            (current) => insertTableColumnEdit(current, column + 1),
            () => ({ rowKind: "header", rowIndex: 0, column: column + 1 }),
          ),
      },
      {
        emoji: "🗑️",
        label: "Delete column",
        action: "delete-column",
        disabled: !canDelete,
        apply: () =>
          applyStructureEdit(
            (current) => deleteTableColumnEdit(current, column),
            (current) => ({
              rowKind: "header",
              rowIndex: 0,
              column: Math.max(0, Math.min(column, current.columnCount - 2)),
            }),
          ),
      },
    ]);
  };

  const openRowMenu = (
    anchor: HTMLElement,
    rowKind: "header" | "body",
    rowIndex: number,
  ): void => {
    if (rowKind === "header") {
      openMenu(anchor, [
        {
          emoji: "⬇️",
          label: "Insert row below",
          action: "insert-row-below",
          apply: () =>
            applyStructureEdit(
              (current) => insertTableRowEdit(current, 0),
              () => ({ rowKind: "body", rowIndex: 0, column: 0 }),
            ),
        },
      ]);
      return;
    }

    openMenu(anchor, [
      {
        emoji: "⬆️",
        label: "Insert row above",
        action: "insert-row-above",
        apply: () =>
          applyStructureEdit(
            (current) => insertTableRowEdit(current, rowIndex),
            () => ({ rowKind: "body", rowIndex, column: 0 }),
          ),
      },
      {
        emoji: "⬇️",
        label: "Insert row below",
        action: "insert-row-below",
        apply: () =>
          applyStructureEdit(
            (current) => insertTableRowEdit(current, rowIndex + 1),
            () => ({ rowKind: "body", rowIndex: rowIndex + 1, column: 0 }),
          ),
      },
      {
        emoji: "🗑️",
        label: "Delete row",
        action: "delete-row",
        apply: () =>
          applyStructureEdit(
            (current) => deleteTableRowEdit(current, rowIndex),
            (current) =>
              current.body.length > 1
                ? {
                    rowKind: "body",
                    rowIndex: Math.min(rowIndex, current.body.length - 2),
                    column: 0,
                  }
                : null,
          ),
      },
    ]);
  };

  const columnIndicator = createIndicatorButton(
    doc,
    "mlrt-table-col-indicator",
  );
  columnIndicator.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (indicatorColumn === null) {
      return;
    }
    if (menuAnchor === columnIndicator) {
      closeMenu();
      return;
    }
    openColumnMenu(columnIndicator, indicatorColumn);
  });
  layer.append(columnIndicator);

  const rowIndicator = createIndicatorButton(doc, "mlrt-table-row-indicator");
  rowIndicator.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!indicatorRow) {
      return;
    }
    if (menuAnchor === rowIndicator) {
      closeMenu();
      return;
    }
    openRowMenu(rowIndicator, indicatorRow.rowKind, indicatorRow.rowIndex);
  });
  layer.append(rowIndicator);

  const focusColumnIndicator = doc.createElement("div");
  focusColumnIndicator.className =
    "mlrt-table-focus-indicator mlrt-table-focus-col-indicator";
  focusColumnIndicator.hidden = true;
  layer.append(focusColumnIndicator);

  const focusRowIndicator = doc.createElement("div");
  focusRowIndicator.className =
    "mlrt-table-focus-indicator mlrt-table-focus-row-indicator";
  focusRowIndicator.hidden = true;
  layer.append(focusRowIndicator);

  const appendColumnRail = createAppendRail(doc, "mlrt-table-append-column");
  appendColumnRail.setAttribute("aria-label", "Add column");
  appendColumnRail.title = "Add column";
  appendColumnRail.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    applyStructureEdit(
      (current) => insertTableColumnEdit(current, current.columnCount),
      (current) => ({
        rowKind: "header",
        rowIndex: 0,
        column: current.columnCount,
      }),
    );
  });
  layer.append(appendColumnRail);

  const appendRowRail = createAppendRail(doc, "mlrt-table-append-row");
  appendRowRail.setAttribute("aria-label", "Add row");
  appendRowRail.title = "Add row";
  appendRowRail.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    applyStructureEdit(
      (current) => insertTableRowEdit(current, current.body.length),
      (current) => ({
        rowKind: "body",
        rowIndex: current.body.length,
        column: 0,
      }),
    );
  });
  layer.append(appendRowRail);

  /** Width a freshly inserted empty column would get, in pixels. */
  const minColumnIndicatorLengthPx = (): number =>
    Math.max(
      MIN_INDICATOR_LENGTH,
      MIN_COLUMN_WIDTH_CH * measureChWidth(tableElement),
    );

  /** Height of a single-line cell, in pixels (a freshly inserted row). */
  const minRowIndicatorLengthPxFor = (cell: HTMLElement | null): number => {
    if (minRowIndicatorLengthPx > 0) {
      return minRowIndicatorLengthPx;
    }
    if (!cell) {
      return 16;
    }
    const styles = getComputedStyle(cell);
    const lineHeight = Number.parseFloat(styles.lineHeight);
    const fontSize = Number.parseFloat(styles.fontSize);
    minRowIndicatorLengthPx = Math.max(
      MIN_INDICATOR_LENGTH,
      Number.isFinite(lineHeight)
        ? lineHeight
        : Number.isFinite(fontSize)
          ? fontSize * 1.4
          : 16,
    );
    return minRowIndicatorLengthPx;
  };

  const positionColumnIndicator = (
    element: HTMLElement,
    state: IndicatorState | null,
    cellRect: DOMRect,
    wrapperRect: DOMRect,
    tableRect: DOMRect,
  ): boolean => {
    const visibleLeft = Math.max(cellRect.left, wrapperRect.left);
    const visibleRight = Math.min(cellRect.right, wrapperRect.right);
    const visibleWidth = visibleRight - visibleLeft;
    if (visibleWidth < MIN_INDICATOR_LENGTH) {
      element.hidden = true;
      return false;
    }

    const width = Math.max(
      MIN_INDICATOR_LENGTH,
      Math.min(minColumnIndicatorLengthPx(), visibleWidth - 4),
    );
    const left =
      (visibleLeft + visibleRight) / 2 - width / 2 - wrapperRect.left;
    const tableTop = tableRect.top - wrapperRect.top;
    element.hidden = false;
    element.style.left = `${left}px`;
    element.style.width = `${width}px`;
    if (state === "dots") {
      element.dataset.state = "dots";
      element.style.top = `${tableTop - (DOT_THICKNESS - 1)}px`;
      element.style.height = `${DOT_THICKNESS}px`;
    } else {
      if (state) {
        element.dataset.state = "line";
      }
      element.style.top = `${tableTop - 1}px`;
      element.style.height = `${HAIRLINE_THICKNESS}px`;
    }
    return true;
  };

  const positionRowIndicator = (
    element: HTMLElement,
    state: IndicatorState | null,
    rowRect: DOMRect,
    wrapperRect: DOMRect,
    referenceCell: HTMLElement | null,
  ): boolean => {
    const height = Math.max(
      MIN_INDICATOR_LENGTH,
      Math.min(minRowIndicatorLengthPxFor(referenceCell), rowRect.height - 4),
    );
    const top =
      rowRect.top + (rowRect.height - height) / 2 - wrapperRect.top;
    element.hidden = false;
    element.style.top = `${top}px`;
    element.style.height = `${height}px`;
    if (state === "dots") {
      element.dataset.state = "dots";
      element.style.left = `${-(DOT_THICKNESS - 1)}px`;
      element.style.width = `${DOT_THICKNESS}px`;
    } else {
      if (state) {
        element.dataset.state = "line";
      }
      element.style.left = `-1px`;
      element.style.width = `${HAIRLINE_THICKNESS}px`;
    }
    return true;
  };

  /**
   * Recomputes every control from the current pointer position, focus, and
   * table geometry. Skipped entirely while a menu is open so the anchored
   * indicator stays frozen under the menu.
   */
  const update = (): void => {
    pendingFrame = 0;
    if (menu) {
      return;
    }

    const wrapperRect = wrapper.getBoundingClientRect();
    const tableRect = tableElement.getBoundingClientRect();
    if (wrapperRect.width <= 0 || tableRect.height <= 0) {
      columnIndicator.hidden = true;
      rowIndicator.hidden = true;
      focusColumnIndicator.hidden = true;
      focusRowIndicator.hidden = true;
      appendColumnRail.hidden = true;
      appendRowRail.hidden = true;
      return;
    }

    const dataLeftX = wrapperRect.left;
    const dataRightX = Math.min(tableRect.right, wrapperRect.right);
    const rows = collectRenderedRows(tableElement);
    const headerCells = Array.from(
      tableElement.querySelectorAll<HTMLElement>(
        `thead ${TABLE_CELL_SELECTOR}`,
      ),
    );
    const pointer = lastPointerPosition;

    let mouseColumn: number | null = null;
    let mouseColumnState: IndicatorState = "line";
    let mouseRow: RenderedRowRef | null = null;
    let mouseRowState: IndicatorState = "line";
    let showAppendColumn = false;
    let showAppendRow = false;

    if (pointer) {
      const { x, y } = pointer;

      if (
        y >= tableRect.top - EDGE_APPROACH_ZONE &&
        y <= tableRect.bottom &&
        x >= dataLeftX &&
        x <= dataRightX
      ) {
        mouseColumn = findColumnAt(headerCells, x);
        mouseColumnState =
          y <= tableRect.top + EDGE_GROW_ZONE ? "dots" : "line";
      }

      if (
        x >= dataLeftX - EDGE_APPROACH_ZONE &&
        x <= dataRightX &&
        y >= tableRect.top &&
        y <= tableRect.bottom
      ) {
        mouseRow = findRowAt(rows, y);
        mouseRowState = x <= dataLeftX + EDGE_GROW_ZONE ? "dots" : "line";
      }

      showAppendColumn =
        x >= dataRightX - EDGE_GROW_ZONE &&
        x <= dataRightX + APPEND_PROXIMITY &&
        y >= tableRect.top - 4 &&
        y <= tableRect.bottom + APPEND_PROXIMITY;
      showAppendRow =
        y >= tableRect.bottom - EDGE_GROW_ZONE &&
        y <= tableRect.bottom + APPEND_PROXIMITY &&
        x >= dataLeftX - 4 &&
        x <= dataRightX + APPEND_PROXIMITY;
    }

    const activeCell = findFocusedCell(doc, wrapper);
    let focusColumn: number | null = null;
    let focusRow: RenderedRowRef | null = null;
    if (activeCell) {
      const column = Number(activeCell.dataset.column ?? "");
      focusColumn =
        Number.isInteger(column) && column >= 0 && column < headerCells.length
          ? column
          : null;
      focusRow =
        rows.find(
          (row) =>
            row.rowKind === activeCell.dataset.rowKind &&
            row.rowIndex === Number(activeCell.dataset.rowIndex ?? ""),
        ) ?? null;
    }

    // Pointer-driven indicators (at most one per axis).
    indicatorColumn = mouseColumn;
    if (mouseColumn !== null && headerCells[mouseColumn]) {
      const shown = positionColumnIndicator(
        columnIndicator,
        mouseColumnState,
        headerCells[mouseColumn].getBoundingClientRect(),
        wrapperRect,
        tableRect,
      );
      if (!shown) {
        indicatorColumn = null;
      }
      columnIndicator.setAttribute(
        "aria-label",
        `Column ${mouseColumn + 1} actions`,
      );
    } else {
      columnIndicator.hidden = true;
    }

    indicatorRow = mouseRow;
    if (mouseRow) {
      positionRowIndicator(
        rowIndicator,
        mouseRowState,
        mouseRow.element.getBoundingClientRect(),
        wrapperRect,
        mouseRow.element.querySelector<HTMLElement>(TABLE_CELL_SELECTOR),
      );
      rowIndicator.setAttribute(
        "aria-label",
        mouseRow.rowKind === "header"
          ? "Header row actions"
          : `Row ${mouseRow.rowIndex + 1} actions`,
      );
    } else {
      rowIndicator.hidden = true;
    }

    // Focused-cell indicators: persistent accent hairlines, hidden while the
    // pointer indicator already marks the same column or row.
    if (focusColumn !== null && focusColumn !== mouseColumn) {
      positionColumnIndicator(
        focusColumnIndicator,
        null,
        headerCells[focusColumn].getBoundingClientRect(),
        wrapperRect,
        tableRect,
      );
    } else {
      focusColumnIndicator.hidden = true;
    }

    if (
      focusRow &&
      !(
        mouseRow &&
        mouseRow.rowKind === focusRow.rowKind &&
        mouseRow.rowIndex === focusRow.rowIndex
      )
    ) {
      positionRowIndicator(
        focusRowIndicator,
        null,
        focusRow.element.getBoundingClientRect(),
        wrapperRect,
        focusRow.element.querySelector<HTMLElement>(TABLE_CELL_SELECTOR),
      );
    } else {
      focusRowIndicator.hidden = true;
    }

    // Append rails, outside the right and bottom borders.
    const tableTop = tableRect.top - wrapperRect.top;
    const tableBottom = tableRect.bottom - wrapperRect.top;
    const dataRight = dataRightX - wrapperRect.left;
    if (showAppendColumn) {
      appendColumnRail.hidden = false;
      // Always outside the data area; the wrapper overflows visibly into the
      // editor's right padding, so no clamp against the wrapper is needed.
      appendColumnRail.style.left = `${dataRight + APPEND_RAIL_GAP}px`;
      appendColumnRail.style.top = `${tableTop}px`;
      appendColumnRail.style.width = `${APPEND_RAIL_THICKNESS}px`;
      appendColumnRail.style.height = `${tableRect.height}px`;
    } else {
      appendColumnRail.hidden = true;
    }

    if (showAppendRow) {
      appendRowRail.hidden = false;
      appendRowRail.style.left = `0px`;
      appendRowRail.style.top = `${tableBottom + APPEND_RAIL_GAP}px`;
      appendRowRail.style.width = `${Math.max(MIN_INDICATOR_LENGTH, dataRight)}px`;
      appendRowRail.style.height = `${APPEND_RAIL_THICKNESS}px`;
    } else {
      appendRowRail.hidden = true;
    }
  };

  const scheduleUpdate = (): void => {
    if (pendingFrame !== 0) {
      return;
    }
    const raf = doc.defaultView?.requestAnimationFrame;
    if (!raf) {
      update();
      return;
    }
    pendingFrame = raf(() => update());
  };

  const onScrollerMouseMove = (event: MouseEvent): void => {
    lastPointerPosition = { x: event.clientX, y: event.clientY };
    scheduleUpdate();
  };

  const onScrollerMouseLeave = (): void => {
    lastPointerPosition = null;
    scheduleUpdate();
  };

  const scroller = view.scrollDOM;
  scroller.addEventListener("mousemove", onScrollerMouseMove);
  scroller.addEventListener("mouseleave", onScrollerMouseLeave);
  wrapper.addEventListener("focusin", scheduleUpdate);
  wrapper.addEventListener("focusout", scheduleUpdate);
  tableScroll.addEventListener("scroll", scheduleUpdate);

  const ResizeObserverCtor = doc.defaultView?.ResizeObserver;
  const resizeObserver = ResizeObserverCtor
    ? new ResizeObserverCtor(scheduleUpdate)
    : undefined;
  resizeObserver?.observe(tableElement);
  resizeObserver?.observe(tableScroll);

  wrapper.append(layer);
  scheduleUpdate();

  return () => {
    closeMenu();
    if (pendingFrame !== 0) {
      doc.defaultView?.cancelAnimationFrame(pendingFrame);
      pendingFrame = 0;
    }
    scroller.removeEventListener("mousemove", onScrollerMouseMove);
    scroller.removeEventListener("mouseleave", onScrollerMouseLeave);
    wrapper.removeEventListener("focusin", scheduleUpdate);
    wrapper.removeEventListener("focusout", scheduleUpdate);
    tableScroll.removeEventListener("scroll", scheduleUpdate);
    resizeObserver?.disconnect();
    layer.remove();
  };
}

function createIndicatorButton(
  doc: Document,
  className: string,
): HTMLButtonElement {
  const button = doc.createElement("button");
  button.type = "button";
  button.tabIndex = -1;
  button.className = className;
  button.dataset.state = "line";
  button.hidden = true;
  button.addEventListener("mousedown", preventFocusSteal);

  const dots = doc.createElement("span");
  dots.className = "mlrt-table-indicator-dots";
  dots.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 3; index++) {
    const dot = doc.createElement("span");
    dot.className = "mlrt-table-indicator-dot";
    dots.append(dot);
  }
  button.append(dots);
  return button;
}

function createAppendRail(
  doc: Document,
  className: string,
): HTMLButtonElement {
  const rail = doc.createElement("button");
  rail.type = "button";
  rail.tabIndex = -1;
  rail.className = `mlrt-table-append-rail ${className}`;
  rail.hidden = true;
  rail.addEventListener("mousedown", preventFocusSteal);

  const plus = doc.createElement("span");
  plus.className = "mlrt-table-append-rail-plus";
  plus.setAttribute("aria-hidden", "true");
  plus.textContent = "+";
  rail.append(plus);
  return rail;
}

function preventFocusSteal(event: MouseEvent): void {
  event.preventDefault();
}

function findColumnAt(headerCells: HTMLElement[], x: number): number | null {
  for (let column = 0; column < headerCells.length; column++) {
    const rect = headerCells[column].getBoundingClientRect();
    if (x <= rect.right) {
      return x >= rect.left - 1 ? column : null;
    }
  }
  return null;
}

function findRowAt(rows: RenderedRowRef[], y: number): RenderedRowRef | null {
  for (const row of rows) {
    const rect = row.element.getBoundingClientRect();
    if (y <= rect.bottom) {
      return y >= rect.top - 1 ? row : null;
    }
  }
  return null;
}

function findFocusedCell(
  doc: Document,
  wrapper: HTMLElement,
): HTMLElement | null {
  const active = doc.activeElement;
  if (
    active instanceof HTMLElement &&
    wrapper.contains(active) &&
    active.classList.contains("mlrt-table-cell")
  ) {
    return active;
  }
  return null;
}

function collectRenderedRows(
  tableElement: HTMLTableElement,
): RenderedRowRef[] {
  const rows: RenderedRowRef[] = [];
  const headerRow = tableElement.querySelector<HTMLTableRowElement>(
    "thead tr",
  );
  if (headerRow) {
    rows.push({ element: headerRow, rowKind: "header", rowIndex: 0 });
  }

  tableElement
    .querySelectorAll<HTMLTableRowElement>("tbody tr")
    .forEach((element, rowIndex) => {
      rows.push({ element, rowKind: "body", rowIndex });
    });
  return rows;
}

function focusCellAfterStructureEdit(
  doc: Document,
  tableFrom: number,
  target: StructureFocusTarget,
): void {
  setTimeout(() => {
    const cell = doc.querySelector<HTMLElement>(
      [
        `${TABLE_CELL_SELECTOR}[data-table-from="${tableFrom}"]`,
        `[data-row-kind="${target.rowKind}"]`,
        `[data-row-index="${target.rowIndex}"]`,
        `[data-column="${target.column}"]`,
      ].join(""),
    );
    if (cell) {
      focusCellAtEnd(cell);
    }
  }, 0);
}
