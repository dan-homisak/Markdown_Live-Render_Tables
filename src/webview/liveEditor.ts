import { redo, undo } from "@codemirror/commands";
import {
  ChangeSet,
  EditorSelection,
  EditorState,
  Transaction,
} from "@codemirror/state";
import { EditorView, ViewUpdate } from "@codemirror/view";
import { createLiveEditorExtensions } from "../editor/liveEditorExtensions";
import {
  tableCellCommitSequenceAnnotation,
  TableCellCommitRestore,
  TableCellCommitSequence,
} from "../editor/tableEditAnnotations";
import {
  findCell,
  setCellCaretOffset,
  TABLE_CELL_SELECTOR,
} from "../editor/table/cellSelection";
import { TABLE_CELL_COMMIT_EVENT } from "../editor/table/tableCellEditing";
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
  source?: "host" | "webviewAck";
  ackId?: number;
}

interface DocumentChangeMessage {
  from: number;
  to: number;
  text: string;
}

interface EditorCommandMessage {
  type: "editorCommand";
  command: "undo" | "redo";
}

interface DebugEvent {
  event: string;
  details: Record<string, unknown>;
  timestamp: number;
}

type TableCellCommitDetail = TableCellCommitRestore;

interface PendingHostUndoFocus {
  beforeText: string;
  restore: HostUndoRestoreTarget;
}

type HostUndoRestoreTarget =
  | {
      kind: "editor";
      anchor: number;
    }
  | {
      kind: "tableCell";
      detail: TableCellCommitDetail;
    };

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
let lastTableCellCommit: TableCellCommitDetail | null = null;
let nextWebviewChangeId = 1;
let hostDocumentApplyToken = 0;
const pendingWebviewEchoes: { id: number; text: string }[] = [];
const pendingHostUndoFocusStack: PendingHostUndoFocus[] = [];
const MAX_PENDING_HOST_UNDO_FOCUS = 200;

try {
  const editorExtensions = createLiveEditorExtensions(readEditorOptions());
  const initialDocument = readInitialDocument();
  app.replaceChildren();
  app.className = "mlrt-editor-shell";
  const editorMount = document.createElement("div");
  editorMount.className = "mlrt-editor-mount";
  app.append(editorMount);
  view = new EditorView({
    parent: editorMount,
    state: EditorState.create({
      doc: initialDocument,
      extensions: [
        ...editorExtensions,
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
            const commitSequence = getTableCellCommitSequence(update);
            if (commitSequence) {
              pushTableCellCommitUndoFocus(
                update.startState.doc.toString(),
                commitSequence,
              );
            } else {
              pushPendingHostUndoFocus({
                beforeText: update.startState.doc.toString(),
                restore: lastTableCellCommit
                  ? { kind: "tableCell", detail: lastTableCellCommit }
                  : {
                      kind: "editor",
                      anchor: update.startState.selection.main.head,
                    },
              });
            }
            lastTableCellCommit = null;
            postDocumentChanges(
              update.changes,
              update.state.doc.toString(),
              commitSequence,
            );
          }
        }),
      ],
    }),
  });
  window.__MLRT_EDITOR_VIEW__ = view;
  updateStatus(initialDocument, "embedded");
  installEditorCommandBridge(app);
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
  if (message.source === "webviewAck") {
    if (typeof message.ackId === "number") {
      acknowledgeWebviewEcho(
        message.ackId,
        message.text,
        `host revision ${message.revision}`,
      );
    } else {
      recordDebug("ignore-unidentified-webview-echo", {
        echoedTextLength: message.text.length,
        currentTextLength: view.state.doc.length,
      });
    }
    return;
  }
  setEditorDocument(message.text, `host revision ${message.revision}`);
});

vscode.postMessage({ type: "ready" });

