import { EditorSelection, Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getParsedTables } from "../shared/tableModel";
import { allowTableSourceChange } from "../shared/tableSourceProtection";

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
