import { EditorView } from "@codemirror/view";
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
import { getTableWidgetTable } from "./tableWidgetState";

/**
 * Low-profile Notion-style structure controls for a rendered table widget:
 *
 * - narrow per-column handles along the table's top exterior edge and
 *   per-row handles along its left exterior edge (in the line-number
 *   gutter), revealed while the widget is hovered,
 * - a compact flyout menu per handle with insert/delete actions,
 * - small "+" buttons on the right and bottom edges that append a column
 *   or row directly.
 *
 * The controls are a pure overlay: they never affect table layout, and each
 * action resolves the table fresh from the current document, computes a
 * source edit via the pure functions in `shared/tableStructureEdits`, and
 * dispatches it as one annotated transaction. The resulting reparse rebuilds
 * the widget (and these controls) from the new table shape.
 */

const CONTROLS_OPEN_CLASS = "mlrt-table-controls-open";
const HANDLE_ACTIVE_CLASS = "mlrt-table-handle-active";
const COLUMN_HANDLE_HEIGHT = 11;
const COLUMN_HANDLE_OVERHANG = 6;
const ROW_HANDLE_WIDTH = 12;
const APPEND_BUTTON_SIZE = 15;
const APPEND_BUTTON_GAP = 3;
const MIN_VISIBLE_HANDLE_WIDTH = 14;

interface StructureControlsOptions {
  wrapper: HTMLElement;
  view: EditorView;
  tableScroll: HTMLElement;
  tableElement: HTMLTableElement;
  table: ParsedTable;
}

