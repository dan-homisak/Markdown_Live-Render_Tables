import { Compartment, Extension, Facet } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import {
  DEFAULT_TABLE_NAVIGATION_MODIFIER_KEY,
  TableNavigationKeyState,
  TableNavigationModifierKey,
} from "../shared/tableKeyboardNavigation";

export const tableNavigationModifierCompartment = new Compartment();
export const tableNavigationModifierFacet = Facet.define<
  TableNavigationModifierKey,
  TableNavigationModifierKey
>({
  combine: (values) => values[0] ?? DEFAULT_TABLE_NAVIGATION_MODIFIER_KEY,
});

const keyStates = new WeakMap<Document, TableNavigationKeyState>();

/** Whether the configured function key is currently held in this webview. */
export function isTableNavigationModifierHeld(
  doc: Document,
  key: TableNavigationModifierKey,
): boolean {
  return keyStates.get(doc)?.isHeld(key) ?? false;
}

/**
 * Tracks F-key down/up state once for the editor document. Function keys are
 * ordinary keys rather than DOM modifier flags, so the later Arrow event does
 * not otherwise reveal that F2 (or the configured alternative) is held.
 */
export function createTableNavigationKeyTracker(): Extension {
  return ViewPlugin.fromClass(
    class {
      private readonly state = new TableNavigationKeyState();
      private readonly doc: Document;
      private readonly ownerWindow: Window | null;

      private readonly onKeyDown = (event: KeyboardEvent): void => {
        if (
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey
        ) {
          this.state.keyDown(event.key);
        }
      };

      private readonly onKeyUp = (event: KeyboardEvent): void => {
        this.state.keyUp(event.key);
      };

      private readonly clear = (): void => {
        this.state.clear();
      };

      private readonly onWindowBlur = (): void => {
        // Chromium can emit transient window blur notifications while focus is
        // moving between editing hosts in an embedded webview. Defer the check
        // and clear only when the document genuinely lost focus.
        this.ownerWindow?.setTimeout(() => {
          if (!this.doc.hasFocus()) {
            this.clear();
          }
        }, 0);
      };

      private readonly onVisibilityChange = (): void => {
        if (this.doc.visibilityState !== "visible") {
          this.clear();
        }
      };

      public constructor(view: EditorView) {
        this.doc = view.dom.ownerDocument;
        this.ownerWindow = this.doc.defaultView;
        keyStates.set(this.doc, this.state);
        this.doc.addEventListener("keydown", this.onKeyDown, true);
        this.doc.addEventListener("keyup", this.onKeyUp, true);
        this.doc.addEventListener(
          "visibilitychange",
          this.onVisibilityChange,
          true,
        );
        this.ownerWindow?.addEventListener("blur", this.onWindowBlur, true);
        this.ownerWindow?.addEventListener("pagehide", this.clear, true);
      }

      public destroy(): void {
        this.doc.removeEventListener("keydown", this.onKeyDown, true);
        this.doc.removeEventListener("keyup", this.onKeyUp, true);
        this.doc.removeEventListener(
          "visibilitychange",
          this.onVisibilityChange,
          true,
        );
        this.ownerWindow?.removeEventListener(
          "blur",
          this.onWindowBlur,
          true,
        );
        this.ownerWindow?.removeEventListener("pagehide", this.clear, true);
        this.clear();
        keyStates.delete(this.doc);
      }
    },
  );
}
