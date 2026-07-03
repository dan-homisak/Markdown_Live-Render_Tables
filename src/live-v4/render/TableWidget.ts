import { EditorSelection } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import {
  formatTableCellSourceEdit,
  ParsedRow,
  ParsedTable,
  rowToDisplayValues,
} from "../../shared/tableModel";
import { allowTableSourceChange } from "../../shared/tableSourceProtection";

export class RenderedTableWidget extends WidgetType {
  public constructor(private readonly table: ParsedTable) {
    super();
  }

  public eq(): boolean {
    return false;
  }

  public getTableFrom(): number {
    return this.table.from;
  }

  public toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("section");
    wrapper.className = "mm-live-v4-table-widget";
    wrapper.dataset.blockId = this.table.id;
    wrapper.dataset.srcFrom = String(this.table.from);
    wrapper.dataset.srcTo = String(getPositionAfterTable(view, this.table));
    wrapper.contentEditable = "false";

    const tableElement = document.createElement("table");
    tableElement.className = "mm-live-v4-table";
    appendColumnSizing(tableElement, this.table);

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    appendCells({
      table: this.table,
      sourceRow: this.table.header,
      tableRow: headerRow,
      tagName: "th",
      rowKind: "header",
      rowIndex: 0,
      sourceLineNumber: this.table.header.lineIndex + 1,
    });
    thead.append(headerRow);
    tableElement.append(thead);

    const tbody = document.createElement("tbody");
    this.table.body.forEach((sourceRow, rowIndex) => {
      const tableRow = document.createElement("tr");
      appendCells({
        table: this.table,
        sourceRow,
        tableRow,
        tagName: "td",
        rowKind: "body",
        rowIndex,
        sourceLineNumber: sourceRow.lineIndex + 1,
      });
      tbody.append(tableRow);
    });
    tableElement.append(tbody);

    wrapper.append(tableElement);
    bindTableBlockHeight(wrapper, tableElement);
    bindTableEditing(wrapper, view, this.table);
    return wrapper;
  }

  public destroy(dom: HTMLElement): void {
    getTableWidgetCleanup(dom)?.();
  }

  public ignoreEvent(): boolean {
    return true;
  }
}

interface TableWidgetElement extends HTMLElement {
  __mlrtTableWidgetCleanup?: () => void;
}

interface AppendCellsOptions {
  table: ParsedTable;
  sourceRow: ParsedRow;
  tableRow: HTMLTableRowElement;
  tagName: "th" | "td";
  rowKind: "header" | "body";
  rowIndex: number;
  sourceLineNumber: number;
}

interface CellTarget {
  rowKind: string;
  rowIndex: string;
  column: string;
}

type VerticalCellTarget = CellTarget | "before-table" | "after-table";

function appendCells(options: AppendCellsOptions): void {
  appendSourceLineCell(options);

  const values = rowToDisplayValues(options.sourceRow, options.table.columnCount);
  values.forEach((value, column) => {
    const cell = document.createElement(options.tagName);
    cell.className = "mm-live-v4-table-cell";
    cell.contentEditable = "true";
    cell.spellcheck = false;
    cell.textContent = value;
    cell.dataset.tableFrom = String(options.table.from);
    cell.dataset.rowKind = options.rowKind;
    cell.dataset.rowIndex = String(options.rowIndex);
    cell.dataset.column = String(column);
    cell.dataset.original = value;
    cell.style.textAlign = options.table.alignments[column] ?? "left";
    options.tableRow.append(cell);
  });
}

function appendSourceLineCell(options: AppendCellsOptions): void {
  const cell = document.createElement(options.tagName);
  cell.className = "mm-live-v4-table-source-line";
  cell.contentEditable = "false";
  cell.dataset.sourceLine = String(options.sourceLineNumber);
  cell.textContent = String(options.sourceLineNumber);
  cell.setAttribute("aria-hidden", "true");
  options.tableRow.append(cell);
}

function appendColumnSizing(
  tableElement: HTMLTableElement,
  table: ParsedTable,
): void {
  const colgroup = document.createElement("colgroup");

  const lineNumberCol = document.createElement("col");
  lineNumberCol.className = "mm-live-v4-table-source-line-col";
  colgroup.append(lineNumberCol);

  const widthPercentages = measureColumnWidthPercentages(table);
  for (let column = 0; column < table.columnCount; column++) {
    const col = document.createElement("col");
    col.className = "mm-live-v4-table-sized-col";
    col.style.width = `${widthPercentages[column].toFixed(4)}%`;
    colgroup.append(col);
  }

  tableElement.append(colgroup);
}

