import { EditorView, WidgetType } from "@codemirror/view";
import {
  formatTableCellEdit,
  ParsedRow,
  ParsedTable,
  rowToDisplayValues,
} from "../../shared/tableModel";

export class RenderedTableWidget extends WidgetType {
  public constructor(private readonly table: ParsedTable) {
    super();
  }

  public eq(): boolean {
    return false;
  }

  public toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("section");
    wrapper.className = "mm-live-v4-table-widget";
    wrapper.dataset.blockId = this.table.id;
    wrapper.dataset.srcFrom = String(this.table.from);
    wrapper.dataset.srcTo = String(this.table.to);
    wrapper.contentEditable = "false";

    const tableElement = document.createElement("table");
    tableElement.className = "mm-live-v4-table";

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    appendCells({
      table: this.table,
      sourceRow: this.table.header,
      tableRow: headerRow,
      tagName: "th",
      rowKind: "header",
      rowIndex: 0,
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
      });
      tbody.append(tableRow);
    });
    tableElement.append(tbody);

    wrapper.append(tableElement);
    bindTableEditing(wrapper, view, this.table);
    return wrapper;
  }

  public ignoreEvent(): boolean {
    return true;
  }
}

interface AppendCellsOptions {
  table: ParsedTable;
  sourceRow: ParsedRow;
  tableRow: HTMLTableRowElement;
  tagName: "th" | "td";
  rowKind: "header" | "body";
  rowIndex: number;
}

interface CellTarget {
  rowKind: string;
  rowIndex: string;
  column: string;
}

function appendCells(options: AppendCellsOptions): void {
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

function bindTableEditing(
  wrapper: HTMLElement,
  view: EditorView,
  table: ParsedTable,
): void {
  wrapper.addEventListener("focusout", (event) => {
    const cell = findCell(event.target);
    if (cell) {
      commitCellEdit(view, table, cell);
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
      commitCellEdit(view, table, cell);
      cell.blur();
      view.focus();
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
): void {
  const rowKind = cell.dataset.rowKind;
  const rowIndex = Number(cell.dataset.rowIndex ?? "0");
  const column = Number(cell.dataset.column ?? "0");
  const sourceRow =
    rowKind === "header" ? table.header : table.body[rowIndex] ?? null;
  if (!sourceRow || !Number.isInteger(column) || column < 0) {
    return;
  }

  const value = cell.innerText.replace(/\u00a0/g, " ").replace(/\n+$/g, "");
  if (value === cell.dataset.original) {
    return;
  }

  view.dispatch({
    changes: {
      from: sourceRow.from,
      to: sourceRow.to,
      insert: formatTableCellEdit(sourceRow, table.columnCount, column, value),
    },
    scrollIntoView: true,
    userEvent: "input",
  });
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

function focusCellAfterRender(tableFrom: number, target: CellTarget): void {
  setTimeout(() => {
    const selector = [
      `.mm-live-v4-table-cell[data-table-from="${tableFrom}"]`,
      `[data-row-kind="${target.rowKind}"]`,
      `[data-row-index="${target.rowIndex}"]`,
      `[data-column="${target.column}"]`,
    ].join("");
    document.querySelector<HTMLElement>(selector)?.focus();
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
