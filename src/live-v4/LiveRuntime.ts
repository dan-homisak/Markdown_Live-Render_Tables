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
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { parseMarkdownTables } from "../shared/tableModel";
import {
  createTableSourceChangeFilter,
  createTableSourceSelectionGuard,
} from "../shared/tableSourceProtection";
import { createLiveStateField } from "./LiveStateField";
import { createPointerController } from "./PointerController";
import { createTableFirstParser } from "./parser/TableFirstParser";

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
          fontFamily:
            "var(--mlrt-editor-font-family, var(--vscode-editor-font-family, monospace))",
          fontSize:
            "var(--mlrt-editor-font-size, var(--vscode-editor-font-size, 13px))",
          fontWeight: "var(--mlrt-editor-font-weight, normal)",
          lineHeight: "var(--mlrt-editor-line-height, normal)",
          letterSpacing: "var(--mlrt-editor-letter-spacing, normal)",
          fontFeatureSettings:
            "var(--mlrt-editor-font-feature-settings, normal)",
          fontVariationSettings:
            "var(--mlrt-editor-font-variation-settings, normal)",
        },
        ".cm-gutters": {
          backgroundColor:
            "var(--vscode-editorGutter-background, var(--vscode-editor-background, #1e1e1e))",
          color: "var(--vscode-editorLineNumber-foreground, #858585)",
          borderRight: "none",
          boxSizing: "border-box",
          paddingLeft: "var(--mlrt-editor-gutter-left-padding, 18px)",
          fontFamily:
            "var(--mlrt-editor-font-family, var(--vscode-editor-font-family, monospace))",
          fontSize:
            "var(--mlrt-editor-font-size, var(--vscode-editor-font-size, 13px))",
          fontWeight: "var(--mlrt-editor-font-weight, normal)",
          lineHeight: "var(--mlrt-editor-line-height, normal)",
          letterSpacing: "var(--mlrt-editor-letter-spacing, normal)",
          fontFeatureSettings:
            "var(--mlrt-editor-font-feature-settings, normal)",
          fontVariationSettings:
            "var(--mlrt-editor-font-variation-settings, normal)",
        },
        ".cm-activeLineGutter": {
          backgroundColor: "transparent",
          color: "var(--vscode-editorLineNumber-activeForeground, #c6c6c6)",
        },
        ".cm-lineNumbers .cm-gutterElement": {
          boxSizing: "border-box",
          width:
            "calc(var(--mlrt-editor-line-number-width, 22px) + var(--mlrt-editor-gutter-right-padding, 26px))",
          minHeight: "var(--mlrt-editor-line-height, 1.5em)",
          minWidth:
            "calc(var(--mlrt-editor-line-number-width, 22px) + var(--mlrt-editor-gutter-right-padding, 26px))",
          maxWidth:
            "calc(var(--mlrt-editor-line-number-width, 22px) + var(--mlrt-editor-gutter-right-padding, 26px))",
          padding: "0 var(--mlrt-editor-gutter-right-padding, 26px) 0 0",
        },
        '.cm-lineNumbers .cm-gutterElement[style*="visibility: hidden"]': {
          minHeight: "0",
        },
        ".cm-content": {
          minHeight: "100%",
          boxSizing: "border-box",
          padding:
            "var(--mlrt-editor-top-padding, 0px) var(--mlrt-editor-right-padding, var(--mlrt-editor-gutter-right-padding, 26px)) var(--mlrt-editor-bottom-padding, 0px) 0",
          caretColor: "var(--vscode-editorCursor-foreground, #aeafad)",
        },
        ".cm-line": {
          color: "var(--vscode-editor-foreground, #d4d4d4)",
          padding: "0",
        },
        ".cm-activeLine": {
          backgroundColor:
            "var(--vscode-editor-lineHighlightBackground, transparent)",
        },
        ".cm-cursor, .cm-dropCursor": {
          borderLeftColor: "var(--vscode-editorCursor-foreground, #aeafad)",
          borderLeftWidth: "var(--mlrt-editor-cursor-width, 1px)",
        },
        "&.mm-live-v4-table-cell-focused .cm-activeLine": {
          backgroundColor: "transparent",
        },
        "&.mm-live-v4-table-cell-focused .cm-cursor": {
          display: "none",
        },
      }),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      lineNumbers(),
      createTableLineNumberSuppressions(),
      createEditorGeometrySync(),
      createTableCellFocusClassSync(),
      createTableSourceChangeFilter(),
      createTableSourceSelectionGuard({
        tableCellSelector: ".mm-live-v4-table-cell",
      }),
      markdown(),
      ...(options.lineWrapping ? [EditorView.lineWrapping] : []),
      liveStateField,
      liveAtomicRanges,
      livePointerHandlers,
    ],
  };
}

/**
 * Publishes the real line-number gutter width as a CSS custom property on the
 * scroller.
 *
 * The rendered table uses CSS viewport units for its wrapping width so it
 * responds to workbench and window resizes in the same frame as the browser
 * layout pass.
 *
 * Measuring the actual gutter width keeps the table's per-row line numbers
 * aligned with the native gutter even when the line-number digit count grows.
 * Observing the editor and table widgets makes CodeMirror remeasure replaced
 * block heights when sidebar-driven width changes wrap table cell text.
 */
