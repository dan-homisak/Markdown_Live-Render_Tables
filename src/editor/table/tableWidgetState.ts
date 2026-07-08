import { ParsedRow, ParsedTable } from "../../shared/tableModel";
import { TableCellSizingOverride } from "../../shared/tableColumnSizing";
import { findCell, readCellDisplayValue } from "./cellSelection";

export const TABLE_WIDGET_SELECTOR = ".mlrt-table-widget";

interface TableWidgetElement extends HTMLElement {
  __mlrtTableWidgetCleanup?: () => void;
  __mlrtTable?: ParsedTable;
}

/**
 * Table starts whose rendered DOM must survive the next decoration rebuild.
 *
 * During a live cell edit the widget updates its own DOM and dispatches the
 * source change itself; adding the table start here makes the freshly built
 * widget compare equal to the mounted one so CodeMirror leaves the DOM (and
 * the user's caret) alone. Entries are removed one animation frame later.
 */
const liveEditPreservedTableStarts = new Set<number>();

export function preserveTableForLiveEdit(tableFrom: number): void {
  liveEditPreservedTableStarts.add(tableFrom);
}

export function releaseTableLiveEditPreservation(tableFrom: number): void {
  liveEditPreservedTableStarts.delete(tableFrom);
}

export function isTablePreservedForLiveEdit(tableFrom: number): boolean {
  return liveEditPreservedTableStarts.has(tableFrom);
}

export function setTableWidgetCleanup(
  wrapper: HTMLElement,
  cleanup: () => void,
): void {
  (wrapper as TableWidgetElement).__mlrtTableWidgetCleanup = cleanup;
}

export function getTableWidgetCleanup(
  wrapper: HTMLElement,
): (() => void) | undefined {
  return (wrapper as TableWidgetElement).__mlrtTableWidgetCleanup;
}

/**
 * Stores the widget's working copy of the parsed table on its root element.
 *
 * The table is cloned because parse results are memoized and shared across
 * extensions, while the live edit path mutates the widget's copy in place as
 * the user types.
 */
export function setTableWidgetTable(
  wrapper: HTMLElement,
  table: ParsedTable,
): void {
  (wrapper as TableWidgetElement).__mlrtTable = cloneParsedTable(table);
}

export function getTableWidgetTable(
  wrapper: HTMLElement,
): ParsedTable | undefined {
  return (wrapper as TableWidgetElement).__mlrtTable;
}

/**
 * Sizing override for the focused cell so column widths track the text the
 * user is currently typing before it is committed to the parsed model.
 */
export function readActiveCellSizingOverride(
  wrapper: HTMLElement,
): TableCellSizingOverride | undefined {
  const activeElement = wrapper.ownerDocument.activeElement;
  const cell = findCell(activeElement);
  if (!cell || !wrapper.contains(cell)) {
    return undefined;
  }

  const rowKind = cell.dataset.rowKind;
  const rowIndex = Number(cell.dataset.rowIndex ?? "0");
  const column = Number(cell.dataset.column ?? "0");
  if (
    (rowKind !== "header" && rowKind !== "body") ||
    !Number.isInteger(rowIndex) ||
    rowIndex < 0 ||
    !Number.isInteger(column) ||
    column < 0
  ) {
    return undefined;
  }

  return {
    rowKind,
    rowIndex,
    column,
    value: readCellDisplayValue(cell),
  };
}

function cloneParsedTable(table: ParsedTable): ParsedTable {
  return {
    from: table.from,
    to: table.to,
    startLine: table.startLine,
    endLine: table.endLine,
    header: cloneParsedRow(table.header),
    delimiter: cloneParsedRow(table.delimiter),
    body: table.body.map(cloneParsedRow),
    columnCount: table.columnCount,
    alignments: [...table.alignments],
  };
}

function cloneParsedRow(row: ParsedRow): ParsedRow {
  return {
    lineIndex: row.lineIndex,
    from: row.from,
    to: row.to,
    text: row.text,
    cells: row.cells.map((cell) => ({ ...cell })),
  };
}