function bindTableBlockHeight(
  wrapper: HTMLElement,
  tableElement: HTMLTableElement,
): void {
  const sync = () => {
    const styles = getComputedStyle(tableElement);
    const lineHeight = parseFloat(styles.lineHeight);
    const tableHeight = tableElement.getBoundingClientRect().height;
    wrapper.style.height = `${Math.max(0, tableHeight - lineHeight * 2)}px`;
  };

  const ResizeObserverCtor = wrapper.ownerDocument.defaultView?.ResizeObserver;
  const resizeObserver = ResizeObserverCtor
    ? new ResizeObserverCtor(sync)
    : undefined;
  resizeObserver?.observe(tableElement);

  requestAnimationFrame(sync);
  setTableWidgetCleanup(wrapper, () => {
    resizeObserver?.disconnect();
  });
}

function setTableWidgetCleanup(
  wrapper: HTMLElement,
  cleanup: () => void,
): void {
  (wrapper as TableWidgetElement).__mlrtTableWidgetCleanup = cleanup;
}

function getTableWidgetCleanup(wrapper: HTMLElement): (() => void) | undefined {
  return (wrapper as TableWidgetElement).__mlrtTableWidgetCleanup;
}

function measureColumnWidthPercentages(table: ParsedTable): number[] {
  const rows = [table.header, ...table.body];
  const weights = Array.from({ length: table.columnCount }, (_value, column) => {
    const longestValue = rows.reduce((longest, row) => {
      const value = rowToDisplayValues(row, table.columnCount)[column] ?? "";
      return Math.max(longest, value.length);
    }, 0);
    return Math.max(8, Math.min(longestValue + 4, 28));
  });
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  if (totalWeight <= 0) {
    return weights.map(() => 100 / Math.max(1, table.columnCount));
  }

  return weights.map((weight) => (weight / totalWeight) * 100);
}

function bindTableEditing(
  wrapper: HTMLElement,
  view: EditorView,
  table: ParsedTable,
): void {
  wrapper.addEventListener("focusin", (event) => {
    if (findCell(event.target)) {
      view.dom.classList.add("mm-live-v4-table-cell-focused");
    }
  });

  wrapper.addEventListener("focusout", (event) => {
    const cell = findCell(event.target);
    if (cell) {
      setTimeout(() => {
        if (!wrapper.contains(wrapper.ownerDocument.activeElement)) {
          view.dom.classList.remove("mm-live-v4-table-cell-focused");
        }
        if (cell.isConnected) {
          commitCellEdit(view, table, cell);
        }
      }, 0);
    }
  });

  wrapper.addEventListener("keydown", (event) => {
    const cell = findCell(event.target);
    if (!cell) {
      return;
    }

    event.stopPropagation();

    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      insertTextAtSelection("\n");
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      commitCellEdit(view, table, cell, {
        selectionAnchor: getPositionAfterTable(view, table),
      });
      cell.blur();
      view.focus();
      return;
    }

    if (
      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey
    ) {
      const rowDelta = event.key === "ArrowUp" ? -1 : 1;
      if (!isCaretAtVerticalBoundary(cell, rowDelta)) {
        return;
      }

      const target = resolveVerticalCell(cell, rowDelta);
      event.preventDefault();
      if (target === "before-table") {
        commitCellEdit(view, table, cell, {
          selectionAnchor: getPositionBeforeTable(table),
        });
        cell.blur();
        view.focus();
        return;
      }
      if (target === "after-table") {
        commitCellEdit(view, table, cell, {
          selectionAnchor: getPositionAfterTable(view, table),
        });
        cell.blur();
        view.focus();
        return;
      }

      commitCellEdit(view, table, cell);
      focusCellAfterRender(table.from, target);
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      const target = resolveRelativeCell(cell, event.shiftKey ? -1 : 1);
      commitCellEdit(view, table, cell);
      focusCellAfterRender(table.from, target);
    }
  });
}

