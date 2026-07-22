import { isolateHistory } from "@codemirror/commands";
import { EditorSelection, Extension, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import {
  ClipboardCopyMode,
  ClipboardDocumentPayload,
  ClipboardGridPayload,
  ClipboardPasteMode,
  buildGridClearEdit,
  importedMarkdownToTableCellSource,
  gridToMarkdown,
  MLRT_CLIPBOARD_MIME,
  MLRT_CLIPBOARD_VERSION,
  MlrtClipboardPayload,
  parseClipboardPayload,
  serializeDelimitedGrid,
  tableRectanglePayload,
} from "../shared/clipboardModel";
import {
  getParsedTables,
  markdownCellToDisplayText,
  parseMarkdownTables,
} from "../shared/tableModel";
import { allowTableSourceChange } from "../shared/tableSourceProtection";
import { editorDragPosition } from "./dragPosition";
import {
  clearDocumentSelectionProjection,
  documentSelectionProjectionsEqual,
  documentSelectionProjectionTransaction,
  DocumentSelectionProjection,
  DocumentTableSelectionRegion,
  fullTableRectangle,
  getDocumentSelectionProjection,
  proseToTableRectangle,
  setDocumentSelectionProjection,
} from "./documentSelectionState";
import {
  clearPendingClipboardCut,
  getPendingClipboardCut,
  PendingCompositeCut,
  PendingTableCut,
  setPendingClipboardCut,
} from "./clipboardCutState";
import { findCell } from "./table/cellSelection";
import {
  addressFromCell,
  clearTableRangeSelection,
  getTableRangeSelection,
  setPendingCutToken,
} from "./table/tableRangeSelection";
import { syncTableSelectionOverlay } from "./table/tableSelectionOverlay";

interface ClipboardReadData {
  privatePayload?: string;
  html?: string;
  markdown?: string;
  plain?: string;
}

const markdownRenderer = new MarkdownIt({
  html: false,
  linkify: false,
  breaks: false,
});
const richMarkdownRenderer = new MarkdownIt({
  html: true,
  linkify: false,
  breaks: true,
});
const turndown = new TurndownService({
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  strongDelimiter: "**",
});
turndown.use(gfm);

let armedDocumentPasteMode: ClipboardPasteMode | null = null;
let requestedDocumentCopyMode: ClipboardCopyMode | null = null;
const documentMenuClosers = new WeakMap<Document, () => void>();

/**
 * Route normalized CodeMirror text input through the spatial mixed-selection
 * model. Reading the default transaction preserves CodeMirror's exact input
 * user event (including composition start), while returning true prevents the
 * raw hidden table-source envelope from also being replaced.
 */
export function createDocumentSelectionInputHandler(): Extension {
  return EditorView.inputHandler.of((view, _from, _to, text, insert) => {
    const projection = getDocumentSelectionProjection(
      view.dom.ownerDocument,
      view.state.selection.main,
    );
    if (!projection) {
      return false;
    }
    const userEvent =
      insert().annotation(Transaction.userEvent) ?? "input.type";
    return dispatchCompositeSelectionReplacement(
      view,
      projection,
      text,
      userEvent,
    );
  });
}

export function installDocumentClipboard(
  root: HTMLElement,
  view: EditorView,
): () => void {
  const doc = root.ownerDocument;
  let mixedDragAnchor: number | null = null;
  let mixedDragRange: { anchor: number; head: number } | null = null;
  let mixedDragProjection: DocumentSelectionProjection | null = null;
  let mixedDragActive = false;
  let mixedDragPointerId: number | null = null;
  let mixedDragOwnsPointerCapture = false;
  let mixedDragGeneration = 0;
  let mixedDragCleanupTimer: ReturnType<typeof setTimeout> | null = null;
  let mixedDragDocument: EditorView["state"]["doc"] | null = null;
  let documentClipboardDisposed = false;

  const onCopy = (event: ClipboardEvent): void => {
    if (
      event.defaultPrevented ||
      getTableRangeSelection(doc) ||
      findCell(event.target)
    ) {
      return;
    }
    const projection = getDocumentSelectionProjection(
      doc,
      view.state.selection.main,
    );
    const range = atomicDocumentSelection(view);
    if ((!range && !projection) || !event.clipboardData) {
      return;
    }
    const requestedMode = requestedDocumentCopyMode;
    const mode = requestedMode ?? readCopyMode(doc);
    requestedDocumentCopyMode = null;
    event.preventDefault();
    const representations = projection
      ? documentRepresentationsForMarkdown(
          view,
          compositeSelectionMarkdown(view, projection),
          mode,
        )
      : documentRepresentations(view, range!.from, range!.to, mode);
    writeDocumentTransfer(event.clipboardData, representations);
    clearPendingClipboardCut(doc);
    setPendingCutToken(doc, undefined);
    view.dom.classList.remove("mlrt-document-cut-pending");
    announce(
      doc,
      requestedMode
        ? `Copied as ${capitalize(requestedMode)}.`
        : "Copied document selection.",
    );
  };

  const onCut = (event: ClipboardEvent): void => {
    if (
      event.defaultPrevented ||
      getTableRangeSelection(doc) ||
      findCell(event.target)
    ) {
      return;
    }
    const projection = getDocumentSelectionProjection(
      doc,
      view.state.selection.main,
    );
    const range = atomicDocumentSelection(view);
    if ((!range && !projection) || !event.clipboardData) {
      return;
    }
    const token = createToken();
    const markdown = projection
      ? compositeSelectionMarkdown(view, projection)
      : view.state.doc.sliceString(range!.from, range!.to);
    const payload: ClipboardDocumentPayload = {
      version: MLRT_CLIPBOARD_VERSION,
      kind: "document",
      sourceDocument: readDocumentToken(doc),
      markdown,
      cutToken: token,
    };
    event.preventDefault();
    writeDocumentTransfer(
      event.clipboardData,
      projection
        ? documentRepresentationsForMarkdown(
            view,
            markdown,
            readCopyMode(doc),
            payload,
          )
        : documentRepresentations(
            view,
            range!.from,
            range!.to,
            readCopyMode(doc),
            payload,
          ),
    );
    setPendingClipboardCut(
      doc,
      projection
        ? {
            kind: "composite",
            token,
            sourceDocument: readDocumentToken(doc),
            sourceDocumentText: view.state.doc.toString(),
            markdown,
            changes: compositeSelectionChanges(view, projection),
          }
        : {
            kind: "document",
            token,
            sourceDocument: readDocumentToken(doc),
            from: range!.from,
            to: range!.to,
            markdown,
          },
    );
    view.dom.classList.add("mlrt-document-cut-pending");
    announce(
      doc,
      "Move pending. Paste in this document to move; external paste copies.",
    );
  };

  const onPaste = (event: ClipboardEvent): void => {
    if (
      event.defaultPrevented ||
      getTableRangeSelection(doc) ||
      findCell(event.target) ||
      !event.clipboardData
    ) {
      return;
    }
    const mode = armedDocumentPasteMode ?? readPasteMode(doc);
    armedDocumentPasteMode = null;
    const data = readTransfer(event.clipboardData);
    const markdown = documentPasteMarkdown(data, mode);
    if (markdown === null) {
      if (atomicDocumentSelection(view)) {
        event.preventDefault();
        event.stopPropagation();
        announce(doc, "Clipboard does not contain pasteable text.");
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (applyDocumentPaste(view, markdown, data)) {
      announce(doc, "Pasted document content.");
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && getPendingClipboardCut(doc)) {
      clearPendingClipboardCut(doc);
      setPendingCutToken(doc, undefined);
      view.dom.classList.remove("mlrt-document-cut-pending");
      announce(doc, "Pending move cancelled.");
      return;
    }
    if (
      (event.key === "Backspace" || event.key === "Delete") &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      const selected = view.state.selection.main;
      const projection = getDocumentSelectionProjection(doc, selected);
      if (projection) {
        event.preventDefault();
        event.stopPropagation();
        applyCompositeSelectionDelete(view, projection);
        return;
      }
      const range = atomicDocumentSelection(view);
      const touchesTable = !selected.empty && getParsedTables(view.state.doc).some(
        (table) => selected.from < table.to && selected.to > table.from,
      );
      if (range && touchesTable) {
        event.preventDefault();
        event.stopPropagation();
        view.dispatch({
          changes: { from: range.from, to: range.to, insert: "" },
          selection: EditorSelection.cursor(range.from, 1),
          annotations: [
            allowTableSourceChange.of(true),
            Transaction.addToHistory.of(true),
          ],
          userEvent: "delete.selection",
        });
      }
    }
  };

  const onContextMenu = (event: MouseEvent): void => {
    if (
      !root.contains(event.target as Node) ||
      !shouldPreserveContextSelection(event)
    ) {
      return;
    }
    const range = atomicDocumentSelection(view);
    if (!range) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    showDocumentMenu(doc, view, event.clientX, event.clientY);
  };

  const shouldPreserveContextSelection = (event: MouseEvent): boolean => {
    const range = view.state.selection.main;
    if (range.empty) {
      return false;
    }
    const cell = findCell(event.target);
    if (cell) {
      // A partial spatial projection can share one hidden-source envelope
      // with unselected cells. Cell hit testing must follow what is painted,
      // not the atomic CodeMirror range behind the widget.
      return cell.classList.contains("mlrt-document-range-selected");
    }
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
    return position !== null && position >= range.from && position <= range.to;
  };

  const onRootPointerDown = (event: PointerEvent): void => {
    if (mixedDragPointerId !== null) {
      // Pointer capture normally guarantees a matching release. If ownership
      // was lost without a release (for example, the iframe blurred), let any
      // new primary gesture replace it. A stale capture flag must not make the
      // editor drop the replacement pointerdown.
      if (!event.isPrimary) {
        return;
      }
      finishMixedDrag(true);
    }
    if (event.button === 2) {
      if (shouldPreserveContextSelection(event)) {
        event.preventDefault();
      }
      return;
    }
    if (
      event.button !== 0 ||
      findCell(event.target) ||
      (event.target instanceof Element &&
        Boolean(event.target.closest(".mlrt-table-widget")))
    ) {
      return;
    }
    // Gutter, blank-line, end-of-line margin, and block-widget boundary
    // coordinates may be outside CodeMirror's text hit boxes even though the
    // gesture begins inside the editor. Resolve them through the same
    // content-edge clamping used while dragging.
    const anchor = editorDragPosition(view, event.clientX, event.clientY);
    if (anchor === null) {
      return;
    }
    mixedDragAnchor = anchor;
    mixedDragRange = null;
    mixedDragProjection = null;
    mixedDragActive = false;
    mixedDragPointerId = event.pointerId;
    mixedDragOwnsPointerCapture = false;
    mixedDragGeneration += 1;
    mixedDragDocument = view.state.doc;
    root.classList.add("mlrt-document-drag-pending");
    clearDocumentSelectionProjection(doc);
    doc.addEventListener("pointermove", onMixedPointerMove, true);
    doc.addEventListener("pointerup", onMixedPointerUp, true);
    doc.addEventListener("pointercancel", onMixedPointerUp, true);
    doc.addEventListener("mousemove", onMixedMouseMove, true);
    doc.addEventListener("mouseup", onMixedMouseUp, true);
    doc.addEventListener("click", onMixedClick, true);
  };

  const onRootMouseDown = (event: MouseEvent): void => {
    if (event.button === 2 && shouldPreserveContextSelection(event)) {
      event.preventDefault();
    }
  };

  const updateMixedDrag = (event: PointerEvent | MouseEvent): void => {
    if (
      mixedDragAnchor === null ||
      (event.buttons & 1) === 0 ||
      ("pointerId" in event &&
        mixedDragPointerId !== null &&
        event.pointerId !== mixedDragPointerId)
    ) {
      return;
    }
    if (mixedDragDocument !== view.state.doc) {
      // Host updates can replace the document while a pointer is down. The
      // stored anchor and table spans belong to the old Text snapshot.
      finishMixedDrag(false, mixedDragGeneration);
      clearDocumentSelectionProjection(doc);
      return;
    }
    const target = documentSelectionTargetAtPoint(
      doc,
      event.clientX,
      event.clientY,
    );
    const cell = target?.cell ?? null;
    if (!cell) {
      if (!mixedDragActive) {
        return;
      }
      const head = editorDragPosition(view, event.clientX, event.clientY);
      if (head === null) {
        return;
      }
      const nextRange = { anchor: mixedDragAnchor, head };
      const tableRegions = fullRegionsForEnvelope(
        getParsedTables(view.state.doc),
        nextRange.anchor,
        nextRange.head,
      );
      const nextProjection = tableRegions.length > 0
        ? {
            ...nextRange,
            tableRegions,
          }
        : null;
      event.preventDefault();
      event.stopPropagation();
      if (!view.hasFocus) {
        // Focus before publishing the custom range. Focusing after a mixed
        // drag makes CodeMirror reconcile the collapsed DOM selection and can
        // discard the spatial projection before the next text/IME input.
        view.focus();
      }
      doc.defaultView?.getSelection()?.removeAllRanges();
      publishMixedDragSelection(nextRange, nextProjection);
      return;
    }
    const tableFrom = Number(cell.dataset.tableFrom ?? "NaN");
    if (!Number.isFinite(tableFrom)) {
      return;
    }
    const table = getParsedTables(view.state.doc).find(
      (candidate) => candidate.from === tableFrom,
    );
    if (!table) {
      return;
    }
    const span = renderedCellSourceSpan(cell, table);
    const rawAddress = addressFromCell(cell);
    const movingForward = mixedDragAnchor <= table.from;
    const address =
      rawAddress && target?.rowSelection
        ? {
            row: rawAddress.row,
            column: movingForward ? table.columnCount - 1 : 0,
          }
        : rawAddress;
    if (!span || !address) {
      return;
    }
    const nextRange = {
      anchor: mixedDragAnchor,
      head: movingForward ? span.to : span.from,
    };
    const nextProjection = {
      ...nextRange,
      tableRegions: regionsForProseToCell(
        getParsedTables(view.state.doc),
        mixedDragAnchor,
        table,
        address,
        movingForward ? "forward" : "backward",
      ),
    };
    mixedDragActive = true;
    if (
      mixedDragPointerId !== null &&
      !root.hasPointerCapture(mixedDragPointerId)
    ) {
      try {
        // Capture only after the drag crosses into a rendered table. Capturing
        // the initial prose gesture would steal pure-text dragging from CM.
        root.setPointerCapture(mixedDragPointerId);
        mixedDragOwnsPointerCapture = root.hasPointerCapture(
          mixedDragPointerId,
        );
      } catch {
        // Synthetic pointer events may not have an active platform pointer.
        // Document listeners and blur cleanup still provide safe ownership.
      }
    }
    event.preventDefault();
    event.stopPropagation();
    if (!view.hasFocus) {
      // The drag may have started while a rendered cell or workbench control
      // owned focus. Establish editor focus before the projected selection so
      // subsequent normalized input replaces the selection atomically.
      view.focus();
    }
    doc.defaultView?.getSelection()?.removeAllRanges();
    publishMixedDragSelection(nextRange, nextProjection);
  };

  const publishMixedDragSelection = (
    range: { anchor: number; head: number },
    projection: DocumentSelectionProjection | null,
  ): void => {
    const currentRange = view.state.selection.main;
    const currentProjection = getDocumentSelectionProjection(
      doc,
      currentRange,
    );
    const rangeChanged =
      currentRange.anchor !== range.anchor || currentRange.head !== range.head;
    const projectionChanged = !documentSelectionProjectionsEqual(
      currentProjection,
      projection,
    );
    mixedDragRange = range;
    mixedDragProjection = projection;
    if (projection) {
      setDocumentSelectionProjection(doc, projection);
    } else {
      // Once a drag returns to prose on its original side it is an ordinary
      // linear selection again. Keeping an empty projection would make
      // delete/cut trim newlines differently from what copy displays.
      clearDocumentSelectionProjection(doc);
    }
    if (!rangeChanged && !projectionChanged) {
      return;
    }
    view.dispatch({
      selection: EditorSelection.range(range.anchor, range.head),
      scrollIntoView: true,
      ...(projection
        ? {
            annotations: documentSelectionProjectionTransaction.of(true),
          }
        : {}),
    });
  };

  const onMixedPointerMove = (event: PointerEvent): void => {
    if (
      mixedDragPointerId !== null &&
      event.pointerId === mixedDragPointerId &&
      (event.buttons & 1) === 0
    ) {
      // A release outside the webview is not guaranteed to send pointerup
      // back into this document. The first hover move after re-entry is the
      // reliable proof that the physical gesture ended.
      finishMixedDrag(true, mixedDragGeneration);
      return;
    }
    if (
      mixedDragOwnsPointerCapture &&
      mixedDragPointerId !== null &&
      !root.hasPointerCapture(mixedDragPointerId)
    ) {
      // Crossing the webview boundary can release capture while the mouse
      // button is still held. Keep the gesture latched so a rapid re-entry
      // continues the source-backed selection instead of falling through to
      // Chromium's DOM-order selection.
      mixedDragOwnsPointerCapture = false;
    }
    updateMixedDrag(event);
  };

  const onMixedMouseMove = (event: MouseEvent): void => {
    if (mixedDragPointerId !== null && (event.buttons & 1) === 0) {
      // Compatibility mouse events also expose a release that happened while
      // the pointer was outside the embedded document.
      finishMixedDrag(true, mixedDragGeneration);
      return;
    }
    // The PointerEvent can scroll the editor to keep its head visible before
    // Chromium emits this compatibility event. Re-evaluate the same client
    // point against the settled layout; publishMixedDragSelection suppresses
    // the second paint when its range and projection are unchanged.
    updateMixedDrag(event);
    if (mixedDragActive) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const restoreMixedDrag = (expectedGeneration: number): void => {
    if (expectedGeneration !== mixedDragGeneration) {
      return;
    }
    if (!mixedDragRange) {
      return;
    }
    restoreMixedDragRange(
      mixedDragRange,
      mixedDragProjection,
      mixedDragDocument,
    );
  };

  const restoreMixedDragRange = (
    range: { anchor: number; head: number },
    projection: DocumentSelectionProjection | null,
    documentSnapshot: EditorView["state"]["doc"] | null,
  ): void => {
    if (
      documentSnapshot !== null &&
      view.dom.isConnected &&
      view.dom.ownerDocument === doc &&
      view.state.doc !== documentSnapshot
    ) {
      clearDocumentSelectionProjection(doc);
      return;
    }
    if (
      documentClipboardDisposed ||
      !root.isConnected ||
      !view.dom.isConnected ||
      view.dom.ownerDocument !== doc ||
      documentSnapshot === null ||
      view.state.doc !== documentSnapshot
    ) {
      return;
    }
    const documentLength = view.state.doc.length;
    const clampedRange = {
      anchor: Math.max(0, Math.min(documentLength, range.anchor)),
      head: Math.max(0, Math.min(documentLength, range.head)),
    };
    const clampedProjection = projection
      ? { ...projection, ...clampedRange }
      : null;
    if (clampedProjection) {
      setDocumentSelectionProjection(doc, clampedProjection);
    }
    view.dispatch({
      selection: EditorSelection.range(
        clampedRange.anchor,
        clampedRange.head,
      ),
      ...(clampedProjection
        ? {
            annotations: documentSelectionProjectionTransaction.of(true),
          }
        : {}),
    });
  };

  const onMixedPointerUp = (event: PointerEvent): void => {
    if (
      mixedDragPointerId !== null &&
      event.pointerId !== mixedDragPointerId
    ) {
      return;
    }
    if (mixedDragActive) {
      event.preventDefault();
      event.stopPropagation();
    }
    const generation = mixedDragGeneration;
    queueMicrotask(() => restoreMixedDrag(generation));
    if (mixedDragCleanupTimer !== null) {
      clearTimeout(mixedDragCleanupTimer);
    }
    mixedDragCleanupTimer = setTimeout(() => {
      mixedDragCleanupTimer = null;
      finishMixedDrag(true, generation);
    }, 0);
  };

  const onMixedMouseUp = (event: MouseEvent): void => {
    if (mixedDragActive) {
      event.preventDefault();
      event.stopPropagation();
    }
    const generation = mixedDragGeneration;
    queueMicrotask(() => restoreMixedDrag(generation));
  };

  const onMixedClick = (event: MouseEvent): void => {
    if (!mixedDragActive) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const onLostPointerCapture = (event: PointerEvent): void => {
    if (
      !mixedDragOwnsPointerCapture ||
      event.pointerId !== mixedDragPointerId ||
      root.hasPointerCapture(event.pointerId)
    ) {
      return;
    }
    // Capture is an optimization, not the lifetime of the physical gesture.
    // The pointer can leave an iframe and re-enter with its primary button
    // still down. Document listeners plus the pending user-select guard keep
    // ownership until pointerup, a buttons=0 move, or a replacement gesture.
    mixedDragOwnsPointerCapture = false;
  };

  const onWindowBlur = (): void => {
    if (mixedDragPointerId === null) {
      return;
    }
    // Workbench excursions blur the webview even though the drag is still in
    // progress. Preserve both the source-backed range and native-selection
    // suppression so a quick return cannot paint browser-only table text.
    doc.defaultView?.getSelection()?.removeAllRanges();
    restoreMixedDrag(mixedDragGeneration);
  };

  const finishMixedDrag = (
    restoreFinalRange: boolean,
    expectedGeneration?: number,
  ): void => {
    if (
      expectedGeneration !== undefined &&
      expectedGeneration !== mixedDragGeneration
    ) {
      return;
    }
    if (mixedDragCleanupTimer !== null) {
      clearTimeout(mixedDragCleanupTimer);
      mixedDragCleanupTimer = null;
    }
    const finalRange = mixedDragRange;
    const finalProjection = mixedDragProjection;
    const finalDocument = mixedDragDocument;
    const pointerId = mixedDragPointerId;
    // Invalidate every deferred restore/cleanup created by this gesture before
    // releasing capture, which can synchronously emit lostpointercapture.
    mixedDragGeneration += 1;
    mixedDragPointerId = null;
    mixedDragOwnsPointerCapture = false;
    doc.removeEventListener("pointermove", onMixedPointerMove, true);
    doc.removeEventListener("pointerup", onMixedPointerUp, true);
    doc.removeEventListener("pointercancel", onMixedPointerUp, true);
    doc.removeEventListener("mousemove", onMixedMouseMove, true);
    doc.removeEventListener("mouseup", onMixedMouseUp, true);
    doc.removeEventListener("click", onMixedClick, true);
    mixedDragAnchor = null;
    mixedDragRange = null;
    mixedDragProjection = null;
    mixedDragActive = false;
    mixedDragDocument = null;
    root.classList.remove("mlrt-document-drag-pending");
    if (pointerId !== null && root.hasPointerCapture(pointerId)) {
      try {
        root.releasePointerCapture(pointerId);
      } catch {
        // The browser may already have released capture during teardown.
      }
    }
    if (restoreFinalRange && finalRange) {
      restoreMixedDragRange(finalRange, finalProjection, finalDocument);
    }
  };

  // Capture before CodeMirror's native clipboard handlers publish hidden raw
  // table source. Table-cell and rectangular operations are explicitly
  // ignored here and continue to their widget-level handlers.
  doc.addEventListener("copy", onCopy, true);
  doc.addEventListener("cut", onCut, true);
  doc.addEventListener("paste", onPaste, true);
  doc.addEventListener("keydown", onKeyDown);
  // Capture before a table's context menu so right-clicking a cell inside a
  // document selection preserves the document selection and its operations.
  root.addEventListener("contextmenu", onContextMenu, true);
  root.addEventListener("pointerdown", onRootPointerDown, true);
  root.addEventListener("lostpointercapture", onLostPointerCapture, true);
  root.addEventListener("mousedown", onRootMouseDown, true);
  doc.defaultView?.addEventListener("blur", onWindowBlur);
  return () => {
    documentClipboardDisposed = true;
    finishMixedDrag(false);
    doc.removeEventListener("copy", onCopy, true);
    doc.removeEventListener("cut", onCut, true);
    doc.removeEventListener("paste", onPaste, true);
    doc.removeEventListener("keydown", onKeyDown);
    root.removeEventListener("contextmenu", onContextMenu, true);
    root.removeEventListener("pointerdown", onRootPointerDown, true);
    root.removeEventListener("lostpointercapture", onLostPointerCapture, true);
    root.removeEventListener("mousedown", onRootMouseDown, true);
    doc.defaultView?.removeEventListener("blur", onWindowBlur);
  };
}

const documentSelectionSyncSignatures = new WeakMap<HTMLElement, string>();

export function syncDocumentRangeSelection(
  view: EditorView,
  hydrateNewWrappersOnly = false,
): void {
  const editorRange = view.state.selection.main;
  if (!editorRange.empty && getTableRangeSelection(view.dom.ownerDocument)) {
    clearTableRangeSelection(view.dom.ownerDocument);
  }
  const projection = getDocumentSelectionProjection(
    view.dom.ownerDocument,
    editorRange,
  );
  const range = editorRange;
  const tables = getParsedTables(view.state.doc);
  if (
    hydrateNewWrappersOnly &&
    range.empty &&
    !view.dom.ownerDocument.querySelector(".mlrt-document-range-selected")
  ) {
    return;
  }
  view.dom.ownerDocument
    .querySelectorAll<HTMLElement>(".mlrt-table-widget")
    .forEach((wrapper) => {
      const from = Number(wrapper.dataset.srcFrom ?? "-1");
      const table = tables.find((candidate) => candidate.from === from);
      const explicitRegion = projection?.tableRegions.find(
        (candidate) => candidate.tableFrom === from,
      );
      const fallbackRegion =
        table &&
        !range.empty &&
        range.from < table.to &&
        range.to > table.from
          ? {
              tableFrom: table.from,
              ...fullTableRectangle(tableDimensions(table)),
            }
          : null;
      const region = projection
        ? explicitRegion ?? null
        : fallbackRegion;
      const signature = [
        range.anchor,
        range.head,
        table?.from ?? -1,
        table?.to ?? -1,
        region?.top ?? -1,
        region?.bottom ?? -1,
        region?.left ?? -1,
        region?.right ?? -1,
      ].join(":");
      if (
        hydrateNewWrappersOnly &&
        documentSelectionSyncSignatures.get(wrapper) === signature
      ) {
        return;
      }
      const cells = Array.from(
        wrapper.querySelectorAll<HTMLElement>(".mlrt-table-cell"),
      );
      const selectedAddresses = new Set<string>();
      if (table && !range.empty && region) {
        cells.forEach((cell) => {
          const row = renderedCellRow(cell);
          const column = Number(cell.dataset.column ?? "0");
          if (
            row >= region.top &&
            row <= region.bottom &&
            column >= region.left &&
            column <= region.right
          ) {
            selectedAddresses.add(renderedCellAddressKey(cell));
          }
        });
      }
      wrapper.classList.toggle(
        "mlrt-document-selection-mode",
        selectedAddresses.size > 0,
      );
      cells.forEach((cell) => {
        const row = renderedCellRow(cell);
        const column = Number(cell.dataset.column ?? "0");
        const selected = selectedAddresses.has(renderedCellAddressKey(cell));
        cell.classList.toggle("mlrt-document-range-selected", selected);
        const tableSelected = cell.classList.contains("mlrt-table-cell-selected");
        const syncEdge = (className: string, edge: boolean): void => {
          if (selected) {
            cell.classList.toggle(className, edge);
          } else if (!tableSelected) {
            cell.classList.remove(className);
          }
        };
        syncEdge(
          "mlrt-table-selection-top",
          !selectedAddresses.has(`${row - 1}:${column}`),
        );
        syncEdge(
          "mlrt-table-selection-bottom",
          !selectedAddresses.has(`${row + 1}:${column}`),
        );
        syncEdge(
          "mlrt-table-selection-left",
          !selectedAddresses.has(`${row}:${column - 1}`),
        );
        syncEdge(
          "mlrt-table-selection-right",
          !selectedAddresses.has(`${row}:${column + 1}`),
        );
      });
      syncTableSelectionOverlay(wrapper);
      documentSelectionSyncSignatures.set(wrapper, signature);
    });
}

function tableDimensions(
  table: ReturnType<typeof getParsedTables>[number],
): { rowCount: number; columnCount: number } {
  return {
    rowCount: table.body.length + 1,
    columnCount: table.columnCount,
  };
}

function fullRegionsForEnvelope(
  tables: ReturnType<typeof getParsedTables>,
  anchor: number,
  head: number,
): DocumentTableSelectionRegion[] {
  const from = Math.min(anchor, head);
  const to = Math.max(anchor, head);
  return tables
    .filter((table) => from < table.to && to > table.from)
    .map((table) => ({
      tableFrom: table.from,
      ...fullTableRectangle(tableDimensions(table)),
    }));
}

function regionsForProseToCell(
  tables: ReturnType<typeof getParsedTables>,
  anchor: number,
  targetTable: ReturnType<typeof getParsedTables>[number],
  targetCell: { row: number; column: number },
  direction: "forward" | "backward",
): DocumentTableSelectionRegion[] {
  const regions = tables
    .filter((table) =>
      direction === "forward"
        ? table.from > anchor && table.from < targetTable.from
        : table.from < anchor && table.from > targetTable.from,
    )
    .map((table) => ({
      tableFrom: table.from,
      ...fullTableRectangle(tableDimensions(table)),
    }));
  regions.push({
    tableFrom: targetTable.from,
    ...proseToTableRectangle(
      direction,
      targetCell,
      tableDimensions(targetTable),
    ),
  });
  return regions;
}

/**
 * A horizontal excursion beside a table remains spatial table selection.
 * Clamp to the nearest rendered cell instead of asking CodeMirror to map the
 * point through hidden source lines (which can jump to 0/doc.length).
 */
function documentSelectionTargetAtPoint(
  doc: Document,
  clientX: number,
  clientY: number,
): { cell: HTMLElement; rowSelection: boolean } | null {
  const direct = findCell(doc.elementFromPoint(clientX, clientY));
  if (direct) {
    return { cell: direct, rowSelection: false };
  }
  const wrapper = Array.from(
    doc.querySelectorAll<HTMLElement>(".mlrt-table-widget"),
  ).find((candidate) => {
    const rect =
      candidate.querySelector<HTMLElement>(".mlrt-table")
        ?.getBoundingClientRect() ?? candidate.getBoundingClientRect();
    return clientY >= rect.top && clientY <= rect.bottom;
  });
  if (!wrapper) {
    return null;
  }
  const cells = Array.from(
    wrapper.querySelectorAll<HTMLElement>(".mlrt-table-cell"),
  );
  if (cells.length === 0) {
    return null;
  }
  const nearest = cells.reduce((nearest, candidate) => {
    const distance = distanceToRect(
      candidate.getBoundingClientRect(),
      clientX,
      clientY,
    );
    const nearestDistance = distanceToRect(
      nearest.getBoundingClientRect(),
      clientX,
      clientY,
    );
    return distance < nearestDistance ? candidate : nearest;
  });
  const sourceLine = Array.from(
    wrapper.querySelectorAll<HTMLElement>(".mlrt-table-source-line"),
  ).find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  });
  const rowCell = sourceLine?.parentElement?.querySelector<HTMLElement>(
    ".mlrt-table-cell",
  );
  return rowCell
    ? { cell: rowCell, rowSelection: true }
    : { cell: nearest, rowSelection: false };
}

function distanceToRect(
  rect: DOMRect,
  clientX: number,
  clientY: number,
): number {
  const dx = Math.max(rect.left - clientX, 0, clientX - rect.right);
  const dy = Math.max(rect.top - clientY, 0, clientY - rect.bottom);
  return dx * dx + dy * dy;
}

function renderedCellRow(cell: HTMLElement): number {
  return cell.dataset.rowKind === "header"
    ? 0
    : Number(cell.dataset.rowIndex ?? "0") + 1;
}

function renderedCellAddressKey(cell: HTMLElement): string {
  return `${renderedCellRow(cell)}:${Number(cell.dataset.column ?? "0")}`;
}

function renderedCellSourceSpan(
  cell: HTMLElement,
  table: ReturnType<typeof getParsedTables>[number],
): { from: number; to: number } | null {
  const directFrom = Number(cell.dataset.sourceFrom ?? "NaN");
  const directTo = Number(cell.dataset.sourceTo ?? "NaN");
  if (Number.isFinite(directFrom) && Number.isFinite(directTo)) {
    return { from: directFrom, to: Math.max(directFrom + 1, directTo) };
  }
  const row = cell.dataset.rowKind === "header"
    ? table.header
    : table.body[Number(cell.dataset.rowIndex ?? "0")];
  if (!row) {
    return null;
  }
  return { from: row.from, to: Math.max(row.from + 1, row.to) };
}

function documentRepresentations(
  view: EditorView,
  from: number,
  to: number,
  mode: ClipboardCopyMode,
  suppliedPayload?: ClipboardDocumentPayload,
): {
  plain: string;
  html?: string;
  markdown?: string;
  privatePayload?: string;
} {
  const markdown = view.state.doc.sliceString(from, to);
  return documentRepresentationsForMarkdown(
    view,
    markdown,
    mode,
    suppliedPayload,
  );
}

function documentRepresentationsForMarkdown(
  view: EditorView,
  markdown: string,
  mode: ClipboardCopyMode,
  suppliedPayload?: ClipboardDocumentPayload,
): {
  plain: string;
  html?: string;
  markdown?: string;
  privatePayload?: string;
} {
  const cutPrivatePayload = suppliedPayload
    ? JSON.stringify(suppliedPayload)
    : null;
  if (mode === "markdown") {
    return {
      plain: markdown,
      markdown,
      ...(cutPrivatePayload
        ? {
            privatePayload: cutPrivatePayload,
            html: metadataTextCarrierHtml(cutPrivatePayload, markdown),
          }
        : {}),
    };
  }
  const clipboard = buildDocumentClipboard(markdown, mode === "rich");
  const plain = mode === "plain" || parseMarkdownTables(markdown).length === 0
    ? clipboard.plain
    : markdown;
  if (mode === "plain") {
    return {
      plain,
      ...(cutPrivatePayload
        ? {
            privatePayload: cutPrivatePayload,
            html: metadataTextCarrierHtml(cutPrivatePayload, plain),
          }
        : {}),
    };
  }
  const rendered = clipboard.html;
  const sanitized = DOMPurify.sanitize(rendered, {
    FORBID_TAGS: ["script", "style", "object", "embed", "iframe", "form"],
    FORBID_ATTR: ["src", "srcset", "onload", "onclick", "onerror"],
  });
  const payload = suppliedPayload ?? {
    version: MLRT_CLIPBOARD_VERSION,
    kind: "document" as const,
    sourceDocument: readDocumentToken(view.dom.ownerDocument),
    markdown,
  };
  const privatePayload = JSON.stringify(payload);
  const metadata = `<meta name="mlrt-clipboard" content="${escapeHtmlAttribute(
    encodePayload(privatePayload),
  )}">`;
  return { plain, html: `${metadata}${sanitized}`, privatePayload };
}

function compositeSelectionMarkdown(
  view: EditorView,
  projection: DocumentSelectionProjection,
): string {
  const tables = getParsedTables(view.state.doc);
  const regions = projection.tableRegions
    .map((region) => ({
      region,
      table: tables.find((candidate) => candidate.from === region.tableFrom),
    }))
    .filter(
      (
        entry,
      ): entry is {
        region: DocumentTableSelectionRegion;
        table: ReturnType<typeof getParsedTables>[number];
      } => Boolean(entry.table),
    )
    .sort((left, right) => left.table.from - right.table.from);
  const selectionFrom = Math.min(projection.anchor, projection.head);
  const selectionTo = Math.max(projection.anchor, projection.head);
  const fragments: string[] = [];
  let cursor = selectionFrom;
  for (const { table, region } of regions) {
    if (table.to <= selectionFrom || table.from >= selectionTo) {
      continue;
    }
    if (cursor < table.from) {
      fragments.push(
        view.state.doc.sliceString(cursor, Math.min(selectionTo, table.from)),
      );
    }
    const payload = tableRectanglePayload(
      table,
      region,
      readDocumentToken(view.dom.ownerDocument),
    );
    fragments.push(markdownForGridPayload(payload));
    cursor = Math.max(cursor, table.to);
  }
  if (cursor < selectionTo) {
    fragments.push(view.state.doc.sliceString(cursor, selectionTo));
  }
  return joinCompositeMarkdownFragments(fragments);
}

function joinCompositeMarkdownFragments(fragments: string[]): string {
  let result = "";
  for (const fragment of fragments.filter((candidate) => candidate.length > 0)) {
    if (
      result.length > 0 &&
      !result.endsWith("\n") &&
      !fragment.startsWith("\n")
    ) {
      result += "\n";
    }
    result += fragment;
  }
  return result;
}

function compositeSelectionChanges(
  view: EditorView,
  projection: DocumentSelectionProjection,
): Array<{ from: number; to: number; insert: string }> {
  if (projection.tableRegions.length === 0) {
    const from = Math.min(projection.anchor, projection.head);
    const to = Math.max(projection.anchor, projection.head);
    return from < to ? [{ from, to, insert: "" }] : [];
  }
  const tables = getParsedTables(view.state.doc);
  const selectedTables = projection.tableRegions
    .map((region) => ({
      region,
      table: tables.find((candidate) => candidate.from === region.tableFrom),
    }))
    .filter(
      (
        entry,
      ): entry is {
        region: DocumentTableSelectionRegion;
        table: ReturnType<typeof getParsedTables>[number];
      } => Boolean(entry.table),
    )
    .sort((left, right) => left.table.from - right.table.from);
  const from = Math.min(projection.anchor, projection.head);
  const to = Math.max(projection.anchor, projection.head);
  const source = view.state.doc.toString();
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  let cursor = from;
  for (const { table, region } of selectedTables) {
    if (table.to <= from || table.from >= to) {
      continue;
    }
    if (cursor < table.from) {
      const proseTo = trimTrailingLineBreaks(
        source,
        cursor,
        Math.min(to, table.from),
      );
      if (cursor < proseTo) {
        changes.push({ from: cursor, to: proseTo, insert: "" });
      }
    }
    const full = isFullTableRegion(table, region);
    changes.push(
      full
        ? { from: table.from, to: table.to, insert: "" }
        : buildGridClearEdit(table, region),
    );
    cursor = Math.max(cursor, table.to);
  }
  if (cursor < to) {
    const proseFrom = trimLeadingLineBreaks(
      source,
      cursor,
      to,
    );
    if (proseFrom < to) {
      changes.push({ from: proseFrom, to, insert: "" });
    }
  }
  return changes
    .filter((change) => change.from < change.to || change.insert.length > 0)
    .sort((left, right) => left.from - right.from);
}

function isFullTableRegion(
  table: ReturnType<typeof getParsedTables>[number],
  region: DocumentTableSelectionRegion,
): boolean {
  return (
    region.top === 0 &&
    region.bottom === table.body.length &&
    region.left === 0 &&
    region.right === table.columnCount - 1
  );
}

function trimTrailingLineBreaks(
  source: string,
  from: number,
  to: number,
): number {
  let result = to;
  while (result > from && source[result - 1] === "\n") {
    result--;
  }
  return result;
}

function trimLeadingLineBreaks(
  source: string,
  from: number,
  to: number,
): number {
  let result = from;
  while (result < to && source[result] === "\n") {
    result++;
  }
  return result;
}

function applyCompositeSelectionDelete(
  view: EditorView,
  projection: DocumentSelectionProjection,
): void {
  const changes = compositeSelectionChanges(view, projection);
  if (changes.length === 0) {
    return;
  }
  const changeSet = view.state.changes(changes);
  const selectionFrom = Math.min(projection.anchor, projection.head);
  clearDocumentSelectionProjection(view.dom.ownerDocument);
  view.dispatch({
    changes: changeSet,
    selection: EditorSelection.cursor(changeSet.mapPos(selectionFrom, -1), 1),
    annotations: [
      allowTableSourceChange.of(true),
      Transaction.addToHistory.of(true),
    ],
    userEvent: "delete.selection",
  });
}

type ClipboardDocumentSegment =
  | { kind: "prose"; markdown: string }
  | { kind: "blank" }
  | {
      kind: "table";
      table: ReturnType<typeof parseMarkdownTables>[number];
    };

/**
 * Publish two complementary public representations. The tab-delimited text
 * keeps a worksheet-shaped matrix for Excel, while the HTML keeps prose in the
 * normal document flow and wraps only real Markdown tables in table elements.
 * Blank source lines are explicit in both representations so Office cannot
 * collapse them while interpreting the clipboard fragment.
 */
function buildDocumentClipboard(markdown: string, rich: boolean): {
  plain: string;
  html: string;
} {
  const segments = clipboardDocumentSegments(markdown);
  const rows: string[][] = [];
  const html: string[] = [];
  for (const segment of segments) {
    if (segment.kind === "blank") {
      rows.push([""]);
      html.push(
        '<p data-mlrt-blank-line="true" style="margin:0"><br></p>',
      );
      continue;
    }
    if (segment.kind === "prose") {
      rows.push(...proseWorksheetRows(segment.markdown));
      html.push(renderClipboardProse(segment.markdown, rich));
      continue;
    }
    const table = segment.table;
    rows.push(
      tableRowDisplayValues(table.header.cells.map((cell) => cell.raw)),
    );
    for (const row of table.body) {
      rows.push(
        tableRowDisplayValues(Array.from(
          { length: table.columnCount },
          (_, column) => row.cells[column]?.raw ?? "",
        )),
      );
    }
    html.push(renderClipboardTable(table, rich));
  }

  if (rows.length === 0) {
    rows.push([""]);
  }
  const plain = serializeDelimitedGrid(rows, "\t");
  return {
    plain,
    html: `<div data-mlrt-clipboard-layout="document">${html.join("")}</div>`,
  };
}

function clipboardDocumentSegments(markdown: string): ClipboardDocumentSegment[] {
  const segments: ClipboardDocumentSegment[] = [];
  const tables = parseMarkdownTables(markdown);
  let cursor = 0;
  for (const table of tables) {
    appendClipboardProseSegments(
      segments,
      markdown.slice(cursor, table.from),
    );
    segments.push({ kind: "table", table });
    cursor = table.to;
    if (markdown[cursor] === "\n") {
      cursor++;
    }
  }
  appendClipboardProseSegments(segments, markdown.slice(cursor));
  return segments;
}

function appendClipboardProseSegments(
  segments: ClipboardDocumentSegment[],
  markdown: string,
): void {
  if (markdown.length === 0) {
    return;
  }
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  // String#split includes one terminal sentinel after a trailing newline.
  // That sentinel is not another blank source line; materializing it as a
  // <p><br></p> gives Word one extra paragraph at the end of the selection.
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  let proseLines: string[] = [];
  const flushProse = (): void => {
    if (proseLines.length > 0) {
      segments.push({ kind: "prose", markdown: proseLines.join("\n") });
      proseLines = [];
    }
  };
  for (const line of lines) {
    if (line.trim().length === 0) {
      flushProse();
      segments.push({ kind: "blank" });
    } else {
      proseLines.push(line);
    }
  }
  flushProse();
}

function renderClipboardProse(markdown: string, rich: boolean): string {
  const rendered = DOMPurify.sanitize(
    (rich ? richMarkdownRenderer : markdownRenderer).render(markdown),
    {
      FORBID_TAGS: ["script", "style", "object", "embed", "iframe", "form"],
      FORBID_ATTR: ["src", "srcset", "onload", "onclick", "onerror"],
    },
  );
  if (rich) {
    return excelSafeRichInline(rendered);
  }
  const parsed = new DOMParser().parseFromString(rendered, "text/html");
  parsed.body
    .querySelectorAll("a, strong, b, em, i, u, s, del, code, sub, sup")
    .forEach((element) => element.replaceWith(...Array.from(element.childNodes)));
  return parsed.body.innerHTML;
}

function renderClipboardTable(
  table: ReturnType<typeof parseMarkdownTables>[number],
  rich: boolean,
): string {
  const renderRow = (
    rawCells: string[],
    kind: "table-header" | "table-body",
  ): string => {
    const values = tableRowDisplayValues(rawCells);
    const richValues = rich ? tableRowRichValues(rawCells) : undefined;
    const tag = kind === "table-header" ? "th" : "td";
    const cells = Array.from({ length: table.columnCount }, (_, column) => {
      const alignment = table.alignments[column] ?? "left";
      const content = richValues?.[column] ?? escapeWorksheetText(values[column] ?? "");
      return `<${tag} style="border:1px solid #000000;padding:2px 6px;text-align:${alignment};vertical-align:top;white-space:pre-wrap">${content}</${tag}>`;
    }).join("");
    return `<tr data-mlrt-row-kind="${kind}">${cells}</tr>`;
  };
  const header = renderRow(
    table.header.cells.map((cell) => cell.raw),
    "table-header",
  );
  const body = table.body
    .map((row) =>
      renderRow(
        Array.from(
          { length: table.columnCount },
          (_, column) => row.cells[column]?.raw ?? "",
        ),
        "table-body",
      ),
    )
    .join("");
  return `<table data-mlrt-clipboard-table="true" style="border-collapse:collapse;border-spacing:0"><thead>${header}</thead><tbody>${body}</tbody></table>`;
}

function proseWorksheetRows(markdown: string): string[][] {
  if (markdown.trim().length === 0) {
    return [];
  }
  const rendered = DOMPurify.sanitize(markdownRenderer.render(markdown), {
    FORBID_TAGS: ["script", "style", "object", "embed", "iframe", "form"],
    FORBID_ATTR: ["src", "srcset", "onload", "onclick", "onerror"],
  });
  const parsed = new DOMParser().parseFromString(rendered, "text/html");
  const values: string[] = [];
  for (const child of Array.from(parsed.body.children)) {
    if (child.tagName === "UL" || child.tagName === "OL") {
      appendListValues(child, values, 0);
      continue;
    }
    visibleElementText(child)
      .split("\n")
      .map((value) => value.trimEnd())
      .filter((value) => value.length > 0)
      .forEach((value) => values.push(value));
  }
  return values.map((value) => [value]);
}

function appendListValues(
  list: Element,
  values: string[],
  depth: number,
): void {
  const ordered = list.tagName === "OL";
  let index = Number(list.getAttribute("start") ?? "1");
  for (const item of Array.from(list.children)) {
    if (item.tagName !== "LI") {
      continue;
    }
    const clone = item.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(":scope > ul, :scope > ol").forEach((nested) => nested.remove());
    const prefix = ordered ? `${index}. ` : "• ";
    values.push(`${"  ".repeat(depth)}${prefix}${visibleElementText(clone).trim()}`);
    for (const nested of Array.from(item.children)) {
      if (nested.tagName === "UL" || nested.tagName === "OL") {
        appendListValues(nested, values, depth + 1);
      }
    }
    index++;
  }
}

function tableRowDisplayValues(rawCells: string[]): string[] {
  return rawCells.map((raw) => {
    const displayed = markdownCellToDisplayText(raw).trim();
    const rendered = markdownRenderer.renderInline(displayed);
    const parsed = new DOMParser().parseFromString(rendered, "text/html");
    return visibleElementText(parsed.body).trim();
  });
}

function tableRowRichValues(rawCells: string[]): string[] {
  return rawCells.map((raw) => {
    const sanitized = DOMPurify.sanitize(
      richMarkdownRenderer.renderInline(
        markdownCellToDisplayText(raw).trim(),
      ),
      {
        ALLOWED_TAGS: [
          "a",
          "b",
          "strong",
          "i",
          "em",
          "u",
          "s",
          "del",
          "code",
          "br",
          "sub",
          "sup",
        ],
        ALLOWED_ATTR: ["href", "title"],
        ALLOW_UNKNOWN_PROTOCOLS: false,
      },
    );
    return excelSafeRichInline(sanitized);
  });
}

function excelSafeRichInline(html: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const replaceWithSpan = (selector: string, style: string): void => {
    parsed.body.querySelectorAll<HTMLElement>(selector).forEach((element) => {
      const span = parsed.createElement("span");
      span.setAttribute("style", style);
      span.append(...Array.from(element.childNodes));
      element.replaceWith(span);
    });
  };
  replaceWithSpan("strong, b", "font-weight:700");
  replaceWithSpan("em, i", "font-style:italic");
  replaceWithSpan("code", "font-family:monospace");
  replaceWithSpan("s, del", "text-decoration:line-through");
  parsed.body.querySelectorAll("br").forEach((br) =>
    br.setAttribute("style", "mso-data-placement:same-cell"),
  );
  return parsed.body.innerHTML;
}

function visibleElementText(element: Element): string {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  return (clone.textContent ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n");
}

function escapeWorksheetText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "<br>");
}

function writeDocumentTransfer(
  transfer: DataTransfer,
  representations: ReturnType<typeof documentRepresentations>,
): void {
  transfer.setData("text/plain", representations.plain);
  if (representations.html) {
    transfer.setData("text/html", representations.html);
  }
  if (representations.markdown) {
    transfer.setData("text/markdown", representations.markdown);
  }
  if (representations.privatePayload) {
    transfer.setData(MLRT_CLIPBOARD_MIME, representations.privatePayload);
  }
}

function readTransfer(transfer: DataTransfer): ClipboardReadData {
  return {
    privatePayload: readTransferType(transfer, MLRT_CLIPBOARD_MIME),
    html: readTransferType(transfer, "text/html"),
    markdown: readTransferType(transfer, "text/markdown"),
    plain: readTransferType(transfer, "text/plain", true),
  };
}

function readTransferType(
  transfer: DataTransfer,
  type: string,
  preserveEmpty = false,
): string | undefined {
  const available = Array.from(transfer.types).some(
    (candidate) => candidate.toLowerCase() === type.toLowerCase(),
  );
  if (!available) {
    return undefined;
  }
  const value = transfer.getData(type);
  return preserveEmpty || value.length > 0 ? value : undefined;
}

function documentPasteMarkdown(
  data: ClipboardReadData,
  mode: ClipboardPasteMode,
): string | null {
  if (mode === "auto") {
    const privatePayload = readPrivatePayload(data);
    if (privatePayload?.kind === "document") {
      return privatePayload.markdown;
    }
    if (privatePayload?.kind === "grid") {
      return markdownForGridPayload(privatePayload);
    }
  }
  if (mode === "markdown") {
    const markdown = data.markdown ?? data.plain;
    return markdown === undefined ? null : normalizeText(markdown);
  }
  if ((mode === "auto" || mode === "rich") && data.html) {
    return htmlToReadableMarkdown(data.html);
  }
  if (mode !== "plain" && data.markdown) {
    return normalizeText(data.markdown);
  }
  return data.plain === undefined ? null : normalizeText(data.plain);
}

function markdownForGridPayload(payload: ClipboardGridPayload): string {
  return payload.exactMarkdown ?? gridToMarkdown(payload.rows, payload.alignments);
}

function htmlToReadableMarkdown(html: string): string {
  const classStyles = officeClassStyles(html);
  const sanitized = DOMPurify.sanitize(html, {
    FORBID_TAGS: [
      "script",
      "style",
      "meta",
      "link",
      "object",
      "embed",
      "iframe",
      "form",
      "input",
    ],
    FORBID_ATTR: ["src", "srcset", "onload", "onclick", "onerror"],
  });
  const parsed = new DOMParser().parseFromString(sanitized, "text/html");
  const replacements = new Map<string, string>();
  Array.from(parsed.querySelectorAll("table")).forEach((table, index) => {
    const token = `MLRTTABLETOKEN${index}X`;
    replacements.set(token, htmlTableToReadableMarkdown(table, classStyles));
    table.replaceWith(parsed.createTextNode(token));
  });
  let markdown = turndown.turndown(parsed.body.innerHTML);
  replacements.forEach((replacement, token) => {
    markdown = markdown.replace(token, `\n\n${replacement}\n\n`);
  });
  return normalizeText(markdown)
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

interface ImportedHtmlCell {
  markdown: string;
  bordered: boolean;
}

function htmlTableToReadableMarkdown(
  table: HTMLTableElement,
  classStyles: Map<string, string>,
): string {
  const rows: ImportedHtmlCell[][] = [];
  Array.from(table.rows).forEach((row, rowIndex) => {
    rows[rowIndex] ??= [];
    let column = 0;
    Array.from(row.cells).forEach((cell) => {
      while (rows[rowIndex][column] !== undefined) {
        column++;
      }
      const markdown = htmlCellToMarkdown(cell);
      const bordered = cellHasVisibleBorder(cell, classStyles);
      const rowSpan = Math.max(1, cell.rowSpan || 1);
      const columnSpan = Math.max(1, cell.colSpan || 1);
      for (let rowOffset = 0; rowOffset < rowSpan; rowOffset++) {
        rows[rowIndex + rowOffset] ??= [];
        for (let columnOffset = 0; columnOffset < columnSpan; columnOffset++) {
          rows[rowIndex + rowOffset][column + columnOffset] = {
            markdown: rowOffset === 0 && columnOffset === 0 ? markdown : "",
            bordered,
          };
        }
      }
      column += columnSpan;
    });
  });
  if (rows.length === 0) {
    return "";
  }
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) =>
    Array.from(
      { length: width },
      (_, column): ImportedHtmlCell => row[column] ?? {
        markdown: "",
        bordered: false,
      },
    ),
  );
  const borderedRows = normalized.map((row) =>
    row.some((cell) => cell.bordered),
  );
  const hasBorderedRows = borderedRows.some(Boolean);
  const hasUnborderedRows = borderedRows.some((bordered) => !bordered);
  if (!hasBorderedRows || !hasUnborderedRows) {
    return importedRowsToMarkdownTable(normalized);
  }

  const blocks: string[] = [];
  let index = 0;
  while (index < normalized.length) {
    if (borderedRows[index]) {
      const start = index;
      while (index < normalized.length && borderedRows[index]) {
        index++;
      }
      blocks.push(importedRowsToMarkdownTable(normalized.slice(start, index)));
      continue;
    }
    const prose = importedRowToProse(normalized[index]);
    if (prose.length > 0) {
      blocks.push(prose);
    }
    index++;
  }
  return blocks.join("\n\n");
}

function importedRowsToMarkdownTable(rows: ImportedHtmlCell[][]): string {
  const width = Math.max(1, ...rows.map((row) => row.length));
  const sourceRows = rows.length > 0 ? rows : [[]];
  const renderRow = (row: ImportedHtmlCell[]): string =>
    `| ${Array.from({ length: width }, (_, column) =>
      markdownForTableCell(row[column]?.markdown ?? ""),
    ).join(" | ")} |`;
  return [
    renderRow(sourceRows[0]),
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...sourceRows.slice(1).map(renderRow),
  ].join("\n");
}

function importedRowToProse(row: ImportedHtmlCell[]): string {
  const populated = row
    .map((cell, column) => ({ column, value: cell.markdown.trim() }))
    .filter(({ value }) => value.length > 0);
  if (populated.length === 0) {
    return "";
  }
  if (populated.length === 1) {
    return populated[0].value.replace(/^(\s*)[•·]\s+/, "$1- ");
  }
  return Array.from(
    { length: populated[populated.length - 1].column + 1 },
    (_, column) => row[column]?.markdown.trim() ?? "",
  ).join("\t");
}

function htmlCellToMarkdown(cell: HTMLTableCellElement): string {
  const clone = cell.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll<HTMLElement>(
      [
        "[hidden]",
        '[style*="display:none"]',
        '[style*="display: none"]',
        '[style*="visibility:hidden"]',
        '[style*="visibility: hidden"]',
        '[style*="mso-hide"]',
      ].join(","),
    )
    .forEach((element) => element.remove());
  const breakToken = uniqueImportToken(clone, "LINEBREAK");
  const slashToken = uniqueImportToken(clone, "BACKSLASH");
  const walker = clone.ownerDocument.createTreeWalker(
    clone,
    NodeFilter.SHOW_TEXT,
  );
  let textNode = walker.nextNode();
  while (textNode) {
    textNode.nodeValue = (textNode.nodeValue ?? "").replace(/\\/g, slashToken);
    textNode = walker.nextNode();
  }
  clone.querySelectorAll("br").forEach((br) =>
    br.replaceWith(clone.ownerDocument.createTextNode(breakToken)),
  );
  return normalizeText(turndown.turndown(clone.innerHTML))
    .replace(/\n{2,}/g, "\n")
    .trim()
    .split(breakToken).join("\n")
    .split(slashToken).join("\\");
}

function markdownForTableCell(value: string): string {
  return importedMarkdownToTableCellSource(value);
}

function uniqueImportToken(root: HTMLElement, label: string): string {
  let token = `MLRT${label}TOKENX`;
  const source = root.textContent ?? "";
  while (source.includes(token)) {
    token += "X";
  }
  return token;
}

function officeClassStyles(html: string): Map<string, string> {
  const styles = new Map<string, string>();
  const styleBlocks = Array.from(html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi));
  for (const styleBlock of styleBlocks) {
    const css = styleBlock[1];
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const declaration = rule[2];
      for (const classMatch of rule[1].matchAll(/\.([a-zA-Z_][\w-]*)/g)) {
        const className = classMatch[1];
        styles.set(
          className,
          `${styles.get(className) ?? ""};${declaration}`,
        );
      }
    }
  }
  return styles;
}

