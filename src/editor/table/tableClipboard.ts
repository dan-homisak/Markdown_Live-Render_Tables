import { Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import {
  buildGridClearEdit,
  buildGridPasteEdit,
  CellRectangle,
  ClipboardCell,
  ClipboardCopyMode,
  ClipboardGridPayload,
  ClipboardPasteMode,
  gridPlainTextForCopy,
  gridToHtml,
  gridToMarkdown,
  importedMarkdownToTableCellSource,
  MLRT_CLIPBOARD_MIME,
  MlrtClipboardPayload,
  parseClipboardPayload,
  parseDelimitedGrid,
  resolveGridPasteRows,
  serializeDelimitedGrid,
  tableRectanglePayload,
  validateClipboardPayload,
} from "../../shared/clipboardModel";
import {
  getParsedTables,
  markdownCellToDisplayText,
  parseMarkdownTables,
  ParsedTable,
} from "../../shared/tableModel";
import { allowTableSourceChange } from "../../shared/tableSourceProtection";
import {
  clearPendingClipboardCut,
  getPendingClipboardCut,
  PendingCompositeCut,
  PendingDocumentCut,
  PendingTableCut,
  setPendingClipboardCut,
} from "../clipboardCutState";
import { findCell, TABLE_CELL_SELECTOR } from "./cellSelection";
import {
  addressFromCell,
  cellFromAddress,
  clearTableRangeSelection,
  ensureContextCellSelection,
  getTableRangeSelection,
  selectionRectangle,
  setPendingCutToken,
  setTableRangeSelection,
  TABLE_CUT_CANCEL_EVENT,
  TABLE_SELECTION_CLEAR_EVENT,
  TableCellAddress,
  TableRangeSelectionState,
} from "./tableRangeSelection";
import { getTableWidgetTable } from "./tableWidgetState";
import {
  OFFICE_RICH_CELL_ALLOWED_ATTR,
  OFFICE_RICH_CELL_ALLOWED_TAGS,
  officeCompatibleRichHtml,
  officeCompatibleSmartListHtml,
} from "../officeClipboardHtml";

const HTML_METADATA_SELECTOR = 'meta[name="mlrt-clipboard"]';
const CLIPBOARD_MENU_CLASS = "mlrt-clipboard-menu";
const COPY_MODE_LABELS: Record<ClipboardCopyMode, string> = {
  smart: "Smart",
  rich: "Rich",
  plain: "Plain Text",
  markdown: "Markdown",
};
const PASTE_MODE_LABELS: Record<ClipboardPasteMode, string> = {
  auto: "Automatic",
  rich: "Rich",
  plain: "Plain Text",
  markdown: "Markdown",
};
const richCellRenderer = new MarkdownIt({ html: true, linkify: false, breaks: true });
const richCellTurndown = new TurndownService({
  emDelimiter: "*",
  strongDelimiter: "**",
  codeBlockStyle: "fenced",
});
richCellTurndown.use(gfm);

interface ClipboardRepresentations {
  plain: string;
  html?: string;
  markdown?: string;
  csv?: string;
  privatePayload?: string;
}

interface ClipboardReadData {
  privatePayload?: string;
  html?: string;
  markdown?: string;
  csv?: string;
  plain?: string;
}

interface RequestedMenuCopy {
  wrapper: HTMLElement;
  mode: ClipboardCopyMode;
  representations: ClipboardRepresentations;
}

const requestedMenuCopies = new WeakMap<Document, RequestedMenuCopy>();
const armedPasteModes = new WeakMap<Document, ClipboardPasteMode>();
const clipboardOperationVersions = new WeakMap<Document, number>();

export function bindTableClipboard(
  wrapper: HTMLElement,
  view: EditorView,
  initialTable: ParsedTable,
): () => void {
  let contextMenu: HTMLElement | null = null;
  const doc = wrapper.ownerDocument;
  const currentTable = (): ParsedTable =>
    getTableWidgetTable(wrapper) ?? initialTable;

  const onCopy = (event: ClipboardEvent): void => {
    const selection = getTableRangeSelection(doc);
    const requested = requestedMenuCopies.get(doc);
    const requestedForWrapper = requested?.wrapper === wrapper
      ? requested
      : null;
    const nativeCell = findCell(event.target) ?? findCell(doc.activeElement);
    const hasNativeSelection = Boolean(
      nativeCell &&
        wrapper.contains(nativeCell) &&
        hasNativeCellSelection(nativeCell),
    );
    if (
      selection?.wrapper !== wrapper &&
      !hasNativeSelection &&
      !requestedForWrapper
    ) {
      return;
    }
    const requestedMode = requestedForWrapper?.mode;
    const representations = requestedForWrapper?.representations ??
      representationsForCurrentSelection(
        doc,
        currentTable(),
        requestedMode ?? readDefaultCopyMode(doc),
      );
    if (!representations || !event.clipboardData) {
      return;
    }
    if (requestedForWrapper) {
      requestedMenuCopies.delete(doc);
    }
    beginClipboardOperation(doc);
    event.preventDefault();
    writeDataTransfer(event.clipboardData, representations);
    clearPendingClipboardCut(doc);
    setPendingCutToken(doc, undefined);
    view.dom.classList.remove("mlrt-document-cut-pending");
    const message = requestedMode
      ? `Copied as ${COPY_MODE_LABELS[requestedMode]}.`
      : "Copied selection.";
    announce(doc, message);
  };

  const onCut = (event: ClipboardEvent): void => {
    const selection = getTableRangeSelection(doc);
    if (!selection || selection.wrapper !== wrapper || !event.clipboardData) {
      return;
    }
    const table = currentTable();
    const token = createToken();
    const rectangle = selectionRectangle(selection);
    const payload = tableRectanglePayload(
      table,
      rectangle,
      readDocumentToken(doc),
      token,
    );
    const representations = representationsForGrid(
      payload,
      readDefaultCopyMode(doc),
    );
    beginClipboardOperation(doc);
    event.preventDefault();
    writeDataTransfer(event.clipboardData, representations);
    view.dom.classList.remove("mlrt-document-cut-pending");
    setPendingClipboardCut(doc, {
      kind: "table",
      token,
      sourceDocument: readDocumentToken(doc),
      tableFrom: table.from,
      rectangle,
      sourceTableText: view.state.doc.sliceString(table.from, table.to),
    });
    setPendingCutToken(doc, token);
    markPendingCutSource(wrapper, rectangle);
    announce(
      doc,
      "Move pending. Paste in this document to move; external paste copies.",
    );
  };

  const onPaste = (event: ClipboardEvent): void => {
    if (!event.clipboardData) {
      return;
    }
    const selection = getTableRangeSelection(doc);
    const activeCell = findCell(event.target) ?? findCell(doc.activeElement);
    if (
      selection?.wrapper !== wrapper &&
      (!activeCell || !wrapper.contains(activeCell))
    ) {
      return;
    }
    const mode = armedPasteModes.get(doc) ?? readDefaultPasteMode(doc);
    armedPasteModes.delete(doc);
    const data = readDataTransfer(event.clipboardData);
    beginClipboardOperation(doc);
    const handled = pasteClipboardData(
      wrapper,
      view,
      currentTable(),
      data,
      mode,
      event.target,
    );
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const onClear = (event: Event): void => {
    const selection = getTableRangeSelection(doc);
    if (!selection || selection.wrapper !== wrapper) {
      return;
    }
    event.preventDefault();
    const table = currentTable();
    dispatchTableEdit(view, buildGridClearEdit(table, selectionRectangle(selection)));
    clearPendingClipboardCut(doc);
    setPendingCutToken(doc, undefined);
    view.dom.classList.remove("mlrt-document-cut-pending");
    restoreSelectionAfterEdit(doc, table.from, selection.anchor, selection.head);
    announce(doc, "Cleared selected cells.");
  };

  const onCancelCut = (event: Event): void => {
    const selection = getTableRangeSelection(doc);
    if (!selection || selection.wrapper !== wrapper) {
      return;
    }
    event.preventDefault();
    clearPendingClipboardCut(doc);
    setPendingCutToken(doc, undefined);
    announce(doc, "Pending move cancelled.");
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const selection = getTableRangeSelection(doc);
    if (
      !selection ||
      selection.wrapper !== wrapper ||
      (!event.metaKey && !event.ctrlKey) ||
      event.altKey
    ) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key !== "c" && key !== "x") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    // A focused table wrapper has no native DOM Range, so Chromium can route
    // Cmd/Ctrl+C to the workbench without ever producing a webview copy event.
    // Invoke the command while the trusted key gesture is active; our
    // copy/cut listeners then populate every clipboard representation.
    if (executeClipboardCommand(doc, key === "c" ? "copy" : "cut")) {
      return;
    }
    if (key === "c") {
      void copyThroughMenu(wrapper, currentTable(), readDefaultCopyMode(doc));
    } else {
      void cutThroughMenu(wrapper, view);
    }
  };

  const onContextMenu = (event: MouseEvent): void => {
    const currentSelection = getTableRangeSelection(doc);
    const cell =
      findCell(event.target) ??
      (currentSelection?.wrapper === wrapper
        ? cellFromAddress(wrapper, currentSelection.head)
        : null);
    if (!cell || !wrapper.contains(cell)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const nativeCellSelection = hasNativeCellSelection(cell);
    const nativeRange = nativeCellSelection
      ? doc.defaultView?.getSelection()?.getRangeAt(0).cloneRange() ?? null
      : null;
    const restoreNativeCellSelection = (): void => {
      if (!nativeRange || !cell.isConnected) {
        return;
      }
      cell.focus({ preventScroll: true });
      const nativeSelection = doc.defaultView?.getSelection();
      nativeSelection?.removeAllRanges();
      nativeSelection?.addRange(nativeRange);
    };
    if (!nativeCellSelection) {
      ensureContextCellSelection(
        wrapper,
        Number(wrapper.dataset.srcFrom ?? currentTable().from),
        cell,
      );
    }
    closeContextMenu();
    contextMenu = createClipboardMenu(doc, {
      defaultCopyMode: readDefaultCopyMode(doc),
      defaultPasteMode: readDefaultPasteMode(doc),
      cutLabel: nativeCellSelection
        ? "Cut selected text"
        : "Cut / Move within document",
      includePaste: !nativeCellSelection,
      onCut: () => {
        if (nativeCellSelection) {
          restoreNativeCellSelection();
          if (!executeClipboardCommand(doc, "cut")) {
            announce(doc, "Cut failed. Use Cmd/Ctrl+X.");
          }
        } else {
          wrapper.focus({ preventScroll: true });
          void cutThroughMenu(wrapper, view);
        }
      },
      onCopy: (mode) => {
        if (nativeCellSelection) {
          restoreNativeCellSelection();
        } else {
          wrapper.focus({ preventScroll: true });
        }
        void copyThroughMenu(wrapper, currentTable(), mode);
      },
      onPaste: (mode) => {
        wrapper.focus({ preventScroll: true });
        void pasteThroughMenu(wrapper, view, mode);
      },
      onSettings: () =>
        {
          wrapper.focus({ preventScroll: true });
          view.dom.dispatchEvent(
            new CustomEvent("mlrt:open-clipboard-settings", { bubbles: true }),
          );
        },
    });
    wrapper.classList.add("mlrt-clipboard-menu-open");
    contextMenu.addEventListener("click", () => setTimeout(closeContextMenu, 0), {
      once: true,
      capture: true,
    });
    contextMenu.addEventListener("keydown", (menuEvent) => {
      if (menuEvent.key === "Escape" || menuEvent.key === "Tab") {
        menuEvent.preventDefault();
        menuEvent.stopPropagation();
        closeContextMenu(true);
      }
    });
    doc.body.append(contextMenu);
    const cellRect = cell.getBoundingClientRect();
    positionContextMenu(
      contextMenu,
      doc,
      event.clientX || cellRect.left,
      event.clientY || cellRect.bottom,
    );
    contextMenu.querySelector<HTMLButtonElement>("button")?.focus();
    doc.addEventListener("pointerdown", onDocumentPointerDown, true);
  };

  const onDocumentPointerDown = (event: PointerEvent): void => {
    if (
      contextMenu &&
      event.target instanceof Node &&
      !contextMenu.contains(event.target)
    ) {
      closeContextMenu();
    }
  };

  const closeContextMenu = (restoreFocus = false): void => {
    contextMenu?.remove();
    contextMenu = null;
    wrapper.classList.remove("mlrt-clipboard-menu-open");
    doc.removeEventListener("pointerdown", onDocumentPointerDown, true);
    if (restoreFocus && wrapper.isConnected) {
      wrapper.focus({ preventScroll: true });
    }
  };

  // Clipboard events produced by a real keyboard shortcut may target the
  // document even while the non-editable selection wrapper has focus.
  // Capture at the document boundary and scope every operation back to this
  // wrapper so exactly one table serializer runs.
  doc.addEventListener("copy", onCopy, true);
  doc.addEventListener("cut", onCut, true);
  doc.addEventListener("paste", onPaste, true);
  wrapper.addEventListener("keydown", onKeyDown);
  wrapper.addEventListener(TABLE_SELECTION_CLEAR_EVENT, onClear);
  wrapper.addEventListener(TABLE_CUT_CANCEL_EVENT, onCancelCut);
  wrapper.addEventListener("contextmenu", onContextMenu);
  restorePendingCutSource(wrapper, currentTable());
  return () => {
    closeContextMenu();
    doc.removeEventListener("copy", onCopy, true);
    doc.removeEventListener("cut", onCut, true);
    doc.removeEventListener("paste", onPaste, true);
    wrapper.removeEventListener("keydown", onKeyDown);
    wrapper.removeEventListener(TABLE_SELECTION_CLEAR_EVENT, onClear);
    wrapper.removeEventListener(TABLE_CUT_CANCEL_EVENT, onCancelCut);
    wrapper.removeEventListener("contextmenu", onContextMenu);
  };
}

function representationsForCurrentSelection(
  doc: Document,
  table: ParsedTable,
  mode: ClipboardCopyMode,
): ClipboardRepresentations | null {
  const selection = getTableRangeSelection(doc);
  if (selection?.tableFrom === table.from) {
    return representationsForGrid(
      tableRectanglePayload(
        table,
        selectionRectangle(selection),
        readDocumentToken(doc),
      ),
      mode,
    );
  }
  const nativeSelection = doc.defaultView?.getSelection();
  if (!nativeSelection || nativeSelection.isCollapsed) {
    return null;
  }
  const plain = nativeSelection.toString().replace(/\u00a0/g, " ");
  if (mode === "markdown") {
    return { plain, markdown: plain };
  }
  if (mode === "plain") {
    return { plain };
  }
  return {
    plain,
    html: `<span>${escapeHtml(plain).replace(/\n/g, "<br>")}</span>`,
  };
}

function representationsForGrid(
  payload: ClipboardGridPayload,
  mode: ClipboardCopyMode,
): ClipboardRepresentations {
  const rows = payload.rows.map((row) => row.map((cell) => cell.text));
  const markdown = payload.exactMarkdown ??
    gridToMarkdown(payload.rows, payload.alignments);
  const cutPayload = payload.cutToken
    ? { privatePayload: JSON.stringify(payload) }
    : {};
  if (mode === "markdown") {
    return {
      plain: markdown,
      markdown,
      ...cutPayload,
      ...(payload.cutToken
        ? { html: metadataTextCarrierHtml(payload, markdown) }
        : {}),
    };
  }
  const plain = gridPlainTextForCopy(payload, mode);
  if (mode === "plain") {
    return {
      plain,
      ...cutPayload,
      ...(payload.cutToken
        ? { html: metadataTextCarrierHtml(payload, plain) }
        : {}),
    };
  }
  const privatePayload = JSON.stringify(payload);
  const embedded = encodePayloadForHtml(privatePayload);
  const renderedCells = mode === "rich" || mode === "smart"
    ? payload.rows.map((row) =>
        row.map((cell) => {
          return DOMPurify.sanitize(
            richCellRenderer.renderInline(cell.markdown?.trim() ?? cell.text),
            {
              ALLOWED_TAGS: OFFICE_RICH_CELL_ALLOWED_TAGS,
              ALLOWED_ATTR: OFFICE_RICH_CELL_ALLOWED_ATTR,
              ALLOW_UNKNOWN_PROTOCOLS: false,
            },
          );
        }),
      )
    : undefined;
  const htmlCells = renderedCells?.map((row) => row.map((cell) =>
    mode === "rich"
      ? officeCompatibleRichHtml(cell)
      : officeCompatibleSmartListHtml(cell) ?? undefined
  ));
  const html = gridToHtml(payload.rows, {
    alignments: payload.alignments,
    embeddedPayload: embedded,
    htmlCells,
    headerRow: payload.includesHeader,
  });
  return {
    plain,
    csv: serializeDelimitedGrid(rows, ","),
    html,
    privatePayload,
  };
}

function metadataTextCarrierHtml(
  payload: ClipboardGridPayload,
  text: string,
): string {
  const encoded = encodePayloadForHtml(JSON.stringify(payload));
  return `<meta name="mlrt-clipboard" content="${escapeHtml(encoded)}">` +
    `<pre style="white-space:pre-wrap">${escapeHtml(text)}</pre>`;
}

function pasteClipboardData(
  wrapper: HTMLElement,
  view: EditorView,
  table: ParsedTable,
  data: ClipboardReadData,
  mode: ClipboardPasteMode,
  eventTarget: EventTarget | null,
): boolean {
  const doc = wrapper.ownerDocument;
  const selection = getTableRangeSelection(doc);
  const candidateActiveCell =
    findCell(eventTarget) ?? findCell(doc.activeElement);
  const activeCell =
    candidateActiveCell && wrapper.contains(candidateActiveCell)
      ? candidateActiveCell
      : null;
  const pendingClipboardCut = getPendingClipboardCut(doc);
  const pendingTableCut =
    pendingClipboardCut?.kind === "table" ? pendingClipboardCut : null;
  const pendingDocumentCut =
    pendingClipboardCut?.kind === "document" ? pendingClipboardCut : null;
  const pendingCompositeCut =
    pendingClipboardCut?.kind === "composite" ? pendingClipboardCut : null;
  const availablePrivatePayload = parsePrivatePayload(data);
  const movePayload =
    pendingTableCut &&
    availablePrivatePayload?.kind === "grid" &&
    availablePrivatePayload.cutToken === pendingTableCut.token &&
    availablePrivatePayload.sourceDocument === pendingTableCut.sourceDocument &&
    pendingTableCut.sourceDocument === readDocumentToken(doc)
      ? availablePrivatePayload
      : null;
  const documentMovePayload =
    pendingDocumentCut &&
    availablePrivatePayload?.kind === "document" &&
    availablePrivatePayload.cutToken === pendingDocumentCut.token &&
    availablePrivatePayload.sourceDocument === pendingDocumentCut.sourceDocument &&
    availablePrivatePayload.markdown === pendingDocumentCut.markdown &&
    pendingDocumentCut.sourceDocument === readDocumentToken(doc)
      ? availablePrivatePayload
      : null;
  const compositeMovePayload =
    pendingCompositeCut &&
    availablePrivatePayload?.kind === "document" &&
    availablePrivatePayload.cutToken === pendingCompositeCut.token &&
    availablePrivatePayload.sourceDocument ===
      pendingCompositeCut.sourceDocument &&
    availablePrivatePayload.markdown === pendingCompositeCut.markdown &&
    pendingCompositeCut.sourceDocument === readDocumentToken(doc)
      ? availablePrivatePayload
      : null;
  const movingDocumentPayload =
    documentMovePayload ?? compositeMovePayload;
  const interpretationPayload =
    movePayload ?? (mode === "auto" ? availablePrivatePayload : null);
  const clearlyTabular =
    Boolean(interpretationPayload?.kind === "grid") ||
    Boolean(data.html && htmlContainsTable(data.html)) ||
    Boolean(data.plain?.includes("\t")) ||
    Boolean(data.csv) ||
    clipboardContainsMarkdownTable(data, mode);
  if (
    !selection &&
    activeCell &&
    !clearlyTabular &&
    !movingDocumentPayload
  ) {
    const text = singleCellPasteText(data, mode);
    return text === undefined
      ? false
      : dispatchCellPasteInput(activeCell, text);
  }
  const parsed = movingDocumentPayload
    ? rowsForDocumentMove(movingDocumentPayload.markdown)
    : clipboardRows(data, mode, interpretationPayload);
  if (!parsed) {
    if (selection?.wrapper === wrapper) {
      announce(doc, "Clipboard does not contain pasteable table data.");
      return true;
    }
    return false;
  }
  const destination = selection?.wrapper === wrapper
    ? selectionRectangle(selection)
    : activeCell
      ? singleCellRectangle(addressFromCell(activeCell))
      : null;
  if (!destination) {
    return false;
  }
  const isTableMove = Boolean(movePayload && pendingTableCut);
  const isDocumentMove = Boolean(documentMovePayload && pendingDocumentCut);
  const isCompositeMove = Boolean(compositeMovePayload && pendingCompositeCut);
  const isSameDocumentMove = isTableMove || isDocumentMove || isCompositeMove;
  if (
    isSameDocumentMove &&
    !moveDestinationMatchesSource(destination, parsed)
  ) {
    announce(
      doc,
      "Move rejected: select one destination cell or a range matching the cut range.",
    );
    return true;
  }
  const resolvedRows = resolveGridPasteRows(parsed, destination);
  if (!resolvedRows) {
    announce(
      doc,
      "Paste rejected: the copied range must match or tile the selected range.",
    );
    return true;
  }

  if (
    isSameDocumentMove &&
    isTableMove &&
    pendingTableCut &&
    pendingTableCut.tableFrom === table.from &&
    rectanglesOverlap(
      pendingTableCut.rectangle,
      pasteOutputRectangle(destination, resolvedRows),
    )
  ) {
    announce(doc, "Move rejected: source and destination ranges overlap.");
    return true;
  }

  const targetPlan = {
    rows: resolvedRows,
    sourceAlignments:
      movingDocumentPayload
        ? alignmentsForDocumentMove(movingDocumentPayload.markdown)
        : interpretationPayload?.kind === "grid"
        ? interpretationPayload.alignments
        : undefined,
    destination: {
      ...destination,
      bottom: destination.top + resolvedRows.length - 1,
      right: destination.left + resolvedRows[0].length - 1,
    },
  };

  let destinationTableFrom = table.from;
  if (isTableMove && pendingTableCut) {
    const movedTableFrom = dispatchMove(
      view,
      table,
      targetPlan,
      pendingTableCut,
    );
    if (movedTableFrom === null) {
      announce(doc, "Move cancelled because the source changed.");
      clearPendingClipboardCut(doc);
      setPendingCutToken(doc, undefined);
      return true;
    }
    destinationTableFrom = movedTableFrom;
  } else if (isDocumentMove && pendingDocumentCut) {
    if (
      view.state.doc.sliceString(
        pendingDocumentCut.from,
        pendingDocumentCut.to,
      ) !== pendingDocumentCut.markdown
    ) {
      announce(doc, "Move cancelled because the cut source changed.");
      clearPendingClipboardCut(doc);
      view.dom.classList.remove("mlrt-document-cut-pending");
      return true;
    }
    if (
      rangesOverlap(
        { from: pendingDocumentCut.from, to: pendingDocumentCut.to },
        { from: table.from, to: table.to },
      )
    ) {
      announce(doc, "Move rejected: choose a table outside the cut source.");
      return true;
    }
    const movedTableFrom = dispatchDocumentMoveToTable(
      view,
      table,
      targetPlan,
      pendingDocumentCut,
    );
    if (movedTableFrom === null) {
      announce(doc, "Move cancelled because the source changed or overlaps the destination.");
      clearPendingClipboardCut(doc);
      view.dom.classList.remove("mlrt-document-cut-pending");
      return true;
    }
    destinationTableFrom = movedTableFrom;
  } else if (isCompositeMove && pendingCompositeCut) {
    if (view.state.doc.toString() !== pendingCompositeCut.sourceDocumentText) {
      announce(doc, "Move cancelled because the cut source changed.");
      clearPendingClipboardCut(doc);
      view.dom.classList.remove("mlrt-document-cut-pending");
      return true;
    }
    if (
      pendingCompositeCut.changes.some((change) =>
        rangesOverlap(change, { from: table.from, to: table.to }),
      )
    ) {
      announce(doc, "Move rejected: choose a table outside the cut source.");
      return true;
    }
    const movedTableFrom = dispatchCompositeMoveToTable(
      view,
      table,
      targetPlan,
      pendingCompositeCut,
    );
    if (movedTableFrom === null) {
      announce(
        doc,
        "Move cancelled because the source changed or overlaps the destination.",
      );
      clearPendingClipboardCut(doc);
      view.dom.classList.remove("mlrt-document-cut-pending");
      return true;
    }
    destinationTableFrom = movedTableFrom;
  } else {
    dispatchTableEdit(view, buildGridPasteEdit(table, targetPlan));
  }

  clearPendingClipboardCut(doc);
  view.dom.classList.remove("mlrt-document-cut-pending");
  setPendingCutToken(doc, undefined);
  const anchor = { row: targetPlan.destination.top, column: targetPlan.destination.left };
  const head = { row: targetPlan.destination.bottom, column: targetPlan.destination.right };
  restoreSelectionAfterEdit(doc, destinationTableFrom, anchor, head);
  announce(doc, isSameDocumentMove ? "Moved cells." : "Pasted cells.");
  return true;
}

function dispatchMove(
  view: EditorView,
  destinationTable: ParsedTable,
  targetPlan: Parameters<typeof buildGridPasteEdit>[1],
  pendingCut: PendingTableCut,
): number | null {
  const tables = getParsedTables(view.state.doc);
  const sourceTable = tables.find((candidate) => candidate.from === pendingCut.tableFrom);
  const sourcePayload = sourceTable
    ? tableRectanglePayload(
        sourceTable,
        pendingCut.rectangle,
        pendingCut.sourceDocument,
      )
    : null;
  if (
    !sourceTable ||
    !sourcePayload ||
    view.state.doc.sliceString(sourceTable.from, sourceTable.to) !==
      pendingCut.sourceTableText ||
    !sameGridText(sourcePayload.rows, targetPlan.rows)
  ) {
    return null;
  }
  const safeTargetPlan = {
    ...targetPlan,
    rows: sourcePayload.rows,
    sourceAlignments: sourcePayload.alignments,
  };
  if (sourceTable.from === destinationTable.from) {
    const cleared = buildGridClearEdit(sourceTable, pendingCut.rectangle);
    const clearedTable = parseMarkdownTables(cleared.insert)[0];
    if (!clearedTable) {
      return null;
    }
    const pasted = buildGridPasteEdit(clearedTable, safeTargetPlan);
    dispatchTableEdit(view, {
      from: sourceTable.from,
      to: sourceTable.to,
      insert: pasted.insert,
    });
    return sourceTable.from;
  }
  const sourceEdit = buildGridClearEdit(sourceTable, pendingCut.rectangle);
  const destinationEdit = buildGridPasteEdit(destinationTable, safeTargetPlan);
  const changeSpecs = [sourceEdit, destinationEdit]
    .sort((left, right) => left.from - right.from)
    .map((edit) => ({ from: edit.from, to: edit.to, insert: edit.insert }));
  const changes = view.state.changes(changeSpecs);
  const destinationTableFrom = changes.mapPos(destinationTable.from, -1);
  view.dispatch({
    changes,
    annotations: [
      allowTableSourceChange.of(true),
      Transaction.addToHistory.of(true),
    ],
    userEvent: "input.paste",
  });
  return destinationTableFrom;
}

function dispatchDocumentMoveToTable(
  view: EditorView,
  destinationTable: ParsedTable,
  targetPlan: Parameters<typeof buildGridPasteEdit>[1],
  pendingCut: PendingDocumentCut,
): number | null {
  if (
    view.state.doc.sliceString(pendingCut.from, pendingCut.to) !==
      pendingCut.markdown ||
    rangesOverlap(
      { from: pendingCut.from, to: pendingCut.to },
      { from: destinationTable.from, to: destinationTable.to },
    )
  ) {
    return null;
  }
  const destinationEdit = buildGridPasteEdit(destinationTable, targetPlan);
  const changeSpecs = [
    { from: pendingCut.from, to: pendingCut.to, insert: "" },
    destinationEdit,
  ]
    .sort((left, right) => left.from - right.from)
    .map((edit) => ({ from: edit.from, to: edit.to, insert: edit.insert }));
  const changes = view.state.changes(changeSpecs);
  const destinationTableFrom = changes.mapPos(destinationTable.from, -1);
  view.dispatch({
    changes,
    annotations: [
      allowTableSourceChange.of(true),
      Transaction.addToHistory.of(true),
    ],
    userEvent: "input.paste",
  });
  return destinationTableFrom;
}

function dispatchCompositeMoveToTable(
  view: EditorView,
  destinationTable: ParsedTable,
  targetPlan: Parameters<typeof buildGridPasteEdit>[1],
  pendingCut: PendingCompositeCut,
): number | null {
  if (
    view.state.doc.toString() !== pendingCut.sourceDocumentText ||
    !sameGridText(rowsForDocumentMove(pendingCut.markdown), targetPlan.rows) ||
    pendingCut.changes.some((change) =>
      rangesOverlap(change, {
        from: destinationTable.from,
        to: destinationTable.to,
      }),
    )
  ) {
    return null;
  }

  const destinationEdit = buildGridPasteEdit(destinationTable, targetPlan);
  const changeSpecs = [...pendingCut.changes, destinationEdit]
    .map((edit) => ({ from: edit.from, to: edit.to, insert: edit.insert }))
    .sort((left, right) => left.from - right.from || left.to - right.to);
  for (let index = 1; index < changeSpecs.length; index++) {
    if (changeSpecs[index - 1].to > changeSpecs[index].from) {
      return null;
    }
  }
  const changes = view.state.changes(changeSpecs);
  const destinationTableFrom = changes.mapPos(destinationTable.from, -1);
  view.dispatch({
    changes,
    annotations: [
      allowTableSourceChange.of(true),
      Transaction.addToHistory.of(true),
    ],
    userEvent: "input.paste",
  });
  return destinationTableFrom;
}

function dispatchTableEdit(
  view: EditorView,
  edit: { from: number; to: number; insert: string },
): void {
  // CodeMirror treats an identical replacement as a document change even
  // though the resulting text is unchanged. Letting that transaction reach
  // the extension host makes VS Code mark the document dirty until its text
  // is reconciled. This is most visible when Delete clears a selection that
  // already contains only empty cells.
  if (view.state.doc.sliceString(edit.from, edit.to) === edit.insert) {
    return;
  }
  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    annotations: [
      allowTableSourceChange.of(true),
      Transaction.addToHistory.of(true),
    ],
    userEvent: "input.paste",
  });
}

