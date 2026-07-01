import { markdown } from "@codemirror/lang-markdown";
import {
  Extension,
  RangeSet,
  RangeSetBuilder,
  StateField,
} from "@codemirror/state";
import {
  EditorView,
  GutterMarker,
  highlightActiveLine,
  highlightActiveLineGutter,
  lineNumbers,
  lineNumberMarkers,
  lineNumberWidgetMarker,
} from "@codemirror/view";
import { parseMarkdownTables } from "../shared/tableModel";
import { createLiveStateField } from "./LiveStateField";
import { createPointerController } from "./PointerController";
import { createTableFirstParser } from "./parser/TableFirstParser";
import { RenderedTableWidget } from "./render/TableWidget";

export interface LiveRuntime {
  extensions: Extension[];
}

export interface LiveRuntimeOptions {
  lineWrapping: boolean;
}

export function createLiveRuntime(options: LiveRuntimeOptions): LiveRuntime {
  const parser = createTableFirstParser();
  const { liveStateField, liveAtomicRanges } = createLiveStateField({ parser });
  const pointerController = createPointerController();

  const livePointerHandlers = EditorView.domEventHandlers({
    mousedown(_event, view) {
      return pointerController.handlePointer(view);
    },
    touchstart(_event, view) {
      return pointerController.handlePointer(view);
    },
  });

  return {
    extensions: [
      EditorView.theme({
        "&": {
          height: "100%",
          color: "var(--vscode-editor-foreground, #d4d4d4)",
          backgroundColor: "var(--vscode-editor-background, #1e1e1e)",
        },
        ".cm-scroller": {
          overflow: "auto !important",
          height: "100%",
          fontFamily: "var(--mlrt-editor-font-family, var(--vscode-editor-font-family, monospace))",
          fontSize: "var(--mlrt-editor-font-size, var(--vscode-editor-font-size, 13px))",
          fontWeight: "var(--mlrt-editor-font-weight, normal)",
          lineHeight: "var(--mlrt-editor-line-height, normal)",
          letterSpacing: "var(--mlrt-editor-letter-spacing, normal)",
          fontFeatureSettings: "var(--mlrt-editor-font-feature-settings, normal)",
          fontVariationSettings: "var(--mlrt-editor-font-variation-settings, normal)",
        },
        ".cm-gutters": {
          backgroundColor: "var(--vscode-editorGutter-background, var(--vscode-editor-background, #1e1e1e))",
          color: "var(--vscode-editorLineNumber-foreground, #858585)",
          borderRight: "none",
          fontFamily: "var(--mlrt-editor-font-family, var(--vscode-editor-font-family, monospace))",
          fontSize: "var(--mlrt-editor-font-size, var(--vscode-editor-font-size, 13px))",
          fontWeight: "var(--mlrt-editor-font-weight, normal)",
          lineHeight: "var(--mlrt-editor-line-height, normal)",
          letterSpacing: "var(--mlrt-editor-letter-spacing, normal)",
          fontFeatureSettings: "var(--mlrt-editor-font-feature-settings, normal)",
          fontVariationSettings: "var(--mlrt-editor-font-variation-settings, normal)",
        },
        ".cm-activeLineGutter": {
          backgroundColor: "var(--vscode-editor-lineHighlightBackground, transparent)",
          color: "var(--vscode-editorLineNumber-activeForeground, #c6c6c6)",
        },
        ".cm-lineNumbers .cm-gutterElement": {
          minHeight: "var(--mlrt-editor-line-height, 1.5em)",
          padding: "0 18px 0 0",
        },
        ".cm-lineNumbers .cm-gutterElement[style*=\"visibility: hidden\"]": {
          minHeight: "0",
        },
        ".cm-lineNumbers .mm-live-v4-table-gutter-lines": {
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
          minWidth: "100%",
          paddingTop: "0",
          paddingBottom: "0",
          color: "var(--vscode-editorLineNumber-foreground, #858585)",
          fontVariantNumeric: "tabular-nums",
          userSelect: "none",
        },
        ".cm-lineNumbers .mm-live-v4-table-gutter-line": {
          boxSizing: "border-box",
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "flex-start",
          minHeight: "var(--mlrt-editor-line-height, 1.5em)",
          paddingRight: "0",
          paddingTop: "0",
          whiteSpace: "nowrap",
        },
        ".cm-content": {
          minHeight: "100%",
          padding: "var(--mlrt-editor-top-padding, 0px) 0 var(--mlrt-editor-bottom-padding, 0px) 0",
          caretColor: "var(--vscode-editorCursor-foreground, #aeafad)",
        },
        ".cm-line": {
          color: "var(--vscode-editor-foreground, #d4d4d4)",
        },
        ".cm-activeLine": {
          backgroundColor: "var(--vscode-editor-lineHighlightBackground, transparent)",
        },
        ".cm-cursor, .cm-dropCursor": {
          borderLeftColor: "var(--vscode-editorCursor-foreground, #aeafad)",
          borderLeftWidth: "var(--mlrt-editor-cursor-width, 1px)",
        },
      }),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      lineNumbers(),
      createTableLineNumberSuppressions(),
      lineNumberWidgetMarker.of((_view, widget) => {
        if (!(widget instanceof RenderedTableWidget)) {
          return null;
        }

        return new TableRowLineNumberMarker(
          widget.getTableFrom(),
          widget.getSourceLineNumbers(),
        );
      }),
      markdown(),
      ...(options.lineWrapping ? [EditorView.lineWrapping] : []),
      liveStateField,
      liveAtomicRanges,
      livePointerHandlers,
    ],
  };
}