function cellHasVisibleBorder(
  cell: HTMLTableCellElement,
  classStyles: Map<string, string>,
): boolean {
  const css = [
    cell.getAttribute("style") ?? "",
    ...Array.from(cell.classList).map((className) => classStyles.get(className) ?? ""),
  ].join(";");
  return /(?:^|;)\s*border(?:-(?:top|right|bottom|left))?\s*:\s*(?!(?:none|0(?:px|pt)?)(?:\s|;|$))[^;]+/i.test(css);
}

function applyDocumentPaste(
  view: EditorView,
  markdown: string,
  data: ClipboardReadData,
): boolean {
  const doc = view.dom.ownerDocument;
  const projection = getDocumentSelectionProjection(
    doc,
    view.state.selection.main,
  );
  const range = atomicDocumentSelection(view) ?? view.state.selection.main;
  const privatePayload = readPrivatePayload(data);
  const documentPayload =
    privatePayload?.kind === "document" ? privatePayload : null;
  const gridPayload = privatePayload?.kind === "grid" ? privatePayload : null;
  const pending = getPendingClipboardCut(doc);
  const completesDocumentMove = Boolean(
    pending?.kind === "document" &&
      documentPayload?.cutToken === pending.token &&
      documentPayload.sourceDocument === pending.sourceDocument &&
      documentPayload.markdown === pending.markdown &&
      pending.sourceDocument === readDocumentToken(doc),
  );
  const completesCompositeMove = Boolean(
    pending?.kind === "composite" &&
      documentPayload?.cutToken === pending.token &&
      documentPayload.sourceDocument === pending.sourceDocument &&
      documentPayload.markdown === pending.markdown &&
      pending.sourceDocument === readDocumentToken(doc),
  );
  const completesTableMove = Boolean(
    pending?.kind === "table" &&
      gridPayload?.cutToken === pending.token &&
      gridPayload.sourceDocument === pending.sourceDocument &&
      pending.sourceDocument === readDocumentToken(doc),
  );
  if (projection) {
    if (completesCompositeMove || completesDocumentMove || completesTableMove) {
      announce(
        doc,
        "Move rejected: choose a text cursor or table range as the destination.",
      );
      // This is a recoverable destination error. Keep the deferred cut armed
      // so the user can collapse the selection and retry the move elsewhere.
      return false;
    }
    if (
      !dispatchCompositeSelectionReplacement(
        view,
        projection,
        markdown,
        "input.paste",
      )
    ) {
      announce(doc, "Paste cancelled because the mixed selection changed.");
      return false;
    }
    clearPendingClipboardCut(doc);
    setPendingCutToken(doc, undefined);
    view.dom.classList.remove("mlrt-document-cut-pending");
    return true;
  }
  if (
    completesCompositeMove &&
    pending?.kind === "composite" &&
    documentPayload
  ) {
    const outcome = dispatchCompositeMoveToDocument(
      view,
      range,
      pending,
      documentPayload,
    );
    if (outcome !== "completed") {
      announce(
        doc,
        outcome === "destination-overlap"
          ? "Move rejected: choose a destination outside the cut source."
          : "Move cancelled because the cut source changed.",
      );
      if (outcome === "source-changed") {
        clearPendingClipboardCut(doc);
        view.dom.classList.remove("mlrt-document-cut-pending");
      }
      return false;
    }
  } else if (
    completesDocumentMove &&
    pending?.kind === "document" &&
    documentPayload
  ) {
    if (view.state.doc.sliceString(pending.from, pending.to) !== pending.markdown) {
      announce(doc, "Move cancelled because the cut source changed.");
      clearPendingClipboardCut(doc);
      view.dom.classList.remove("mlrt-document-cut-pending");
      return false;
    }
    if (
      rangesOverlap(
        { from: pending.from, to: pending.to },
        { from: range.from, to: range.to },
      ) ||
      (range.empty && range.from > pending.from && range.from < pending.to)
    ) {
      announce(doc, "Move rejected: choose a destination outside the cut source.");
      return false;
    }
    const moveMarkdown = documentPayload.markdown;
    const changeSpecs = [
      { from: pending.from, to: pending.to, insert: "" },
      { from: range.from, to: range.to, insert: moveMarkdown },
    ].sort((left, right) => left.from - right.from);
    const changes = view.state.changes(changeSpecs);
    const insertionFrom = changes.mapPos(range.from, -1);
    view.dispatch({
      changes,
      selection: EditorSelection.cursor(insertionFrom + moveMarkdown.length, 1),
      annotations: [
        allowTableSourceChange.of(true),
        Transaction.addToHistory.of(true),
      ],
      userEvent: "input.paste",
    });
  } else if (
    completesTableMove &&
    pending?.kind === "table" &&
    gridPayload
  ) {
    const outcome = dispatchTableMoveToDocument(
      view,
      range,
      pending,
      gridPayload,
    );
    if (outcome !== "completed") {
      announce(
        doc,
        outcome === "destination-overlap"
          ? "Move rejected: choose a destination outside the cut source."
          : "Move cancelled because the cut source changed.",
      );
      if (outcome === "source-changed") {
        clearPendingClipboardCut(doc);
        setPendingCutToken(doc, undefined);
      }
      return false;
    }
  } else {
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: markdown },
      selection: EditorSelection.cursor(range.from + markdown.length, 1),
      annotations: [
        allowTableSourceChange.of(true),
        Transaction.addToHistory.of(true),
      ],
      userEvent: "input.paste",
    });
  }
  clearPendingClipboardCut(doc);
  setPendingCutToken(doc, undefined);
  view.dom.classList.remove("mlrt-document-cut-pending");
  return true;
}

