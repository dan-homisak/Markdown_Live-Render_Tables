import { Annotation } from "@codemirror/state";
import { CellRectangle } from "../shared/clipboardModel";

/** A rectangular table fragment participating in a mixed prose/table drag. */
export interface DocumentTableSelectionRegion extends CellRectangle {
  tableFrom: number;
}

/**
 * CodeMirror can only store one linear envelope. Rendered tables need a
 * second, spatial projection so a mixed selection can keep exact prose
 * endpoints while selecting a rectangle of cells.
 */
export interface DocumentSelectionProjection {
  anchor: number;
  head: number;
  tableRegions: readonly DocumentTableSelectionRegion[];
}

export interface TableSelectionDimensions {
  rowCount: number;
  columnCount: number;
}

export interface TableCellCoordinate {
  row: number;
  column: number;
}

const projections = new WeakMap<Document, DocumentSelectionProjection>();

/**
 * Marks a CodeMirror selection transaction as the linear half of an active
 * mixed prose/table projection. Any unmarked selection transaction is an
 * independent editor gesture and invalidates the out-of-band cell geometry.
 */
export const documentSelectionProjectionTransaction =
  Annotation.define<boolean>();

export function setDocumentSelectionProjection(
  doc: Document,
  projection: DocumentSelectionProjection,
): void {
  projections.set(doc, {
    anchor: projection.anchor,
    head: projection.head,
    tableRegions: projection.tableRegions.map(normalizeRegion),
  });
}

export function getDocumentSelectionProjection(
  doc: Document,
  selection?: { anchor: number; head: number },
): DocumentSelectionProjection | null {
  const projection = projections.get(doc) ?? null;
  if (
    projection &&
    selection &&
    (projection.anchor !== selection.anchor || projection.head !== selection.head)
  ) {
    // The projection belongs to one exact CodeMirror range. Controllers that
    // restore after pointer-up explicitly set it again before dispatching
    // their annotated transaction, so retaining mismatched geometry can only
    // resurrect a stale selection later.
    projections.delete(doc);
    return null;
  }
  return projection
    ? {
        anchor: projection.anchor,
        head: projection.head,
        tableRegions: projection.tableRegions.map((region) => ({ ...region })),
      }
    : null;
}

export function clearDocumentSelectionProjection(doc: Document): void {
  projections.delete(doc);
}

/** Prose above grows from the table's top-left corner to the hovered cell. */
export function proseToTableRectangle(
  direction: "forward" | "backward",
  cell: TableCellCoordinate,
  dimensions: TableSelectionDimensions,
): CellRectangle {
  const address = clampCell(cell, dimensions);
  if (direction === "forward") {
    return {
      top: 0,
      bottom: address.row,
      left: 0,
      right: address.column,
    };
  }
  return {
    top: address.row,
    bottom: Math.max(0, dimensions.rowCount - 1),
    left: address.column,
    right: Math.max(0, dimensions.columnCount - 1),
  };
}

/**
 * Leaving a cell selection vertically promotes every traversed row to full
 * width. This matches Word's table-selection transition and, importantly,
 * always includes the row where the drag began.
 */
export function tableToProseRectangle(
  direction: "above" | "below",
  anchor: TableCellCoordinate,
  dimensions: TableSelectionDimensions,
): CellRectangle {
  const address = clampCell(anchor, dimensions);
  return direction === "above"
    ? {
        top: 0,
        bottom: address.row,
        left: 0,
        right: Math.max(0, dimensions.columnCount - 1),
      }
    : {
        top: address.row,
        bottom: Math.max(0, dimensions.rowCount - 1),
        left: 0,
        right: Math.max(0, dimensions.columnCount - 1),
      };
}

export function fullTableRectangle(
  dimensions: TableSelectionDimensions,
): CellRectangle {
  return {
    top: 0,
    bottom: Math.max(0, dimensions.rowCount - 1),
    left: 0,
    right: Math.max(0, dimensions.columnCount - 1),
  };
}

export function cellRectangle(
  anchor: TableCellCoordinate,
  head: TableCellCoordinate,
  dimensions: TableSelectionDimensions,
): CellRectangle {
  const first = clampCell(anchor, dimensions);
  const last = clampCell(head, dimensions);
  return {
    top: Math.min(first.row, last.row),
    bottom: Math.max(first.row, last.row),
    left: Math.min(first.column, last.column),
    right: Math.max(first.column, last.column),
  };
}

function normalizeRegion(
  region: DocumentTableSelectionRegion,
): DocumentTableSelectionRegion {
  return {
    tableFrom: region.tableFrom,
    top: Math.min(region.top, region.bottom),
    bottom: Math.max(region.top, region.bottom),
    left: Math.min(region.left, region.right),
    right: Math.max(region.left, region.right),
  };
}

function clampCell(
  cell: TableCellCoordinate,
  dimensions: TableSelectionDimensions,
): TableCellCoordinate {
  return {
    row: Math.max(0, Math.min(dimensions.rowCount - 1, cell.row)),
    column: Math.max(0, Math.min(dimensions.columnCount - 1, cell.column)),
  };
}