function clipboardRows(
  data: ClipboardReadData,
  mode: ClipboardPasteMode,
  payload: MlrtClipboardPayload | null,
): ClipboardCell[][] | null {
  if (payload?.kind === "grid") {
    return payload.rows;
  }
  if ((mode === "auto" || mode === "rich") && data.html) {
    const htmlRows = rowsFromHtmlTable(data.html, mode === "rich");
    if (htmlRows) {
      return htmlRows;
    }
  }
  if (mode === "plain") {
    return data.plain === undefined
      ? null
      : stringsToCells(parseDelimitedGrid(data.plain, "\t"));
  }
  const markdown = mode === "markdown"
    ? data.markdown ?? data.plain
    : data.markdown;
  if (markdown) {
    const markdownTable = parseMarkdownTables(markdown)[0];
    if (markdownTable) {
      return [markdownTable.header, ...markdownTable.body].map((row) =>
        Array.from({ length: markdownTable.columnCount }, (_, column) => ({
          text: markdownCellToDisplayText(row.cells[column]?.raw ?? ""),
          markdown: row.cells[column]?.raw,
        })),
      );
    }
  }
  if (mode === "markdown") {
    return markdown === undefined
      ? null
      : stringsToCells(parseDelimitedGrid(markdown, "\t"));
  }
  if (data.csv && !data.plain?.includes("\t")) {
    return stringsToCells(parseDelimitedGrid(data.csv, ","));
  }
  if (data.plain !== undefined) {
    return stringsToCells(parseDelimitedGrid(data.plain, "\t"));
  }
  if (payload?.kind === "document") {
    return [[{ text: payload.markdown }]];
  }
  return null;
}

