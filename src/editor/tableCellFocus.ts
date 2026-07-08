import { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { findCell } from "./table/cellSelection";

export const TABLE_CELL_FOCUSED_CLASS = "mlrt-table-cell-focused";

/**
 * Single owner of the `mlrt-table-cell-focused` class on the editor root.
 * While a rendered table cell has focus, the theme hides the CodeMirror
 * cursor and active-line highlight so only the cell shows editing chrome.
 *
 * Syncing is deferred to a microtask so focus changes settle before the
 * class is read/written (focusout fires before the next element focuses).
 */
export function createTableCellFocusClassSync(): Extension {
  return ViewPlugin.fromClass(
    class {
      private readonly syncFocusClass: () => void;
      private recheckScheduled = false;

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
          const ownerDocument = this.view.dom.ownerDocument;
          const hasTableCellFocus = Boolean(findCell(ownerDocument.activeElement));
          if (
            !hasTableCellFocus &&
            ownerDocument.documentElement.dataset.mlrtApplyingHostDocument ===
              "true"
          ) {
            // A host document apply blurs the cell briefly and refocuses it
            // right after rendering. Keep the class on for now so the editor
            // cursor and active-line highlight do not flash between undo
            // steps, then re-check once the apply window has passed.
            this.scheduleRecheck();
            return;
          }
          this.view.dom.classList.toggle(
            TABLE_CELL_FOCUSED_CLASS,
            hasTableCellFocus,
          );
        });
      }

      private scheduleRecheck(): void {
        if (this.recheckScheduled) {
          return;
        }
        this.recheckScheduled = true;
        const ownerWindow = this.view.dom.ownerDocument.defaultView;
        const raf = ownerWindow
          ? ownerWindow.requestAnimationFrame.bind(ownerWindow)
          : requestAnimationFrame;
        raf(() => {
          raf(() => {
            this.recheckScheduled = false;
            this.sync();
          });
        });
      }
    },
  );
}
