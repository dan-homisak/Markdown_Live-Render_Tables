import { Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  getParsedTables,
  ParsedTable,
  positionAfterTable,
} from "../shared/tableModel";
import { findCell, focusCellAtVerticalEdge } from "./table/cellSelection";
import { TABLE_CELL_SELECTOR } from "./table/cellSelection";
import { TABLE_WIDGET_SELECTOR } from "./table/tableWidgetState";
import { selectVisibleTableBoundary } from "./tableBoundaryInput";

/**
 * Arrow-key handoff between the source editor and rendered tables.
 *
 * Table source lines are atomic/replaced, so the editor cursor can never sit
 * on them. Pressing ArrowDown on the line above a table (or ArrowUp on the
 * line below) moves focus into the nearest rendered cell instead of skipping
 * the whole block.
 */
export function createTableBoundaryArrowNavigation(): Extension {
  return keymap.of([
    {
      key: "ArrowDown",
      run: (view) => focusTableAcrossBoundary(view, "down"),
    },
    {
      key: "ArrowUp",
      run: (view) => focusTableAcrossBoundary(view, "up"),
    },
  ]);
}

function focusTableAcrossBoundary(
  view: EditorView,
  direction: "up" | "down",
): boolean {
  if (!view.state.selection.main.empty || isRenderedTableCellFocused(view)) {
    return false;
  }

  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  const tables = getParsedTables(view.state.doc);
  for (const table of tables) {
    if (direction === "down" && head === table.to) {
      selectVisibleTableBoundary(view, table, "after");
      return true;
    }
    if (direction === "up" && head === table.from) {
      selectVisibleTableBoundary(view, table, "before");
      return true;
    }
    // table.startLine is 0-based, line.number is 1-based, so the line
    // directly above the table has line.number === table.startLine.
    const lineNumberAboveTable = table.startLine;
    const afterTable = positionAfterTable(view.state.doc, table);
    if (direction === "down" && line.number === lineNumberAboveTable) {
      return focusRenderedTableCell(view, table, "first");
    }
    if (direction === "up" && line.from === afterTable && head >= afterTable) {
      return focusRenderedTableCell(view, table, "last");
    }
    if (head >= table.from && head <= table.to) {
      return focusRenderedTableCell(
        view,
        table,
        direction === "down" ? "first" : "last",
      );
    }
  }

  return false;
}

function focusRenderedTableCell(
  view: EditorView,
  table: ParsedTable,
  target: "first" | "last",
): boolean {
  const wrapper = view.dom.querySelector<HTMLElement>(
    `${TABLE_WIDGET_SELECTOR}[data-src-from="${table.from}"]`,
  );
  const cells = Array.from(
    wrapper?.querySelectorAll<HTMLElement>(TABLE_CELL_SELECTOR) ?? [],
  );
  const cell = target === "first" ? cells[0] : cells[cells.length - 1];
  if (!cell) {
    return false;
  }

  const caret = view.coordsAtPos(view.state.selection.main.head);
  focusCellAtVerticalEdge(
    cell,
    target === "first" ? 1 : -1,
    caret?.left ?? null,
  );
  return true;
}

function isRenderedTableCellFocused(view: EditorView): boolean {
  return Boolean(findCell(view.dom.ownerDocument.activeElement));
}