function rowsForDocumentMove(markdown: string): ClipboardCell[][] {
  const table = exactDocumentMoveTable(markdown);
  if (!table) {
    return [[{ text: markdown }]];
  }
  return [table.header, ...table.body].map((row) =>
    Array.from({ length: table.columnCount }, (_, column) => ({
      text: markdownCellToDisplayText(row.cells[column]?.raw ?? ""),
      markdown: row.cells[column]?.raw,
    })),
  );
}

function alignmentsForDocumentMove(
  markdown: string,
): ParsedTable["alignments"] | undefined {
  return exactDocumentMoveTable(markdown)?.alignments;
}

function exactDocumentMoveTable(markdown: string): ParsedTable | null {
  const tables = parseMarkdownTables(markdown);
  if (tables.length !== 1) {
    return null;
  }
  const table = tables[0];
  return markdown.slice(0, table.from).trim().length === 0 &&
      markdown.slice(table.to).trim().length === 0
    ? table
    : null;
}

function rowsFromHtmlTable(
  html: string,
  preserveFormatting: boolean,
): ClipboardCell[][] | null {
  const sanitized = DOMPurify.sanitize(html, {
    FORBID_TAGS: ["script", "style", "meta", "link", "object", "embed", "iframe"],
    FORBID_ATTR: ["src", "srcset", "onload", "onclick", "onerror"],
  });
  const parsed = new DOMParser().parseFromString(sanitized, "text/html");
  const table = parsed.querySelector("table");
  if (!table) {
    return null;
  }
  const rows: ClipboardCell[][] = [];
  Array.from(table.rows).forEach((row, rowIndex) => {
    rows[rowIndex] ??= [];
    let column = 0;
    Array.from(row.cells).forEach((cell) => {
      while (rows[rowIndex][column] !== undefined) {
        column++;
      }
      const text = htmlCellText(cell);
      const markdown = preserveFormatting
        ? richHtmlCellMarkdown(cell)
        : undefined;
      const rowSpan = Math.max(1, cell.rowSpan || 1);
      const columnSpan = Math.max(1, cell.colSpan || 1);
      for (let rowOffset = 0; rowOffset < rowSpan; rowOffset++) {
        rows[rowIndex + rowOffset] ??= [];
        for (let columnOffset = 0; columnOffset < columnSpan; columnOffset++) {
          const primaryCell = rowOffset === 0 && columnOffset === 0;
          rows[rowIndex + rowOffset][column + columnOffset] = {
            text: primaryCell ? text : "",
            ...(primaryCell && markdown !== undefined ? { markdown } : {}),
          };
        }
      }
      column += columnSpan;
    });
  });
  if (rows.length === 0) {
    return null;
  }
  const width = Math.max(...rows.map((row) => row.length));
  return rows.map((row) =>
    Array.from(
      { length: width },
      (_, column): ClipboardCell => row[column] ?? { text: "" },
    ),
  );
}