function createTableLineNumberSuppressions(): Extension {
  const tableLineNumberSuppressions = StateField.define<RangeSet<GutterMarker>>({
    create(state) {
      return buildTableLineNumberSuppressions(state.doc.toString());
    },
    update(value, transaction) {
      if (!transaction.docChanged) {
        return value;
      }
      return buildTableLineNumberSuppressions(transaction.state.doc.toString());
    },
    provide(field) {
      return lineNumberMarkers.from(field);
    },
  });

  return tableLineNumberSuppressions;
}

const hiddenLineNumberMarker = new class extends GutterMarker {
  public eq(other: GutterMarker): boolean {
    return other === this;
  }

  public toDOM(view: EditorView): Node {
    return view.dom.ownerDocument.createTextNode("");
  }
}();

function buildTableLineNumberSuppressions(text: string): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>();
  for (const table of parseMarkdownTables(text)) {
    builder.add(table.from, table.from, hiddenLineNumberMarker);
  }
  return builder.finish();
}

class TableRowLineNumberMarker extends GutterMarker {
  public constructor(
    private readonly tableFrom: number,
    private readonly lineNumbers: readonly number[],
  ) {
    super();
  }

  public eq(_other: GutterMarker): boolean {
    return false;
  }

  public toDOM(view: EditorView): Node {
    const wrapper = view.dom.ownerDocument.createElement("div");
    wrapper.className = "mm-live-v4-table-gutter-lines";
    wrapper.dataset.tableFrom = String(this.tableFrom);

    this.lineNumbers.forEach((lineNumber) => {
      const line = view.dom.ownerDocument.createElement("div");
      line.className = "mm-live-v4-table-gutter-line";
      line.textContent = String(lineNumber);
      wrapper.append(line);
    });

    scheduleTableGutterSync(view, wrapper, this.tableFrom);
    return wrapper;
  }

  public destroy(dom: Node): void {
    if (dom instanceof HTMLElement) {
      const observer = tableGutterObservers.get(dom);
      observer?.disconnect();
      tableGutterObservers.delete(dom);
    }
  }
}

const tableGutterObservers = new WeakMap<HTMLElement, ResizeObserver>();

function scheduleTableGutterSync(
  view: EditorView,
  gutter: HTMLElement,
  tableFrom: number,
): void {
  const win = view.dom.ownerDocument.defaultView ?? window;
  win.requestAnimationFrame(() => {
    syncTableGutterRows(view, gutter, tableFrom);
  });
}

function syncTableGutterRows(
  view: EditorView,
  gutter: HTMLElement,
  tableFrom: number,
): void {
  const table = view.dom.ownerDocument.querySelector<HTMLElement>(
    `.mm-live-v4-table-widget[data-src-from="${tableFrom}"] .mm-live-v4-table`,
  );
  if (!table) {
    return;
  }

  const tableRows = Array.from(
    table.querySelectorAll<HTMLTableRowElement>("thead tr, tbody tr"),
  );
  const gutterRows = Array.from(
    gutter.querySelectorAll<HTMLElement>(".mm-live-v4-table-gutter-line"),
  );

  tableRows.forEach((tableRow, index) => {
    const gutterRow = gutterRows[index];
    if (!gutterRow) {
      return;
    }

    gutterRow.style.height = `${tableRow.getBoundingClientRect().height}px`;
  });

  if (typeof ResizeObserver === "undefined" || tableGutterObservers.has(gutter)) {
    return;
  }

  const observer = new ResizeObserver(() => {
    tableRows.forEach((tableRow, index) => {
      const gutterRow = gutterRows[index];
      if (gutterRow) {
        gutterRow.style.height = `${tableRow.getBoundingClientRect().height}px`;
      }
    });
  });
  observer.observe(table);
  tableGutterObservers.set(gutter, observer);
}