/**
 * Replace exactly what a mixed selection paints. Prose spans are deleted and
 * partial table rectangles are cleared; the pasted Markdown is inserted at
 * the gesture anchor, which is always prose or a safe table boundary.
 */
function dispatchCompositeSelectionReplacement(
  view: EditorView,
  projection: DocumentSelectionProjection,
  markdown: string,
  userEvent: string,
): boolean {
  const edits = compositeSelectionChanges(view, projection).map((edit) => ({
    ...edit,
  }));
  if (edits.length === 0) {
    return false;
  }

  const anchor = projection.anchor;
  let insertionEdit = edits.find(
    (edit) => anchor === edit.from || anchor === edit.to,
  );
  let insertionOffset = markdown.length;
  if (!insertionEdit) {
    insertionEdit = { from: anchor, to: anchor, insert: markdown };
    edits.push(insertionEdit);
  } else if (anchor === insertionEdit.from) {
    insertionEdit.insert = editRewritesTable(view, insertionEdit)
      ? joinMarkdownAtBlockBoundary(markdown, insertionEdit.insert)
      : markdown + insertionEdit.insert;
  } else {
    insertionEdit.insert = editRewritesTable(view, insertionEdit)
      ? joinMarkdownAtBlockBoundary(insertionEdit.insert, markdown)
      : insertionEdit.insert + markdown;
    insertionOffset = insertionEdit.insert.length;
  }

  edits.sort((left, right) => left.from - right.from || left.to - right.to);
  for (let index = 1; index < edits.length; index++) {
    if (edits[index - 1].to > edits[index].from) {
      return false;
    }
  }
  const changes = view.state.changes(edits);
  const cursor = changes.mapPos(insertionEdit.from, -1) + insertionOffset;
  clearDocumentSelectionProjection(view.dom.ownerDocument);
  view.dispatch({
    changes,
    selection: EditorSelection.cursor(cursor, 1),
    annotations: [
      allowTableSourceChange.of(true),
      Transaction.addToHistory.of(true),
      // A spatial replacement can touch several non-contiguous prose/table
      // spans. It must begin a fresh undo event, while remaining open on the
      // trailing side so later IME composition updates still undo with it.
      isolateHistory.of("before"),
    ],
    userEvent,
  });
  return true;
}

