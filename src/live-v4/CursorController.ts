import { EditorView } from "@codemirror/view";

export interface CursorController {
  focusEditor(view: EditorView): boolean;
}

export function createCursorController(): CursorController {
  return {
    focusEditor(view: EditorView): boolean {
      view.focus();
      return true;
    },
  };
}
