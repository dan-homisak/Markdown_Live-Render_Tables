import { markdown } from "@codemirror/lang-markdown";
import { ChangeSet, EditorSelection, EditorState } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import {
  formatTableCellSourceEdit,
  parseMarkdownTables,
  ParsedRow,
  ParsedTable,
  rowToDisplayValues,
} from "../shared/tableModel";
import {
  allowTableSourceChange,
  createTableSourceChangeFilter,
  createTableSourceSelectionGuard,
} from "../shared/tableSourceProtection";

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
  throw new Error("Missing editor mount element.");
}

let applyingFromHost = false;
let hostRevision = 0;
let view: EditorView;

try {
  const initialDocument = readInitialDocument();
  app.replaceChildren();
  view = new EditorView({
    parent: app,
    state: EditorState.create({
      doc: initialDocument,
      extensions: [
        markdown(),
        EditorView.lineWrapping,
        createTableSourceChangeFilter(),
        createTableSourceSelectionGuard({
          tableCellSelector: ".mlrt-cell",
        }),
        tableRenderer(),
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

  const currentText = view.state.doc.toString();
  if (message.text === currentText) {
    return;
  }

  applyingFromHost = true;
  view.dispatch({
    changes: {
      from: 0,
      to: currentText.length,
      insert: message.text,
    },
    annotations: allowTableSourceChange.of(true),
  });
  applyingFromHost = false;
});

vscode.postMessage({ type: "ready" });

function readInitialDocument(): string {
  return typeof window.__MLRT_INITIAL_DOCUMENT__ === "string"
    ? window.__MLRT_INITIAL_DOCUMENT__
    : "";
}

function renderStartupError(error: unknown): HTMLElement {
  const wrapper = document.createElement("pre");
  wrapper.style.padding = "1rem";
  wrapper.style.whiteSpace = "pre-wrap";
  wrapper.style.color = "var(--vscode-errorForeground)";
  wrapper.textContent =
    error instanceof Error
      ? `Markdown table editor failed to start:\n${error.message}\n${error.stack ?? ""}`
      : `Markdown table editor failed to start:\n${String(error)}`;
  return wrapper;
}

function postDocumentChanges(changes: ChangeSet, text: string): void {
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

function tableRenderer() {
  return ViewPlugin.fromClass(
    class {
      public decorations: DecorationSet;

      public constructor(view: EditorView) {
        this.decorations = buildTableDecorations(view);
      }

      public update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildTableDecorations(update.view);
        }
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
    },
  );
}

function buildTableDecorations(view: EditorView): DecorationSet {
  const tables = parseMarkdownTables(view.state.doc.toString());
  const decorations = tables.map((table) =>
    Decoration.replace({
      widget: new MarkdownTableWidget(table),
      block: true,
      inclusive: false,
    }).range(table.from, table.to),
  );
  return Decoration.set(decorations, true);
}

class MarkdownTableWidget extends WidgetType {
  public constructor(private readonly table: ParsedTable) {
    super();
  }

  public eq(): boolean {
    return false;
  }

  public toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "mlrt-table-wrap";
    wrapper.dataset.tableFrom = String(this.table.from);

    const tableElement = document.createElement("table");
    tableElement.className = "mlrt-table";

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    appendCells({
      table: this.table,
      sourceRow: this.table.header,
      tableRow: headerRow,
      tagName: "th",
      rowKind: "header",
      rowIndex: 0,
    });
    thead.append(headerRow);
    tableElement.append(thead);

    const tbody = document.createElement("tbody");
    this.table.body.forEach((sourceRow, rowIndex) => {
      const tableRow = document.createElement("tr");
      appendCells({
        table: this.table,
        sourceRow,
        tableRow,
        tagName: "td",
        rowKind: "body",
        rowIndex,
      });
      tbody.append(tableRow);
    });
    tableElement.append(tbody);

    wrapper.append(tableElement);
    bindTableEditing(wrapper, view, this.table);
    return wrapper;
  }

  public ignoreEvent(): boolean {
    return true;
  }
}

interface AppendCellsOptions {
  table: ParsedTable;
  sourceRow: ParsedRow;
  tableRow: HTMLTableRowElement;
  tagName: "th" | "td";
  rowKind: "header" | "body";
  rowIndex: number;
}

function appendCells(options: AppendCellsOptions): void {
  const values = rowToDisplayValues(options.sourceRow, options.table.columnCount);
  values.forEach((value, column) => {
    const cell = document.createElement(options.tagName);
    cell.className = "mlrt-cell";
    cell.contentEditable = "true";
    cell.spellcheck = false;
    cell.textContent = value;
    cell.dataset.tableFrom = String(options.table.from);
    cell.dataset.rowKind = options.rowKind;
    cell.dataset.rowIndex = String(options.rowIndex);
    cell.dataset.column = String(column);
    cell.dataset.original = value;
    cell.style.textAlign = options.table.alignments[column] ?? "left";
    options.tableRow.append(cell);
  });
}

function bindTableEditing(
  wrapper: HTMLElement,
  view: EditorView,
  table: ParsedTable,
): void {
  wrapper.addEventListener("focusout", (event) => {
    const cell = findCell(event.target);
    if (cell) {
      setTimeout(() => {
        if (cell.isConnected) {
          commitCellEdit(view, table, cell);
        }
      }, 0);
    }
  });

  wrapper.addEventListener("keydown", (event) => {
    const cell = findCell(event.target);
    if (!cell) {
      return;
    }

    event.stopPropagation();
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      insertTextAtSelection("\n");
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      commitCellEdit(view, table, cell, {
        selectionAnchor: getPositionAfterTable(view, table),
      });
      cell.blur();
      view.focus();
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      const target = resolveRelativeCell(cell, event.shiftKey ? -1 : 1);
      commitCellEdit(view, table, cell);
      focusCellAfterRender(table.from, target);
    }
  });
}

interface CellTarget {
  rowKind: string;
  rowIndex: string;
  column: string;
}

function resolveRelativeCell(cell: HTMLElement, delta: number): CellTarget {
  const cells = Array.from(
    cell
      .closest(".mlrt-table")
      ?.querySelectorAll<HTMLElement>(".mlrt-cell") ?? [],
  );
  const index = cells.indexOf(cell);
  const next = cells[index + delta] ?? cell;
  return {
    rowKind: next.dataset.rowKind ?? "body",
    rowIndex: next.dataset.rowIndex ?? "0",
    column: next.dataset.column ?? "0",
  };
}

function focusCellAfterRender(tableFrom: number, target: CellTarget): void {
  setTimeout(() => {
    const selector = [
      `.mlrt-cell[data-table-from="${tableFrom}"]`,
      `[data-row-kind="${target.rowKind}"]`,
      `[data-row-index="${target.rowIndex}"]`,
      `[data-column="${target.column}"]`,
    ].join("");
    const next = document.querySelector<HTMLElement>(selector);
    if (next) {
      next.focus();
    }
  }, 0);
}

function commitCellEdit(
  view: EditorView,
  table: ParsedTable,
  cell: HTMLElement,
  options: { selectionAnchor?: number } = {},
): void {
  const rowKind = cell.dataset.rowKind;
  const rowIndex = Number(cell.dataset.rowIndex ?? "0");
  const column = Number(cell.dataset.column ?? "0");
  const sourceRow =
    rowKind === "header" ? table.header : table.body[rowIndex] ?? null;
  if (!sourceRow || !Number.isInteger(column) || column < 0) {
    dispatchSelection(view, options.selectionAnchor);
    return;
  }

  const value = cell.innerText.replace(/\u00a0/g, " ").replace(/\n+$/g, "");
  if (value === cell.dataset.original) {
    dispatchSelection(view, options.selectionAnchor);
    return;
  }

  const edit = formatTableCellSourceEdit(
    sourceRow,
    table.columnCount,
    column,
    value,
  );
  view.dom.dispatchEvent(
    new CustomEvent("mlrt:table-cell-commit", {
      bubbles: true,
      detail: {
        rowKind,
        rowIndex,
        column,
        from: edit.from,
        to: edit.to,
        insertLength: edit.insert.length,
        valueLength: value.length,
      },
    }),
  );
  const selectionAnchor =
    options.selectionAnchor === undefined
      ? undefined
      : mapPositionThroughCellEdit(options.selectionAnchor, edit);
  view.dispatch({
    changes: {
      from: edit.from,
      to: edit.to,
      insert: edit.insert,
    },
    selection:
      selectionAnchor === undefined
        ? undefined
        : EditorSelection.cursor(selectionAnchor, 1),
    annotations: allowTableSourceChange.of(true),
    scrollIntoView: true,
  });
}

function dispatchSelection(
  view: EditorView,
  selectionAnchor: number | undefined,
): void {
  if (selectionAnchor === undefined) {
    return;
  }

  view.dispatch({
    selection: EditorSelection.cursor(selectionAnchor, 1),
    scrollIntoView: true,
  });
}

function getPositionAfterTable(view: EditorView, table: ParsedTable): number {
  const doc = view.state.doc;
  if (table.to < doc.length && doc.sliceString(table.to, table.to + 1) === "\n") {
    return table.to + 1;
  }

  return table.to;
}

function mapPositionThroughCellEdit(
  position: number,
  edit: { from: number; to: number; insert: string },
): number {
  if (position <= edit.from) {
    return position;
  }
  if (position <= edit.to) {
    return edit.from + edit.insert.length;
  }

  return position + edit.insert.length - (edit.to - edit.from);
}

function findCell(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) {
    return null;
  }
  return target.closest<HTMLElement>(".mlrt-cell");
}

function insertTextAtSelection(text: string): void {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.setEndAfter(node);
  selection.removeAllRanges();
  selection.addRange(range);
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