function editRewritesTable(
  view: EditorView,
  edit: { from: number; to: number },
): boolean {
  return getParsedTables(view.state.doc).some(
    (table) => edit.from === table.from && edit.to === table.to,
  );
}

function joinMarkdownAtBlockBoundary(left: string, right: string): string {
  if (!left || !right) {
    return left + right;
  }
  const trailingBreaks = left.match(/\n+$/)?.[0].length ?? 0;
  const leadingBreaks = right.match(/^\n+/)?.[0].length ?? 0;
  const missingBreaks = Math.max(0, 2 - trailingBreaks - leadingBreaks);
  return left + "\n".repeat(missingBreaks) + right;
}

type MoveDispatchOutcome =
  | "completed"
  | "destination-overlap"
  | "source-changed";

function dispatchCompositeMoveToDocument(
  view: EditorView,
  destination: { from: number; to: number; empty: boolean },
  pending: PendingCompositeCut,
  payload: ClipboardDocumentPayload,
): MoveDispatchOutcome {
  if (
    view.state.doc.toString() !== pending.sourceDocumentText ||
    payload.markdown !== pending.markdown
  ) {
    return "source-changed";
  }
  if (
    pending.changes.some((change) =>
      rangesOverlap(
        { from: change.from, to: change.to },
        { from: destination.from, to: destination.to },
      ) ||
      (destination.empty &&
        destination.from > change.from &&
        destination.from < change.to),
    )
  ) {
    return "destination-overlap";
  }
  const changeSpecs = [
    ...pending.changes,
    {
      from: destination.from,
      to: destination.to,
      insert: pending.markdown,
    },
  ].sort((left, right) => left.from - right.from);
  for (let index = 1; index < changeSpecs.length; index++) {
    if (changeSpecs[index - 1].to > changeSpecs[index].from) {
      return "destination-overlap";
    }
  }
  const changes = view.state.changes(changeSpecs);
  const insertionFrom = changes.mapPos(destination.from, -1);
  view.dispatch({
    changes,
    selection: EditorSelection.cursor(
      insertionFrom + pending.markdown.length,
      1,
    ),
    annotations: [
      allowTableSourceChange.of(true),
      Transaction.addToHistory.of(true),
    ],
    userEvent: "input.paste",
  });
  return "completed";
}