function htmlCellText(cell: HTMLTableCellElement): string {
  const visibleText = htmlFragmentVisibleText(cell.innerHTML);
  if (visibleText !== undefined) {
    return visibleText;
  }
  return (cell.textContent ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n");
}

function richHtmlCellMarkdown(cell: HTMLTableCellElement): string {
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
  const source = clone.textContent ?? "";
  const uniqueToken = (label: string): string => {
    let token = `MLRTRICHCELL${label}TOKENX`;
    while (source.includes(token)) {
      token += "X";
    }
    return token;
  };
  const slashToken = uniqueToken("BACKSLASH");
  const breakToken = uniqueToken("LINEBREAK");
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
  const markdown = richCellTurndown.turndown(clone.innerHTML)
    .trim()
    .replace(/\r\n?/g, "\n")
    .split(breakToken).join("\n")
    .split(slashToken).join("\\");
  return importedMarkdownToTableCellSource(markdown);
}

function parsePrivatePayload(data: ClipboardReadData): MlrtClipboardPayload | null {
  if (data.privatePayload) {
    const direct = parseClipboardPayload(data.privatePayload);
    if (direct) {
      return direct;
    }
  }
  if (!data.html) {
    return null;
  }
  const parsed = new DOMParser().parseFromString(data.html, "text/html");
  const encoded = parsed.querySelector<HTMLMetaElement>(HTML_METADATA_SELECTOR)?.content;
  if (!encoded) {
    return null;
  }
  const decoded = decodePayloadFromHtml(encoded);
  return decoded ? parseClipboardPayload(decoded) : null;
}

function writeDataTransfer(
  transfer: DataTransfer,
  representations: ClipboardRepresentations,
): void {
  transfer.setData("text/plain", representations.plain);
  if (representations.html) {
    transfer.setData("text/html", representations.html);
  }
  if (representations.markdown) {
    transfer.setData("text/markdown", representations.markdown);
  }
  if (representations.csv) {
    transfer.setData("text/csv", representations.csv);
  }
  if (representations.privatePayload) {
    transfer.setData(MLRT_CLIPBOARD_MIME, representations.privatePayload);
  }
}

function readDataTransfer(transfer: DataTransfer): ClipboardReadData {
  return {
    privatePayload: readDataTransferType(transfer, MLRT_CLIPBOARD_MIME),
    html: readDataTransferType(transfer, "text/html"),
    markdown: readDataTransferType(transfer, "text/markdown"),
    csv: readDataTransferType(transfer, "text/csv"),
    plain: readDataTransferType(transfer, "text/plain", true),
  };
}

function readDataTransferType(
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

async function copyThroughMenu(
  wrapper: HTMLElement,
  table: ParsedTable,
  mode: ClipboardCopyMode,
): Promise<void> {
  const doc = wrapper.ownerDocument;
  const representations = representationsForCurrentSelection(doc, table, mode);
  if (!representations) {
    announce(doc, "Nothing selected to copy.");
    return;
  }
  requestedMenuCopies.set(doc, { wrapper, mode, representations });
  executeClipboardCommandWithCarrier(doc, "copy", representations.plain);
  // execCommand can report success without dispatching a copy event. The
  // request is deleted only by onCopy after it has written the chosen mode.
  if (!requestedMenuCopies.has(doc)) {
    return;
  }
  requestedMenuCopies.delete(doc);
  const operationVersion = beginClipboardOperation(doc);
  try {
    await writeAsyncClipboard(representations);
    if (!isCurrentClipboardOperation(doc, operationVersion)) {
      return;
    }
    clearPendingClipboardCut(doc);
    setPendingCutToken(doc, undefined);
    doc.querySelector(".cm-editor")?.classList.remove(
      "mlrt-document-cut-pending",
    );
    announce(doc, `Copied as ${COPY_MODE_LABELS[mode]}.`);
  } catch {
    if (isCurrentClipboardOperation(doc, operationVersion)) {
      announce(doc, "Copy failed. Use Cmd/Ctrl+C.");
    }
  }
}

async function cutThroughMenu(
  wrapper: HTMLElement,
  view: EditorView,
): Promise<void> {
  const doc = wrapper.ownerDocument;
  const selection = getTableRangeSelection(doc);
  const table = getTableWidgetTable(wrapper);
  if (!selection || selection.wrapper !== wrapper || !table) {
    announce(doc, "Nothing selected to move.");
    return;
  }
  const token = createToken();
  const rectangle = selectionRectangle(selection);
  const sourceTableText = view.state.doc.sliceString(table.from, table.to);
  const sourceDocument = readDocumentToken(doc);
  const representations = representationsForGrid(
    tableRectanglePayload(
      table,
      rectangle,
      sourceDocument,
      token,
    ),
    readDefaultCopyMode(doc),
  );
  if (executeClipboardCommandWithCarrier(doc, "cut", representations.plain)) {
    return;
  }
  if (!representations.html) {
    representations.html = representationsForGrid(
      tableRectanglePayload(table, rectangle, sourceDocument, token),
      "smart",
    ).html;
  }
  const operationVersion = beginClipboardOperation(doc);
  try {
    await writeAsyncClipboard(representations);
  } catch {
    if (isCurrentClipboardOperation(doc, operationVersion)) {
      announce(doc, "Move could not access the clipboard. Use Cmd/Ctrl+X.");
    }
    return;
  }
  if (!isCurrentClipboardOperation(doc, operationVersion)) {
    return;
  }
  const currentSelection = getTableRangeSelection(doc);
  const currentTable = getTableWidgetTable(wrapper);
  if (
    !wrapper.isConnected ||
    !currentTable ||
    !sameSelection(currentSelection, wrapper, selection) ||
    view.state.doc.sliceString(currentTable.from, currentTable.to) !==
      sourceTableText
  ) {
    announce(doc, "Copied, but move was cancelled because the source changed.");
    return;
  }
  view.dom.classList.remove("mlrt-document-cut-pending");
  setPendingClipboardCut(doc, {
    kind: "table",
    token,
    sourceDocument,
    tableFrom: currentTable.from,
    rectangle,
    sourceTableText,
  });
  setPendingCutToken(doc, token);
  markPendingCutSource(wrapper, rectangle);
  announce(
    doc,
    "Move pending. Paste in this document to move; external paste copies.",
  );
}

async function pasteThroughMenu(
  wrapper: HTMLElement,
  view: EditorView,
  mode: ClipboardPasteMode,
): Promise<void> {
  const doc = wrapper.ownerDocument;
  const selection = getTableRangeSelection(doc);
  const table = getTableWidgetTable(wrapper);
  if (!selection || selection.wrapper !== wrapper || !table) {
    announce(doc, "Select a destination range before pasting.");
    return;
  }
  const tableText = view.state.doc.sliceString(table.from, table.to);
  const operationVersion = beginClipboardOperation(doc);
  try {
    const data = await readAsyncClipboard();
    if (!isCurrentClipboardOperation(doc, operationVersion)) {
      return;
    }
    const currentSelection = getTableRangeSelection(doc);
    const currentTable = getTableWidgetTable(wrapper);
    if (
      !wrapper.isConnected ||
      !currentTable ||
      !sameSelection(currentSelection, wrapper, selection) ||
      view.state.doc.sliceString(currentTable.from, currentTable.to) !== tableText
    ) {
      announce(doc, "Paste cancelled because the destination changed.");
      return;
    }
    if (!pasteClipboardData(wrapper, view, currentTable, data, mode, wrapper)) {
      announce(doc, "Clipboard does not contain pasteable data.");
    }
  } catch {
    if (!isCurrentClipboardOperation(doc, operationVersion)) {
      return;
    }
    armedPasteModes.set(doc, mode);
    announce(
      doc,
      `Paste as ${PASTE_MODE_LABELS[mode]} armed — press Cmd/Ctrl+V.`,
    );
  }
}

async function writeAsyncClipboard(
  representations: ClipboardRepresentations,
): Promise<void> {
  if (!navigator.clipboard) {
    throw new Error("Async clipboard unavailable");
  }
  if (
    !navigator.clipboard.write ||
    typeof ClipboardItem === "undefined"
  ) {
    await navigator.clipboard.writeText(representations.plain);
    return;
  }
  const data: Record<string, Blob> = {
    "text/plain": new Blob([representations.plain], { type: "text/plain" }),
  };
  if (representations.html) {
    data["text/html"] = new Blob([representations.html], { type: "text/html" });
  }
  const requiredData = { ...data };
  const supports = (
    ClipboardItem as typeof ClipboardItem & {
      supports?: (type: string) => boolean;
    }
  ).supports;
  if (representations.csv && supports?.("text/csv")) {
    data["text/csv"] = new Blob([representations.csv], { type: "text/csv" });
  }
  if (representations.markdown && supports?.("text/markdown")) {
    data["text/markdown"] = new Blob([representations.markdown], {
      type: "text/markdown",
    });
  }
  try {
    await navigator.clipboard.write([new ClipboardItem(data)]);
  } catch (error) {
    // ClipboardItem.supports can overstate platform support in Windows
    // webviews. Retry without optional formats before giving up rich HTML.
    if (Object.keys(data).length > Object.keys(requiredData).length) {
      try {
        await navigator.clipboard.write([new ClipboardItem(requiredData)]);
        return;
      } catch {
        // Fall through to the mandatory plain-text API below.
      }
    }
    try {
      await navigator.clipboard.writeText(representations.plain);
    } catch {
      throw error;
    }
  }
}

async function readAsyncClipboard(): Promise<ClipboardReadData> {
  if (!navigator.clipboard?.read) {
    throw new Error("Async clipboard unavailable");
  }
  const items = await navigator.clipboard.read();
  const item = items[0];
  if (!item) {
    return {};
  }
  const read = async (type: string): Promise<string | undefined> => {
    if (!item.types.includes(type)) {
      return undefined;
    }
    return (await item.getType(type)).text();
  };
  return {
    privatePayload: await read(MLRT_CLIPBOARD_MIME),
    html: await read("text/html"),
    markdown: await read("text/markdown"),
    csv: await read("text/csv"),
    plain: await read("text/plain"),
  };
}

function createClipboardMenu(
  doc: Document,
  actions: {
    defaultCopyMode: ClipboardCopyMode;
    defaultPasteMode: ClipboardPasteMode;
    cutLabel: string;
    includePaste: boolean;
    onCut: () => void;
    onCopy: (mode: ClipboardCopyMode) => void;
    onPaste: (mode: ClipboardPasteMode) => void;
    onSettings: () => void;
  },
): HTMLElement {
  const menu = doc.createElement("div");
  menu.className = CLIPBOARD_MENU_CLASS;
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Table clipboard actions");
  const add = (label: string, action: string, callback: () => void): void => {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "mlrt-clipboard-menu-item";
    button.dataset.action = action;
    button.setAttribute("role", "menuitem");
    button.textContent = label;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      menu.remove();
      callback();
    });
    button.addEventListener("keydown", (event) => navigateMenu(event, menu));
    menu.append(button);
  };
  const separator = (): void => {
    const element = doc.createElement("div");
    element.className = "mlrt-clipboard-menu-separator";
    element.setAttribute("role", "separator");
    menu.append(element);
  };
  add(actions.cutLabel, "cut", actions.onCut);
  add(
    `Copy (${COPY_MODE_LABELS[actions.defaultCopyMode]})`,
    "copy-default",
    () => actions.onCopy(actions.defaultCopyMode),
  );
  (Object.keys(COPY_MODE_LABELS) as ClipboardCopyMode[]).forEach((mode) =>
    add(`Copy ${COPY_MODE_LABELS[mode]}`, `copy-${mode}`, () => actions.onCopy(mode)),
  );
  if (actions.includePaste) {
    separator();
    add(
      `Paste (${PASTE_MODE_LABELS[actions.defaultPasteMode]})`,
      "paste-default",
      () => actions.onPaste(actions.defaultPasteMode),
    );
    (Object.keys(PASTE_MODE_LABELS) as ClipboardPasteMode[]).forEach((mode) =>
      add(`Paste ${PASTE_MODE_LABELS[mode]}`, `paste-${mode}`, () => actions.onPaste(mode)),
    );
  }
  separator();
  add("Clipboard Settings…", "settings", actions.onSettings);
  const items = Array.from(
    menu.querySelectorAll<HTMLButtonElement>("button"),
  );
  items.forEach((item, index) => {
    item.tabIndex = index === 0 ? 0 : -1;
  });
  return menu;
}