function setEditorDocument(text: string, source: string): void {
  const currentText = view.state.doc.toString();
  updateStatus(text, source);
  if (text === currentText) {
    return;
  }

  const undoFocus = popPendingHostUndoFocus(text);
  const hostChange = computeMinimalTextChange(currentText, text);
  markHostDocumentApplyInProgress();

  // Focus handling during a host apply is deliberately conservative:
  // - undo returning to a source-editor edit blurs the cell and places the
  //   cursor at the undone edit,
  // - undo of a cell edit re-targets the cell via focusTableCellAfterRender
  //   (an atomic focus transfer; no intermediate blur, so cell chrome and
  //   the active-line highlight never flash),
  // - all other host changes leave focus and let CodeMirror map the
  //   selection through the change. Dispatching a cursor into hidden table
  //   source would make the selection guard bounce the active line.
  const returnFocusToEditor = undoFocus?.restore.kind === "editor";
  if (returnFocusToEditor) {
    blurActiveTableCell();
  }

  applyingFromHost = true;
  view.dispatch({
    changes: hostChange,
    selection:
      undoFocus?.restore.kind === "editor"
        ? EditorSelection.cursor(
            clampEditorPosition(undoFocus.restore.anchor, text.length),
            1,
          )
        : undefined,
    annotations: [
      allowTableSourceChange.of(true),
      // Host-applied changes (external edits and the host-owned table cell
      // undo path) must not enter the source editor's CodeMirror history, or
      // the two undo stacks would fight. CodeMirror still maps its stored
      // history through these changes so a later source undo stays consistent.
      Transaction.addToHistory.of(false),
    ],
  });
  applyingFromHost = false;

  if (undoFocus?.restore.kind === "tableCell") {
    focusTableCellAfterRender(undoFocus.restore.detail);
  }
}

function markHostDocumentApplyInProgress(): void {
  const token = ++hostDocumentApplyToken;
  const documentElement = view.dom.ownerDocument.documentElement;
  const ownerWindow = view.dom.ownerDocument.defaultView;
  documentElement.dataset.mlrtApplyingHostDocument = "true";
  const clearIfCurrent = (): void => {
    if (hostDocumentApplyToken !== token) {
      return;
    }
    delete documentElement.dataset.mlrtApplyingHostDocument;
  };
  if (!ownerWindow) {
    setTimeout(clearIfCurrent, 50);
    return;
  }

  ownerWindow.requestAnimationFrame(() => {
    ownerWindow.requestAnimationFrame(clearIfCurrent);
  });
}

function blurActiveTableCell(): void {
  const activeElement = view.dom.ownerDocument.activeElement;
  if (!(activeElement instanceof HTMLElement)) {
    return;
  }

  findCell(activeElement)?.blur();
}

function installEditorCommandBridge(root: HTMLElement): void {
  const ownerDocument = root.ownerDocument;
  ownerDocument.addEventListener(
    "pointerdown",
    (event) => {
      if (event.target instanceof Element) {
        if (event.target.closest(TABLE_CELL_SELECTOR)) {
          return;
        }
        if (!root.contains(event.target)) {
          return;
        }
      }

      blurActiveTableCell();
    },
    true,
  );

  ownerDocument.addEventListener(
    "keydown",
    (event) => {
      const command = getUndoRedoCommand(event);
      if (!command) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      dispatchUndoRedo(command);
    },
    true,
  );

  ownerDocument.addEventListener(
    "beforeinput",
    (event) => {
      if (!(event instanceof InputEvent)) {
        return;
      }

      const command =
        event.inputType === "historyUndo"
          ? "undo"
          : event.inputType === "historyRedo"
            ? "redo"
            : null;
      if (!command) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      dispatchUndoRedo(command);
    },
    true,
  );
}

/**
 * Undo/redo routing:
 * - While a rendered table cell is focused, keep the fine-grained per-cell
 *   history that the table editing subsystem owns (delegated to the host).
 * - Otherwise the source editor owns history through CodeMirror, which
 *   coalesces typing into word/whitespace groups and stops at the initially
 *   loaded document — matching the stock VS Code editor.
 */
function dispatchUndoRedo(command: EditorCommandMessage["command"]): void {
  if (isTableCellFocused()) {
    postEditorCommand(command);
    return;
  }
  runHistoryCommand(command);
}

function getUndoRedoCommand(
  event: KeyboardEvent,
): EditorCommandMessage["command"] | null {
  const key = event.key.toLowerCase();
  const hasPrimaryModifier = event.metaKey || event.ctrlKey;
  if (!hasPrimaryModifier || event.altKey) {
    return null;
  }

  if (key === "z") {
    return event.shiftKey ? "redo" : "undo";
  }

  if (key === "y" && !event.shiftKey) {
    return "redo";
  }

  return null;
}