function dispatchTableMoveToDocument(
  view: EditorView,
  destination: { from: number; to: number; empty: boolean },
  pending: PendingTableCut,
  payload: ClipboardGridPayload,
): MoveDispatchOutcome {
  const sourceTable = getParsedTables(view.state.doc).find(
    (candidate) => candidate.from === pending.tableFrom,
  );
  if (
    !sourceTable ||
    view.state.doc.sliceString(sourceTable.from, sourceTable.to) !==
      pending.sourceTableText
  ) {
    return "source-changed";
  }
  if (
    rangesOverlap(
      { from: sourceTable.from, to: sourceTable.to },
      destination,
    ) ||
    (destination.empty &&
      destination.from > sourceTable.from &&
      destination.from < sourceTable.to)
  ) {
    return "destination-overlap";
  }
  const expectedPayload = tableRectanglePayload(
    sourceTable,
    pending.rectangle,
    pending.sourceDocument,
  );
  if (!sameGridPayloadText(payload, expectedPayload)) {
    return "source-changed";
  }
  const markdown = markdownForGridPayload(expectedPayload);
  const sourceEdit = buildGridClearEdit(sourceTable, pending.rectangle);
  const changeSpecs = [
    sourceEdit,
    { from: destination.from, to: destination.to, insert: markdown },
  ]
    .sort((left, right) => left.from - right.from)
    .map((edit) => ({ from: edit.from, to: edit.to, insert: edit.insert }));
  const changes = view.state.changes(changeSpecs);
  const insertionFrom = changes.mapPos(destination.from, -1);
  view.dispatch({
    changes,
    selection: EditorSelection.cursor(insertionFrom + markdown.length, 1),
    annotations: [
      allowTableSourceChange.of(true),
      Transaction.addToHistory.of(true),
    ],
    userEvent: "input.paste",
  });
  return "completed";
}

