import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { getParsedTables } from "../shared/tableModel";

const proseSelectionMark = Decoration.mark({
  class: "mlrt-prose-selection",
});

/**
 * Paint selected prose on the characters themselves. CodeMirror's default
 * selection rectangles deliberately fill line tails and bridge block widgets;
 * that is useful in a source editor but produces blanket rows and viewport-
 * sized rectangles when table source is replaced by rendered block widgets.
 */
export function createDocumentSelectionDecorations(): ViewPlugin<{
  decorations: DecorationSet;
}> {
  return ViewPlugin.fromClass(
    class {
      public decorations: DecorationSet;

      public constructor(view: EditorView) {
        this.decorations = buildProseSelectionDecorations(view);
      }

      public update(update: ViewUpdate): void {
        if (update.selectionSet || update.docChanged || update.viewportChanged) {
          this.decorations = buildProseSelectionDecorations(update.view);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

function buildProseSelectionDecorations(view: EditorView): DecorationSet {
  const range = view.state.selection.main;
  if (range.empty) {
    return Decoration.none;
  }

  const tables = getParsedTables(view.state.doc)
    .filter((table) => range.from < table.to && range.to > table.from)
    .sort((left, right) => left.from - right.from);
  const proseSegments: Array<{ from: number; to: number }> = [];
  let cursor = range.from;
  for (const table of tables) {
    if (cursor < table.from) {
      proseSegments.push({ from: cursor, to: Math.min(range.to, table.from) });
    }
    cursor = Math.max(cursor, table.to);
  }
  if (cursor < range.to) {
    proseSegments.push({ from: cursor, to: range.to });
  }

  const builder = new RangeSetBuilder<Decoration>();
  for (const segment of proseSegments) {
    let line = view.state.doc.lineAt(segment.from);
    while (line.from <= segment.to) {
      const from = Math.max(segment.from, line.from);
      const to = Math.min(segment.to, line.to);
      // Deliberately exclude line separators and empty-line width. Selection
      // therefore ends at the final selected glyph instead of painting rows.
      if (from < to) {
        builder.add(from, to, proseSelectionMark);
      }
      if (line.to >= segment.to || line.number >= view.state.doc.lines) {
        break;
      }
      line = view.state.doc.line(line.number + 1);
    }
  }
  return builder.finish();
}