function pushTableCellCommitUndoFocus(
  beforeText: string,
  commitSequence: TableCellCommitSequence,
): void {
  let currentText = beforeText;
  for (const step of commitSequence.steps) {
    pushPendingHostUndoFocus({
      beforeText: currentText,
      restore: {
        kind: "tableCell",
        detail: step.restore,
      },
    });
    currentText = applyDocumentChange(currentText, step.change);
  }
}

function pushPendingHostUndoFocus(pendingFocus: PendingHostUndoFocus): void {
  pendingHostUndoFocusStack.push(pendingFocus);
  if (pendingHostUndoFocusStack.length > MAX_PENDING_HOST_UNDO_FOCUS) {
    pendingHostUndoFocusStack.splice(
      0,
      pendingHostUndoFocusStack.length - MAX_PENDING_HOST_UNDO_FOCUS,
    );
  }
}

/**
 * Runs undo/redo against CodeMirror's own history (the source editor's single
 * source of truth). This gives stock-VS Code-style grouping and stops at the
 * initially loaded document, instead of walking the host document's
 * per-keystroke undo stack.
 */
function runHistoryCommand(command: EditorCommandMessage["command"]): void {
  const applied = command === "undo" ? undo(view) : redo(view);
  recordDebug("run-history-command", {
    command,
    applied,
    activeElement: summarizeTarget(document.activeElement),
    editorSelection: summarizeEditorSelection(view),
  });
  if (applied && !view.hasFocus) {
    view.focus();
  }
}

function postEditorCommand(command: EditorCommandMessage["command"]): void {
  recordDebug("post-editor-command", {
    command,
    activeElement: summarizeTarget(document.activeElement),
    editorSelection: summarizeEditorSelection(view),
  });
  vscode.postMessage({
    type: "editorCommand",
    command,
  } satisfies EditorCommandMessage);
}

function isTableCellFocused(): boolean {
  const active = view.dom.ownerDocument.activeElement;
  return (
    active instanceof Element && active.closest(TABLE_CELL_SELECTOR) !== null
  );
}

function computeMinimalTextChange(
  currentText: string,
  nextText: string,
): { from: number; to: number; insert: string } {
  let from = 0;
  while (
    from < currentText.length &&
    from < nextText.length &&
    currentText[from] === nextText[from]
  ) {
    from++;
  }

  let currentTo = currentText.length;
  let nextTo = nextText.length;
  while (
    currentTo > from &&
    nextTo > from &&
    currentText[currentTo - 1] === nextText[nextTo - 1]
  ) {
    currentTo--;
    nextTo--;
  }

  return {
    from,
    to: currentTo,
    insert: nextText.slice(from, nextTo),
  };
}

function acknowledgeWebviewEcho(
  ackId: number,
  text: string,
  source: string,
): boolean {
  const acknowledgedIndex = pendingWebviewEchoes.findIndex(
    (pending) => pending.id === ackId,
  );
  if (acknowledgedIndex === -1) {
    if (ackId > 0 && ackId < nextWebviewChangeId) {
      recordDebug("ignore-stale-webview-echo", {
        ackId,
        pendingEchoCount: pendingWebviewEchoes.length,
        echoedTextLength: text.length,
        currentTextLength: view.state.doc.length,
      });
      return true;
    }
    return false;
  }

  const acknowledged = pendingWebviewEchoes[acknowledgedIndex];
  if (acknowledged.text !== text) {
    pendingWebviewEchoes.splice(0, acknowledgedIndex + 1);
    recordDebug("ignore-mismatched-webview-echo", {
      ackId,
      pendingEchoCount: pendingWebviewEchoes.length,
      echoedTextLength: text.length,
      expectedTextLength: acknowledged.text.length,
      currentTextLength: view.state.doc.length,
    });
    return true;
  }

  pendingWebviewEchoes.splice(0, acknowledgedIndex + 1);
  updateStatus(view.state.doc.toString(), `${source} acknowledged`);
  recordDebug("ack-webview-echo", {
    ackId,
    acknowledgedIndex,
    pendingEchoCount: pendingWebviewEchoes.length,
    echoedTextLength: text.length,
    currentTextLength: view.state.doc.length,
  });
  return true;
}

function popPendingHostUndoFocus(text: string): PendingHostUndoFocus | null {
  for (let index = pendingHostUndoFocusStack.length - 1; index >= 0; index--) {
    const pendingFocus = pendingHostUndoFocusStack[index];
    if (pendingFocus.beforeText === text) {
      pendingHostUndoFocusStack.splice(index);
      return pendingFocus;
    }
  }

  return null;
}