function sameGridPayloadText(
  left: ClipboardGridPayload,
  right: ClipboardGridPayload,
): boolean {
  return left.rows.length === right.rows.length &&
    left.rows.every(
      (row, rowIndex) =>
        row.length === right.rows[rowIndex]?.length &&
        row.every(
          (cell, column) =>
            cell.text === right.rows[rowIndex]?.[column]?.text,
        ),
    );
}

function readPrivatePayload(data: ClipboardReadData): MlrtClipboardPayload | null {
  const direct = data.privatePayload
    ? parseClipboardPayload(data.privatePayload)
    : null;
  if (direct) {
    return direct;
  }
  if (!data.html) {
    return null;
  }
  const parsed = new DOMParser().parseFromString(data.html, "text/html");
  const encoded = parsed.querySelector<HTMLMetaElement>(
    'meta[name="mlrt-clipboard"]',
  )?.content;
  if (!encoded) {
    return null;
  }
  const text = decodePayload(encoded);
  return text ? parseClipboardPayload(text) : null;
}

function atomicDocumentSelection(
  view: EditorView,
): { from: number; to: number; empty: boolean } | null {
  const selection = view.state.selection.main;
  if (selection.empty) {
    return null;
  }
  let from = selection.from;
  let to = selection.to;
  for (const table of getParsedTables(view.state.doc)) {
    if (from < table.to && to > table.from) {
      from = Math.min(from, table.from);
      to = Math.max(to, table.to);
    }
  }
  return { from, to, empty: false };
}

