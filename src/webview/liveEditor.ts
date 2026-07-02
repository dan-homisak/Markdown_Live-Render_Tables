import { ChangeSet, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createLiveRuntime } from "../live-v4/LiveRuntime";
import { allowTableSourceChange } from "../shared/tableSourceProtection";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

declare global {
  interface Window {
    __MLRT_INITIAL_DOCUMENT__?: unknown;
    __MLRT_EDITOR_OPTIONS__?: unknown;
    __MLRT_DEBUG__?: unknown;
    __MLRT_DEBUG_EVENTS__?: DebugEvent[];
    __MLRT_EDITOR_VIEW__?: EditorView;
  }
}

interface HostSetDocumentMessage {
  type: "setDocument";
  text: string;
  revision: number;
  debug: boolean;
}

interface DocumentChangeMessage {
  from: number;
  to: number;
  text: string;
}

interface DebugEvent {
  event: string;
  details: Record<string, unknown>;
  timestamp: number;
}

interface EditorOptions {
  lineWrapping: boolean;
}

const vscode = acquireVsCodeApi();
const app = document.getElementById("app");

if (!app) {
  throw new Error("Missing live editor mount element.");
}

let applyingFromHost = false;
let debugEnabled = window.__MLRT_DEBUG__ === true;
let hostRevision = 0;
let view: EditorView;

try {
  const runtime = createLiveRuntime(readEditorOptions());
  const initialDocument = readInitialDocument();
  app.replaceChildren();
  app.className = "mm-live-v4-shell";
  const editorMount = document.createElement("div");
  editorMount.className = "mm-live-v4-editor-mount";
  app.append(editorMount);
  view = new EditorView({
    parent: editorMount,
    state: EditorState.create({
      doc: initialDocument,
      extensions: [
        ...runtime.extensions,
        EditorView.updateListener.of((update) => {
          if (update.selectionSet || update.focusChanged || update.docChanged) {
            recordDebug("editor-update", {
              docChanged: update.docChanged,
              focusChanged: update.focusChanged,
              hasFocus: update.view.hasFocus,
              selectionSet: update.selectionSet,
              editorSelection: summarizeEditorSelection(update.view),
            });
          }
          if (update.docChanged && !applyingFromHost) {
            postDocumentChanges(
              update.changes,
              update.state.doc.toString(),
            );
          }
        }),
      ],
    }),
  });
  window.__MLRT_EDITOR_VIEW__ = view;
  updateStatus(initialDocument, "embedded");
  installCursorDebugListeners(app);
} catch (error) {
  app.replaceChildren(renderStartupError(error));
  throw error;
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = event.data;
  if (!isHostSetDocumentMessage(message)) {
    return;
  }

  hostRevision = message.revision;
  debugEnabled = message.debug;
  setEditorDocument(message.text, `host revision ${message.revision}`);
});

vscode.postMessage({ type: "ready" });

function setEditorDocument(text: string, source: string): void {
  const currentText = view.state.doc.toString();
  updateStatus(text, source);
  if (text === currentText) {
    return;
  }

  applyingFromHost = true;
  view.dispatch({
    changes: {
      from: 0,
      to: currentText.length,
      insert: text,
    },
    annotations: allowTableSourceChange.of(true),
  });
  applyingFromHost = false;
}

function updateStatus(text: string, source: string): void {
  document.documentElement.dataset.mlrtDocumentStatus =
    `${text.length} characters loaded from ${source}`;
}

function readInitialDocument(): string {
  return typeof window.__MLRT_INITIAL_DOCUMENT__ === "string"
    ? window.__MLRT_INITIAL_DOCUMENT__
    : "";
}

function readEditorOptions(): EditorOptions {
  const options = window.__MLRT_EDITOR_OPTIONS__;
  if (!options || typeof options !== "object") {
    return { lineWrapping: true };
  }
  const optionRecord = options as Record<string, unknown>;

  return {
    lineWrapping:
      typeof optionRecord.lineWrapping === "boolean"
        ? optionRecord.lineWrapping
        : true,
  };
}

function postDocumentChanges(
  changes: ChangeSet,
  text: string,
): void {
  const documentChanges: DocumentChangeMessage[] = [];
  changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    documentChanges.push({
      from,
      to,
      text: inserted.toString(),
    });
  });
  recordDebug("post-change", {
    baseRevision: hostRevision,
    changes: documentChanges,
  });
  vscode.postMessage({
    type: "change",
    text,
    changes: documentChanges,
    baseRevision: hostRevision,
  });
}