interface StructureMenuEntry {
  label: string;
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
    menuAnchor?.classList.remove(HANDLE_ACTIVE_CLASS);
    menuAnchor = null;
    wrapper.classList.remove(CONTROLS_OPEN_CLASS);
    doc.removeEventListener("pointerdown", onDocumentPointerDown, true);
    doc.removeEventListener("keydown", onDocumentKeyDown, true);
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
      item.textContent = entry.label;
      item.disabled = entry.disabled === true;
      item.addEventListener("mousedown", preventFocusSteal);
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        entry.apply();
      });
      menu.append(item);
    }

    menuAnchor = anchor;
    anchor.classList.add(HANDLE_ACTIVE_CLASS);
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
    const isColumnAnchor = anchor.classList.contains("mlrt-table-col-handle");
    let left: number;
    let top: number;
    if (isColumnAnchor) {
      left = anchorRect.left - wrapperRect.left;
      top = anchorRect.bottom - wrapperRect.top + 2;
    } else {
      left = anchorRect.right - wrapperRect.left + 2;
      top = anchorRect.top - wrapperRect.top;
    }

    const maxLeft = wrapperRect.width - menuWidth - 2;
    menu.style.left = `${Math.max(Math.min(left, maxLeft), -ROW_HANDLE_WIDTH)}px`;
    menu.style.top = `${top}px`;
  };

  const openColumnMenu = (anchor: HTMLElement, column: number): void => {
    const canDelete = currentTable().columnCount > 1;
    openMenu(anchor, [
      {
        label: "Insert column left",
        apply: () =>
          applyStructureEdit(
            (current) => insertTableColumnEdit(current, column),
            () => ({ rowKind: "header", rowIndex: 0, column }),
          ),
      },
      {
        label: "Insert column right",
        apply: () =>
          applyStructureEdit(
            (current) => insertTableColumnEdit(current, column + 1),
            () => ({ rowKind: "header", rowIndex: 0, column: column + 1 }),
          ),
      },
      {
        label: "Delete column",
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
          label: "Insert row below",
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
        label: "Insert row above",
        apply: () =>
          applyStructureEdit(
            (current) => insertTableRowEdit(current, rowIndex),
            () => ({ rowKind: "body", rowIndex, column: 0 }),
          ),
      },
      {
        label: "Insert row below",
        apply: () =>
          applyStructureEdit(
            (current) => insertTableRowEdit(current, rowIndex + 1),
            () => ({ rowKind: "body", rowIndex: rowIndex + 1, column: 0 }),
          ),
      },
      {
        label: "Delete row",
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

  const columnHandles: HTMLButtonElement[] = [];
  for (let column = 0; column < table.columnCount; column++) {
    const handle = createHandleButton(doc, "mlrt-table-col-handle");
    handle.setAttribute("aria-label", `Column ${column + 1} actions`);
    handle.title = "Column actions";
    handle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (menuAnchor === handle) {
        closeMenu();
        return;
      }
      openColumnMenu(handle, column);
    });
    columnHandles.push(handle);
    layer.append(handle);
  }

  const rowHandles: HTMLButtonElement[] = [];
  const rowRefs = collectRenderedRows(tableElement);
  for (const rowRef of rowRefs) {
    const handle = createHandleButton(doc, "mlrt-table-row-handle");
    handle.setAttribute(
      "aria-label",
      rowRef.rowKind === "header"
        ? "Header row actions"
        : `Row ${rowRef.rowIndex + 1} actions`,
    );
    handle.title = "Row actions";
    handle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (menuAnchor === handle) {
        closeMenu();
        return;
      }
      openRowMenu(handle, rowRef.rowKind, rowRef.rowIndex);
    });
    rowHandles.push(handle);
    layer.append(handle);
  }

  const appendColumnButton = createAppendButton(
    doc,
    "mlrt-table-append-column",
  );
  appendColumnButton.setAttribute("aria-label", "Add column");
  appendColumnButton.title = "Add column";
  appendColumnButton.addEventListener("click", (event) => {
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
  layer.append(appendColumnButton);

  const appendRowButton = createAppendButton(doc, "mlrt-table-append-row");
  appendRowButton.setAttribute("aria-label", "Add row");
  appendRowButton.title = "Add row";
  appendRowButton.addEventListener("click", (event) => {
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
  layer.append(appendRowButton);

  const syncControlPositions = (): void => {
    const wrapperRect = wrapper.getBoundingClientRect();
    const tableRect = tableElement.getBoundingClientRect();
    if (wrapperRect.width <= 0 || tableRect.height <= 0) {
      return;
    }

    const tableTop = tableRect.top - wrapperRect.top;
    const headerCells = tableElement.querySelectorAll<HTMLElement>(
      `thead ${TABLE_CELL_SELECTOR}`,
    );
    columnHandles.forEach((handle, column) => {
      const cell = headerCells[column];
      if (!cell) {
        handle.hidden = true;
        return;
      }

      const cellRect = cell.getBoundingClientRect();
      const visibleLeft = Math.max(cellRect.left, wrapperRect.left);
      const visibleRight = Math.min(cellRect.right, wrapperRect.right);
      const width = visibleRight - visibleLeft;
      if (width < MIN_VISIBLE_HANDLE_WIDTH) {
        handle.hidden = true;
        return;
      }

      handle.hidden = false;
      handle.style.left = `${visibleLeft - wrapperRect.left + 1}px`;
      handle.style.width = `${width - 2}px`;
      handle.style.top = `${tableTop - COLUMN_HANDLE_OVERHANG}px`;
      handle.style.height = `${COLUMN_HANDLE_HEIGHT}px`;
    });

    const rows = collectRenderedRows(tableElement);
    rowHandles.forEach((handle, index) => {
      const row = rows[index];
      if (!row) {
        handle.hidden = true;
        return;
      }

      const rowRect = row.element.getBoundingClientRect();
      handle.hidden = false;
      handle.style.left = `${-ROW_HANDLE_WIDTH}px`;
      handle.style.width = `${ROW_HANDLE_WIDTH}px`;
      handle.style.top = `${rowRect.top - wrapperRect.top + 1}px`;
      handle.style.height = `${Math.max(8, rowRect.height - 2)}px`;
    });

    const dataRight =
      Math.min(tableRect.right, wrapperRect.right) - wrapperRect.left;
    appendColumnButton.style.left = `${Math.min(
      dataRight + APPEND_BUTTON_GAP,
      wrapperRect.width - APPEND_BUTTON_SIZE,
    )}px`;
    appendColumnButton.style.top = `${
      tableTop + Math.max(0, (tableRect.height - APPEND_BUTTON_SIZE) / 2)
    }px`;

    appendRowButton.style.left = `${Math.max(0, dataRight / 2 - APPEND_BUTTON_SIZE / 2)}px`;
    appendRowButton.style.top = `${
      tableRect.bottom - wrapperRect.top - APPEND_BUTTON_SIZE / 2
    }px`;

    if (menu && menuAnchor) {
      positionMenu(menuAnchor);
    }
  };

  const onWrapperMouseEnter = (): void => {
    syncControlPositions();
  };

  wrapper.append(layer);
  syncControlPositions();

  const ResizeObserverCtor = doc.defaultView?.ResizeObserver;
  const resizeObserver = ResizeObserverCtor
    ? new ResizeObserverCtor(syncControlPositions)
    : undefined;
  resizeObserver?.observe(tableElement);
  resizeObserver?.observe(tableScroll);
  tableScroll.addEventListener("scroll", syncControlPositions);
  wrapper.addEventListener("mouseenter", onWrapperMouseEnter);

  return () => {
    closeMenu();
    resizeObserver?.disconnect();
    tableScroll.removeEventListener("scroll", syncControlPositions);
    wrapper.removeEventListener("mouseenter", onWrapperMouseEnter);
    layer.remove();
  };
}

function createHandleButton(
  doc: Document,
  className: string,
): HTMLButtonElement {
  const handle = doc.createElement("button");
  handle.type = "button";
  handle.tabIndex = -1;
  handle.className = className;
  handle.addEventListener("mousedown", preventFocusSteal);

  const bar = doc.createElement("span");
  bar.className = "mlrt-table-handle-bar";
  handle.append(bar);
  return handle;
}

function createAppendButton(
  doc: Document,
  className: string,
): HTMLButtonElement {
  const button = doc.createElement("button");
  button.type = "button";
  button.tabIndex = -1;
  button.className = `mlrt-table-append-button ${className}`;
  button.textContent = "+";
  button.addEventListener("mousedown", preventFocusSteal);
  return button;
}

function preventFocusSteal(event: MouseEvent): void {
  event.preventDefault();
}

function collectRenderedRows(tableElement: HTMLTableElement): RenderedRowRef[] {
  const rows: RenderedRowRef[] = [];
  const headerRow = tableElement.querySelector<HTMLTableRowElement>("thead tr");
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