function showDocumentMenu(
  doc: Document,
  view: EditorView,
  clientX: number,
  clientY: number,
): void {
  documentMenuClosers.get(doc)?.();
  const menu = doc.createElement("div");
  menu.className = "mlrt-clipboard-menu mlrt-document-clipboard-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Document clipboard actions");
  const close = (restoreFocus = false): void => {
    menu.remove();
    doc.removeEventListener("pointerdown", closeOnOutsidePointer, true);
    documentMenuClosers.delete(doc);
    if (restoreFocus) {
      view.focus();
    }
  };
  const closeOnOutsidePointer = (event: PointerEvent): void => {
    if (event.target instanceof Node && !menu.contains(event.target)) {
      close();
    }
  };
  const add = (label: string, callback: () => void): void => {
    const item = doc.createElement("button");
    item.type = "button";
    item.className = "mlrt-clipboard-menu-item";
    item.setAttribute("role", "menuitem");
    item.textContent = label;
    item.addEventListener("click", () => {
      close();
      view.focus();
      callback();
    });
    item.addEventListener("keydown", (event) => {
      const items = Array.from(
        menu.querySelectorAll<HTMLButtonElement>("button"),
      );
      const index = items.indexOf(item);
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        const target = event.key === "Home"
          ? items[0]
          : items[items.length - 1];
        items.forEach((candidate) => {
          candidate.tabIndex = candidate === target ? 0 : -1;
        });
        target?.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
        return;
      }
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const target = items[(index + delta + items.length) % items.length];
      items.forEach((candidate) => {
        candidate.tabIndex = candidate === target ? 0 : -1;
      });
      target?.focus();
    });
    menu.append(item);
  };
  add("Cut / Move within document", () => {
    if (!doc.execCommand("cut")) {
      announce(doc, "Cut failed. Use Cmd/Ctrl+X.");
    }
  });
  (["smart", "rich", "plain", "markdown"] as ClipboardCopyMode[]).forEach(
    (mode) =>
      add(`Copy ${capitalize(mode)}`, () => {
        void copyDocumentThroughMenu(doc, view, mode);
      }),
  );
  (["auto", "rich", "plain", "markdown"] as ClipboardPasteMode[]).forEach(
    (mode) =>
      add(`Paste ${capitalize(mode)}`, () => {
        armedDocumentPasteMode = mode;
        announce(doc, `Paste ${capitalize(mode)} armed — press Cmd/Ctrl+V.`);
      }),
  );
  add("Clipboard Settings…", () =>
    view.dom.dispatchEvent(
      new CustomEvent("mlrt:open-clipboard-settings", { bubbles: true }),
    ),
  );
  const items = Array.from(
    menu.querySelectorAll<HTMLButtonElement>("button"),
  );
  items.forEach((item, index) => {
    item.tabIndex = index === 0 ? 0 : -1;
  });
  doc.body.append(menu);
  menu.style.position = "fixed";
  const viewportWidth = doc.documentElement.clientWidth;
  const viewportHeight = doc.documentElement.clientHeight;
  menu.style.left = `${Math.max(
    4,
    Math.min(clientX, viewportWidth - menu.offsetWidth - 4),
  )}px`;
  menu.style.top = `${Math.max(
    4,
    Math.min(clientY, viewportHeight - menu.offsetHeight - 4),
  )}px`;
  menu.querySelector<HTMLButtonElement>("button")?.focus();
  documentMenuClosers.set(doc, close);
  doc.addEventListener("pointerdown", closeOnOutsidePointer, true);
}