function installCursorDebugListeners(root: HTMLElement): void {
  for (const eventName of ["focusin", "focusout", "mousedown", "mouseup", "click", "keydown"]) {
    root.addEventListener(
      eventName,
      (event) => {
        recordDebug(`dom-${event.type}`, {
          target: summarizeTarget(event.target),
          relatedTarget:
            "relatedTarget" in event
              ? summarizeTarget((event as FocusEvent).relatedTarget)
              : null,
          key: event instanceof KeyboardEvent ? event.key : undefined,
          selection: summarizeDomSelection(),
          editorSelection: view ? summarizeEditorSelection(view) : null,
          activeElement: summarizeTarget(document.activeElement),
        });
      },
      true,
    );
  }

  document.addEventListener("selectionchange", () => {
    if (!root.contains(document.activeElement)) {
      return;
    }

    recordDebug("dom-selectionchange", {
      selection: summarizeDomSelection(),
      editorSelection: view ? summarizeEditorSelection(view) : null,
      activeElement: summarizeTarget(document.activeElement),
    });
  });

  root.addEventListener("mlrt:table-cell-commit", (event) => {
    recordDebug("table-cell-commit", {
      detail: event instanceof CustomEvent ? event.detail : null,
      selection: summarizeDomSelection(),
      editorSelection: view ? summarizeEditorSelection(view) : null,
      activeElement: summarizeTarget(document.activeElement),
    });
  });
}

function recordDebug(event: string, details: Record<string, unknown>): void {
  const debugEvent: DebugEvent = {
    event,
    details,
    timestamp: Date.now(),
  };
  window.__MLRT_DEBUG_EVENTS__ = window.__MLRT_DEBUG_EVENTS__ ?? [];
  window.__MLRT_DEBUG_EVENTS__.push(debugEvent);
  if (window.__MLRT_DEBUG_EVENTS__.length > 500) {
    window.__MLRT_DEBUG_EVENTS__.splice(
      0,
      window.__MLRT_DEBUG_EVENTS__.length - 500,
    );
  }

  if (debugEnabled) {
    vscode.postMessage({
      type: "debug",
      event,
      details,
    });
  }
}

function summarizeEditorSelection(editorView: EditorView): Record<string, unknown> {
  return {
    ranges: editorView.state.selection.ranges.map((range) => ({
      from: range.from,
      to: range.to,
      empty: range.empty,
    })),
  };
}

function summarizeDomSelection(): Record<string, unknown> | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }

  return {
    anchor: summarizeNodePosition(selection.anchorNode, selection.anchorOffset),
    focus: summarizeNodePosition(selection.focusNode, selection.focusOffset),
    textLength: selection.toString().length,
    collapsed: selection.isCollapsed,
  };
}

function summarizeNodePosition(
  node: Node | null,
  offset: number,
): Record<string, unknown> | null {
  if (!node) {
    return null;
  }

  const element =
    node instanceof HTMLElement ? node : node.parentElement ?? undefined;
  return {
    target: summarizeTarget(element ?? node),
    offset,
  };
}

function summarizeTarget(target: EventTarget | null): Record<string, unknown> | null {
  if (!(target instanceof Element)) {
    return null;
  }

  return {
    tag: target.tagName.toLowerCase(),
    className: target.className,
    text: target.textContent?.slice(0, 80) ?? "",
    rowKind: target.getAttribute("data-row-kind"),
    rowIndex: target.getAttribute("data-row-index"),
    column: target.getAttribute("data-column"),
    tableFrom: target.getAttribute("data-table-from"),
  };
}

function renderStartupError(error: unknown): HTMLElement {
  const wrapper = document.createElement("pre");
  wrapper.style.padding = "1rem";
  wrapper.style.whiteSpace = "pre-wrap";
  wrapper.style.color = "var(--vscode-errorForeground)";
  wrapper.textContent =
    error instanceof Error
      ? `Markdown live editor failed to start:\n${error.message}\n${error.stack ?? ""}`
      : `Markdown live editor failed to start:\n${String(error)}`;
  return wrapper;
}

function isHostSetDocumentMessage(
  message: unknown,
): message is HostSetDocumentMessage {
  return (
    Boolean(message) &&
    typeof message === "object" &&
    (message as Record<string, unknown>).type === "setDocument" &&
    typeof (message as Record<string, unknown>).text === "string" &&
    typeof (message as Record<string, unknown>).revision === "number"
  );
}