function commitCellEdit(
  view: EditorView,
  table: ParsedTable,
  cell: HTMLElement,
  options: { selectionAnchor?: number } = {},
): void {
  const rowKind = cell.dataset.rowKind;
  const rowIndex = Number(cell.dataset.rowIndex ?? "0");
  const column = Number(cell.dataset.column ?? "0");
  const sourceRow =
    rowKind === "header" ? table.header : table.body[rowIndex] ?? null;
  if (!sourceRow || !Number.isInteger(column) || column < 0) {
    dispatchSelection(view, options.selectionAnchor);
    return;
  }

  const value = cell.innerText.replace(/\u00a0/g, " ").replace(/\n+$/g, "");
  if (value === cell.dataset.original) {
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
    new CustomEvent("mlrt:table-cell-commit", {
      bubbles: true,
      detail: {
        rowKind,
        rowIndex,
        column,
        from: edit.from,
        to: edit.to,
        insertLength: edit.insert.length,
        valueLength: value.length,
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
    annotations: allowTableSourceChange.of(true),
    scrollIntoView: true,
    userEvent: "input",
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

function getPositionAfterTable(view: EditorView, table: ParsedTable): number {
  const doc = view.state.doc;
  if (table.to < doc.length && doc.sliceString(table.to, table.to + 1) === "\n") {
    return table.to + 1;
  }

  return table.to;
}

function getPositionBeforeTable(table: ParsedTable): number {
  return Math.max(0, table.from - 1);
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

function resolveRelativeCell(cell: HTMLElement, delta: number): CellTarget {
  const cells = Array.from(
    cell
      .closest(".mm-live-v4-table")
      ?.querySelectorAll<HTMLElement>(".mm-live-v4-table-cell") ?? [],
  );
  const index = cells.indexOf(cell);
  const next = cells[index + delta] ?? cell;
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
      .closest(".mm-live-v4-table")
      ?.querySelectorAll<HTMLElement>(
        `.mm-live-v4-table-cell[data-column="${column}"]`,
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

function focusCellAfterRender(tableFrom: number, target: CellTarget): void {
  setTimeout(() => {
    const selector = [
      `.mm-live-v4-table-cell[data-table-from="${tableFrom}"]`,
      `[data-row-kind="${target.rowKind}"]`,
      `[data-row-index="${target.rowIndex}"]`,
      `[data-column="${target.column}"]`,
    ].join("");
    const cell = document.querySelector<HTMLElement>(selector);
    if (cell) {
      focusCellAtEnd(cell);
    }
  }, 0);
}

function findCell(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) {
    return null;
  }
  return target.closest<HTMLElement>(".mm-live-v4-table-cell");
}

function insertTextAtSelection(text: string): void {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.setEndAfter(node);
  selection.removeAllRanges();
  selection.addRange(range);
}

function isCaretAtVerticalBoundary(
  cell: HTMLElement,
  rowDelta: -1 | 1,
): boolean {
  const selection = cell.ownerDocument.defaultView?.getSelection();
  if (
    !selection ||
    selection.rangeCount === 0 ||
    !selection.isCollapsed ||
    !isNodeInside(selection.anchorNode, cell)
  ) {
    return false;
  }

  const caretRect = getCaretRect(selection.getRangeAt(0));
  const lineBounds = getCellLineBounds(cell);
  if (!caretRect || !lineBounds) {
    return true;
  }

  const styles = getComputedStyle(cell);
  const parsedLineHeight = parseFloat(styles.lineHeight);
  const tolerance = Number.isFinite(parsedLineHeight)
    ? Math.max(2, parsedLineHeight * 0.25)
    : 3;

  return rowDelta < 0
    ? caretRect.top <= lineBounds.firstTop + tolerance
    : caretRect.bottom >= lineBounds.lastBottom - tolerance;
}

function isNodeInside(node: Node | null, element: HTMLElement): boolean {
  return node === element || (node !== null && element.contains(node));
}

function getCaretRect(range: Range): DOMRect | null {
  const directRect = firstUsefulRect(range.getClientRects());
  if (directRect) {
    return directRect;
  }

  const doc = getNodeDocument(range.startContainer);
  if (!doc) {
    return null;
  }

  const marker = doc.createElement("span");
  marker.textContent = "\u200b";
  marker.style.display = "inline-block";
  marker.style.width = "0";
  marker.style.height = "1em";
  marker.style.overflow = "hidden";
  marker.style.padding = "0";
  marker.style.margin = "0";
  marker.style.border = "0";

  const restoreRange = range.cloneRange();
  const markerRange = range.cloneRange();
  markerRange.insertNode(marker);
  const markerRect = marker.getBoundingClientRect();
  marker.remove();

  const selection = doc.defaultView?.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(restoreRange);

  return markerRect.height > 0 ? markerRect : null;
}

function getNodeDocument(node: Node): Document | null {
  return node.nodeType === Node.DOCUMENT_NODE
    ? (node as Document)
    : node.ownerDocument;
}

function getCellLineBounds(
  cell: HTMLElement,
): { firstTop: number; lastBottom: number } | null {
  const range = cell.ownerDocument.createRange();
  range.selectNodeContents(cell);
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.height > 0 && rect.width >= 0,
  );
  range.detach();
  if (rects.length === 0) {
    const cellRect = cell.getBoundingClientRect();
    return cellRect.height > 0
      ? { firstTop: cellRect.top, lastBottom: cellRect.bottom }
      : null;
  }

  return rects.reduce(
    (bounds, rect) => ({
      firstTop: Math.min(bounds.firstTop, rect.top),
      lastBottom: Math.max(bounds.lastBottom, rect.bottom),
    }),
    { firstTop: Number.POSITIVE_INFINITY, lastBottom: Number.NEGATIVE_INFINITY },
  );
}

function firstUsefulRect(rects: DOMRectList): DOMRect | null {
  for (let index = 0; index < rects.length; index++) {
    const rect = rects.item(index);
    if (rect && rect.height > 0) {
      return rect;
    }
  }

  return null;
}

function focusCellAtEnd(cell: HTMLElement): void {
  cell.focus();
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const range = document.createRange();
  range.selectNodeContents(cell);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}