async function copyDocumentThroughMenu(
  doc: Document,
  view: EditorView,
  mode: ClipboardCopyMode,
): Promise<void> {
  const projection = getDocumentSelectionProjection(
    doc,
    view.state.selection.main,
  );
  const range = atomicDocumentSelection(view);
  if (!range && !projection) {
    announce(doc, "Nothing selected to copy.");
    return;
  }
  const representations = projection
    ? documentRepresentationsForMarkdown(
        view,
        compositeSelectionMarkdown(view, projection),
        mode,
      )
    : documentRepresentations(view, range!.from, range!.to, mode);

  requestedDocumentCopyMode = mode;
  try {
    doc.execCommand("copy");
  } catch {
    // Fall through to the async clipboard path below.
  }
  // execCommand can report success without dispatching a copy event. onCopy
  // clears this request only after it has populated the clipboard data.
  if (requestedDocumentCopyMode === null) {
    return;
  }
  requestedDocumentCopyMode = null;

  try {
    await writeDocumentAsyncClipboard(representations);
    clearPendingClipboardCut(doc);
    setPendingCutToken(doc, undefined);
    view.dom.classList.remove("mlrt-document-cut-pending");
    announce(doc, `Copied as ${capitalize(mode)}.`);
  } catch {
    announce(doc, "Copy failed. Use Cmd/Ctrl+C.");
  }
}

async function writeDocumentAsyncClipboard(
  representations: ReturnType<typeof documentRepresentations>,
): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Async clipboard unavailable");
  }
  const data: Record<string, Blob> = {
    "text/plain": new Blob([representations.plain], { type: "text/plain" }),
  };
  if (representations.html) {
    data["text/html"] = new Blob([representations.html], { type: "text/html" });
  }
  if (representations.markdown) {
    data["text/markdown"] = new Blob([representations.markdown], {
      type: "text/markdown",
    });
  }
  await navigator.clipboard.write([new ClipboardItem(data)]);
}

function announce(doc: Document, message: string): void {
  let status = doc.querySelector<HTMLElement>(".mlrt-clipboard-status");
  if (!status) {
    status = doc.createElement("div");
    status.className = "mlrt-clipboard-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    doc.body.append(status);
  }
  status.textContent = "";
  requestAnimationFrame(() => {
    if (!status) {
      return;
    }
    status.textContent = message;
    status.dataset.visible = "true";
    setTimeout(() => {
      if (status?.textContent === message) {
        delete status.dataset.visible;
      }
    }, 2400);
  });
}

function readCopyMode(doc: Document): ClipboardCopyMode {
  const value = doc.documentElement.dataset.mlrtDefaultCopyMode;
  return value === "rich" || value === "plain" || value === "markdown"
    ? value
    : "smart";
}

function readPasteMode(doc: Document): ClipboardPasteMode {
  const value = doc.documentElement.dataset.mlrtDefaultPasteMode;
  return value === "rich" || value === "plain" || value === "markdown"
    ? value
    : "auto";
}

function readDocumentToken(doc: Document): string {
  return doc.documentElement.dataset.mlrtDocumentToken ?? "";
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
}

function rangesOverlap(
  left: { from: number; to: number },
  right: { from: number; to: number },
): boolean {
  return left.from < right.to && right.from < left.to;
}

function createToken(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function encodePayload(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function decodePayload(value: string): string | null {
  try {
    return new TextDecoder().decode(
      Uint8Array.from(atob(value), (character) => character.charCodeAt(0)),
    );
  } catch {
    return null;
  }
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function metadataTextCarrierHtml(
  privatePayload: string,
  text: string,
): string {
  return `<meta name="mlrt-clipboard" content="${escapeHtmlAttribute(
    encodePayload(privatePayload),
  )}"><pre style="white-space:pre-wrap">${escapeHtmlAttribute(text)}</pre>`;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