function navigateMenu(event: KeyboardEvent, menu: HTMLElement): void {
  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>("button"));
  const index = items.indexOf(event.currentTarget as HTMLButtonElement);
  if (event.key === "Escape") {
    return;
  }
  if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    const target = event.key === "Home" ? items[0] : items[items.length - 1];
    items.forEach((item) => {
      item.tabIndex = item === target ? 0 : -1;
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
  items.forEach((item) => {
    item.tabIndex = item === target ? 0 : -1;
  });
  target?.focus();
}

function positionContextMenu(
  menu: HTMLElement,
  doc: Document,
  clientX: number,
  clientY: number,
): void {
  const viewport = doc.documentElement.getBoundingClientRect();
  const padding = 4;
  const left = Math.min(
    Math.max(padding, clientX),
    Math.max(padding, viewport.width - menu.offsetWidth - padding),
  );
  const below = clientY;
  const above = clientY - menu.offsetHeight;
  const top = below + menu.offsetHeight <= viewport.height - padding
    ? below
    : Math.max(padding, above);
  menu.style.position = "fixed";
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function restoreSelectionAfterEdit(
  doc: Document,
  previousTableFrom: number,
  anchor: TableCellAddress,
  head: TableCellAddress,
): void {
  setTimeout(() => {
    const wrapper = Array.from(
      doc.querySelectorAll<HTMLElement>(".mlrt-table-widget"),
    ).find(
      (candidate) =>
        Number(candidate.dataset.srcFrom ?? "-1") === previousTableFrom,
    );
    if (!wrapper) {
      return;
    }
    setTableRangeSelection(wrapper, previousTableFrom, anchor, head, true);
  }, 0);
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
    if (status) {
      status.textContent = message;
      status.dataset.visible = "true";
      setTimeout(() => {
        if (status?.textContent === message) {
          delete status.dataset.visible;
        }
      }, 2400);
    }
  });
}

