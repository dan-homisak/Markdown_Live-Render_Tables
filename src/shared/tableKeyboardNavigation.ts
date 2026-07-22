/** Function keys that may be held to move directly between rendered cells. */
export const TABLE_NAVIGATION_MODIFIER_KEYS = [
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
] as const;

export type TableNavigationModifierKey =
  (typeof TABLE_NAVIGATION_MODIFIER_KEYS)[number];

export const DEFAULT_TABLE_NAVIGATION_MODIFIER_KEY: TableNavigationModifierKey =
  "F2";

/** Returns a supported key, falling back safely for stale or invalid settings. */
export function normalizeTableNavigationModifierKey(
  value: unknown,
  fallback: TableNavigationModifierKey =
    DEFAULT_TABLE_NAVIGATION_MODIFIER_KEY,
): TableNavigationModifierKey {
  return typeof value === "string" &&
    (TABLE_NAVIGATION_MODIFIER_KEYS as readonly string[]).includes(value)
    ? (value as TableNavigationModifierKey)
    : fallback;
}

export type TableCellArrowDirection = "up" | "down" | "left" | "right";

export interface TableCellGridAddress {
  /** Header is row 0; body rows begin at row 1. */
  row: number;
  column: number;
}

export interface TableCellGridSize {
  rowCount: number;
  columnCount: number;
}

/** Resolves one geometric (non-wrapping) arrow step inside a table grid. */
export function adjacentTableCell(
  address: TableCellGridAddress,
  direction: TableCellArrowDirection,
  size: TableCellGridSize,
): TableCellGridAddress | null {
  const delta = direction === "up"
    ? { row: -1, column: 0 }
    : direction === "down"
      ? { row: 1, column: 0 }
      : direction === "left"
        ? { row: 0, column: -1 }
        : { row: 0, column: 1 };
  const target = {
    row: address.row + delta.row,
    column: address.column + delta.column,
  };
  return target.row >= 0 &&
      target.row < size.rowCount &&
      target.column >= 0 &&
      target.column < size.columnCount
    ? target
    : null;
}

/** Small testable state machine behind the held-function-key tracker. */
export class TableNavigationKeyState {
  private readonly held = new Set<TableNavigationModifierKey>();

  public keyDown(key: string): void {
    if ((TABLE_NAVIGATION_MODIFIER_KEYS as readonly string[]).includes(key)) {
      this.held.add(key as TableNavigationModifierKey);
    }
  }

  public keyUp(key: string): void {
    this.held.delete(key as TableNavigationModifierKey);
  }

  public clear(): void {
    this.held.clear();
  }

  public isHeld(key: TableNavigationModifierKey): boolean {
    return this.held.has(key);
  }
}