function createEditorGeometrySync(): Extension {
  return ViewPlugin.fromClass(
    class {
      private readonly measureKey = {};
      private lastGutterWidth = -1;
      private lastContentWidth = -1;
      private resizeObserver: ResizeObserver | undefined;
      private readonly observedTableWidgets = new Set<Element>();

      public constructor(view: EditorView) {
        const ResizeObserverCtor =
          view.dom.ownerDocument.defaultView?.ResizeObserver;
        if (ResizeObserverCtor) {
          this.resizeObserver = new ResizeObserverCtor(() => {
            this.schedule(view, true);
          });
          this.resizeObserver.observe(view.dom);
          this.resizeObserver.observe(view.scrollDOM);
        }
        this.schedule(view);
      }

      public update(update: ViewUpdate): void {
        this.syncObservedTableWidgets(update.view);
        if (
          update.geometryChanged ||
          update.viewportChanged ||
          update.docChanged
        ) {
          this.schedule(update.view);
        }
      }

      public destroy(): void {
        this.resizeObserver?.disconnect();
        this.observedTableWidgets.clear();
      }

      private schedule(view: EditorView, forceContentRemeasure = false): void {
        if (forceContentRemeasure) {
          forceCodeMirrorContentRemeasure(view);
        }

        view.requestMeasure({
          key: this.measureKey,
          read: (measuredView) => ({
            gutterWidth:
              measuredView.dom.querySelector<HTMLElement>(".cm-gutters")
                ?.offsetWidth ?? 0,
            contentWidth: measuredView.scrollDOM.clientWidth,
          }),
          write: (metrics, measuredView) => {
            this.syncObservedTableWidgets(measuredView);
            const scrollerStyle = measuredView.scrollDOM.style;
            if (
              metrics.gutterWidth > 0 &&
              metrics.gutterWidth !== this.lastGutterWidth
            ) {
              this.lastGutterWidth = metrics.gutterWidth;
              scrollerStyle.setProperty(
                "--mlrt-live-gutter-width",
                `${metrics.gutterWidth}px`,
              );
            }
            if (
              metrics.contentWidth > 0 &&
              metrics.contentWidth !== this.lastContentWidth
            ) {
              this.lastContentWidth = metrics.contentWidth;
              scrollerStyle.setProperty(
                "--mlrt-live-content-width",
                `calc(${metrics.contentWidth}px - var(--mlrt-editor-right-padding, 26px))`,
              );
            }
          },
        });
      }

      private syncObservedTableWidgets(view: EditorView): void {
        if (!this.resizeObserver) {
          return;
        }

        const widgets = new Set(
          Array.from(view.dom.querySelectorAll(".mm-live-v4-table-widget")),
        );
        for (const widget of widgets) {
          if (!this.observedTableWidgets.has(widget)) {
            this.resizeObserver.observe(widget);
          }
        }
        for (const widget of this.observedTableWidgets) {
          if (!widgets.has(widget)) {
            this.resizeObserver.unobserve(widget);
          }
        }
        this.observedTableWidgets.clear();
        for (const widget of widgets) {
          this.observedTableWidgets.add(widget);
        }
      }
    },
  );
}

function forceCodeMirrorContentRemeasure(view: EditorView): void {
  const viewState = (
    view as unknown as {
      viewState?: { mustMeasureContent?: boolean | "refresh" };
    }
  ).viewState;
  if (viewState) {
    viewState.mustMeasureContent = "refresh";
  }
}

function createTableCellFocusClassSync(): Extension {
  return ViewPlugin.fromClass(
    class {
      private readonly syncFocusClass: () => void;

      public constructor(private readonly view: EditorView) {
        this.syncFocusClass = () => this.sync();
        const doc = view.dom.ownerDocument;
        doc.addEventListener("focusin", this.syncFocusClass, true);
        doc.addEventListener("focusout", this.syncFocusClass, true);
        this.sync();
      }

      public update(update: ViewUpdate): void {
        if (update.focusChanged || update.selectionSet || update.docChanged) {
          this.sync();
        }
      }

      public destroy(): void {
        const doc = this.view.dom.ownerDocument;
        doc.removeEventListener("focusin", this.syncFocusClass, true);
        doc.removeEventListener("focusout", this.syncFocusClass, true);
      }

      private sync(): void {
        queueMicrotask(() => {
          const activeElement = this.view.dom.ownerDocument.activeElement;
          const hasTableCellFocus =
            activeElement instanceof HTMLElement &&
            Boolean(activeElement.closest(".mm-live-v4-table-cell"));
          this.view.dom.classList.toggle(
            "mm-live-v4-table-cell-focused",
            hasTableCellFocus,
          );
        });
      }
    },
  );
}

function createTableLineNumberSuppressions(): Extension {
  const tableLineNumberSuppressions = StateField.define<RangeSet<GutterMarker>>(
    {
      create(state) {
        return buildTableLineNumberSuppressions(state.doc.toString());
      },
      update(value, transaction) {
        if (!transaction.docChanged) {
          return value;
        }
        return buildTableLineNumberSuppressions(
          transaction.state.doc.toString(),
        );
      },
      provide(field) {
        return lineNumberMarkers.from(field);
      },
    },
  );

  return tableLineNumberSuppressions;
}

const hiddenLineNumberMarker = new (class extends GutterMarker {
  public eq(other: GutterMarker): boolean {
    return other === this;
  }

  public toDOM(view: EditorView): Node {
    return view.dom.ownerDocument.createTextNode("");
  }
})();

function buildTableLineNumberSuppressions(
  text: string,
): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>();
  for (const table of parseMarkdownTables(text)) {
    builder.add(table.from, table.from, hiddenLineNumberMarker);
  }
  return builder.finish();
}
