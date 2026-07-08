import {
  getCellPaddingWhitespace,
  ParsedRow,
  ParsedTable,
  rowToDisplayValues,
} from "../../shared/tableModel";
import { setTableWidgetTable } from "./tableWidgetState";

/**
 * Keeps `data-*` source metadata on the widget and its cells aligned with a
 * parsed table, without touching cell text content. Used after live edits and
 * as part of DOM patching so committed edits and navigation always resolve
 * accurate source spans.
 */
export function syncTableSourceMetadata(
  dom: HTMLElement,
  table: ParsedTable,
): void {
  setTableWidgetTable(dom, table);
  dom.dataset.srcFrom = String(table.from);
  dom.dataset.srcTo = String(table.to);
  syncTableRowSourceMetadata(dom, table, table.header, "header", 0);
  table.body.forEach((row, rowIndex) => {
    syncTableRowSourceMetadata(dom, table, row, "body", rowIndex);
  });
}

export function syncTableRowSourceMetadata(
  dom: HTMLElement,
  table: ParsedTable,
  sourceRow: ParsedRow,
  rowKind: "header" | "body",
  rowIndex: number,
): void {
  const values = rowToDisplayValues(sourceRow, table.columnCount);
  for (let column = 0; column < table.columnCount; column++) {
    const cell = queryCell(dom, rowKind, rowIndex, column);
    if (!cell) {
      continue;
    }

    syncCellSourceMetadata(
      cell,
      table,
      sourceRow,
      column,
      values[column] ?? "",
    );
  }
}

/**
 * Writes one cell's source metadata: value, source span, preserved padding
 * whitespace, and column alignment.
 */
export function syncCellSourceMetadata(
  cell: HTMLElement,
  table: ParsedTable,
  sourceRow: ParsedRow,
  column: number,
  value: string,
): void {
  cell.dataset.tableFrom = String(table.from);
  cell.dataset.sourceValue = value;
  cell.style.textAlign = table.alignments[column] ?? "left";
  const sourceCell = sourceRow.cells[column];
  if (!sourceCell) {
    delete cell.dataset.sourceFrom;
    delete cell.dataset.sourceTo;
    delete cell.dataset.sourceLeadingWhitespace;
    delete cell.dataset.sourceTrailingWhitespace;
    return;
  }

  const { leadingWhitespace, trailingWhitespace } = getCellPaddingWhitespace(
    sourceCell.raw,
  );
  cell.dataset.sourceFrom = String(sourceCell.start);
  cell.dataset.sourceTo = String(sourceCell.end);
  cell.dataset.sourceLeadingWhitespace = leadingWhitespace;
  cell.dataset.sourceTrailingWhitespace = trailingWhitespace;
}

export function queryCell(
  dom: HTMLElement,
  rowKind: "header" | "body",
  rowIndex: number,
  column: number,
): HTMLElement | null {
  return dom.querySelector<HTMLElement>(
    [
      `.mlrt-table-cell[data-row-kind="${rowKind}"]`,
      `[data-row-index="${rowIndex}"]`,
      `[data-column="${column}"]`,
    ].join(""),
  );
}
