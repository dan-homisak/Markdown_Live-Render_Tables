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
  gridToHtml,
  gridToMarkdown,
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
  TABLE_SELECTION_CLEAR_EVENT,
  TableCellAddress,
  TableRangeSelectionState,
} from "./tableRangeSelection";
import { getTableWidgetTable } from "./tableWidgetState";

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

interface PendingCut {
  token: string;
  sourceDocument: string;
  tableFrom: number;
  rectangle: CellRectangle;
  sourceTableText: string;
}

const pendingCuts = new WeakMap<Document, PendingCut>();
const requestedCopyModes = new WeakMap<Document, ClipboardCopyMode>();
const armedPasteModes = new WeakMap<Document, ClipboardPasteMode>();

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
    if (!selection || selection.wrapper !== wrapper) {
      return;
    }
    const representations = representationsForCurrentSelection(
      doc,
      currentTable(),
      requestedCopyModes.get(doc) ?? readDefaultCopyMode(doc),
    );
    requestedCopyModes.delete(doc);
    if (!representations || !event.clipboardData) {
      return;
    }
    event.preventDefault();
    writeDataTransfer(event.clipboardData, representations);
    announce(doc, "Copied selection.");
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
      readDocumentUri(doc),
      token,
    );
    const representations = representationsForGrid(
      payload,
      readDefaultCopyMode(doc),
    );
    event.preventDefault();
    writeDataTransfer(event.clipboardData, representations);
    pendingCuts.set(doc, {
      token,
      sourceDocument: readDocumentUri(doc),
      tableFrom: table.from,
      rectangle,
      sourceTableText: view.state.doc.sliceString(table.from, table.to),
    });
    setPendingCutToken(doc, token);
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
    pendingCuts.delete(doc);
    setPendingCutToken(doc, undefined);
    restoreSelectionAfterEdit(doc, table.from, selection.anchor, selection.head);
    announce(doc, "Cleared selected cells.");
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
      void copyThroughMenu(doc, currentTable(), readDefaultCopyMode(doc));
    } else {
      void cutThroughMenu(doc, view, currentTable());
    }
  };

  const onContextMenu = (event: MouseEvent): void => {
    const cell = findCell(event.target);
    if (!cell || !wrapper.contains(cell)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    ensureContextCellSelection(
      wrapper,
      Number(wrapper.dataset.srcFrom ?? currentTable().from),
      cell,
    );
    closeContextMenu();
    contextMenu = createClipboardMenu(doc, {
      defaultCopyMode: readDefaultCopyMode(doc),
      defaultPasteMode: readDefaultPasteMode(doc),
      onCut: () => void cutThroughMenu(doc, view, currentTable()),
      onCopy: (mode) => void copyThroughMenu(doc, currentTable(), mode),
      onPaste: (mode) => void pasteThroughMenu(wrapper, view, currentTable(), mode),
      onSettings: () =>
        view.dom.dispatchEvent(
          new CustomEvent("mlrt:open-clipboard-settings", { bubbles: true }),
        ),
    });
    wrapper.classList.add("mlrt-clipboard-menu-open");
    contextMenu.addEventListener("click", () => setTimeout(closeContextMenu, 0), {
      once: true,
    });
    contextMenu.addEventListener("keydown", (menuEvent) => {
      if (menuEvent.key === "Escape") {
        closeContextMenu();
      }
    });
    wrapper.append(contextMenu);
    positionContextMenu(contextMenu, wrapper, event.clientX, event.clientY);
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

  const closeContextMenu = (): void => {
    contextMenu?.remove();
    contextMenu = null;
    wrapper.classList.remove("mlrt-clipboard-menu-open");
    doc.removeEventListener("pointerdown", onDocumentPointerDown, true);
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
  wrapper.addEventListener("contextmenu", onContextMenu);
  return () => {
    closeContextMenu();
    doc.removeEventListener("copy", onCopy, true);
    doc.removeEventListener("cut", onCut, true);
    doc.removeEventListener("paste", onPaste, true);
    wrapper.removeEventListener("keydown", onKeyDown);
    wrapper.removeEventListener(TABLE_SELECTION_CLEAR_EVENT, onClear);
    wrapper.removeEventListener("contextmenu", onContextMenu);
  };
}

function representationsForCurrentSelection(
  doc: Document,
  table: ParsedTable,
  mode: ClipboardCopyMode,
): ClipboardRepresentations | null {
  const selection = getTableRangeSelection(doc);
  if (selection) {
    return representationsForGrid(
      tableRectanglePayload(
        table,
        selectionRectangle(selection),
        readDocumentUri(doc),
      ),
      mode,
    );
  }
  const nativeSelection = doc.defaultView?.getSelection();
  if (!nativeSelection || nativeSelection.isCollapsed) {
    return null;
  }
  const plain = nativeSelection.toString().replace(/\u00a0/g, " ");
  return mode === "markdown"
    ? { plain, markdown: plain }
    : { plain, html: `<span>${escapeHtml(plain).replace(/\n/g, "<br>")}</span>` };
}

function representationsForGrid(
  payload: ClipboardGridPayload,
  mode: ClipboardCopyMode,
): ClipboardRepresentations {
  const rows = payload.rows.map((row) => row.map((cell) => cell.text));
  if (mode === "markdown") {
    const markdown = payload.exactMarkdown ??
      gridToMarkdown(payload.rows, payload.alignments);
    return { plain: markdown, markdown };
  }
  const plain = serializeDelimitedGrid(rows, "\t");
  if (mode === "plain") {
    return { plain };
  }
  const privatePayload = JSON.stringify(payload);
  const embedded = encodePayloadForHtml(privatePayload);
  const richCells =
    mode === "rich"
      ? payload.rows.map((row) =>
          row.map((cell) =>
            excelSafeRichInline(DOMPurify.sanitize(
              richCellRenderer.renderInline(cell.markdown?.trim() ?? cell.text),
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
            )),
          ),
        )
      : undefined;
  return {
    plain,
    csv: serializeDelimitedGrid(rows, ","),
    html: gridToHtml(payload.rows, {
      alignments: payload.alignments,
      embeddedPayload: embedded,
      rich: mode === "rich",
      richCells,
      headerRow: payload.includesHeader,
    }),
    privatePayload,
  };
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
  const activeCell = findCell(eventTarget) ?? findCell(doc.activeElement);
  const privatePayload =
    mode === "plain" || mode === "markdown"
      ? null
      : parsePrivatePayload(data);
  const parsed = clipboardRows(data, mode, privatePayload);
  if (!parsed) {
    if (selection?.wrapper === wrapper) {
      announce(doc, "Clipboard does not contain pasteable table data.");
      return true;
    }
    return false;
  }
  const clearlyTabular =
    Boolean(privatePayload?.kind === "grid") ||
    Boolean(data.html && htmlContainsTable(data.html)) ||
    Boolean(data.plain?.includes("\t"));
  if (!selection && activeCell && !clearlyTabular) {
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
  const resolvedRows = resolveGridPasteRows(parsed, destination);
  if (!resolvedRows) {
    announce(
      doc,
      "Paste rejected: the copied range must match or tile the selected range.",
    );
    return true;
  }

  const pendingCut = pendingCuts.get(doc);
  const isSameDocumentMove = Boolean(
    pendingCut &&
      privatePayload?.cutToken === pendingCut.token &&
      privatePayload.sourceDocument === readDocumentUri(doc),
  );
  if (
    isSameDocumentMove &&
    pendingCut &&
    pendingCut.tableFrom === table.from &&
    rectanglesOverlap(
      pendingCut.rectangle,
      pasteOutputRectangle(destination, resolvedRows),
    )
  ) {
    announce(doc, "Move rejected: source and destination ranges overlap.");
    return true;
  }

  const targetPlan = {
    rows: resolvedRows,
    sourceAlignments:
      privatePayload?.kind === "grid" ? privatePayload.alignments : undefined,
    destination: {
      ...destination,
      bottom: destination.top + resolvedRows.length - 1,
      right: destination.left + resolvedRows[0].length - 1,
    },
  };

  if (isSameDocumentMove && pendingCut) {
    if (!dispatchMove(view, table, targetPlan, pendingCut)) {
      announce(doc, "Move cancelled because the source changed.");
      pendingCuts.delete(doc);
      setPendingCutToken(doc, undefined);
      return true;
    }
  } else {
    dispatchTableEdit(view, buildGridPasteEdit(table, targetPlan));
  }

  pendingCuts.delete(doc);
  setPendingCutToken(doc, undefined);
  const anchor = { row: targetPlan.destination.top, column: targetPlan.destination.left };
  const head = { row: targetPlan.destination.bottom, column: targetPlan.destination.right };
  restoreSelectionAfterEdit(doc, table.from, anchor, head);
  announce(doc, isSameDocumentMove ? "Moved cells." : "Pasted cells.");
  return true;
}

function dispatchMove(
  view: EditorView,
  destinationTable: ParsedTable,
  targetPlan: Parameters<typeof buildGridPasteEdit>[1],
  pendingCut: PendingCut,
): boolean {
  const tables = getParsedTables(view.state.doc);
  const sourceTable = tables.find((candidate) => candidate.from === pendingCut.tableFrom);
  if (
    !sourceTable ||
    view.state.doc.sliceString(sourceTable.from, sourceTable.to) !==
      pendingCut.sourceTableText
  ) {
    return false;
  }
  if (sourceTable.from === destinationTable.from) {
    const cleared = buildGridClearEdit(sourceTable, pendingCut.rectangle);
    const clearedTable = parseMarkdownTables(cleared.insert)[0];
    if (!clearedTable) {
      return false;
    }
    const pasted = buildGridPasteEdit(clearedTable, targetPlan);
    dispatchTableEdit(view, {
      from: sourceTable.from,
      to: sourceTable.to,
      insert: pasted.insert,
    });
    return true;
  }
  const sourceEdit = buildGridClearEdit(sourceTable, pendingCut.rectangle);
  const destinationEdit = buildGridPasteEdit(destinationTable, targetPlan);
  view.dispatch({
    changes: [sourceEdit, destinationEdit]
      .sort((left, right) => left.from - right.from)
      .map((edit) => ({ from: edit.from, to: edit.to, insert: edit.insert })),
    annotations: [
      allowTableSourceChange.of(true),
      Transaction.addToHistory.of(true),
    ],
    userEvent: "input.paste",
  });
  return true;
}

function dispatchTableEdit(
  view: EditorView,
  edit: { from: number; to: number; insert: string },
): void {
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
  if (mode !== "plain" && mode !== "markdown" && data.html) {
    const htmlRows = rowsFromHtmlTable(data.html, mode === "rich");
    if (htmlRows) {
      return htmlRows;
    }
  }
  const markdown =
    mode === "markdown" ? data.markdown ?? data.plain : data.markdown;
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
  if (data.csv && !data.plain?.includes("\t")) {
    return stringsToCells(parseDelimitedGrid(data.csv, ","));
  }
  if (data.plain !== undefined) {
    return stringsToCells(
      parseDelimitedGrid(data.plain, data.plain.includes("\t") ? "\t" : "\t"),
    );
  }
  if (payload?.kind === "document") {
    return [[{ text: payload.markdown }]];
  }
  return null;
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
      const text = preserveFormatting
        ? richCellTurndown.turndown(cell.innerHTML).trim()
        : htmlCellText(cell);
      const rowSpan = Math.max(1, cell.rowSpan || 1);
      const columnSpan = Math.max(1, cell.colSpan || 1);
      for (let rowOffset = 0; rowOffset < rowSpan; rowOffset++) {
        rows[rowIndex + rowOffset] ??= [];
        for (let columnOffset = 0; columnOffset < columnSpan; columnOffset++) {
          rows[rowIndex + rowOffset][column + columnOffset] = {
            text: rowOffset === 0 && columnOffset === 0 ? text : "",
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
  const clone = cell.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
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
  return (clone.textContent ?? "").replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n");
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
    privatePayload: transfer.getData(MLRT_CLIPBOARD_MIME) || undefined,
    html: transfer.getData("text/html") || undefined,
    markdown: transfer.getData("text/markdown") || undefined,
    csv: transfer.getData("text/csv") || undefined,
    plain: transfer.getData("text/plain"),
  };
}

async function copyThroughMenu(
  doc: Document,
  table: ParsedTable,
  mode: ClipboardCopyMode,
): Promise<void> {
  const representations = representationsForCurrentSelection(doc, table, mode);
  if (!representations) {
    announce(doc, "Nothing selected to copy.");
    return;
  }
  try {
    await writeAsyncClipboard(representations);
    announce(doc, `Copied as ${COPY_MODE_LABELS[mode]}.`);
  } catch {
    requestedCopyModes.set(doc, mode);
    if (!executeClipboardCommand(doc, "copy")) {
      announce(doc, "Copy failed. Use Cmd/Ctrl+C.");
    }
  }
}

async function cutThroughMenu(
  doc: Document,
  view: EditorView,
  table: ParsedTable,
): Promise<void> {
  const selection = getTableRangeSelection(doc);
  if (!selection) {
    announce(doc, "Nothing selected to move.");
    return;
  }
  const token = createToken();
  const rectangle = selectionRectangle(selection);
  const representations = representationsForGrid(
    tableRectanglePayload(
      table,
      rectangle,
      readDocumentUri(doc),
      token,
    ),
    readDefaultCopyMode(doc),
  );
  try {
    await writeAsyncClipboard(representations);
  } catch {
    requestedCopyModes.set(doc, readDefaultCopyMode(doc));
    announce(doc, "Move could not access the clipboard. Use Cmd/Ctrl+X.");
    return;
  }
  pendingCuts.set(doc, {
    token,
    sourceDocument: readDocumentUri(doc),
    tableFrom: table.from,
    rectangle,
    sourceTableText: view.state.doc.sliceString(table.from, table.to),
  });
  setPendingCutToken(doc, token);
  announce(
    doc,
    "Move pending. Paste in this document to move; external paste copies.",
  );
}

async function pasteThroughMenu(
  wrapper: HTMLElement,
  view: EditorView,
  table: ParsedTable,
  mode: ClipboardPasteMode,
): Promise<void> {
  try {
    const data = await readAsyncClipboard();
    if (!pasteClipboardData(wrapper, view, table, data, mode, wrapper)) {
      announce(wrapper.ownerDocument, "Clipboard does not contain pasteable data.");
    }
  } catch {
    armedPasteModes.set(wrapper.ownerDocument, mode);
    announce(
      wrapper.ownerDocument,
      `Paste as ${PASTE_MODE_LABELS[mode]} armed — press Cmd/Ctrl+V.`,
    );
  }
}

async function writeAsyncClipboard(
  representations: ClipboardRepresentations,
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
  if (representations.csv) {
    data["text/csv"] = new Blob([representations.csv], { type: "text/csv" });
  }
  if (representations.markdown) {
    data["text/markdown"] = new Blob([representations.markdown], {
      type: "text/markdown",
    });
  }
  await navigator.clipboard.write([new ClipboardItem(data)]);
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
    onCut: () => void;
    onCopy: (mode: ClipboardCopyMode) => void;
    onPaste: (mode: ClipboardPasteMode) => void;
    onSettings: () => void;
  },
): HTMLElement {
  const menu = doc.createElement("div");
  menu.className = CLIPBOARD_MENU_CLASS;
  menu.setAttribute("role", "menu");
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
  add("Cut / Move within document", "cut", actions.onCut);
  add(
    `Copy (${COPY_MODE_LABELS[actions.defaultCopyMode]})`,
    "copy-default",
    () => actions.onCopy(actions.defaultCopyMode),
  );
  (Object.keys(COPY_MODE_LABELS) as ClipboardCopyMode[]).forEach((mode) =>
    add(`Copy ${COPY_MODE_LABELS[mode]}`, `copy-${mode}`, () => actions.onCopy(mode)),
  );
  separator();
  add(
    `Paste (${PASTE_MODE_LABELS[actions.defaultPasteMode]})`,
    "paste-default",
    () => actions.onPaste(actions.defaultPasteMode),
  );
  (Object.keys(PASTE_MODE_LABELS) as ClipboardPasteMode[]).forEach((mode) =>
    add(`Paste ${PASTE_MODE_LABELS[mode]}`, `paste-${mode}`, () => actions.onPaste(mode)),
  );
  separator();
  add("Clipboard Settings…", "settings", actions.onSettings);
  return menu;
}

function navigateMenu(event: KeyboardEvent, menu: HTMLElement): void {
  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>("button"));
  const index = items.indexOf(event.currentTarget as HTMLButtonElement);
  if (event.key === "Escape") {
    event.preventDefault();
    menu.remove();
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
    return;
  }
  event.preventDefault();
  const delta = event.key === "ArrowDown" ? 1 : -1;
  items[(index + delta + items.length) % items.length]?.focus();
}

function positionContextMenu(
  menu: HTMLElement,
  wrapper: HTMLElement,
  clientX: number,
  clientY: number,
): void {
  const wrapperRect = wrapper.getBoundingClientRect();
  const left = Math.min(
    Math.max(0, clientX - wrapperRect.left),
    Math.max(0, wrapperRect.width - menu.offsetWidth),
  );
  const top = Math.min(
    Math.max(0, clientY - wrapperRect.top),
    Math.max(0, wrapperRect.height - menu.offsetHeight),
  );
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

function readDocumentUri(doc: Document): string {
  return doc.documentElement.dataset.mlrtDocumentUri ?? "";
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

function htmlContainsTable(html: string): boolean {
  return /<table[\s>]/i.test(html);
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
