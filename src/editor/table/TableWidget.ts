import { EditorView, WidgetType } from "@codemirror/view";
import {
  ParsedRow,
  ParsedTable,
  rowToDisplayValues,
} from "../../shared/tableModel";
import { measureTableColumnSizing } from "../../shared/tableColumnSizing";
import { setCellPlainText } from "./cellSelection";
import { bindTableEditing } from "./tableCellEditing";
import {
  queryCell,
  syncCellSourceMetadata,
} from "./tableCellMetadata";
import {
  appendColumnSizing,
  applyColumnSizing,
  applyCurrentColumnSizing,
  bindTableLayout,
} from "./tableLayout";
import {
  getTableWidgetCleanup,
  isTablePreservedForLiveEdit,
  setTableWidgetTable,
} from "./tableWidgetState";

/**
 * Block widget that replaces a markdown table's source lines with a rendered,
 * editable grid.
 *
 * Flicker control:
 * - `eq` returns true only mid live-edit, so CodeMirror leaves the mounted
 *   DOM completely untouched while the user types in a cell.
 * - For all other document changes CodeMirror calls `updateDOM`, which
 *   patches text, metadata, alignment, and column sizing in place whenever
 *   the rendered shape (rows x columns) still matches. The DOM is only
 *   rebuilt when the table's structure actually changed.
 */
export class RenderedTableWidget extends WidgetType {
  public constructor(private readonly table: ParsedTable) {
    super();
  }

  public eq(widget: WidgetType): boolean {
    return (
      widget instanceof RenderedTableWidget &&
      widget.table.from === this.table.from &&
      isTablePreservedForLiveEdit(this.table.from)
    );
  }

  public updateDOM(dom: HTMLElement, _view: EditorView): boolean {
    if (!canPatchTableDOM(dom, this.table)) {
      return false;
    }

    patchTableDOM(dom, this.table);
    return true;
  }

  public toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("section");
    wrapper.className = "mlrt-table-widget";
    wrapper.dataset.srcFrom = String(this.table.from);
    wrapper.dataset.srcTo = String(this.table.to);
    wrapper.contentEditable = "false";
    setTableWidgetTable(wrapper, this.table);

    const columnSizing = measureTableColumnSizing(this.table);
    applyColumnSizing(wrapper, columnSizing);

    const tableElement = document.createElement("table");
    tableElement.className = "mlrt-table";
    appendColumnSizing(tableElement, this.table, columnSizing);

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

    const tableScroll = document.createElement("div");
    tableScroll.className = "mlrt-table-scroll";
    tableScroll.append(tableElement);

    const scrollbar = document.createElement("div");
    scrollbar.className = "mlrt-table-scrollbar";
    const scrollbarThumb = document.createElement("div");
    scrollbarThumb.className = "mlrt-table-scrollbar-thumb";
    scrollbar.append(scrollbarThumb);

    wrapper.append(tableScroll, scrollbar);
    const scheduleTableLayout = bindTableLayout(
      wrapper,
      tableScroll,
      tableElement,
      scrollbar,
      scrollbarThumb,
      this.table,
    );
    bindTableEditing(wrapper, view, this.table, scheduleTableLayout);
    return wrapper;
  }

  public destroy(dom: HTMLElement): void {
    getTableWidgetCleanup(dom)?.();
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

/**
 * Whether the mounted widget DOM has the same rendered shape as the parsed
 * table: one header row, matching body row count, matching column count, and
 * a full set of editable cells in every row.
 */
function canPatchTableDOM(dom: HTMLElement, table: ParsedTable): boolean {
  if (!dom.classList.contains("mlrt-table-widget")) {
    return false;
  }

  const headerRows = dom.querySelectorAll("thead tr");
  const bodyRows = dom.querySelectorAll("tbody tr");
  if (headerRows.length !== 1 || bodyRows.length !== table.body.length) {
    return false;
  }

  const sizedColumns = dom.querySelectorAll(".mlrt-table-sized-col");
  if (sizedColumns.length !== table.columnCount) {
    return false;
  }

  const rows = [...Array.from(headerRows), ...Array.from(bodyRows)];
  for (const row of rows) {
    if (row.querySelectorAll(".mlrt-table-cell").length !== table.columnCount) {
      return false;
    }
  }

  return true;
}

function patchTableDOM(dom: HTMLElement, table: ParsedTable): void {
  setTableWidgetTable(dom, table);
  dom.dataset.srcFrom = String(table.from);
  dom.dataset.srcTo = String(table.to);

  patchTableRowDOM(dom, table, table.header, "header", 0);
  table.body.forEach((row, rowIndex) => {
    patchTableRowDOM(dom, table, row, "body", rowIndex);
  });

  applyCurrentColumnSizing(dom, table);
}

function patchTableRowDOM(
  dom: HTMLElement,
  table: ParsedTable,
  sourceRow: ParsedRow,
  rowKind: "header" | "body",
  rowIndex: number,
): void {
  const lineCell = dom.querySelector<HTMLElement>(
    `.mlrt-table-source-line[data-source-line="${sourceRow.lineIndex + 1}"]`,
  );
  if (lineCell) {
    const sourceLineText = String(sourceRow.lineIndex + 1);
    if (lineCell.textContent !== sourceLineText) {
      lineCell.textContent = sourceLineText;
    }
  }

  const values = rowToDisplayValues(sourceRow, table.columnCount);
  for (let column = 0; column < table.columnCount; column++) {
    const cell = queryCell(dom, rowKind, rowIndex, column);
    if (!cell) {
      continue;
    }

    const value = values[column] ?? "";
    const isActive = cell.ownerDocument.activeElement === cell;
    const isApplyingHostDocument =
      dom.ownerDocument.documentElement.dataset.mlrtApplyingHostDocument ===
      "true";
    syncCellSourceMetadata(cell, table, sourceRow, column, value);
    if ((!isActive || isApplyingHostDocument) && cell.textContent !== value) {
      setCellPlainText(cell, value);
    }
  }
}

function appendCells(options: AppendCellsOptions): void {
  appendSourceLineCell(options);

  const values = rowToDisplayValues(
    options.sourceRow,
    options.table.columnCount,
  );
  values.forEach((value, column) => {
    const cell = document.createElement(options.tagName);
    cell.className = "mlrt-table-cell";
    cell.contentEditable = "true";
    cell.spellcheck = false;
    cell.textContent = value;
    cell.dataset.rowKind = options.rowKind;
    cell.dataset.rowIndex = String(options.rowIndex);
    cell.dataset.column = String(column);
    syncCellSourceMetadata(cell, options.table, options.sourceRow, column, value);
    options.tableRow.append(cell);
  });
}

/**
 * Leading non-editable cell that renders the row's source line number inside
 * the table itself, so row height and line-number height are resolved by a
 * single layout (see gutter strategy notes in the stylesheet).
 */
function appendSourceLineCell(options: AppendCellsOptions): void {
  const cell = document.createElement(options.tagName);
  cell.className = "mlrt-table-source-line";
  cell.contentEditable = "false";
  cell.dataset.sourceLine = String(options.sourceRow.lineIndex + 1);
  cell.textContent = String(options.sourceRow.lineIndex + 1);
  cell.setAttribute("aria-hidden", "true");
  options.tableRow.append(cell);
}
