import {
  ParsedRow,
  ParsedTable,
  rowToDisplayValues,
} from "./tableModel";

export interface TableColumnSizing {
  columns: TableColumnMeasurement[];
  dataWidthCh: number;
  widthPercentages: number[];
}

export interface TableColumnMeasurement {
  cellLineLengths: number[];
  minWidthCh: number;
  preferredWidthCh: number;
  widthCh: number;
}

const CELL_HORIZONTAL_PADDING_CH = 2;
const CELL_COMFORT_CH = 1;
const MIN_COLUMN_WIDTH_CH = 3;
const READABLE_NARROW_COLUMN_WIDTH_CH = 6;
const MAX_UNBROKEN_TOKEN_WIDTH_CH = 36;
const MAX_PREFERRED_COLUMN_WIDTH_CH = 96;
const WIDTH_STEP_CH = 0.5;

export function measureTableColumnSizing(
  table: ParsedTable,
  availableDataWidthCh?: number,
): TableColumnSizing {
  const rows = [table.header, ...table.body];
  const columns = Array.from({ length: table.columnCount }, (_value, column) =>
    measureColumn(rows, table.columnCount, column),
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
      : scaleColumnWidths(columns, Math.max(targetWidth, table.columnCount));
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
  rows: ParsedRow[],
  columnCount: number,
  column: number,
): TableColumnMeasurement {
  let longestLine = 0;
  let longestToken = 0;
  const cellLineLengths: number[] = [];

  for (const row of rows) {
    const value = rowToDisplayValues(row, columnCount)[column] ?? "";
    for (const line of splitDisplayLines(value)) {
      cellLineLengths.push(line.length);
      longestLine = Math.max(longestLine, line.length);
      longestToken = Math.max(longestToken, measureLongestToken(line));
    }
  }

  const readableMinWidthCh =
    longestToken <= 3 ? READABLE_NARROW_COLUMN_WIDTH_CH : MIN_COLUMN_WIDTH_CH;
  const minWidthCh = clamp(
    Math.max(longestToken + CELL_HORIZONTAL_PADDING_CH, readableMinWidthCh),
    MIN_COLUMN_WIDTH_CH,
    MAX_UNBROKEN_TOKEN_WIDTH_CH,
  );
  const preferredWidthCh = clamp(
    longestLine + CELL_HORIZONTAL_PADDING_CH + CELL_COMFORT_CH,
    minWidthCh,
    MAX_PREFERRED_COLUMN_WIDTH_CH,
  );

  return {
    cellLineLengths,
    minWidthCh,
    preferredWidthCh,
    widthCh: preferredWidthCh,
  };
}

function allocateColumnWidths(
  columns: TableColumnMeasurement[],
  targetWidthCh: number,
): TableColumnMeasurement[] {
  const allocated = columns.map((column) => ({
    ...column,
    widthCh: column.minWidthCh,
  }));
  let remainingSteps = Math.round(
    (targetWidthCh -
      allocated.reduce((total, column) => total + column.widthCh, 0)) /
      WIDTH_STEP_CH,
  );

  while (remainingSteps > 0) {
    let bestColumnIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < allocated.length; index++) {
      const column = allocated[index];
      if (column.widthCh >= column.preferredWidthCh) {
        continue;
      }

      const nextWidth = Math.min(
        column.preferredWidthCh,
        column.widthCh + WIDTH_STEP_CH,
      );
      const wrapReduction =
        measureWrapCost(column, column.widthCh) -
        measureWrapCost(column, nextWidth);
      const remainingNeed = column.preferredWidthCh - column.widthCh;
      const score = wrapReduction * 1000 + remainingNeed;
      if (score > bestScore) {
        bestScore = score;
        bestColumnIndex = index;
      }
    }

    if (bestColumnIndex === -1) {
      break;
    }

    const column = allocated[bestColumnIndex];
    column.widthCh = Math.min(
      column.preferredWidthCh,
      column.widthCh + WIDTH_STEP_CH,
    );
    remainingSteps--;
  }

  return allocated;
}

function scaleColumnWidths(
  columns: TableColumnMeasurement[],
  targetWidthCh: number,
): TableColumnMeasurement[] {
  const totalMinWidth = columns.reduce(
    (total, column) => total + column.minWidthCh,
    0,
  );
  const scale = totalMinWidth > 0 ? targetWidthCh / totalMinWidth : 1;
  return columns.map((column) => ({
    ...column,
    widthCh: Math.max(1, column.minWidthCh * scale),
  }));
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
