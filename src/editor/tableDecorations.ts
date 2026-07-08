import {
  Extension,
  RangeSet,
  RangeSetBuilder,
  StateField,
  Text,
} from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  GutterMarker,
  lineNumberMarkers,
} from "@codemirror/view";
import { getParsedTables } from "../shared/tableModel";
import { tableCellLiveEditAnnotation } from "./tableEditAnnotations";
import { RenderedTableWidget } from "./table/TableWidget";

interface TableDecorationSets {
  /** Rendered table widgets plus hidden-line decorations over table source. */
  decorations: DecorationSet;
  /** Markers that blank the native gutter numbers for table source lines. */
  gutterMarkers: RangeSet<GutterMarker>;
}

/**
 * Single state field that derives everything table rendering needs from one
 * memoized parse per document version:
 *
 * - a block widget replacing each table's source lines,
 * - line decorations hiding the raw source lines,
 * - gutter markers suppressing their native line numbers (each rendered row
 *   draws its own number inside the table),
 * - atomic ranges so cursor motion skips the replaced source.
 *
 * Live cell edits (annotated transactions) map the existing sets through the
 * change instead of rebuilding, which keeps the mounted widget DOM stable
 * while typing.
 */
export function createTableDecorations(): Extension {
  const field = StateField.define<TableDecorationSets>({
    create(state) {
      return buildTableDecorationSets(state.doc);
    },
    update(value, transaction) {
      if (!transaction.docChanged) {
        return value;
      }
      if (transaction.annotation(tableCellLiveEditAnnotation)) {
        return {
          decorations: value.decorations.map(transaction.changes),
          gutterMarkers: value.gutterMarkers.map(transaction.changes),
        };
      }
      return buildTableDecorationSets(transaction.state.doc);
    },
    provide(field) {
      return [
        EditorView.decorations.from(field, (value) => value.decorations),
        lineNumberMarkers.from(field, (value) => value.gutterMarkers),
        EditorView.atomicRanges.of(
          (view) => view.state.field(field).decorations,
        ),
      ];
    },
  });

  return field;
}

function buildTableDecorationSets(doc: Text): TableDecorationSets {
  const tables = getParsedTables(doc);
  const gutterBuilder = new RangeSetBuilder<GutterMarker>();
  const decorations = Decoration.set(
    tables.flatMap((table) => [
      Decoration.widget({
        widget: new RenderedTableWidget(table),
        block: true,
        side: -1,
      }).range(table.from),
      ...[table.header, table.delimiter, ...table.body].map((row) =>
        Decoration.line({
          class: "mlrt-hidden-table-source-line",
        }).range(row.from),
      ),
    ]),
    true,
  );

  for (const table of tables) {
    for (const row of [table.header, table.delimiter, ...table.body]) {
      gutterBuilder.add(row.from, row.from, hiddenLineNumberMarker);
    }
  }

  return {
    decorations,
    gutterMarkers: gutterBuilder.finish(),
  };
}

const hiddenLineNumberMarker = new (class extends GutterMarker {
  public override elementClass = "mlrt-hidden-table-source-gutter";

  public eq(other: GutterMarker): boolean {
    return other === this;
  }

  public toDOM(view: EditorView): Node {
    return view.dom.ownerDocument.createTextNode("");
  }
})();