function readDefaultCopyMode(doc: Document): ClipboardCopyMode {
  const value = doc.documentElement.dataset.mlrtDefaultCopyMode;
  return value === "rich" || value === "plain" || value === "markdown"
    ? value
    : "smart";
}

function readDefaultPasteMode(doc: Document): ClipboardPasteMode {
  const value = doc.documentElement.dataset.mlrtDefaultPasteMode;
  return value === "rich" || value === "plain" || value === "markdown"
    ? value
    : "auto";
}

function readDocumentToken(doc: Document): string {
  return doc.documentElement.dataset.mlrtDocumentToken ?? "";
}

function beginClipboardOperation(doc: Document): number {
  const version = (clipboardOperationVersions.get(doc) ?? 0) + 1;
  clipboardOperationVersions.set(doc, version);
  return version;
}

function isCurrentClipboardOperation(doc: Document, version: number): boolean {
  return clipboardOperationVersions.get(doc) === version;
}

function executeClipboardCommand(
  doc: Document,
  command: "copy" | "cut",
): boolean {
  try {
    return doc.execCommand(command);
  } catch {
    return false;
  }
}

/**
 * Programmatic copy/cut on Windows needs a real DOM selection even though a
 * table rectangle is source-backed and intentionally owns no native Range.
 * The temporary textarea supplies that selection during the trusted menu
 * click; capture listeners still replace its value with every requested MIME
 * representation before the browser writes the system clipboard.
 */