function clampEditorPosition(position: number, documentLength: number): number {
  return Math.min(documentLength, Math.max(0, position));
}

function getTableCellCommitSequence(
  update: ViewUpdate,
): TableCellCommitSequence | undefined {
  for (const transaction of update.transactions) {
    const sequence = transaction.annotation(tableCellCommitSequenceAnnotation);
    if (sequence) {
      return sequence;
    }
  }

  return undefined;
}

function applyDocumentChange(
  text: string,
  change: DocumentChangeMessage,
): string {
  return `${text.slice(0, change.from)}${change.text}${text.slice(change.to)}`;
}

function updateStatus(text: string, source: string): void {
  document.documentElement.dataset.mlrtDocumentStatus = `${text.length} characters loaded from ${source}`;
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
  commitSequence?: TableCellCommitSequence,
): void {
  const documentChanges: DocumentChangeMessage[] = [];
  changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    documentChanges.push({
      from,
      to,
      text: inserted.toString(),
    });
  });
  const changeId = nextWebviewChangeId++;
  recordDebug("post-change", {
    changeId,
    baseRevision: hostRevision,
    changes: documentChanges,
    changeGroups: commitSequence?.steps.map((step) => [step.change]),
  });
  pendingWebviewEchoes.push({ id: changeId, text });
  if (pendingWebviewEchoes.length > 100) {
    pendingWebviewEchoes.splice(0, pendingWebviewEchoes.length - 100);
  }
  vscode.postMessage({
    type: "change",
    changeId,
    text,
    changes: documentChanges,
    changeGroups: commitSequence?.steps.map((step) => [step.change]),
    baseRevision: hostRevision,
  });
}

function installCursorDebugListeners(root: HTMLElement): void {
  for (const eventName of [
    "focusin",
    "focusout",
    "mousedown",
    "mouseup",
    "click",
    "keydown",
  ]) {
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

  root.addEventListener(TABLE_CELL_COMMIT_EVENT, (event) => {
    if (event instanceof CustomEvent && isTableCellCommitDetail(event.detail)) {
      lastTableCellCommit = event.detail;
    }
    recordDebug("table-cell-commit", {
      detail: event instanceof CustomEvent ? event.detail : null,
      selection: summarizeDomSelection(),
      editorSelection: view ? summarizeEditorSelection(view) : null,
      activeElement: summarizeTarget(document.activeElement),
    });
  });
}

function focusTableCellAfterRender(detail: TableCellCommitDetail): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const tableSelector = `${TABLE_CELL_SELECTOR}[data-table-from="${detail.tableFrom}"]`;
      const selector = [
        tableSelector,
        `[data-row-kind="${cssEscapeAttribute(detail.rowKind)}"]`,
        `[data-row-index="${detail.rowIndex}"]`,
        `[data-column="${detail.column}"]`,
      ].join("");
      const cell =
        document.querySelector<HTMLElement>(selector) ??
        document.querySelector<HTMLElement>(
          [
            `${TABLE_CELL_SELECTOR}[data-row-kind="${cssEscapeAttribute(detail.rowKind)}"]`,
            `[data-row-index="${detail.rowIndex}"]`,
            `[data-column="${detail.column}"]`,
          ].join(""),
        );
      if (!cell) {
        return;
      }

      cell.focus();
      setCellCaretOffset(cell, detail.restoreCaretOffset);
    });
  });
}

function cssEscapeAttribute(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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

function summarizeEditorSelection(
  editorView: EditorView,
): Record<string, unknown> {
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
    node instanceof HTMLElement ? node : (node.parentElement ?? undefined);
  return {
    target: summarizeTarget(element ?? node),
    offset,
  };
}

function summarizeTarget(
  target: EventTarget | null,
): Record<string, unknown> | null {
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

function isTableCellCommitDetail(
  detail: unknown,
): detail is TableCellCommitDetail {
  if (!detail || typeof detail !== "object") {
    return false;
  }

  const record = detail as Record<string, unknown>;
  return (
    typeof record.tableFrom === "number" &&
    typeof record.rowKind === "string" &&
    typeof record.rowIndex === "number" &&
    typeof record.column === "number" &&
    typeof record.from === "number" &&
    typeof record.to === "number" &&
    typeof record.restoreCaretOffset === "number"
  );
}
