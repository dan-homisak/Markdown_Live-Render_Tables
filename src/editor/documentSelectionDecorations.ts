import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { getParsedTables } from "../shared/tableModel";

const proseSelectionMarkCache = new Map<string, Decoration>();
const emptyProseSelectionMarkCache = new Map<string, Decoration>();

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

  const selectedLines: Array<{
    from: number;
    to: number;
    lineFrom: number;
    lineTo: number;
    lineNumber: number;
    isEmpty: boolean;
  }> = [];
  for (const segment of proseSegments) {
    let line = view.state.doc.lineAt(segment.from);
    while (line.from <= segment.to) {
      const from = Math.max(segment.from, line.from);
      const to = Math.min(segment.to, line.to);
      // Deliberately exclude line separators and empty-line width. Selection
      // therefore ends at the final selected glyph instead of painting rows.
      if (from < to) {
        selectedLines.push({
          from,
          to,
          lineFrom: line.from,
          lineTo: line.to,
          lineNumber: line.number,
          isEmpty: false,
        });
      } else if (
        line.from === line.to &&
        segment.from <= line.from &&
        segment.to >= line.to
      ) {
        // A selection that crosses or terminates on an empty source line must
        // still expose that row. This is especially important for a drag that
        // starts on a blank line: both the anchor row and intervening blank
        // rows remain visible as compact Monaco-like markers.
        selectedLines.push({
          from: line.from,
          to: line.to,
          lineFrom: line.from,
          lineTo: line.to,
          lineNumber: line.number,
          isEmpty: true,
        });
      }
      if (line.to >= segment.to || line.number >= view.state.doc.lines) {
        break;
      }
      line = view.state.doc.line(line.number + 1);
    }
  }

  const builder = new RangeSetBuilder<Decoration>();
  for (let index = 0; index < selectedLines.length; index += 1) {
    const selectedLine = selectedLines[index];
    const previous = selectedLines[index - 1];
    const next = selectedLines[index + 1];
    const continuesFromPrevious = Boolean(
      previous &&
        previous.lineNumber + 1 === selectedLine.lineNumber &&
        previous.to === previous.lineTo &&
        selectedLine.from === selectedLine.lineFrom,
    );
    const continuesToNext = Boolean(
      next &&
        selectedLine.lineNumber + 1 === next.lineNumber &&
        selectedLine.to === selectedLine.lineTo &&
        next.from === next.lineFrom,
    );
    const classes = [
      selectedLine.isEmpty
        ? "mlrt-prose-selection-empty-line"
        : "mlrt-prose-selection",
    ];
    if (continuesFromPrevious && previous) {
      classes.push("mlrt-prose-selection-continues-from-previous");
      if (selectionLeft(previous) <= selectionLeft(selectedLine)) {
        classes.push("mlrt-prose-selection-connects-top-left");
      }
      if (selectionRight(previous) >= selectionRight(selectedLine)) {
        classes.push("mlrt-prose-selection-connects-top-right");
      }
    }
    if (continuesToNext && next) {
      classes.push("mlrt-prose-selection-continues-to-next");
      if (selectionLeft(next) <= selectionLeft(selectedLine)) {
        classes.push("mlrt-prose-selection-connects-bottom-left");
      }
      if (selectionRight(next) >= selectionRight(selectedLine)) {
        classes.push("mlrt-prose-selection-connects-bottom-right");
      }
    }
    const className = classes.join(" ");
    const cache = selectedLine.isEmpty
      ? emptyProseSelectionMarkCache
      : proseSelectionMarkCache;
    let decoration = cache.get(className);
    if (!decoration) {
      decoration = selectedLine.isEmpty
        ? Decoration.line({ class: className })
        : Decoration.mark({ class: className });
      cache.set(className, decoration);
    }
    builder.add(selectedLine.from, selectedLine.to, decoration);
  }
  return builder.finish();
}

function selectionLeft(selectedLine: {
  from: number;
  lineFrom: number;
}): number {
  return selectedLine.from - selectedLine.lineFrom;
}

function selectionRight(selectedLine: {
  to: number;
  lineFrom: number;
  isEmpty: boolean;
}): number {
  // Empty rows use a compact 0.8ch marker, which is close enough to one
  // editor column for deciding whether an adjoining corner is internal.
  return selectedLine.isEmpty ? 1 : selectedLine.to - selectedLine.lineFrom;
}
