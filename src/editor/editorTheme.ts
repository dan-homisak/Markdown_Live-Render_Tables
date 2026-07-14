import { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * CodeMirror theme that mirrors the stock VS Code editor: fonts, gutter
 * geometry, active-line and cursor colors all come from the VS Code webview
 * CSS variables plus the per-document metrics injected by the host.
 *
 * Gutter geometry is expressed with the same custom properties the rendered
 * table uses for its own line-number column, so the two stay aligned by
 * construction. Keep this in sync with media/liveEditor.css.
 */
export function createEditorTheme(): Extension {
  return EditorView.theme({
    "&": {
      height: "100%",
      color: "var(--vscode-editor-foreground, #d4d4d4)",
      backgroundColor: "var(--vscode-editor-background, #1e1e1e)",
    },
    ".cm-scroller": {
      overflowX: "hidden !important",
      overflowY: "auto !important",
      height: "100%",
      fontFamily:
        "var(--mlrt-editor-font-family, var(--vscode-editor-font-family, monospace))",
      fontSize:
        "var(--mlrt-editor-font-size, var(--vscode-editor-font-size, 13px))",
      fontWeight: "var(--mlrt-editor-font-weight, normal)",
      lineHeight: "var(--mlrt-editor-line-height, normal)",
      letterSpacing: "var(--mlrt-editor-letter-spacing, normal)",
      fontFeatureSettings: "var(--mlrt-editor-font-feature-settings, normal)",
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
      fontFeatureSettings: "var(--mlrt-editor-font-feature-settings, normal)",
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
    "&.mlrt-table-cell-focused .cm-activeLine": {
      backgroundColor: "transparent",
    },
    "&.mlrt-selection-active .cm-activeLine": {
      backgroundColor: "transparent",
    },
    "&.mlrt-table-cell-focused .cm-cursor": {
      display: "none",
    },
    // While a rendered table cell has focus, the editor selection is parked
    // on some unrelated line; do not let the native gutter highlight it.
    "&.mlrt-table-cell-focused .cm-activeLineGutter": {
      color: "var(--vscode-editorLineNumber-foreground, #858585)",
    },
    // A selection already communicates the active range. Keeping a second
    // active-line marker on its moving head (or its parked table-source
    // cursor) leaves a misleading grey line number behind.
    "&.mlrt-selection-active .cm-activeLineGutter": {
      color: "var(--vscode-editorLineNumber-foreground, #858585)",
    },
  });
}
