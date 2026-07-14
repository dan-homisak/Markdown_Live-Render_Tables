import {
  ChangeSet,
  EditorSelection,
  EditorState,
  Transaction,
} from "@codemirror/state";
import { EditorView, ViewUpdate } from "@codemirror/view";
import {
  createLiveEditorExtensions,
  lineWrappingCompartment,
} from "../editor/liveEditorExtensions";
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
import { normalizeDocumentText } from "../shared/documentChangeMapping";
import {
  ClipboardCopyMode,
  ClipboardPasteMode,
} from "../shared/clipboardModel";
import {
  installDocumentClipboard,
  syncDocumentRangeSelection,
} from "../editor/documentClipboard";
import {
  clearDocumentSelectionProjection,
  documentSelectionProjectionTransaction,
} from "../editor/documentSelectionState";
import {
  clearPendingClipboardCut,
  getPendingClipboardCut,
} from "../editor/clipboardCutState";
import { setPendingCutToken } from "../editor/table/tableRangeSelection";

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
  editorOptions?: unknown;
}

interface HostSetEditorOptionsMessage {
  type: "setEditorOptions";
  editorOptions: EditorOptions;
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

interface PendingEditorComposition {
  changes: ChangeSet;
  beforeText: string;
  beforeAnchor: number;
}

interface DeferredHostDocumentDuringEditorComposition {
  text: string;
  source: string;
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
  clipboardDocumentToken: string;
  defaultCopyMode: ClipboardCopyMode;
  defaultPasteMode: ClipboardPasteMode;
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
let editorCompositionActive = false;
let pendingEditorComposition: PendingEditorComposition | null = null;
let editorCompositionFlushTimer: number | null = null;
let deferredHostDocumentDuringEditorComposition:
  | DeferredHostDocumentDuringEditorComposition
  | null = null;
const pendingEditorCommandsAfterComposition: EditorCommandMessage["command"][] =
  [];
let editorOptions = readEditorOptions();
const pendingWebviewEchoes: { id: number; text: string }[] = [];
const pendingHostUndoFocusStack: PendingHostUndoFocus[] = [];
const MAX_PENDING_HOST_UNDO_FOCUS = 200;

try {
  const editorExtensions = createLiveEditorExtensions(editorOptions);
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
          if (
            update.docChanged &&
            getPendingClipboardCut(update.view.dom.ownerDocument)
          ) {
            clearPendingClipboardCut(update.view.dom.ownerDocument);
            setPendingCutToken(update.view.dom.ownerDocument, undefined);
            update.view.dom.classList.remove("mlrt-document-cut-pending");
          }
          const projectionAuthoredSelection = update.transactions.some(
            (transaction) =>
              transaction.annotation(documentSelectionProjectionTransaction) ===
              true,
          );
          if (
            update.docChanged ||
            (update.selectionSet && !projectionAuthoredSelection)
          ) {
            clearDocumentSelectionProjection(update.view.dom.ownerDocument);
          }
          if (
            update.selectionSet ||
            update.focusChanged ||
            update.docChanged ||
            update.viewportChanged
          ) {
            syncDocumentRangeSelection(
              update.view,
              update.viewportChanged &&
                !update.selectionSet &&
                !update.focusChanged &&
                !update.docChanged,
            );
          }
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
            publishEditorDocumentUpdate(update);
          }
        }),
      ],
    }),
  });
  window.__MLRT_EDITOR_VIEW__ = view;
  installEditorCompositionBatching(view);
  applyClipboardOptions(editorOptions);
  updateStatus(initialDocument, "embedded");
  installEditorCommandBridge(app);
  installDocumentClipboard(app, view);
  syncDocumentRangeSelection(view);
  installCursorDebugListeners(app);
  view.dom.addEventListener("mlrt:open-clipboard-settings", () => {
    vscode.postMessage({ type: "openClipboardSettings" });
  });
} catch (error) {
  app.replaceChildren(renderStartupError(error));
  throw error;
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = event.data;
  if (isHostSetEditorOptionsMessage(message)) {
    updateEditorOptions(message.editorOptions);
    return;
  }
  if (!isHostSetDocumentMessage(message)) {
    return;
  }

  hostRevision = message.revision;
  debugEnabled = message.debug;
  if (isEditorOptions(message.editorOptions)) {
    updateEditorOptions(message.editorOptions);
  }
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
  const source = `host revision ${message.revision}`;
  if (reconcileEditorCompositionWithHostDocument(message.text, source)) {
    return;
  }
  setEditorDocument(message.text, source);
});

