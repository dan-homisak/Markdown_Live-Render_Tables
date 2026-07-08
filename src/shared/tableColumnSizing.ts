import { ParsedRow, ParsedTable, rowToDisplayValues } from "./tableModel";

export interface TableColumnSizing {
  columns: TableColumnMeasurement[];
  dataWidthCh: number;
  widthPercentages: number[];
}

export interface TableColumnMeasurement {
  cellLineLengths: number[];
  minWidthCh: number;
  /** Width the column wants under contention (long headers capped). */
  preferredWidthCh: number;
  /** Width the column wants when space is plentiful (header caps lifted). */
  fullPreferredWidthCh: number;
  widthCh: number;
}

export interface TableCellSizingOverride {
  rowKind: "header" | "body";
  rowIndex: number;
  column: number;
  value: string;
}

interface RowMeasurementSource {
  row: ParsedRow;
  rowKind: "header" | "body";
  rowIndex: number;
}

const CELL_HORIZONTAL_PADDING_CH = 2;
const CELL_COMFORT_CH = 1;
const TOKEN_COMFORT_CH = 0.5;
/** Narrowest a column can be, and the width a freshly inserted column gets. */
export const MIN_COLUMN_WIDTH_CH = 3;
const READABLE_COLUMN_WIDTH_CH = 12;
const READABLE_LINE_LENGTH_THRESHOLD_CH = 32;
const MAX_UNBROKEN_TOKEN_WIDTH_CH = 36;
const MAX_PREFERRED_COLUMN_WIDTH_CH = 96;
const HEADER_PREFERRED_WIDTH_CAP_CH = 24;
const HEADER_TOKEN_WIDTH_CAP_CH = 24;
const WIDTH_STEP_CH = 0.5;

export function measureTableColumnSizing(
  table: ParsedTable,
  availableDataWidthCh?: number,
  cellOverride?: TableCellSizingOverride,
): TableColumnSizing {
  const rows: RowMeasurementSource[] = [
    { row: table.header, rowKind: "header", rowIndex: 0 },
    ...table.body.map((row, rowIndex) => ({
      row,
      rowKind: "body" as const,
      rowIndex,
    })),
  ];
  const columns = Array.from({ length: table.columnCount }, (_value, column) =>
    measureColumn(rows, table.columnCount, column, cellOverride),
  );
  const totalPreferredWidth = columns.reduce(
    (total, column) => total + column.preferredWidthCh,
    0,
  );
  const totalMinWidth = columns.reduce(
    (total, column) => total + column.minWidthCh,
    0,
  );
  const safeTotalWidth =
    totalPreferredWidth > 0 ? totalPreferredWidth : table.columnCount;
  const targetWidth =
    availableDataWidthCh === undefined || availableDataWidthCh <= 0
      ? safeTotalWidth
      : Math.min(safeTotalWidth, availableDataWidthCh);
  const allocatedColumns =
    targetWidth >= totalMinWidth
      ? allocateColumnWidths(columns, targetWidth)
      : columns.map((column) => ({ ...column, widthCh: column.minWidthCh }));

  // Second pass: when the contention-capped layout leaves free width, spend
  // it un-wrapping columns up to their uncapped preference (typically long
  // header titles), so no line wraps that the viewport could have fit.
  if (availableDataWidthCh !== undefined && availableDataWidthCh > 0) {
    distributeWidthSteps(
      allocatedColumns,
      availableDataWidthCh,
      (column) => column.fullPreferredWidthCh,
    );
  }

  const dataWidthCh = allocatedColumns.reduce(
    (total, column) => total + column.widthCh,
    0,
  );
  const safeDataWidth = dataWidthCh > 0 ? dataWidthCh : table.columnCount;

  return {
    columns: allocatedColumns,
    dataWidthCh: safeDataWidth,
    widthPercentages: allocatedColumns.map(
      (column) => (column.widthCh / safeDataWidth) * 100,
    ),
  };
}

