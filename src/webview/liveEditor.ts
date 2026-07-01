import { ChangeSet, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createLiveRuntime } from "../live-v4/LiveRuntime";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

declare global {
  interface Window {
    __MLRT_INITIAL_DOCUMENT__?: unknown;
  }
}

interface HostSetDocumentMessage {
  type: "setDocument";
  text: string;
  revision: number;
}

interface DocumentChangeMessage {
  from: number;
  to: number;
  text: string;
}

const vscode = acquireVsCodeApi();
const app = document.getElementById("app");

if (!app) {
  throw new Error("Missing live editor mount element.");
}

let applyingFromHost = false;
let hostRevision = 0;
let view: EditorView;
let statusElement: HTMLElement;

try {
  const runtime = createLiveRuntime();
  const initialDocument = readInitialDocument();
  app.replaceChildren();
  app.className = "mm-live-v4-shell";
  const toolbar = document.createElement("div");
  toolbar.className = "mm-live-v4-toolbar";
  const sourceButton = document.createElement("button");
  sourceButton.className = "mm-live-v4-source-button";
  sourceButton.type = "button";
  sourceButton.textContent = "Source";
  sourceButton.title = "Return to source";
  sourceButton.addEventListener("click", () => {
    vscode.postMessage({ type: "openSource" });
  });
  statusElement = document.createElement("div");
  statusElement.className = "mm-live-v4-status";
  statusElement.textContent = "Loading markdown...";
  toolbar.append(sourceButton, statusElement);
  const editorMount = document.createElement("div");
  editorMount.className = "mm-live-v4-editor-mount";
  app.append(toolbar, editorMount);
  view = new EditorView({
    parent: editorMount,
    state: EditorState.create({
      doc: "",
      extensions: [
        ...runtime.extensions,
        EditorView.updateListener.of((update) => {
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
  setEditorDocument(initialDocument, "embedded");
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
  });
  applyingFromHost = false;
}

function updateStatus(text: string, source: string): void {
  if (!statusElement) {
    return;
  }
  statusElement.textContent = `Markdown Live Editor: ${text.length} characters loaded from ${source}`;
}

function readInitialDocument(): string {
  return typeof window.__MLRT_INITIAL_DOCUMENT__ === "string"
    ? window.__MLRT_INITIAL_DOCUMENT__
    : "";
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
  vscode.postMessage({
    type: "change",
    text,
    changes: documentChanges,
    baseRevision: hostRevision,
  });
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
