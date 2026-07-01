import { markdown } from "@codemirror/lang-markdown";
import { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createCursorController } from "./CursorController";
import { createLiveStateField } from "./LiveStateField";
import { createPointerController } from "./PointerController";
import { createTableFirstParser } from "./parser/TableFirstParser";

export interface LiveRuntime {
  extensions: Extension[];
}

export function createLiveRuntime(): LiveRuntime {
  const parser = createTableFirstParser();
  const { liveStateField, liveAtomicRanges } = createLiveStateField({ parser });
  const cursorController = createCursorController();
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
          fontFamily: "var(--vscode-editor-font-family, monospace)",
          fontSize: "var(--vscode-editor-font-size, 13px)",
          lineHeight: "1.5",
        },
        ".cm-content": {
          minHeight: "100%",
          padding: "8px 12px",
          caretColor: "var(--vscode-editorCursor-foreground, #aeafad)",
        },
        ".cm-line": {
          color: "var(--vscode-editor-foreground, #d4d4d4)",
        },
      }),
      markdown(),
      EditorView.lineWrapping,
      liveStateField,
      liveAtomicRanges,
      livePointerHandlers,
      EditorView.updateListener.of((update) => {
        if (update.focusChanged && update.view.hasFocus) {
          cursorController.focusEditor(update.view);
        }
      }),
    ],
  };
}
