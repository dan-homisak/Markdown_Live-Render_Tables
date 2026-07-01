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
          backgroundColor:
            "var(--vscode-editor-lineHighlightBackground, transparent)",
          color: "var(--vscode-editorLineNumber-activeForeground, #c6c6c6)",
        },
        ".cm-lineNumbers .cm-gutterElement": {
          minHeight: "var(--mlrt-editor-line-height, 1.5em)",
          minWidth: "var(--mlrt-editor-line-number-width, 22px)",
          padding: "0 var(--mlrt-editor-gutter-right-padding, 26px) 0 0",
        },
        '.cm-lineNumbers .cm-gutterElement[style*="visibility: hidden"]': {
          minHeight: "0",
        },
        ".cm-content": {
          minHeight: "100%",
          padding:
            "var(--mlrt-editor-top-padding, 0px) 0 var(--mlrt-editor-bottom-padding, 0px) 0",
          caretColor: "var(--vscode-editorCursor-foreground, #aeafad)",
        },
        ".cm-line": {
          color: "var(--vscode-editor-foreground, #d4d4d4)",
        },
        ".cm-activeLine": {
          backgroundColor:
            "var(--vscode-editor-lineHighlightBackground, transparent)",
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
      createEditorGeometrySync(),
      markdown(),
      ...(options.lineWrapping ? [EditorView.lineWrapping] : []),
      liveStateField,
      liveAtomicRanges,
      livePointerHandlers,
    ],
  };
}

/**
 * Publishes live editor geometry (the usable content width and the real
 * line-number gutter width) as CSS custom properties on the scroller.
 *
 * The rendered table is a block widget living inside `.cm-content`. When line
 * wrapping is disabled the content box is sized to `max-content`, so a table
 * with `width: 100%` resolves against a shrink-to-fit container and never
 * wraps. Exposing the measured viewport width lets the table adopt a definite
 * width (viewport minus gutter) regardless of the editor's word-wrap setting.
 *
 * Measuring the actual gutter width keeps the table's per-row line numbers
 * aligned with the native gutter even when the line-number digit count grows.
 */
function createEditorGeometrySync(): Extension {
  return ViewPlugin.fromClass(
    class {
      private lastContentWidth = -1;
      private lastGutterWidth = -1;

      public constructor(view: EditorView) {
        this.schedule(view);
      }

      public update(update: ViewUpdate): void {
        if (
          update.geometryChanged ||
          update.viewportChanged ||
          update.docChanged
        ) {
          this.schedule(update.view);
        }
      }

      private schedule(view: EditorView): void {
        view.requestMeasure({
          read: (measuredView) => ({
            contentWidth: measuredView.scrollDOM.clientWidth,
            gutterWidth:
              measuredView.dom.querySelector<HTMLElement>(".cm-gutters")
                ?.offsetWidth ?? 0,
          }),
          write: (metrics, measuredView) => {
            const scrollerStyle = measuredView.scrollDOM.style;
            if (metrics.contentWidth !== this.lastContentWidth) {
              this.lastContentWidth = metrics.contentWidth;
              scrollerStyle.setProperty(
                "--mlrt-live-content-width",
                `${metrics.contentWidth}px`,
              );
            }
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
          },
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
