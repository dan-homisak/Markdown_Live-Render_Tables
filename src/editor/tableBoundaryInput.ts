import { EditorSelection, Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  getParsedTables,
  ParsedTable,
  positionAfterTable,
  positionBeforeTable,
  ReadonlyDocText,
} from "../shared/tableModel";
import { allowTableSourceChange } from "../shared/tableSourceProtection";

export type TableBoundarySide = "before" | "after";

export interface VisibleTableBoundaryPlan {
  anchor: number;
  change?: {
    from: number;
    to: number;
    insert: "\n";
  };
}

/**
 * Plans a visible cursor destination beside a rendered table. A table at a
 * document edge has no prose position on that side, so leaving the cursor at
 * `table.from`/`table.to` would park it on a hidden source line. In that case
 * one structural newline creates a real blank CodeMirror line first.
 */
export function planVisibleTableBoundary(
  doc: ReadonlyDocText,
  table: ParsedTable,
  side: TableBoundarySide,
): VisibleTableBoundaryPlan {
  if (side === "before") {
    return table.from === 0
      ? {
          anchor: 0,
          change: { from: 0, to: 0, insert: "\n" },
        }
      : { anchor: positionBeforeTable(table) };
  }

  if (table.to === doc.length) {
    return {
      anchor: table.to + 1,
      change: { from: table.to, to: table.to, insert: "\n" },
    };
  }

  return { anchor: positionAfterTable(doc, table) };
}

/**
 * Moves CodeMirror to a visible prose line beside a table, inserting the
 * missing edge newline when necessary. Returns the final selection anchor.
 */
export function selectVisibleTableBoundary(
  view: EditorView,
  table: ParsedTable,
  side: TableBoundarySide,
): number {
  const latestTable =
    getParsedTables(view.state.doc).find(
      (candidate) => candidate.from === table.from,
    ) ?? table;
  const plan = planVisibleTableBoundary(view.state.doc, latestTable, side);
  if (plan.change) {
    view.dispatch({
      changes: plan.change,
      selection: EditorSelection.cursor(
        plan.anchor,
        side === "before" ? -1 : 1,
      ),
      annotations: allowTableSourceChange.of(true),
      scrollIntoView: true,
      userEvent: "input.type",
    });
  } else {
    view.dispatch({
      selection: EditorSelection.cursor(
        plan.anchor,
        side === "before" ? -1 : 1,
      ),
      scrollIntoView: true,
    });
  }

  return plan.anchor;
}

/**
 * Creates a real prose line when the user types at a document edge occupied
 * by a rendered table. At those edges there is no source position outside the
 * table: inserting plain text directly at `table.from`/`table.to` would turn
 * the header or final row into a different number of columns.
 */
export function createTableBoundaryInputHandler(): Extension {
  return EditorView.inputHandler.of((view, from, to, text) => {
    if (from !== to || text.length === 0) {
      return false;
    }

    const table = getParsedTables(view.state.doc).find(
      (candidate) =>
        (candidate.from === 0 && from === candidate.from) ||
        (candidate.to === view.state.doc.length && from === candidate.to),
    );
    if (!table) {
      return false;
    }

    const insertingBefore = table.from === 0 && from === table.from;
    const insert = insertingBefore
      ? text.endsWith("\n")
        ? text
        : `${text}\n`
      : text.startsWith("\n")
        ? text
        : `\n${text}`;
    const anchor = insertingBefore
      ? from + insert.length - 1
      : from + insert.length;

    view.dispatch({
      changes: { from, to, insert },
      selection: EditorSelection.cursor(anchor, insertingBefore ? -1 : 1),
      annotations: allowTableSourceChange.of(true),
      scrollIntoView: true,
      userEvent: "input.type",
    });
    return true;
  });
}