function measureColumn(
  rows: RowMeasurementSource[],
  columnCount: number,
  column: number,
  cellOverride: TableCellSizingOverride | undefined,
): TableColumnMeasurement {
  let longestLine = 0;
  let longestToken = 0;
  let longestBodyLine = 0;
  let longestBodyToken = 0;
  let longestHeaderLine = 0;
  let longestHeaderToken = 0;
  let hasBodyRow = false;
  const cellLineLengths: number[] = [];

  for (const source of rows) {
    const value = getCellDisplayValue(
      source,
      columnCount,
      column,
      cellOverride,
    );
    for (const line of splitDisplayLines(value)) {
      const lineLength = line.length;
      const tokenLength = measureLongestToken(line);
      cellLineLengths.push(lineLength);
      longestLine = Math.max(longestLine, lineLength);
      longestToken = Math.max(longestToken, tokenLength);
      if (source.rowKind === "body") {
        hasBodyRow = true;
        longestBodyLine = Math.max(longestBodyLine, lineLength);
        longestBodyToken = Math.max(longestBodyToken, tokenLength);
      } else {
        longestHeaderLine = Math.max(longestHeaderLine, lineLength);
        longestHeaderToken = Math.max(longestHeaderToken, tokenLength);
      }
    }
  }

  const sizingLine = hasBodyRow
    ? Math.max(
        longestBodyLine,
        Math.min(longestHeaderLine, HEADER_PREFERRED_WIDTH_CAP_CH),
      )
    : longestLine;
  const sizingToken = hasBodyRow
    ? Math.max(
        longestBodyToken,
        Math.min(longestHeaderToken, HEADER_TOKEN_WIDTH_CAP_CH),
      )
    : longestToken;
  const hasProseLikeContent = cellLineLengths.some(
    (lineLength) => lineLength >= READABLE_LINE_LENGTH_THRESHOLD_CH,
  );
  const readableMinWidthCh = hasProseLikeContent ? READABLE_COLUMN_WIDTH_CH : 0;
  const minWidthCh = clamp(
    Math.max(
      sizingToken + CELL_HORIZONTAL_PADDING_CH + TOKEN_COMFORT_CH,
      readableMinWidthCh,
    ),
    MIN_COLUMN_WIDTH_CH,
    MAX_UNBROKEN_TOKEN_WIDTH_CH,
  );
  const preferredWidthCh = clamp(
    sizingLine + CELL_HORIZONTAL_PADDING_CH + CELL_COMFORT_CH,
    minWidthCh,
    MAX_PREFERRED_COLUMN_WIDTH_CH,
  );
  const fullPreferredWidthCh = clamp(
    longestLine + CELL_HORIZONTAL_PADDING_CH + CELL_COMFORT_CH,
    preferredWidthCh,
    MAX_PREFERRED_COLUMN_WIDTH_CH,
  );

  return {
    cellLineLengths,
    minWidthCh,
    preferredWidthCh,
    fullPreferredWidthCh,
    widthCh: preferredWidthCh,
  };
}

function getCellDisplayValue(
  source: RowMeasurementSource,
  columnCount: number,
  column: number,
  cellOverride: TableCellSizingOverride | undefined,
): string {
  if (
    cellOverride &&
    cellOverride.rowKind === source.rowKind &&
    cellOverride.rowIndex === source.rowIndex &&
    cellOverride.column === column
  ) {
    return cellOverride.value;
  }

  return rowToDisplayValues(source.row, columnCount)[column] ?? "";
}

/**
 * Greedy width allocation: starting from minimum widths, hand out fixed
 * steps to whichever column removes the most wrapped lines per step (with
 * remaining need as tiebreak) until the target width or every column's
 * contention-capped preference is reached.
 */
function allocateColumnWidths(
  columns: TableColumnMeasurement[],
  targetWidthCh: number,
): TableColumnMeasurement[] {
  const allocated = columns.map((column) => ({
    ...column,
    widthCh: column.minWidthCh,
  }));
  distributeWidthSteps(
    allocated,
    targetWidthCh,
    (column) => column.preferredWidthCh,
  );
  return allocated;
}

function distributeWidthSteps(
  columns: TableColumnMeasurement[],
  targetWidthCh: number,
  limitOf: (column: TableColumnMeasurement) => number,
): void {
  let remainingSteps = Math.round(
    (targetWidthCh -
      columns.reduce((total, column) => total + column.widthCh, 0)) /
      WIDTH_STEP_CH,
  );

  while (remainingSteps > 0) {
    let bestColumnIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < columns.length; index++) {
      const column = columns[index];
      const limit = limitOf(column);
      if (column.widthCh >= limit) {
        continue;
      }

      const nextWidth = Math.min(limit, column.widthCh + WIDTH_STEP_CH);
      const wrapReduction =
        measureWrapCost(column, column.widthCh) -
        measureWrapCost(column, nextWidth);
      const remainingNeed = limit - column.widthCh;
      const score = wrapReduction * 1000 + remainingNeed;
      if (score > bestScore) {
        bestScore = score;
        bestColumnIndex = index;
      }
    }

    if (bestColumnIndex === -1) {
      break;
    }

    const column = columns[bestColumnIndex];
    column.widthCh = Math.min(limitOf(column), column.widthCh + WIDTH_STEP_CH);
    remainingSteps--;
  }
}

function measureWrapCost(
  column: TableColumnMeasurement,
  widthCh: number,
): number {
  const contentWidthCh = Math.max(1, widthCh - CELL_HORIZONTAL_PADDING_CH);
  return column.cellLineLengths.reduce(
    (total, lineLength) =>
      total + Math.max(1, Math.ceil(lineLength / contentWidthCh)),
    0,
  );
}

function splitDisplayLines(value: string): string[] {
  const lines = value.split(/\r\n?|\n/);
  return lines.length > 0 ? lines : [""];
}

function measureLongestToken(value: string): number {
  return value
    .trim()
    .split(/\s+/)
    .reduce((longest, token) => Math.max(longest, token.length), 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