function executeClipboardCommandWithCarrier(
  doc: Document,
  command: "copy" | "cut",
  plain: string,
): boolean {
  const activeElement = doc.activeElement instanceof HTMLElement
    ? doc.activeElement
    : null;
  const selection = doc.defaultView?.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) =>
        selection.getRangeAt(index).cloneRange())
    : [];
  const carrier = doc.createElement("textarea");
  carrier.value = plain;
  carrier.readOnly = true;
  carrier.tabIndex = -1;
  carrier.setAttribute("aria-hidden", "true");
  carrier.style.cssText = [
    "position:fixed",
    "left:-10000px",
    "top:0",
    "width:1px",
    "height:1px",
    "opacity:0",
    "pointer-events:none",
  ].join(";");
  doc.body.append(carrier);

  let eventDispatched = false;
  const markDispatched = (): void => {
    eventDispatched = true;
  };
  doc.addEventListener(command, markDispatched, { capture: true, once: true });
  carrier.focus({ preventScroll: true });
  carrier.select();
  executeClipboardCommand(doc, command);
  doc.removeEventListener(command, markDispatched, true);
  carrier.remove();

  if (activeElement?.isConnected) {
    activeElement.focus({ preventScroll: true });
  }
  if (selection && ranges.length > 0) {
    selection.removeAllRanges();
    ranges.forEach((range) => selection.addRange(range));
  }
  // Chromium can report success without dispatching a clipboard event. Only
  // the event proves our listener populated the system clipboard; callers can
  // otherwise use the async fallback.
  return eventDispatched;
}

