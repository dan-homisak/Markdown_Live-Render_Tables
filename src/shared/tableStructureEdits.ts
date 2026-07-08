import {
  formatMarkdownRow,
  ParsedRow,
  ParsedTable,
  TableCellSourceEdit,
} from "./tableModel";

/**
 * Pure structural mutations for parsed markdown tables. Each function maps a
 * parsed table plus a target index to a single source edit (or null when the
 * operation is invalid), keeping row/column mutation logic fully separate
 * from the UI that triggers it.
 *
 * Row operations are surgical single-point edits, so every other line keeps
 * its exact source bytes. Column operations rebuild each table line from the
 * row's raw cell text (padding ragged rows first), so existing cell content
 * and padding whitespace are preserved verbatim.
 */

/** Raw text for an inserted or padded empty data cell. */
const EMPTY_DATA_CELL_RAW = "  ";

/** Raw text for an inserted or padded delimiter cell (left-aligned). */
const EMPTY_DELIMITER_CELL_RAW = " --- ";

/**
 * Inserts an empty column so the new column has index `columnIndex`
 * (0 inserts at the left edge, `columnCount` appends at the right edge).
 * Every existing row gets an empty cell; the delimiter gets `---`.
 */
export function insertTableColumnEdit(
  table: ParsedTable,
  columnIndex: number,
): TableCellSourceEdit | null {
  if (
    !Number.isInteger(columnIndex) ||
    columnIndex < 0 ||
    columnIndex > table.columnCount
  ) {
    return null;
  }

  return replaceTableLines(table, (rawCells, emptyCellRaw) => {
    const next = [...rawCells];
    next.splice(columnIndex, 0, emptyCellRaw);
    return next;
  });
}

/**
 * Deletes the column at `columnIndex` from every row. Refuses to delete the
 * final remaining column, which would leave an invalid table.
 */
export function deleteTableColumnEdit(
  table: ParsedTable,
  columnIndex: number,
): TableCellSourceEdit | null {
  if (
    table.columnCount <= 1 ||
    !Number.isInteger(columnIndex) ||
    columnIndex < 0 ||
    columnIndex >= table.columnCount
  ) {
    return null;
  }

  return replaceTableLines(table, (rawCells) => {
    const next = [...rawCells];
    next.splice(columnIndex, 1);
    return next;
  });
}

/**
 * Inserts an empty body row so the new row has body index `bodyIndex`
 * (0 inserts directly below the header, `body.length` appends at the bottom).
 * The new row gets an empty cell per current column.
 */
export function insertTableRowEdit(
  table: ParsedTable,
  bodyIndex: number,
): TableCellSourceEdit | null {
  if (
    !Number.isInteger(bodyIndex) ||
    bodyIndex < 0 ||
    bodyIndex > table.body.length
  ) {
    return null;
  }

  const previousRow =
    bodyIndex === 0 ? table.delimiter : table.body[bodyIndex - 1];
  const rowText = formatMarkdownRow(
    Array.from({ length: table.columnCount }, () => ""),
  );
  return {
    from: previousRow.to,
    to: previousRow.to,
    insert: `${getTableLineSeparator(table)}${rowText}`,
  };
}

/**
 * Deletes the body row at `bodyIndex` together with its preceding line break.
 * The header row cannot be deleted; a header-only table remains valid.
 */
export function deleteTableRowEdit(
  table: ParsedTable,
  bodyIndex: number,
): TableCellSourceEdit | null {
  if (!Number.isInteger(bodyIndex) || bodyIndex < 0) {
    return null;
  }

  const row = table.body[bodyIndex];
  if (!row) {
    return null;
  }

  const previousRow =
    bodyIndex === 0 ? table.delimiter : table.body[bodyIndex - 1];
  return { from: previousRow.to, to: row.to, insert: "" };
}

/**
 * Rebuilds every table line from raw cell text (padded to the full column
 * count so ragged rows stay consistent through structural edits) and returns
 * one whole-table replacement edit.
 */
function replaceTableLines(
  table: ParsedTable,
  mutateRawCells: (rawCells: string[], emptyCellRaw: string) => string[],
): TableCellSourceEdit {
  const lines = [table.header, table.delimiter, ...table.body].map((row) => {
    const emptyCellRaw =
      row === table.delimiter ? EMPTY_DELIMITER_CELL_RAW : EMPTY_DATA_CELL_RAW;
    return `|${mutateRawCells(paddedRawCells(row, table.columnCount, emptyCellRaw), emptyCellRaw).join("|")}|`;
  });
  return {
    from: table.from,
    to: table.to,
    insert: lines.join(getTableLineSeparator(table)),
  };
}

function paddedRawCells(
  row: ParsedRow,
  columnCount: number,
  emptyCellRaw: string,
): string[] {
  return Array.from(
    { length: columnCount },
    (_, column) => row.cells[column]?.raw ?? emptyCellRaw,
  );
}

/** Line separator in use between the table's own lines (`\n` or `\r\n`). */
function getTableLineSeparator(table: ParsedTable): string {
  return table.delimiter.from - table.header.to === 2 ? "\r\n" : "\n";
}
