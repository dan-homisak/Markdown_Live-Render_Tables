import { StateField } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
} from "@codemirror/view";
import { parseMarkdownTables } from "../shared/tableModel";
import { buildLiveProjection, LiveProjection } from "./LiveProjection";
import { createEmptyLiveDocModel } from "./model/LiveDocModel";
import {
  createTableFirstParser,
  TableFirstParser,
} from "./parser/TableFirstParser";
import { RenderedTableWidget } from "./render/TableWidget";
import { tableCellLiveEdit } from "./tableCellCommitSequence";

export interface LiveEditorState {
  projection: LiveProjection;
  decorations: DecorationSet;
}

export function createLiveStateField({
  parser = createTableFirstParser(),
}: {
  parser?: TableFirstParser;
} = {}) {
  const buildState = (viewState: { doc: { toString(): string } }): LiveEditorState => {
    const text = viewState.doc.toString();
    const model = parser.parse(text);
    const projection = buildLiveProjection(model);
    const tables = parseMarkdownTables(text);

    return {
      projection,
      decorations: Decoration.set(
        tables.flatMap((table) => [
          Decoration.widget({
            widget: new RenderedTableWidget(table),
            block: true,
            side: -1,
          }).range(table.from),
          ...[table.header, table.delimiter, ...table.body].map((row) =>
            Decoration.line({
              class: "mm-live-v4-hidden-table-source-line",
            }).range(row.from),
          ),
        ]),
        true,
      ),
    };
  };

  const liveStateField = StateField.define<LiveEditorState>({
    create(state) {
      return buildState(state);
    },
    update(value, transaction) {
      if (!transaction.docChanged) {
        return value;
      }
      const liveEdit = transaction.annotation(tableCellLiveEdit);
      if (liveEdit) {
        return {
          projection: value.projection,
          decorations: value.decorations.map(transaction.changes),
        };
      }
      return buildState(transaction.state);
    },
    provide(field) {
      return EditorView.decorations.from(field, (value) => value.decorations);
    },
  });

  const liveAtomicRanges = EditorView.atomicRanges.of((view) => {
    try {
      return view.state.field(liveStateField).decorations;
    } catch {
      return Decoration.none;
    }
  });

  return {
    liveStateField,
    liveAtomicRanges,
    readLiveState(state: { field<T>(field: StateField<T>): T }): LiveEditorState {
      try {
        return state.field(liveStateField);
      } catch {
        return {
          projection: buildLiveProjection(createEmptyLiveDocModel()),
          decorations: Decoration.none,
        };
      }
    },
  };
}
