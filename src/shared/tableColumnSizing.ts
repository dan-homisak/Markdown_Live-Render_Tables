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
  minWidthCh: number;
  preferredWidthCh: number;
}

const CELL_HORIZONTAL_PADDING_CH = 2;
const CELL_COMFORT_CH = 1;
const MIN_COLUMN_WIDTH_CH = 3;
const MAX_UNBROKEN_TOKEN_WIDTH_CH = 36;
const MAX_PREFERRED_COLUMN_WIDTH_CH = 96;

export function measureTableColumnSizing(table: ParsedTable): TableColumnSizing {
  const rows = [table.header, ...table.body];
  const columns = Array.from({ length: table.columnCount }, (_value, column) =>
    measureColumn(rows, table.columnCount, column),
  );
  const totalPreferredWidth = columns.reduce(
    (total, column) => total + column.preferredWidthCh,
    0,
  );
  const safeTotalWidth =
    totalPreferredWidth > 0 ? totalPreferredWidth : table.columnCount;

  return {
    columns,
    dataWidthCh: safeTotalWidth,
    widthPercentages: columns.map(
      (column) => (column.preferredWidthCh / safeTotalWidth) * 100,
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

  for (const row of rows) {
    const value = rowToDisplayValues(row, columnCount)[column] ?? "";
    for (const line of splitDisplayLines(value)) {
      longestLine = Math.max(longestLine, line.length);
      longestToken = Math.max(longestToken, measureLongestToken(line));
    }
  }

  const minWidthCh = clamp(
    longestToken + CELL_HORIZONTAL_PADDING_CH,
    MIN_COLUMN_WIDTH_CH,
    MAX_UNBROKEN_TOKEN_WIDTH_CH,
  );
  const preferredWidthCh = clamp(
    longestLine + CELL_HORIZONTAL_PADDING_CH + CELL_COMFORT_CH,
    minWidthCh,
    MAX_PREFERRED_COLUMN_WIDTH_CH,
  );

  return {
    minWidthCh,
    preferredWidthCh,
  };
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
