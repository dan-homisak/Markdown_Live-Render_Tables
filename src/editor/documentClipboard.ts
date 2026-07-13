import { EditorSelection, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import {
  ClipboardCopyMode,
  ClipboardDocumentPayload,
  ClipboardPasteMode,
  MLRT_CLIPBOARD_MIME,
  MLRT_CLIPBOARD_VERSION,
  parseClipboardPayload,
  serializeDelimitedGrid,
} from "../shared/clipboardModel";
import {
  getParsedTables,
  markdownCellToDisplayText,
  parseMarkdownTables,
} from "../shared/tableModel";
import { allowTableSourceChange } from "../shared/tableSourceProtection";
import { findCell } from "./table/cellSelection";
import {
  clearTableRangeSelection,
  getTableRangeSelection,
  syncTableSelectionOutline,
} from "./table/tableRangeSelection";

interface ClipboardReadData {
  privatePayload?: string;
  html?: string;
  markdown?: string;
  plain?: string;
}

interface PendingDocumentCut {
  token: string;
  sourceDocument: string;
  from: number;
  to: number;
  markdown: string;
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

let pendingDocumentCut: PendingDocumentCut | null = null;
let armedDocumentPasteMode: ClipboardPasteMode | null = null;
let requestedDocumentCopyMode: ClipboardCopyMode | null = null;

export function installDocumentClipboard(
  root: HTMLElement,
  view: EditorView,
): () => void {
  const doc = root.ownerDocument;
  let mixedDragAnchor: number | null = null;
  let mixedDragRange: { anchor: number; head: number } | null = null;
  let mixedDragActive = false;

  const onCopy = (event: ClipboardEvent): void => {
    if (
      event.defaultPrevented ||
      getTableRangeSelection(doc) ||
      findCell(event.target)
    ) {
      return;
    }
    const range = atomicDocumentSelection(view);
    if (!range || !event.clipboardData) {
      return;
    }
    const mode = requestedDocumentCopyMode ?? readCopyMode(doc);
    requestedDocumentCopyMode = null;
    event.preventDefault();
    writeDocumentTransfer(
      event.clipboardData,
      documentRepresentations(view, range.from, range.to, mode),
    );
    announce(doc, "Copied document selection.");
  };

  const onCut = (event: ClipboardEvent): void => {
    if (
      event.defaultPrevented ||
      getTableRangeSelection(doc) ||
      findCell(event.target)
    ) {
      return;
    }
    const range = atomicDocumentSelection(view);
    if (!range || !event.clipboardData) {
      return;
    }
    const token = createToken();
    const markdown = view.state.doc.sliceString(range.from, range.to);
    const payload: ClipboardDocumentPayload = {
      version: MLRT_CLIPBOARD_VERSION,
      kind: "document",
      sourceDocument: readDocumentUri(doc),
      markdown,
      cutToken: token,
    };
    event.preventDefault();
    writeDocumentTransfer(
      event.clipboardData,
      documentRepresentations(
        view,
        range.from,
        range.to,
        readCopyMode(doc),
        payload,
      ),
    );
    pendingDocumentCut = {
      token,
      sourceDocument: readDocumentUri(doc),
      from: range.from,
      to: range.to,
      markdown,
    };
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
    const markdown = documentPasteMarkdown(readTransfer(event.clipboardData), mode);
    if (markdown === null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    applyDocumentPaste(view, markdown, readTransfer(event.clipboardData));
    announce(doc, "Pasted document content.");
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && pendingDocumentCut) {
      pendingDocumentCut = null;
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
    if (!root.contains(event.target as Node)) {
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
    if (cell?.classList.contains("mlrt-document-range-selected")) {
      return true;
    }
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
    return position !== null && position >= range.from && position <= range.to;
  };

  const onRootPointerDown = (event: PointerEvent): void => {
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
    const anchor = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (anchor === null) {
      return;
    }
    mixedDragAnchor = anchor;
    mixedDragRange = null;
    mixedDragActive = false;
    doc.addEventListener("pointermove", onMixedPointerMove, true);
    doc.addEventListener("pointerup", onMixedPointerUp, true);
    doc.addEventListener("pointercancel", onMixedPointerUp, true);
    doc.addEventListener("mousemove", onMixedMouseMove, true);
    doc.addEventListener("mouseup", onMixedMouseUp, true);
    doc.addEventListener("click", onMixedClick, true);
    doc.addEventListener("selectionchange", onMixedSelectionChange);
  };

  const onRootMouseDown = (event: MouseEvent): void => {
    if (event.button === 2 && shouldPreserveContextSelection(event)) {
      event.preventDefault();
    }
  };

  const onNativeSelectionChange = (): void => {
    if (
      view.state.selection.main.empty ||
      !doc.querySelector(".mlrt-document-range-selected")
    ) {
      return;
    }
    const nativeSelection = doc.defaultView?.getSelection();
    if (nativeSelection && !nativeSelection.isCollapsed) {
      nativeSelection.removeAllRanges();
    }
  };

  const updateMixedDrag = (event: PointerEvent | MouseEvent): void => {
    if (mixedDragAnchor === null || (event.buttons & 1) === 0) {
      return;
    }
    const target = doc.elementFromPoint(event.clientX, event.clientY);
    const cell = findCell(target);
    if (!cell) {
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
    if (!span) {
      return;
    }
    const movingForward = mixedDragAnchor <= table.from;
    mixedDragRange = {
      anchor: mixedDragAnchor,
      head: movingForward ? span.to : span.from,
    };
    mixedDragActive = true;
    event.preventDefault();
    event.stopPropagation();
    doc.defaultView?.getSelection()?.removeAllRanges();
    view.dispatch({
      selection: EditorSelection.range(
        mixedDragRange.anchor,
        mixedDragRange.head,
      ),
      scrollIntoView: true,
    });
  };

  const onMixedPointerMove = (event: PointerEvent): void => {
    updateMixedDrag(event);
  };

  const onMixedMouseMove = (event: MouseEvent): void => {
    updateMixedDrag(event);
    if (mixedDragActive) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const restoreMixedDrag = (): void => {
    if (!mixedDragRange) {
      return;
    }
    doc.defaultView?.getSelection()?.removeAllRanges();
    view.dispatch({
      selection: EditorSelection.range(
        mixedDragRange.anchor,
        mixedDragRange.head,
      ),
    });
  };

  const onMixedPointerUp = (): void => {
    queueMicrotask(restoreMixedDrag);
    setTimeout(removeMixedDragListeners, 0);
  };

  const onMixedMouseUp = (event: MouseEvent): void => {
    if (mixedDragActive) {
      event.preventDefault();
      event.stopPropagation();
    }
    queueMicrotask(restoreMixedDrag);
  };

  const onMixedClick = (event: MouseEvent): void => {
    if (!mixedDragActive) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const onMixedSelectionChange = (): void => {
    if (!mixedDragActive) {
      return;
    }
    const nativeSelection = doc.defaultView?.getSelection();
    if (nativeSelection && !nativeSelection.isCollapsed) {
      nativeSelection.removeAllRanges();
    }
  };

  const removeMixedDragListeners = (): void => {
    const finalRange = mixedDragRange;
    doc.removeEventListener("pointermove", onMixedPointerMove, true);
    doc.removeEventListener("pointerup", onMixedPointerUp, true);
    doc.removeEventListener("pointercancel", onMixedPointerUp, true);
    doc.removeEventListener("mousemove", onMixedMouseMove, true);
    doc.removeEventListener("mouseup", onMixedMouseUp, true);
    doc.removeEventListener("click", onMixedClick, true);
    doc.removeEventListener("selectionchange", onMixedSelectionChange);
    doc.defaultView?.getSelection()?.removeAllRanges();
    mixedDragAnchor = null;
    mixedDragRange = null;
    mixedDragActive = false;
    if (finalRange) {
      view.dispatch({
        selection: EditorSelection.range(finalRange.anchor, finalRange.head),
      });
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
  root.addEventListener("mousedown", onRootMouseDown, true);
  doc.addEventListener("selectionchange", onNativeSelectionChange);
  return () => {
    removeMixedDragListeners();
    doc.removeEventListener("copy", onCopy, true);
    doc.removeEventListener("cut", onCut, true);
    doc.removeEventListener("paste", onPaste, true);
    doc.removeEventListener("keydown", onKeyDown);
    root.removeEventListener("contextmenu", onContextMenu, true);
    root.removeEventListener("pointerdown", onRootPointerDown, true);
    root.removeEventListener("mousedown", onRootMouseDown, true);
    doc.removeEventListener("selectionchange", onNativeSelectionChange);
  };
}

export function syncDocumentRangeSelection(view: EditorView): void {
  const range = view.state.selection.main;
  if (!range.empty && getTableRangeSelection(view.dom.ownerDocument)) {
    clearTableRangeSelection(view.dom.ownerDocument);
  }
  const tables = getParsedTables(view.state.doc);
  view.dom.ownerDocument
    .querySelectorAll<HTMLElement>(".mlrt-table-widget")
    .forEach((wrapper) => {
      const from = Number(wrapper.dataset.srcFrom ?? "-1");
      const table = tables.find((candidate) => candidate.from === from);
      const cells = Array.from(
        wrapper.querySelectorAll<HTMLElement>(".mlrt-table-cell"),
      );
      const selectedAddresses = new Set<string>();
      if (table && !range.empty) {
        cells.forEach((cell) => {
          const span = renderedCellSourceSpan(cell, table);
          if (span && range.from < span.to && range.to > span.from) {
            selectedAddresses.add(renderedCellAddressKey(cell));
          }
        });
      }
      cells.forEach((cell) => {
        const row = renderedCellRow(cell);
        const column = Number(cell.dataset.column ?? "0");
        const selected = selectedAddresses.has(renderedCellAddressKey(cell));
        cell.classList.toggle("mlrt-document-range-selected", selected);
        cell.classList.toggle(
          "mlrt-table-selection-top",
          selected && !selectedAddresses.has(`${row - 1}:${column}`),
        );
        cell.classList.toggle(
          "mlrt-table-selection-bottom",
          selected && !selectedAddresses.has(`${row + 1}:${column}`),
        );
        cell.classList.toggle(
          "mlrt-table-selection-left",
          selected && !selectedAddresses.has(`${row}:${column - 1}`),
        );
        cell.classList.toggle(
          "mlrt-table-selection-right",
          selected && !selectedAddresses.has(`${row}:${column + 1}`),
        );
      });
      syncTableSelectionOutline(wrapper);
    });
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
  if (mode === "markdown") {
    return { plain: markdown, markdown };
  }
  const worksheet = buildClipboardWorksheet(markdown, mode === "rich");
  const plain = worksheet.plain;
  if (mode === "plain") {
    return { plain };
  }
  const rendered = worksheet.html;
  const sanitized = DOMPurify.sanitize(rendered, {
    FORBID_TAGS: ["script", "style", "object", "embed", "iframe", "form"],
    FORBID_ATTR: ["src", "srcset", "onload", "onclick", "onerror"],
  });
  const payload = suppliedPayload ?? {
    version: MLRT_CLIPBOARD_VERSION,
    kind: "document" as const,
    sourceDocument: readDocumentUri(view.dom.ownerDocument),
    markdown,
  };
  const privatePayload = JSON.stringify(payload);
  const metadata = `<meta name="mlrt-clipboard" content="${escapeHtmlAttribute(
    encodePayload(privatePayload),
  )}">`;
  return { plain, html: `${metadata}${sanitized}`, privatePayload };
}

interface WorksheetRow {
  cells: string[];
  richCells?: string[];
  kind: "prose" | "table-header" | "table-body";
  alignments?: ("left" | "center" | "right")[];
}

/**
 * Excel gives text/html precedence over text/plain. Arbitrary Markdown HTML
 * (especially nested lists) is consequently distributed across spreadsheet
 * columns. Smart copy instead publishes one flat worksheet table: prose is a
 * single value in column A and Markdown table cells retain their matrix.
 */
function buildClipboardWorksheet(markdown: string, rich: boolean): {
  plain: string;
  html: string;
} {
  const tables = parseMarkdownTables(markdown);
  const rows: WorksheetRow[] = [];
  let cursor = 0;
  for (const table of tables) {
    rows.push(...proseWorksheetRows(markdown.slice(cursor, table.from)));
    rows.push({
      cells: tableRowDisplayValues(table.header.cells.map((cell) => cell.raw)),
      ...(rich
        ? { richCells: tableRowRichValues(table.header.cells.map((cell) => cell.raw)) }
        : {}),
      kind: "table-header",
      alignments: table.alignments,
    });
    for (const row of table.body) {
      rows.push({
        cells: tableRowDisplayValues(Array.from(
          { length: table.columnCount },
          (_, column) => row.cells[column]?.raw ?? "",
        )),
        ...(rich
          ? { richCells: tableRowRichValues(Array.from(
              { length: table.columnCount },
              (_, column) => row.cells[column]?.raw ?? "",
            )) }
          : {}),
        kind: "table-body",
        alignments: table.alignments,
      });
    }
    cursor = table.to;
  }
  rows.push(...proseWorksheetRows(markdown.slice(cursor)));

  if (rows.length === 0) {
    rows.push({ cells: [""], kind: "prose" });
  }
  const width = Math.max(1, ...rows.map((row) => row.cells.length));
  const plain = serializeDelimitedGrid(
    rows.map((row) => row.cells),
    "\t",
  );
  const htmlRows = rows.map((row) => {
    const cells = Array.from({ length: width }, (_, column) => {
      const value = row.cells[column] ?? "";
      const isTable = row.kind !== "prose";
      const alignment = row.alignments?.[column] ?? "left";
      const tag = row.kind === "table-header" ? "th" : "td";
      const style = isTable
        ? `border:1px solid #000000;padding:2px 6px;text-align:${alignment};vertical-align:top;white-space:pre-wrap`
        : "border:none;padding:2px 6px;text-align:left;vertical-align:top;white-space:pre-wrap";
      const content = row.richCells?.[column] ?? escapeWorksheetText(value);
      return `<${tag} style="${style}">${content}</${tag}>`;
    }).join("");
    return `<tr data-mlrt-row-kind="${row.kind}">${cells}</tr>`;
  }).join("");
  return {
    plain,
    html: `<table data-mlrt-clipboard-layout="worksheet" style="border-collapse:collapse;border-spacing:0"><tbody>${htmlRows}</tbody></table>`,
  };
}

function proseWorksheetRows(markdown: string): WorksheetRow[] {
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
  return values.map((value) => ({ cells: [value], kind: "prose" }));
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
    privatePayload: transfer.getData(MLRT_CLIPBOARD_MIME) || undefined,
    html: transfer.getData("text/html") || undefined,
    markdown: transfer.getData("text/markdown") || undefined,
    plain: transfer.getData("text/plain"),
  };
}

function documentPasteMarkdown(
  data: ClipboardReadData,
  mode: ClipboardPasteMode,
): string | null {
  if (mode !== "plain" && mode !== "markdown") {
    const privatePayload = readPrivateDocumentPayload(data);
    if (privatePayload) {
      return privatePayload.markdown;
    }
  }
  if (mode === "markdown") {
    return normalizeText(data.markdown ?? data.plain ?? "");
  }
  if (mode !== "plain" && data.html) {
    return htmlToReadableMarkdown(data.html);
  }
  if (data.markdown && mode !== "plain") {
    return normalizeText(data.markdown);
  }
  return data.plain === undefined ? null : normalizeText(data.plain);
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
  clone.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  return normalizeText(turndown.turndown(clone.innerHTML))
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function markdownForTableCell(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, "<br>");
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
): void {
  const range = atomicDocumentSelection(view) ?? view.state.selection.main;
  const payload = readPrivateDocumentPayload(data);
  const pending = pendingDocumentCut;
  const completesMove = Boolean(
    pending &&
      payload?.cutToken === pending.token &&
      payload.sourceDocument === readDocumentUri(view.dom.ownerDocument),
  );
  if (completesMove && pending) {
    if (
      view.state.doc.sliceString(pending.from, pending.to) !== pending.markdown ||
      rangesOverlap(
        { from: pending.from, to: pending.to },
        { from: range.from, to: range.to },
      ) ||
      (range.empty && range.from > pending.from && range.from < pending.to)
    ) {
      announce(view.dom.ownerDocument, "Move cancelled because source and destination overlap or changed.");
      pendingDocumentCut = null;
      view.dom.classList.remove("mlrt-document-cut-pending");
      return;
    }
    const changes = [
      { from: pending.from, to: pending.to, insert: "" },
      { from: range.from, to: range.to, insert: markdown },
    ].sort((left, right) => left.from - right.from);
    view.dispatch({
      changes,
      annotations: [
        allowTableSourceChange.of(true),
        Transaction.addToHistory.of(true),
      ],
      userEvent: "input.paste",
    });
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
  pendingDocumentCut = null;
  view.dom.classList.remove("mlrt-document-cut-pending");
}

function readPrivateDocumentPayload(
  data: ClipboardReadData,
): ClipboardDocumentPayload | null {
  const direct = data.privatePayload
    ? parseClipboardPayload(data.privatePayload)
    : null;
  if (direct?.kind === "document") {
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
  const payload = text ? parseClipboardPayload(text) : null;
  return payload?.kind === "document" ? payload : null;
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
  doc.querySelector(".mlrt-document-clipboard-menu")?.remove();
  const menu = doc.createElement("div");
  menu.className = "mlrt-clipboard-menu mlrt-document-clipboard-menu";
  menu.setAttribute("role", "menu");
  const add = (label: string, callback: () => void): void => {
    const item = doc.createElement("button");
    item.type = "button";
    item.className = "mlrt-clipboard-menu-item";
    item.textContent = label;
    item.addEventListener("click", () => {
      menu.remove();
      callback();
    });
    menu.append(item);
  };
  add("Cut / Move within document", () => doc.execCommand("cut"));
  (["smart", "rich", "plain", "markdown"] as ClipboardCopyMode[]).forEach(
    (mode) =>
      add(`Copy ${capitalize(mode)}`, () => {
        requestedDocumentCopyMode = mode;
        doc.execCommand("copy");
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
  doc.body.append(menu);
  menu.style.position = "fixed";
  menu.style.left = `${Math.min(clientX, innerWidth - menu.offsetWidth - 4)}px`;
  menu.style.top = `${Math.min(clientY, innerHeight - menu.offsetHeight - 4)}px`;
  menu.querySelector<HTMLButtonElement>("button")?.focus();
  const close = (event: PointerEvent): void => {
    if (event.target instanceof Node && !menu.contains(event.target)) {
      menu.remove();
      doc.removeEventListener("pointerdown", close, true);
    }
  };
  doc.addEventListener("pointerdown", close, true);
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
  status.textContent = message;
  status.dataset.visible = "true";
  setTimeout(() => {
    if (status?.textContent === message) {
      delete status.dataset.visible;
    }
  }, 2400);
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

function readDocumentUri(doc: Document): string {
  return doc.documentElement.dataset.mlrtDocumentUri ?? "";
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

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
