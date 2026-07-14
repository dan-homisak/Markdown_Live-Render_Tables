import { EditorView } from "@codemirror/view";

/**
 * Resolve a drag coordinate without treating a horizontal excursion as a
 * jump to the start or end of the document. CodeMirror may return null when
 * either coordinate is outside its content box, so clamp X while Y remains
 * inside the editor and reserve document boundaries for vertical exits.
 */
export function editorDragPosition(
  view: EditorView,
  clientX: number,
  clientY: number,
): number | null {
  const editorRect = view.dom.getBoundingClientRect();
  if (clientY < editorRect.top) {
    return 0;
  }
  if (clientY > editorRect.bottom) {
    return view.state.doc.length;
  }
  if (editorRect.width <= 1) {
    return null;
  }
  const clampedX = Math.max(
    editorRect.left + 0.5,
    Math.min(clientX, editorRect.right - 0.5),
  );
  return view.posAtCoords({ x: clampedX, y: clientY });
}