function stringsToCells(rows: string[][] | null): ClipboardCell[][] | null {
  return rows?.map((row) => row.map((text) => ({ text }))) ?? null;
}

function singleCellRectangle(address: TableCellAddress | null): CellRectangle | null {
  return address
    ? { top: address.row, bottom: address.row, left: address.column, right: address.column }
    : null;
}

function pasteOutputRectangle(
  destination: CellRectangle,
  rows: ClipboardCell[][],
): CellRectangle {
  return {
    top: destination.top,
    bottom: destination.top + rows.length - 1,
    left: destination.left,
    right: destination.left + rows[0].length - 1,
  };
}

function rectanglesOverlap(left: CellRectangle, right: CellRectangle): boolean {
  return !(
    left.right < right.left ||
    right.right < left.left ||
    left.bottom < right.top ||
    right.bottom < left.top
  );
}

function rangesOverlap(
  left: { from: number; to: number },
  right: { from: number; to: number },
): boolean {
  return left.from < right.to && right.from < left.to;
}

function moveDestinationMatchesSource(
  destination: CellRectangle,
  rows: ClipboardCell[][],
): boolean {
  const destinationHeight = destination.bottom - destination.top + 1;
  const destinationWidth = destination.right - destination.left + 1;
  return (
    (destinationHeight === 1 && destinationWidth === 1) ||
    (destinationHeight === rows.length &&
      destinationWidth === (rows[0]?.length ?? 0))
  );
}

function clipboardContainsMarkdownTable(
  data: ClipboardReadData,
  mode: ClipboardPasteMode,
): boolean {
  if (mode === "plain") {
    return false;
  }
  const markdown = mode === "markdown"
    ? data.markdown ?? data.plain
    : data.markdown;
  return Boolean(markdown && parseMarkdownTables(markdown).length > 0);
}

function sameSelection(
  current: TableRangeSelectionState | null,
  wrapper: HTMLElement,
  expected: TableRangeSelectionState,
): boolean {
  return Boolean(
    current?.wrapper === wrapper &&
      current.anchor.row === expected.anchor.row &&
      current.anchor.column === expected.anchor.column &&
      current.head.row === expected.head.row &&
      current.head.column === expected.head.column,
  );
}

function hasNativeCellSelection(cell: HTMLElement): boolean {
  const selection = cell.ownerDocument.defaultView?.getSelection();
  return Boolean(
    selection &&
      !selection.isCollapsed &&
      cell.contains(selection.anchorNode) &&
      cell.contains(selection.focusNode),
  );
}

function sameGridText(
  left: readonly (readonly ClipboardCell[])[],
  right: readonly (readonly ClipboardCell[])[],
): boolean {
  return left.length === right.length &&
    left.every(
      (row, rowIndex) =>
        row.length === right[rowIndex]?.length &&
        row.every(
          (cell, column) => cell.text === right[rowIndex]?.[column]?.text,
        ),
    );
}

function restorePendingCutSource(
  wrapper: HTMLElement,
  table: ParsedTable,
): void {
  const pending = getPendingClipboardCut(wrapper.ownerDocument);
  if (pending?.kind === "table" && pending.tableFrom === table.from) {
    markPendingCutSource(wrapper, pending.rectangle);
  }
}

function markPendingCutSource(
  wrapper: HTMLElement,
  rectangle: CellRectangle,
): void {
  wrapper.classList.add("mlrt-table-cut-source-pending");
  wrapper.querySelectorAll<HTMLElement>(TABLE_CELL_SELECTOR).forEach((cell) => {
    const address = addressFromCell(cell);
    const selected = Boolean(
      address &&
        address.row >= rectangle.top &&
        address.row <= rectangle.bottom &&
        address.column >= rectangle.left &&
        address.column <= rectangle.right,
    );
    cell.classList.toggle("mlrt-table-cut-source", selected);
    cell.classList.toggle(
      "mlrt-table-cut-source-top",
      selected && address?.row === rectangle.top,
    );
    cell.classList.toggle(
      "mlrt-table-cut-source-right",
      selected && address?.column === rectangle.right,
    );
    cell.classList.toggle(
      "mlrt-table-cut-source-bottom",
      selected && address?.row === rectangle.bottom,
    );
    cell.classList.toggle(
      "mlrt-table-cut-source-left",
      selected && address?.column === rectangle.left,
    );
  });
}

function htmlContainsTable(html: string): boolean {
  return /<table[\s>]/i.test(html);
}

function singleCellPasteText(
  data: ClipboardReadData,
  mode: ClipboardPasteMode,
): string | undefined {
  if ((mode === "auto" || mode === "rich") && data.html) {
    const htmlText = htmlFragmentVisibleText(data.html);
    if (htmlText !== undefined && (htmlText.length > 0 || data.plain === undefined)) {
      return htmlText;
    }
  }
  if (mode === "markdown") {
    const markdown = data.markdown ?? data.plain;
    return markdown?.replace(/\r\n?/g, "\n");
  }
  return (data.plain ?? data.markdown)?.replace(/\r\n?/g, "\n");
}

function dispatchCellPasteInput(cell: HTMLElement, text: string): boolean {
  const InputEventConstructor = cell.ownerDocument.defaultView?.InputEvent;
  if (!InputEventConstructor) {
    return false;
  }
  const event = new InputEventConstructor("beforeinput", {
    inputType: "insertFromPaste",
    data: text,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  cell.dispatchEvent(event);
  return event.defaultPrevented;
}

const HTML_TEXT_BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DIV",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "UL",
]);

/** Visible text from an HTML fragment, retaining semantic line boundaries. */
function htmlFragmentVisibleText(html: string): string | undefined {
  const sanitized = DOMPurify.sanitize(html, {
    FORBID_TAGS: ["script", "style", "meta", "link", "object", "embed", "iframe"],
    FORBID_ATTR: ["src", "srcset", "onload", "onclick", "onerror"],
  });
  const parsed = new DOMParser().parseFromString(sanitized, "text/html");
  if (parsed.querySelector("table")) {
    return undefined;
  }
  parsed
    .querySelectorAll<HTMLElement>(
      [
        "[hidden]",
        '[style*="display:none"]',
        '[style*="display: none"]',
        '[style*="visibility:hidden"]',
        '[style*="visibility: hidden"]',
      ].join(","),
    )
    .forEach((element) => element.remove());

  const render = (parent: Node): { text: string; block: boolean } => {
    if (parent.nodeType === Node.TEXT_NODE) {
      return { text: parent.nodeValue ?? "", block: false };
    }
    if (!(parent instanceof Element)) {
      return renderChildren(parent);
    }
    if (parent.tagName === "BR") {
      return { text: "\n", block: false };
    }
    const rendered = renderChildren(parent);
    return {
      text: rendered.text,
      block: HTML_TEXT_BLOCK_TAGS.has(parent.tagName),
    };
  };
  const renderChildren = (parent: Node): { text: string; block: boolean } => {
    let text = "";
    let previousBlock = false;
    for (const child of Array.from(parent.childNodes)) {
      const rendered = render(child);
      if (
        text.length > 0 &&
        rendered.text.length > 0 &&
        (previousBlock || rendered.block) &&
        !text.endsWith("\n") &&
        !rendered.text.startsWith("\n")
      ) {
        text += "\n";
      }
      text += rendered.text;
      previousBlock = rendered.block;
    }
    return { text, block: false };
  };

  return renderChildren(parsed.body).text
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n");
}

function createToken(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function encodePayloadForHtml(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function decodePayloadFromHtml(value: string): string | null {
  try {
    const binary = atob(value);
    return new TextDecoder().decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
