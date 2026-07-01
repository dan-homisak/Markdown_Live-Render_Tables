import { EditorView } from "@codemirror/view";

export interface PointerController {
  handlePointer(view: EditorView): boolean;
}

export function createPointerController(): PointerController {
  return {
    handlePointer(): boolean {
      return false;
    },
  };
}