vscode.postMessage({ type: "ready" });

function setEditorDocument(
  text: string,
  source: string,
  restorePendingUndoFocus = true,
): void {
  const currentText = view.state.doc.toString();
  updateStatus(text, source);
  if (text === currentText) {
    return;
  }

  const undoFocus = restorePendingUndoFocus
    ? popPendingHostUndoFocus(text)
    : null;
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
 * VS Code owns the document and dirty state for the custom text editor, so
 * undo/redo must go through the extension host. Keeping source text undo local
 * to CodeMirror would restore the visible text while leaving VS Code's undo
 * stack with the original apply and inverse apply as separate dirty edits.
 */
function dispatchUndoRedo(command: EditorCommandMessage["command"]): void {
  if (editorCompositionActive || view.compositionStarted) {
    pendingEditorCommandsAfterComposition.push(command);
    recordDebug("defer-editor-command-for-composition", {
      command,
      editorCompositionActive,
      codeMirrorCompositionStarted: view.compositionStarted,
      pendingCommandCount: pendingEditorCommandsAfterComposition.length,
    });
    scheduleEditorCompositionFlush();
    return;
  }

  // compositionend and the following keyboard/beforeinput event are separate
  // browser tasks. Do not let the timer leave VS Code unaware of the composed
  // edit when an immediate undo/redo command reaches the host. Webview messages
  // retain order, so posting the change synchronously here guarantees that the
  // extension host applies it before executing the command.
  cancelEditorCompositionFlush();
  flushEditorComposition();
  // A command may already be waiting from an earlier event that arrived while
  // the composition was still active. Cancelling the scheduled flush above
  // must not strand that command or let this newer command overtake it.
  flushPendingEditorCommandsAfterComposition();
  postEditorCommand(command);
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
  if (normalizeDocumentText(acknowledged.text) !== normalizeDocumentText(text)) {
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
  const defaults: EditorOptions = {
    lineWrapping: true,
    clipboardDocumentToken: createClipboardDocumentToken(),
    defaultCopyMode: "smart",
    defaultPasteMode: "auto",
  };
  if (!options || typeof options !== "object") {
    return defaults;
  }
  const optionRecord = options as Record<string, unknown>;

  return normalizeEditorOptions(
    {
      lineWrapping:
        typeof optionRecord.lineWrapping === "boolean"
          ? optionRecord.lineWrapping
          : true,
      clipboardDocumentToken: optionRecord.clipboardDocumentToken,
      defaultCopyMode: optionRecord.defaultCopyMode,
      defaultPasteMode: optionRecord.defaultPasteMode,
    },
    defaults,
  );
}

function normalizeEditorOptions(
  value: unknown,
  fallback: EditorOptions,
): EditorOptions {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const defaultCopyMode = record.defaultCopyMode;
  const defaultPasteMode = record.defaultPasteMode;
  return {
    lineWrapping:
      typeof record.lineWrapping === "boolean"
        ? record.lineWrapping
        : fallback.lineWrapping,
    clipboardDocumentToken:
      typeof record.clipboardDocumentToken === "string" &&
      record.clipboardDocumentToken.length > 0
        ? record.clipboardDocumentToken
        : fallback.clipboardDocumentToken,
    defaultCopyMode:
      defaultCopyMode === "smart" ||
      defaultCopyMode === "rich" ||
      defaultCopyMode === "plain" ||
      defaultCopyMode === "markdown"
        ? defaultCopyMode
        : fallback.defaultCopyMode,
    defaultPasteMode:
      defaultPasteMode === "auto" ||
      defaultPasteMode === "rich" ||
      defaultPasteMode === "plain" ||
      defaultPasteMode === "markdown"
        ? defaultPasteMode
        : fallback.defaultPasteMode,
  };
}

function applyClipboardOptions(options: EditorOptions): void {
  const root = document.documentElement;
  root.dataset.mlrtDocumentToken = options.clipboardDocumentToken;
  root.dataset.mlrtDefaultCopyMode = options.defaultCopyMode;
  root.dataset.mlrtDefaultPasteMode = options.defaultPasteMode;
}

function updateEditorOptions(value: unknown): void {
  const nextOptions = normalizeEditorOptions(value, editorOptions);
  const lineWrappingChanged =
    nextOptions.lineWrapping !== editorOptions.lineWrapping;
  editorOptions = nextOptions;
  applyClipboardOptions(editorOptions);
  if (lineWrappingChanged) {
    view.dispatch({
      effects: lineWrappingCompartment.reconfigure(
        editorOptions.lineWrapping ? EditorView.lineWrapping : [],
      ),
    });
  }
}

function createClipboardDocumentToken(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Candidate updates in one IME composition are provisional. Publishing each
 * one as a separate WorkspaceEdit makes VS Code undo only the last candidate
 * and leaves the original mixed selection deleted. Compose those CodeMirror
 * changes locally and send the host one final source edit on compositionend.
 */
function installEditorCompositionBatching(editorView: EditorView): void {
  const belongsToSourceEditor = (event: CompositionEvent): boolean =>
    event.target instanceof Node &&
    !findCell(event.target) &&
    editorView.contentDOM.contains(event.target);

  editorView.contentDOM.addEventListener(
    "compositionstart",
    (event) => {
      if (!belongsToSourceEditor(event)) {
        return;
      }
      editorCompositionActive = true;
      cancelEditorCompositionFlush();
    },
    true,
  );
  editorView.contentDOM.addEventListener(
    "compositionend",
    (event) => {
      if (!belongsToSourceEditor(event)) {
        return;
      }
      editorCompositionActive = false;
      scheduleEditorCompositionFlush();
    },
    true,
  );
}

function publishEditorDocumentUpdate(update: ViewUpdate): void {
  if (deferredHostDocumentDuringEditorComposition) {
    // An authoritative host update arrived while the browser still owned a
    // source-editor composition. Chromium can emit one final candidate update
    // after that host document has been applied. Never publish that candidate
    // against the new host revision; the authoritative text is replayed once
    // composition has actually ended.
    lastTableCellCommit = null;
    recordDebug("discard-editor-update-after-host-composition-conflict", {
      editorCompositionActive,
      codeMirrorCompositionStarted: update.view.compositionStarted,
      documentLength: update.state.doc.length,
    });
    if (!editorCompositionActive && !update.view.compositionStarted) {
      scheduleEditorCompositionFlush();
    }
    return;
  }

  const commitSequence = getTableCellCommitSequence(update);
  const shouldBatchComposition =
    !commitSequence &&
    (editorCompositionActive ||
      update.view.compositionStarted ||
      pendingEditorComposition !== null);

  if (shouldBatchComposition) {
    if (pendingEditorComposition) {
      pendingEditorComposition.changes =
        pendingEditorComposition.changes.compose(update.changes);
    } else {
      pendingEditorComposition = {
        changes: update.changes,
        beforeText: update.startState.doc.toString(),
        beforeAnchor: update.startState.selection.main.head,
      };
    }
    lastTableCellCommit = null;
    if (!editorCompositionActive && !update.view.compositionStarted) {
      scheduleEditorCompositionFlush();
    }
    return;
  }

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

function scheduleEditorCompositionFlush(): void {
  cancelEditorCompositionFlush();
  editorCompositionFlushTimer = window.setTimeout(() => {
    editorCompositionFlushTimer = null;
    if (editorCompositionActive || view.compositionStarted) {
      scheduleEditorCompositionFlush();
      return;
    }
    flushEditorComposition();
    flushPendingEditorCommandsAfterComposition();
  }, 10);
}

function cancelEditorCompositionFlush(): void {
  if (editorCompositionFlushTimer === null) {
    return;
  }
  window.clearTimeout(editorCompositionFlushTimer);
  editorCompositionFlushTimer = null;
}

function flushEditorComposition(): void {
  const deferredHostDocument =
    deferredHostDocumentDuringEditorComposition;
  if (deferredHostDocument) {
    deferredHostDocumentDuringEditorComposition = null;
    pendingEditorComposition = null;
    recordDebug("reapply-host-document-after-canceled-composition", {
      source: deferredHostDocument.source,
      documentLength: deferredHostDocument.text.length,
    });
    setEditorDocument(
      deferredHostDocument.text,
      `${deferredHostDocument.source} after canceled composition`,
      false,
    );
    return;
  }

  const composition = pendingEditorComposition;
  pendingEditorComposition = null;
  if (!composition) {
    return;
  }
  const finalText = view.state.doc.toString();
  const changes = validateOrRebuildEditorCompositionChanges(
    composition,
    finalText,
  );
  if (changes.empty) {
    return;
  }
  pushPendingHostUndoFocus({
    beforeText: composition.beforeText,
    restore: {
      kind: "editor",
      anchor: composition.beforeAnchor,
    },
  });
  postDocumentChanges(changes, finalText);
}

function flushPendingEditorCommandsAfterComposition(): void {
  if (pendingEditorCommandsAfterComposition.length === 0) {
    return;
  }

  const commands = pendingEditorCommandsAfterComposition.splice(0);
  for (const command of commands) {
    postEditorCommand(command);
  }
}

function validateOrRebuildEditorCompositionChanges(
  composition: PendingEditorComposition,
  finalText: string,
): ChangeSet {
  let composedText: string | null = null;
  try {
    const baseDocument = EditorState.create({
      doc: composition.beforeText,
    }).doc;
    composedText = composition.changes.apply(baseDocument).toString();
  } catch (error) {
    recordDebug("invalid-editor-composition-changes", {
      error: String(error),
      beforeTextLength: composition.beforeText.length,
      finalTextLength: finalText.length,
    });
  }

  if (composedText === finalText) {
    return composition.changes;
  }

  // This is a defensive recovery for an unexpected transaction interleaving.
  // The before snapshot is the host's known base, so a minimal replacement
  // from that snapshot to the final local text remains safe and preserves the
  // single host undo step without sending stale composed coordinates.
  const replacement = computeMinimalTextChange(
    composition.beforeText,
    finalText,
  );
  recordDebug("rebuild-editor-composition-changes", {
    beforeTextLength: composition.beforeText.length,
    composedTextLength: composedText?.length,
    finalTextLength: finalText.length,
    replacementFrom: replacement.from,
    replacementTo: replacement.to,
    replacementInsertLength: replacement.insert.length,
  });
  return ChangeSet.of(replacement, composition.beforeText.length);
}

/**
 * Reconcile an authoritative host document with a source-editor composition.
 * Returning true means the message was completely handled here.
 */
function reconcileEditorCompositionWithHostDocument(
  text: string,
  source: string,
): boolean {
  const composition = pendingEditorComposition;
  const compositionInProgress =
    editorCompositionActive || view.compositionStarted;
  const currentText = view.state.doc.toString();

  if (
    !composition &&
    !compositionInProgress &&
    !deferredHostDocumentDuringEditorComposition
  ) {
    return false;
  }

  if (
    !deferredHostDocumentDuringEditorComposition &&
    composition &&
    text === composition.beforeText
  ) {
    // The host confirms the exact document on which this ChangeSet is based.
    // Keep the provisional candidate visible and publish it after the browser
    // finishes composition, now using the newly received host revision.
    updateStatus(currentText, `${source} confirmed composition base`);
    recordDebug("host-confirmed-editor-composition-base", {
      source,
      editorCompositionActive,
      codeMirrorCompositionStarted: view.compositionStarted,
      beforeTextLength: composition.beforeText.length,
      currentTextLength: currentText.length,
    });
    return true;
  }

  if (
    !deferredHostDocumentDuringEditorComposition &&
    composition &&
    text === currentText
  ) {
    // The host already contains the final candidate. Settle the local batch
    // without posting it a second time, while retaining the focus target for a
    // later host-owned undo.
    cancelEditorCompositionFlush();
    pendingEditorComposition = null;
    pushPendingHostUndoFocus({
      beforeText: composition.beforeText,
      restore: {
        kind: "editor",
        anchor: composition.beforeAnchor,
      },
    });
    updateStatus(text, `${source} settled composition`);
    recordDebug("host-settled-editor-composition", {
      source,
      editorCompositionActive,
      codeMirrorCompositionStarted: view.compositionStarted,
      documentLength: text.length,
    });
    if (!compositionInProgress) {
      flushPendingEditorCommandsAfterComposition();
    }
    return true;
  }

  if (
    !deferredHostDocumentDuringEditorComposition &&
    !composition &&
    text === currentText
  ) {
    // A no-op host message during composition does not invalidate the browser's
    // in-progress range. Let the ordinary host path update status and return.
    return false;
  }

  // The host moved to a different document while this batch still referenced
  // its old base. The host is authoritative: cancel the batch immediately. Do
  // not dispatch into CodeMirror while Chromium still owns the composition --
  // that can strand CodeMirror in its composing state. Instead, retain the
  // latest authoritative text, suppress trailing candidate updates, and apply
  // the host document only after compositionend.
  cancelEditorCompositionFlush();
  pendingEditorComposition = null;
  lastTableCellCommit = null;
  deferredHostDocumentDuringEditorComposition = compositionInProgress
    ? { text, source }
    : null;
  recordDebug("cancel-editor-composition-for-host-document", {
    source,
    editorCompositionActive,
    codeMirrorCompositionStarted: view.compositionStarted,
    beforeTextLength: composition?.beforeText.length,
    currentTextLength: currentText.length,
    hostTextLength: text.length,
    deferredReplay: compositionInProgress,
  });
  if (compositionInProgress) {
    scheduleEditorCompositionFlush();
  } else {
    setEditorDocument(text, source);
    flushPendingEditorCommandsAfterComposition();
  }
  return true;
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

function isHostSetEditorOptionsMessage(
  message: unknown,
): message is HostSetEditorOptionsMessage {
  if (!message || typeof message !== "object") {
    return false;
  }
  const record = message as Record<string, unknown>;
  return (
    record.type === "setEditorOptions" && isEditorOptions(record.editorOptions)
  );
}

function isEditorOptions(value: unknown): value is EditorOptions {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.lineWrapping === "boolean" &&
    typeof record.clipboardDocumentToken === "string" &&
    record.clipboardDocumentToken.length > 0 &&
    (record.defaultCopyMode === "smart" ||
      record.defaultCopyMode === "rich" ||
      record.defaultCopyMode === "plain" ||
      record.defaultCopyMode === "markdown") &&
    (record.defaultPasteMode === "auto" ||
      record.defaultPasteMode === "rich" ||
      record.defaultPasteMode === "plain" ||
      record.defaultPasteMode === "markdown")
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
