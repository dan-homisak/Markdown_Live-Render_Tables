import { EditorSelection } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import {
  formatMarkdownCell,
  formatTableCellSourceEdit,
  ParsedRow,
  ParsedTable,
  rowToDisplayValues,
  TableCellSourceEdit,
} from "../../shared/tableModel";
import {
  measureTableColumnSizing,
  TableCellSizingOverride,
  TableColumnSizing,
} from "../../shared/tableColumnSizing";
import { allowTableSourceChange } from "../../shared/tableSourceProtection";
import {
  tableCellCommitSequence,
  tableCellLiveEdit,
} from "../tableCellCommitSequence";

export class RenderedTableWidget extends WidgetType {
  public constructor(private readonly table: ParsedTable) {
    super();
  }

  public eq(widget: WidgetType): boolean {
    return (
      widget instanceof RenderedTableWidget &&
      widget.table.from === this.table.from &&
      preservedLiveEditTableStarts.has(this.table.from)
    );
  }

  public updateDOM(dom: HTMLElement, _view: EditorView): boolean {
    if (!canPatchTableDOM(dom, this.table)) {
      return false;
    }

    patchTableDOM(dom, this.table);
    return true;
  }

  public getTableFrom(): number {
    return this.table.from;
  }

  public toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("section");
    wrapper.className = "mm-live-v4-table-widget";
    wrapper.dataset.blockId = this.table.id;
    wrapper.dataset.srcFrom = String(this.table.from);
    wrapper.dataset.srcTo = String(getPositionAfterTable(view, this.table));
    wrapper.contentEditable = "false";

    const columnSizing = measureTableColumnSizing(this.table);
    applyColumnSizing(wrapper, columnSizing);

    const tableElement = document.createElement("table");
    tableElement.className = "mm-live-v4-table";
    appendColumnSizing(tableElement, this.table, columnSizing);

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    appendCells({
      table: this.table,
      sourceRow: this.table.header,
      tableRow: headerRow,
      tagName: "th",
      rowKind: "header",
      rowIndex: 0,
      sourceLineNumber: this.table.header.lineIndex + 1,
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
        sourceLineNumber: sourceRow.lineIndex + 1,
      });
      tbody.append(tableRow);
    });
    tableElement.append(tbody);

    const tableScroll = document.createElement("div");
    tableScroll.className = "mm-live-v4-table-scroll";
    tableScroll.append(tableElement);

    const scrollbar = document.createElement("div");
    scrollbar.className = "mm-live-v4-table-scrollbar";
    const scrollbarThumb = document.createElement("div");
    scrollbarThumb.className = "mm-live-v4-table-scrollbar-thumb";
    scrollbar.append(scrollbarThumb);

    wrapper.append(tableScroll, scrollbar);
    const scheduleTableLayout = bindTableLayout(
      wrapper,
      tableScroll,
      tableElement,
      scrollbar,
      scrollbarThumb,
      this.table,
    );
    bindTableEditing(wrapper, view, this.table, scheduleTableLayout);
    return wrapper;
  }

  public destroy(dom: HTMLElement): void {
    getTableWidgetCleanup(dom)?.();
  }

  public ignoreEvent(): boolean {
    return true;
  }
}

function canPatchTableDOM(dom: HTMLElement, table: ParsedTable): boolean {
  if (!dom.classList.contains("mm-live-v4-table-widget")) {
    return false;
  }

  const existingCells = dom.querySelectorAll<HTMLElement>(
    ".mm-live-v4-table-cell",
  );
  return existingCells.length === table.columnCount * (table.body.length + 1);
}

function patchTableDOM(dom: HTMLElement, table: ParsedTable): void {
  dom.dataset.blockId = table.id;
  dom.dataset.srcFrom = String(table.from);
  dom.dataset.srcTo = String(table.to);

  patchTableRowDOM(dom, table, table.header, "header", 0);
  table.body.forEach((row, rowIndex) => {
    patchTableRowDOM(dom, table, row, "body", rowIndex);
  });

  applyColumnSizing(
    dom,
    measureTableColumnSizing(
      table,
      measureAvailableDataWidthCh(dom),
      readActiveCellSizingOverride(dom),
    ),
  );
}

function patchTableRowDOM(
  dom: HTMLElement,
  table: ParsedTable,
  sourceRow: ParsedRow,
  rowKind: "header" | "body",
  rowIndex: number,
): void {
  const lineCell = dom.querySelector<HTMLElement>(
    `.mm-live-v4-table-source-line[data-source-line="${sourceRow.lineIndex + 1}"]`,
  );
  if (lineCell) {
    lineCell.textContent = String(sourceRow.lineIndex + 1);
  }

  const values = rowToDisplayValues(sourceRow, table.columnCount);
  for (let column = 0; column < table.columnCount; column++) {
    const cell = dom.querySelector<HTMLElement>(
      [
        `.mm-live-v4-table-cell[data-row-kind="${rowKind}"]`,
        `[data-row-index="${rowIndex}"]`,
        `[data-column="${column}"]`,
      ].join(""),
    );
    if (!cell) {
      continue;
    }

    const value = values[column] ?? "";
    const isActive = cell.ownerDocument.activeElement === cell;
    cell.dataset.tableFrom = String(table.from);
    cell.dataset.sourceValue = value;
    cell.dataset.original = value;
    const sourceCell = sourceRow.cells[column];
    if (sourceCell) {
      const { leadingWhitespace, trailingWhitespace } =
        getSourceCellPaddingWhitespace(sourceCell.raw);
      cell.dataset.sourceFrom = String(sourceCell.start);
      cell.dataset.sourceTo = String(sourceCell.end);
      cell.dataset.sourceLeadingWhitespace = leadingWhitespace;
      cell.dataset.sourceTrailingWhitespace = trailingWhitespace;
    }
    if (!isActive && cell.textContent !== value) {
      cell.textContent = value;
    }
  }
}

interface TableWidgetElement extends HTMLElement {
  __mlrtTableWidgetCleanup?: () => void;
}

interface CellEditHistory {
  undoStack: CellEditSnapshot[];
  redoStack: CellEditSnapshot[];
  lastValue: string;
}

interface CellEditSnapshot {
  value: string;
  caretOffset: number;
}

interface CellCommitValueStep {
  value: string;
  restoreCaretOffset: number;
}

interface CellSourceCommitStep {
  change: {
    from: number;
    to: number;
    text: string;
  };
  restoreCaretOffset: number;
}

interface AppendCellsOptions {
  table: ParsedTable;
  sourceRow: ParsedRow;
  tableRow: HTMLTableRowElement;
  tagName: "th" | "td";
  rowKind: "header" | "body";
  rowIndex: number;
  sourceLineNumber: number;
}

interface CellTarget {
  rowKind: string;
  rowIndex: string;
  column: string;
}

type VerticalCellTarget = CellTarget | "before-table" | "after-table";

const persistentCellHistories = new Map<string, CellEditHistory>();
const preservedLiveEditTableStarts = new Set<number>();
const chWidthCache = new WeakMap<HTMLElement, { key: string; width: number }>();

function appendCells(options: AppendCellsOptions): void {
  appendSourceLineCell(options);

  const values = rowToDisplayValues(options.sourceRow, options.table.columnCount);
  values.forEach((value, column) => {
    const sourceCell = options.sourceRow.cells[column];
    const cell = document.createElement(options.tagName);
    cell.className = "mm-live-v4-table-cell";
    cell.contentEditable = "true";
    cell.spellcheck = false;
    cell.textContent = value;
    cell.dataset.tableFrom = String(options.table.from);
    cell.dataset.rowKind = options.rowKind;
    cell.dataset.rowIndex = String(options.rowIndex);
    cell.dataset.column = String(column);
    cell.dataset.original = value;
    cell.dataset.sourceValue = value;
    if (sourceCell) {
      const { leadingWhitespace, trailingWhitespace } =
        getSourceCellPaddingWhitespace(sourceCell.raw);
      cell.dataset.sourceFrom = String(sourceCell.start);
      cell.dataset.sourceTo = String(sourceCell.end);
      cell.dataset.sourceLeadingWhitespace = leadingWhitespace;
      cell.dataset.sourceTrailingWhitespace = trailingWhitespace;
    }
    cell.style.textAlign = options.table.alignments[column] ?? "left";
    options.tableRow.append(cell);
  });
}

function appendSourceLineCell(options: AppendCellsOptions): void {
  const cell = document.createElement(options.tagName);
  cell.className = "mm-live-v4-table-source-line";
  cell.contentEditable = "false";
  cell.dataset.sourceLine = String(options.sourceLineNumber);
  cell.textContent = String(options.sourceLineNumber);
  cell.setAttribute("aria-hidden", "true");
  options.tableRow.append(cell);
}

function getSourceCellPaddingWhitespace(raw: string): {
  leadingWhitespace: string;
  trailingWhitespace: string;
} {
  if (raw.trim() === "") {
    const split = Math.floor(raw.length / 2);
    return {
      leadingWhitespace: raw.slice(0, split),
      trailingWhitespace: raw.slice(split),
    };
  }

  return {
    leadingWhitespace: raw.match(/^\s*/)?.[0] ?? "",
    trailingWhitespace: raw.match(/\s*$/)?.[0] ?? "",
  };
}

function appendColumnSizing(
  tableElement: HTMLTableElement,
  table: ParsedTable,
  columnSizing: TableColumnSizing,
): void {
  const colgroup = document.createElement("colgroup");

  const lineNumberCol = document.createElement("col");
  lineNumberCol.className = "mm-live-v4-table-source-line-col";
  colgroup.append(lineNumberCol);

  for (let column = 0; column < table.columnCount; column++) {
    const col = document.createElement("col");
    col.className = "mm-live-v4-table-sized-col";
    col.style.width = `${columnSizing.columns[column].widthCh.toFixed(4)}ch`;
    colgroup.append(col);
  }

  tableElement.append(colgroup);
}

function bindTableLayout(
  wrapper: HTMLElement,
  tableScroll: HTMLElement,
  tableElement: HTMLTableElement,
  scrollbar: HTMLElement,
  scrollbarThumb: HTMLElement,
  table: ParsedTable,
): () => void {
  const syncScrollbar = () =>
    syncTableScrollbar(tableScroll, scrollbar, scrollbarThumb);
  let pendingAnimationFrame = 0;
  const syncLayout = () => {
    pendingAnimationFrame = 0;
    applyColumnSizing(
      wrapper,
      measureTableColumnSizing(
        table,
        measureAvailableDataWidthCh(wrapper),
        readActiveCellSizingOverride(wrapper),
      ),
    );
    const tableHeight = tableElement.getBoundingClientRect().height;
    syncScrollbar();
    const scrollbarHeight = scrollbar.hidden
      ? 0
      : scrollbar.getBoundingClientRect().height;
    wrapper.style.height = `${Math.max(0, tableHeight + scrollbarHeight)}px`;
  };
  const scheduleLayout = () => {
    if (pendingAnimationFrame !== 0) {
      return;
    }

    pendingAnimationFrame = requestTableAnimationFrame(wrapper, syncLayout);
  };

  const ResizeObserverCtor = wrapper.ownerDocument.defaultView?.ResizeObserver;
  const resizeObserver = ResizeObserverCtor
    ? new ResizeObserverCtor(scheduleLayout)
    : undefined;
  resizeObserver?.observe(tableElement);
  resizeObserver?.observe(tableScroll);
  tableScroll.addEventListener("scroll", syncScrollbar);

  scheduleLayout();
  setTableWidgetCleanup(wrapper, () => {
    if (pendingAnimationFrame !== 0) {
      cancelTableAnimationFrame(wrapper, pendingAnimationFrame);
      pendingAnimationFrame = 0;
    }
    resizeObserver?.disconnect();
    tableScroll.removeEventListener("scroll", syncScrollbar);
  });
  return scheduleLayout;
}

function syncTableScrollbar(
  tableScroll: HTMLElement,
  scrollbar: HTMLElement,
  scrollbarThumb: HTMLElement,
): void {
  const maxScrollLeft = Math.max(0, tableScroll.scrollWidth - tableScroll.clientWidth);
  const hasOverflow = maxScrollLeft > 1;
  scrollbar.hidden = !hasOverflow;
  if (!hasOverflow) {
    scrollbarThumb.style.width = "0px";
    scrollbarThumb.style.transform = "translateX(0px)";
    return;
  }

  const trackWidth = Math.max(0, scrollbar.clientWidth);
  const thumbWidth = Math.max(
    24,
    (tableScroll.clientWidth / tableScroll.scrollWidth) * trackWidth,
  );
  const maxThumbLeft = Math.max(0, trackWidth - thumbWidth);
  const thumbLeft = maxScrollLeft > 0
    ? (tableScroll.scrollLeft / maxScrollLeft) * maxThumbLeft
    : 0;
  scrollbarThumb.style.width = `${thumbWidth}px`;
  scrollbarThumb.style.transform = `translateX(${thumbLeft}px)`;
}

function applyColumnSizing(
  wrapper: HTMLElement,
  columnSizing: TableColumnSizing,
): void {
  wrapper.style.setProperty(
    "--mlrt-table-data-width",
    `${columnSizing.dataWidthCh.toFixed(4)}ch`,
  );
  wrapper
    .querySelectorAll<HTMLTableColElement>(".mm-live-v4-table-sized-col")
    .forEach((col, column) => {
      col.style.width = `${(
        columnSizing.columns[column]?.widthCh ?? 1
      ).toFixed(4)}ch`;
    });
}

function measureAvailableDataWidthCh(wrapper: HTMLElement): number | undefined {
  const scroller = wrapper.closest<HTMLElement>(".cm-scroller");
  if (!scroller) {
    return undefined;
  }

  const styles = getComputedStyle(scroller);
  const gutterWidth = resolveCssLengthPx(
    scroller,
    styles.getPropertyValue("--mlrt-live-gutter-width"),
  );
  const rightPadding = resolveCssLengthPx(
    scroller,
    styles.getPropertyValue("--mlrt-editor-right-padding"),
  );
  const chWidth = measureChWidth(wrapper);
  const availablePx = Math.max(
    0,
    scroller.clientWidth - gutterWidth - rightPadding,
  );
  return chWidth > 0 ? availablePx / chWidth : undefined;
}

function measureChWidth(element: HTMLElement): number {
  const styles = getComputedStyle(element);
  const cacheKey = [
    styles.fontFamily,
    styles.fontSize,
    styles.fontWeight,
    styles.fontStretch,
    styles.fontStyle,
    styles.letterSpacing,
    styles.fontFeatureSettings,
    styles.fontVariationSettings,
  ].join("|");
  const cached = chWidthCache.get(element);
  if (cached?.key === cacheKey) {
    return cached.width;
  }

  const probe = element.ownerDocument.createElement("span");
  probe.textContent = "0";
  probe.style.position = "absolute";
  probe.style.left = "-10000px";
  probe.style.top = "0";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.whiteSpace = "pre";
  probe.style.fontFamily = styles.fontFamily;
  probe.style.fontSize = styles.fontSize;
  probe.style.fontWeight = styles.fontWeight;
  probe.style.fontStretch = styles.fontStretch;
  probe.style.fontStyle = styles.fontStyle;
  probe.style.letterSpacing = styles.letterSpacing;
  probe.style.fontFeatureSettings = styles.fontFeatureSettings;
  probe.style.fontVariationSettings = styles.fontVariationSettings;
  const host = element.ownerDocument.body ?? element.ownerDocument.documentElement;
  host.append(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  chWidthCache.set(element, { key: cacheKey, width });
  return width;
}

function resolveCssLengthPx(element: HTMLElement, value: string): number {
  const direct = Number.parseFloat(value);
  if (Number.isFinite(direct) && value.trim().endsWith("px")) {
    return direct;
  }

  const probe = element.ownerDocument.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.width = value.trim() || "0px";
  element.append(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return Number.isFinite(width) ? width : 0;
}

function setTableWidgetCleanup(
  wrapper: HTMLElement,
  cleanup: () => void,
): void {
  (wrapper as TableWidgetElement).__mlrtTableWidgetCleanup = cleanup;
}

function getTableWidgetCleanup(wrapper: HTMLElement): (() => void) | undefined {
  return (wrapper as TableWidgetElement).__mlrtTableWidgetCleanup;
}

function requestTableAnimationFrame(
  wrapper: HTMLElement,
  callback: FrameRequestCallback,
): number {
  const view = wrapper.ownerDocument.defaultView;
  return view
    ? view.requestAnimationFrame(callback)
    : requestAnimationFrame(callback);
}

function cancelTableAnimationFrame(
  wrapper: HTMLElement,
  frame: number,
): void {
  const view = wrapper.ownerDocument.defaultView;
  if (view) {
    view.cancelAnimationFrame(frame);
    return;
  }

  cancelAnimationFrame(frame);
}

function readActiveCellSizingOverride(
  wrapper: HTMLElement,
): TableCellSizingOverride | undefined {
  const activeElement = wrapper.ownerDocument.activeElement;
  const cell = findCell(activeElement);
  if (!cell || !wrapper.contains(cell)) {
    return undefined;
  }

  const rowKind = cell.dataset.rowKind;
  const rowIndex = Number(cell.dataset.rowIndex ?? "0");
  const column = Number(cell.dataset.column ?? "0");
  if (
    (rowKind !== "header" && rowKind !== "body") ||
    !Number.isInteger(rowIndex) ||
    rowIndex < 0 ||
    !Number.isInteger(column) ||
    column < 0
  ) {
    return undefined;
  }

  return {
    rowKind,
    rowIndex,
    column,
    value: readCellDisplayValue(cell),
  };
}

function bindTableEditing(
  wrapper: HTMLElement,
  view: EditorView,
  table: ParsedTable,
  scheduleTableLayout: () => void,
): void {
  const cellHistories = persistentCellHistories;

  wrapper.addEventListener("focusin", (event) => {
    const cell = findCell(event.target);
    if (cell) {
      ensureCellEditHistory(cellHistories, cell);
      view.dom.classList.add("mm-live-v4-table-cell-focused");
      scheduleTableLayout();
    }
  });

  wrapper.addEventListener("beforeinput", (event) => {
    const cell = findCell(event.target);
    if (!cell || !(event instanceof InputEvent)) {
      return;
    }

    if (event.inputType === "historyUndo") {
      if (!restoreCellEditHistory(cellHistories, cell, "undo")) {
        return;
      }
      event.preventDefault();
      if (applyLiveCellEdit(view, table, cell)) {
        scheduleTableLayout();
        return;
      }
      scheduleTableLayout();
      return;
    }

    if (event.inputType === "historyRedo") {
      if (!restoreCellEditHistory(cellHistories, cell, "redo")) {
        return;
      }
      event.preventDefault();
      if (applyLiveCellEdit(view, table, cell)) {
        scheduleTableLayout();
        return;
      }
      scheduleTableLayout();
      return;
    }

    const nextSnapshot = computeBeforeInputSnapshot(cell, event);
    if (!nextSnapshot) {
      recordCellEditHistory(cellHistories, cell);
      return;
    }

    event.preventDefault();
    applyCellEditSnapshotChange(
      view,
      table,
      cell,
      cellHistories,
      nextSnapshot,
      scheduleTableLayout,
    );
  });

  wrapper.addEventListener("input", (event) => {
    const cell = findCell(event.target);
    if (!cell) {
      return;
    }

    syncCellEditHistory(cellHistories, cell);
    if (applyLiveCellEdit(view, table, cell)) {
      scheduleTableLayout();
      return;
    }
    scheduleTableLayout();
  });

  wrapper.addEventListener("focusout", (event) => {
    const cell = findCell(event.target);
    if (cell) {
      setTimeout(() => {
        if (!findCell(wrapper.ownerDocument.activeElement)) {
          view.dom.classList.remove("mm-live-v4-table-cell-focused");
        }
        if (cell.isConnected) {
          commitCellEdit(view, table, cell, cellHistories);
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

    const historyDirection = getCellEditHistoryDirection(event);
    if (historyDirection) {
      if (!restoreCellEditHistory(cellHistories, cell, historyDirection)) {
        return;
      }
      event.preventDefault();
      if (applyLiveCellEdit(view, table, cell)) {
        scheduleTableLayout();
        return;
      }
      scheduleTableLayout();
      return;
    }

    if (event.key === "Enter" && isPlainKey(event)) {
      event.preventDefault();
      commitCellEdit(view, table, cell, cellHistories, {
        selectionAnchor: getPositionAfterTable(view, table),
      });
      cell.blur();
      view.focus();
      return;
    }

    if (
      event.key === "Enter" &&
      event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      if (!getCellSelectionOffsets(cell)) {
        focusCellAtEnd(cell);
      }
      const nextSnapshot = computeCellTextInsertionSnapshot(cell, "\n");
      if (!nextSnapshot) {
        return;
      }

      event.preventDefault();
      applyCellEditSnapshotChange(
        view,
        table,
        cell,
        cellHistories,
        nextSnapshot,
        scheduleTableLayout,
      );
      return;
    }

    if (isUnmodifiedVerticalArrow(event)) {
      const rowDelta = event.key === "ArrowUp" ? -1 : 1;
      if (!isCaretAtVerticalBoundary(cell, rowDelta)) {
        return;
      }

      const target = resolveVerticalCell(cell, rowDelta);
      event.preventDefault();
      if (target === "before-table") {
        commitCellEdit(view, table, cell, cellHistories, {
          selectionAnchor: getPositionBeforeTable(table),
        });
        cell.blur();
        view.focus();
        return;
      }
      if (target === "after-table") {
        commitCellEdit(view, table, cell, cellHistories, {
          selectionAnchor: getEndOfLineAfterTable(view, table),
        });
        cell.blur();
        view.focus();
        return;
      }

      commitCellEdit(view, table, cell, cellHistories);
      focusCellAfterRender(table.from, target);
      return;
    }

    if (event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      const target = resolveRelativeCell(cell, event.shiftKey ? -1 : 1);
      commitCellEdit(view, table, cell, cellHistories);
      focusCellAfterRender(table.from, target);
    }
  });
}

function commitCellEdit(
  view: EditorView,
  table: ParsedTable,
  cell: HTMLElement,
  histories: Map<string, CellEditHistory>,
  options: { selectionAnchor?: number } = {},
): void {
  const rowKind = cell.dataset.rowKind;
  const rowIndex = Number(cell.dataset.rowIndex ?? "0");
  const column = Number(cell.dataset.column ?? "0");
  if (rowKind !== "header" && rowKind !== "body") {
    dispatchSelection(view, options.selectionAnchor);
    return;
  }

  const sourceRow =
    rowKind === "header" ? table.header : table.body[rowIndex] ?? null;
  if (!sourceRow || !Number.isInteger(column) || column < 0) {
    dispatchSelection(view, options.selectionAnchor);
    return;
  }

  const value = readCellDisplayValue(cell);
  if (value === getCellSourceValue(cell)) {
    dispatchSelection(view, options.selectionAnchor);
    return;
  }

  const originalValue = getCellSourceValue(cell);
  const caretOffset = getCellCaretOffset(cell);
  const restoreCaretOffset = Math.min(
    originalValue.length,
    caretOffset + Math.max(0, originalValue.length - value.length),
  );
  const valueSteps = buildCellCommitValueSteps(
    getCellEditHistory(histories, cell),
    originalValue,
    value,
    restoreCaretOffset,
  );
  const sourceSteps = buildCellSourceCommitSteps(
    sourceRow,
    table.columnCount,
    column,
    valueSteps,
  );
  const finalSourceStep = sourceSteps[sourceSteps.length - 1];
  if (!finalSourceStep) {
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
        tableFrom: table.from,
        rowKind,
        rowIndex,
        column,
        from: edit.from,
        to: edit.to,
        insertLength: edit.insert.length,
        valueLength: value.length,
        restoreCaretOffset: finalSourceStep.restoreCaretOffset,
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
    annotations: [
      allowTableSourceChange.of(true),
      tableCellCommitSequence.of({
        steps: sourceSteps.map((step) => ({
          change: step.change,
          restore: {
            tableFrom: table.from,
            rowKind,
            rowIndex,
            column,
            from: step.change.from,
            to: step.change.to,
            restoreCaretOffset: step.restoreCaretOffset,
          },
        })),
      }),
    ],
    scrollIntoView: true,
    userEvent: "input",
  });
}

function applyLiveCellEdit(
  view: EditorView,
  table: ParsedTable,
  cell: HTMLElement,
): boolean {
  const rowKind = cell.dataset.rowKind;
  const rowIndex = Number(cell.dataset.rowIndex ?? "0");
  const column = Number(cell.dataset.column ?? "0");
  if (
    (rowKind !== "header" && rowKind !== "body") ||
    !Number.isInteger(rowIndex) ||
    rowIndex < 0 ||
    !Number.isInteger(column) ||
    column < 0
  ) {
    return false;
  }

  const sourceRow =
    rowKind === "header" ? table.header : table.body[rowIndex] ?? null;
  if (!sourceRow) {
    return false;
  }

  const value = readCellDisplayValue(cell);
  const originalValue = getCellSourceValue(cell);
  if (value === originalValue) {
    return false;
  }

  const caretOffset = getCellCaretOffset(cell);
  const restoreCaretOffset = Math.min(
    originalValue.length,
    caretOffset + Math.max(0, originalValue.length - value.length),
  );
  const edit =
    formatLiveTableCellSourceEdit(cell, value) ??
    formatTableCellSourceEdit(
      sourceRow,
      table.columnCount,
      column,
      value,
    );
  const restore = {
    tableFrom: table.from,
    rowKind,
    rowIndex,
    column,
    from: edit.from,
    to: edit.to,
    restoreCaretOffset,
  };
  view.dom.dispatchEvent(
    new CustomEvent("mlrt:table-cell-commit", {
      bubbles: true,
      detail: {
        ...restore,
        insertLength: edit.insert.length,
        valueLength: value.length,
      },
    }),
  );
  updateTableSourceAfterCellEdit(table, rowKind, rowIndex, column, edit, value);
  updateCellSourceDataset(cell, edit, value);
  preservedLiveEditTableStarts.add(table.from);
  view.dispatch({
    changes: {
      from: edit.from,
      to: edit.to,
      insert: edit.insert,
    },
    annotations: [
      allowTableSourceChange.of(true),
      tableCellLiveEdit.of({
        change: {
          from: edit.from,
          to: edit.to,
          text: edit.insert,
        },
        restore,
      }),
    ],
    userEvent: "input",
  });
  requestTableAnimationFrame(cell, () => {
    preservedLiveEditTableStarts.delete(table.from);
  });
  if (!cell.isConnected || cell.ownerDocument.activeElement !== cell) {
    focusCellAfterRenderAtOffset(
      table.from,
      { rowKind, rowIndex: String(rowIndex), column: String(column) },
      caretOffset,
    );
  }
  return true;
}

function getCellSourceValue(cell: HTMLElement): string {
  return cell.dataset.sourceValue ?? cell.dataset.original ?? "";
}

function formatLiveTableCellSourceEdit(
  cell: HTMLElement,
  value: string,
): TableCellSourceEdit | null {
  const from = Number(cell.dataset.sourceFrom);
  const to = Number(cell.dataset.sourceTo);
  if (
    !Number.isInteger(from) ||
    from < 0 ||
    !Number.isInteger(to) ||
    to < from
  ) {
    return null;
  }

  return {
    from,
    to,
    insert: `${cell.dataset.sourceLeadingWhitespace ?? ""}${formatMarkdownCell(value, { trim: false })}${cell.dataset.sourceTrailingWhitespace ?? ""}`,
  };
}

function updateCellSourceDataset(
  cell: HTMLElement,
  edit: TableCellSourceEdit,
  value: string,
): void {
  cell.dataset.sourceValue = value;
  cell.dataset.original = value;
  cell.dataset.sourceFrom = String(edit.from);
  cell.dataset.sourceTo = String(edit.from + edit.insert.length);
}

function updateTableSourceAfterCellEdit(
  table: ParsedTable,
  rowKind: "header" | "body",
  rowIndex: number,
  column: number,
  edit: TableCellSourceEdit,
  value: string,
): void {
  const sourceRow = rowKind === "header" ? table.header : table.body[rowIndex];
  if (!sourceRow) {
    return;
  }

  const delta = edit.insert.length - (edit.to - edit.from);
  table.to += delta;
  sourceRow.to += delta;
  sourceRow.text =
    `${sourceRow.text.slice(0, edit.from - sourceRow.from)}${edit.insert}${sourceRow.text.slice(edit.to - sourceRow.from)}`;

  for (const cell of sourceRow.cells) {
    if (cell.start > edit.from) {
      cell.start += delta;
    }
    if (cell.end >= edit.to) {
      cell.end += delta;
    }
  }

  for (const row of [table.delimiter, ...table.body]) {
    if (row === sourceRow || row.from <= sourceRow.from) {
      continue;
    }
    row.from += delta;
    row.to += delta;
    for (const cell of row.cells) {
      cell.start += delta;
      cell.end += delta;
    }
  }

  const editedCell = sourceRow.cells[column];
  if (editedCell) {
    editedCell.start = edit.from;
    editedCell.end = edit.from + edit.insert.length;
    editedCell.raw = edit.insert;
  }
  table.id = `table-${table.from}-${table.to}`;
}

function buildCellCommitValueSteps(
  history: CellEditHistory | undefined,
  originalValue: string,
  finalValue: string,
  fallbackRestoreCaretOffset: number,
): CellCommitValueStep[] {
  const snapshots = history?.undoStack ?? [];
  const steps: CellCommitValueStep[] = [];
  let currentValue = originalValue;

  for (let index = 1; index < snapshots.length; index++) {
    const snapshot = snapshots[index];
    if (snapshot.value === currentValue) {
      continue;
    }

    steps.push({
      value: snapshot.value,
      restoreCaretOffset: snapshots[index - 1]?.caretOffset ?? 0,
    });
    currentValue = snapshot.value;
  }

  if (finalValue !== currentValue) {
    steps.push({
      value: finalValue,
      restoreCaretOffset:
        snapshots[snapshots.length - 1]?.caretOffset ??
        fallbackRestoreCaretOffset,
    });
  }

  return steps;
}

function buildCellSourceCommitSteps(
  sourceRow: ParsedRow,
  columnCount: number,
  column: number,
  valueSteps: CellCommitValueStep[],
): CellSourceCommitStep[] {
  let currentEdit: TableCellSourceEdit | null = null;
  return valueSteps.map((step) => {
    const formattedEdit = formatTableCellSourceEdit(
      sourceRow,
      columnCount,
      column,
      step.value,
    );
    const change = currentEdit
      ? {
          from: currentEdit.from,
          to: currentEdit.from + currentEdit.insert.length,
          text: formattedEdit.insert,
        }
      : {
          from: formattedEdit.from,
          to: formattedEdit.to,
          text: formattedEdit.insert,
        };
    currentEdit = {
      from: change.from,
      to: change.from + change.text.length,
      insert: change.text,
    };
    return {
      change,
      restoreCaretOffset: step.restoreCaretOffset,
    };
  });
}

function readCellDisplayValue(cell: HTMLElement): string {
  return cell.innerText.replace(/\u00a0/g, " ");
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

function getEndOfLineAfterTable(view: EditorView, table: ParsedTable): number {
  return view.state.doc.lineAt(getPositionAfterTable(view, table)).to;
}

function getPositionBeforeTable(table: ParsedTable): number {
  return Math.max(0, table.from - 1);
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

function resolveRelativeCell(cell: HTMLElement, delta: number): CellTarget {
  const cells = Array.from(
    cell
      .closest(".mm-live-v4-table")
      ?.querySelectorAll<HTMLElement>(".mm-live-v4-table-cell") ?? [],
  );
  const index = cells.indexOf(cell);
  const next = cells[index + delta] ?? cell;
  return {
    rowKind: next.dataset.rowKind ?? "body",
    rowIndex: next.dataset.rowIndex ?? "0",
    column: next.dataset.column ?? "0",
  };
}

function resolveVerticalCell(
  cell: HTMLElement,
  rowDelta: -1 | 1,
): VerticalCellTarget {
  const column = cell.dataset.column ?? "0";
  const columnCells = Array.from(
    cell
      .closest(".mm-live-v4-table")
      ?.querySelectorAll<HTMLElement>(
        `.mm-live-v4-table-cell[data-column="${column}"]`,
      ) ?? [],
  );
  const index = columnCells.indexOf(cell);
  const next = columnCells[index + rowDelta];
  if (!next) {
    return rowDelta < 0 ? "before-table" : "after-table";
  }

  return {
    rowKind: next.dataset.rowKind ?? "body",
    rowIndex: next.dataset.rowIndex ?? "0",
    column: next.dataset.column ?? "0",
  };
}

function focusCellAfterRender(tableFrom: number, target: CellTarget): void {
  setTimeout(() => {
    const selector = [
      `.mm-live-v4-table-cell[data-table-from="${tableFrom}"]`,
      `[data-row-kind="${target.rowKind}"]`,
      `[data-row-index="${target.rowIndex}"]`,
      `[data-column="${target.column}"]`,
    ].join("");
    const cell = document.querySelector<HTMLElement>(selector);
    if (cell) {
      focusCellAtEnd(cell);
    }
  }, 0);
}

function focusCellAfterRenderAtOffset(
  tableFrom: number,
  target: CellTarget,
  caretOffset: number,
): void {
  setTimeout(() => {
    const selector = [
      `.mm-live-v4-table-cell[data-table-from="${tableFrom}"]`,
      `[data-row-kind="${target.rowKind}"]`,
      `[data-row-index="${target.rowIndex}"]`,
      `[data-column="${target.column}"]`,
    ].join("");
    const cell = document.querySelector<HTMLElement>(selector);
    if (cell) {
      cell.focus();
      setCellCaretOffset(cell, caretOffset);
    }
  }, 0);
}

function findCell(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) {
    return null;
  }
  return target.closest<HTMLElement>(".mm-live-v4-table-cell");
}

function ensureCellEditHistory(
  histories: Map<string, CellEditHistory>,
  cell: HTMLElement,
): CellEditHistory {
  const key = getCellHistoryKey(cell);
  const existing = histories.get(key);
  if (existing) {
    return existing;
  }

  const history = {
    undoStack: [],
    redoStack: [],
    lastValue: readCellDisplayValue(cell),
  };
  histories.set(key, history);
  return history;
}

function getCellEditHistory(
  histories: Map<string, CellEditHistory>,
  cell: HTMLElement,
): CellEditHistory | undefined {
  return histories.get(getCellHistoryKey(cell));
}

function getCellHistoryKey(cell: HTMLElement): string {
  return [
    cell.dataset.tableFrom ?? "",
    cell.dataset.rowKind ?? "",
    cell.dataset.rowIndex ?? "",
    cell.dataset.column ?? "",
  ].join(":");
}

function recordCellEditHistory(
  histories: Map<string, CellEditHistory>,
  cell: HTMLElement,
): void {
  const history = ensureCellEditHistory(histories, cell);
  const snapshot = captureCellEditSnapshot(cell);
  const previousSnapshot = history.undoStack[history.undoStack.length - 1];
  if (
    previousSnapshot &&
    previousSnapshot.value === snapshot.value &&
    previousSnapshot.caretOffset === snapshot.caretOffset
  ) {
    return;
  }

  history.undoStack.push(snapshot);
  history.redoStack = [];
  history.lastValue = snapshot.value;
}

function syncCellEditHistory(
  histories: Map<string, CellEditHistory>,
  cell: HTMLElement,
): void {
  ensureCellEditHistory(histories, cell).lastValue = readCellDisplayValue(cell);
}

function restoreCellEditHistory(
  histories: Map<string, CellEditHistory>,
  cell: HTMLElement,
  direction: "undo" | "redo",
): boolean {
  const history = ensureCellEditHistory(histories, cell);
  const sourceStack = direction === "undo" ? history.undoStack : history.redoStack;
  const targetStack = direction === "undo" ? history.redoStack : history.undoStack;
  const snapshot = sourceStack.pop();
  if (!snapshot) {
    return false;
  }

  targetStack.push(captureCellEditSnapshot(cell));
  applyCellEditSnapshot(cell, snapshot);
  history.lastValue = snapshot.value;
  return true;
}

function computeBeforeInputSnapshot(
  cell: HTMLElement,
  event: InputEvent,
): CellEditSnapshot | null {
  const selection = getCellSelectionOffsets(cell);
  if (!selection) {
    return null;
  }

  const value = readCellDisplayValue(cell);
  const from = Math.min(selection.anchor, selection.head);
  const to = Math.max(selection.anchor, selection.head);
  if (event.inputType === "insertText") {
    const insert = event.data ?? "";
    return replaceCellTextRange(value, from, to, insert);
  }

  if (
    event.inputType === "insertLineBreak" ||
    event.inputType === "insertParagraph"
  ) {
    return replaceCellTextRange(value, from, to, "\n");
  }

  if (
    event.inputType === "deleteContentBackward" ||
    event.inputType === "deleteByCut"
  ) {
    if (from !== to) {
      return replaceCellTextRange(value, from, to, "");
    }
    if (from === 0) {
      return { value, caretOffset: 0 };
    }
    return replaceCellTextRange(value, from - 1, to, "");
  }

  if (event.inputType === "deleteContentForward") {
    if (from !== to) {
      return replaceCellTextRange(value, from, to, "");
    }
    if (to >= value.length) {
      return { value, caretOffset: value.length };
    }
    return replaceCellTextRange(value, from, to + 1, "");
  }

  return null;
}

function computeCellTextInsertionSnapshot(
  cell: HTMLElement,
  insert: string,
): CellEditSnapshot | null {
  const selection = getCellSelectionOffsets(cell);
  if (!selection) {
    return null;
  }

  const value = readCellDisplayValue(cell);
  return replaceCellTextRange(
    value,
    Math.min(selection.anchor, selection.head),
    Math.max(selection.anchor, selection.head),
    insert,
  );
}

function replaceCellTextRange(
  value: string,
  from: number,
  to: number,
  insert: string,
): CellEditSnapshot {
  return {
    value: `${value.slice(0, from)}${insert}${value.slice(to)}`,
    caretOffset: from + insert.length,
  };
}

function applyCellEditSnapshotChange(
  view: EditorView,
  table: ParsedTable,
  cell: HTMLElement,
  histories: Map<string, CellEditHistory>,
  snapshot: CellEditSnapshot,
  scheduleTableLayout: () => void,
): void {
  recordCellEditHistory(histories, cell);
  applyCellEditSnapshot(cell, snapshot);
  syncCellEditHistory(histories, cell);
  if (applyLiveCellEdit(view, table, cell)) {
    scheduleTableLayout();
    return;
  }
  scheduleTableLayout();
}

function captureCellEditSnapshot(cell: HTMLElement): CellEditSnapshot {
  return {
    value: readCellDisplayValue(cell),
    caretOffset: getCellCaretOffset(cell),
  };
}

function applyCellEditSnapshot(
  cell: HTMLElement,
  snapshot: CellEditSnapshot,
): void {
  setCellPlainText(cell, snapshot.value);
  setCellCaretOffset(cell, snapshot.caretOffset);
}

function setCellPlainText(cell: HTMLElement, value: string): void {
  if (cell.childNodes.length === 1 && cell.firstChild instanceof Text) {
    if (cell.firstChild.data !== value) {
      cell.firstChild.data = value;
    }
    return;
  }

  if (cell.childNodes.length === 0) {
    cell.append(cell.ownerDocument.createTextNode(value));
    return;
  }

  cell.replaceChildren(cell.ownerDocument.createTextNode(value));
}

function getCellEditHistoryDirection(
  event: KeyboardEvent,
): "undo" | "redo" | null {
  const key = event.key.toLowerCase();
  const primaryModifier = event.metaKey || event.ctrlKey;
  if (!primaryModifier || event.altKey) {
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

function isPlainKey(event: KeyboardEvent): boolean {
  return !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

function isUnmodifiedVerticalArrow(event: KeyboardEvent): boolean {
  return (
    (event.key === "ArrowUp" || event.key === "ArrowDown") &&
    isPlainKey(event)
  );
}

function getCellCaretOffset(cell: HTMLElement): number {
  const selection = cell.ownerDocument.defaultView?.getSelection();
  if (
    !selection ||
    selection.rangeCount === 0 ||
    !isNodeInside(selection.anchorNode, cell)
  ) {
    return readCellDisplayValue(cell).length;
  }

  const range = selection.getRangeAt(0).cloneRange();
  const measuringRange = cell.ownerDocument.createRange();
  measuringRange.selectNodeContents(cell);
  measuringRange.setEnd(range.endContainer, range.endOffset);
  const offset = measuringRange.toString().replace(/\u00a0/g, " ").length;
  range.detach();
  measuringRange.detach();
  return offset;
}

function getCellSelectionOffsets(
  cell: HTMLElement,
): { anchor: number; head: number } | null {
  const selection = cell.ownerDocument.defaultView?.getSelection();
  if (
    !selection ||
    selection.rangeCount === 0 ||
    !isNodeInside(selection.anchorNode, cell) ||
    !isNodeInside(selection.focusNode, cell)
  ) {
    return null;
  }

  return {
    anchor: getCellNodeOffset(cell, selection.anchorNode, selection.anchorOffset),
    head: getCellNodeOffset(cell, selection.focusNode, selection.focusOffset),
  };
}

function getCellNodeOffset(
  cell: HTMLElement,
  node: Node | null,
  offset: number,
): number {
  if (!node) {
    return readCellDisplayValue(cell).length;
  }

  const measuringRange = cell.ownerDocument.createRange();
  measuringRange.selectNodeContents(cell);
  measuringRange.setEnd(node, offset);
  const measuredOffset = measuringRange.toString().replace(/\u00a0/g, " ").length;
  measuringRange.detach();
  return measuredOffset;
}

function setCellCaretOffset(cell: HTMLElement, offset: number): void {
  const selection = cell.ownerDocument.defaultView?.getSelection();
  if (!selection) {
    return;
  }

  const walker = cell.ownerDocument.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  let remainingOffset = Math.max(0, offset);
  let textNode = walker.nextNode();
  while (textNode) {
    const length = textNode.textContent?.length ?? 0;
    if (remainingOffset <= length) {
      const range = cell.ownerDocument.createRange();
      range.setStart(textNode, remainingOffset);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      range.detach();
      return;
    }

    remainingOffset -= length;
    textNode = walker.nextNode();
  }

  focusCellAtEnd(cell);
}

function isCaretAtVerticalBoundary(
  cell: HTMLElement,
  rowDelta: -1 | 1,
): boolean {
  const selection = cell.ownerDocument.defaultView?.getSelection();
  if (
    !selection ||
    selection.rangeCount === 0 ||
    !selection.isCollapsed ||
    !isNodeInside(selection.anchorNode, cell)
  ) {
    return false;
  }

  const caretRect = getCaretRect(selection.getRangeAt(0));
  const lineBounds = getCellLineBounds(cell);
  if (!caretRect || !lineBounds) {
    return true;
  }

  const styles = getComputedStyle(cell);
  const parsedLineHeight = parseFloat(styles.lineHeight);
  const tolerance = Number.isFinite(parsedLineHeight)
    ? Math.max(2, parsedLineHeight * 0.25)
    : 3;

  return rowDelta < 0
    ? caretRect.top <= lineBounds.firstTop + tolerance
    : caretRect.bottom >= lineBounds.lastBottom - tolerance;
}

function isNodeInside(node: Node | null, element: HTMLElement): boolean {
  return node === element || (node !== null && element.contains(node));
}

function getCaretRect(range: Range): DOMRect | null {
  const directRect = firstUsefulRect(range.getClientRects());
  if (directRect) {
    return directRect;
  }

  const doc = getNodeDocument(range.startContainer);
  if (!doc) {
    return null;
  }

  const marker = doc.createElement("span");
  marker.textContent = "\u200b";
  marker.style.display = "inline-block";
  marker.style.width = "0";
  marker.style.height = "1em";
  marker.style.overflow = "hidden";
  marker.style.padding = "0";
  marker.style.margin = "0";
  marker.style.border = "0";

  const restoreRange = range.cloneRange();
  const markerRange = range.cloneRange();
  markerRange.insertNode(marker);
  const markerRect = marker.getBoundingClientRect();
  marker.remove();

  const selection = doc.defaultView?.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(restoreRange);

  return markerRect.height > 0 ? markerRect : null;
}

function getNodeDocument(node: Node): Document | null {
  return node.nodeType === Node.DOCUMENT_NODE
    ? (node as Document)
    : node.ownerDocument;
}

function getCellLineBounds(
  cell: HTMLElement,
): { firstTop: number; lastBottom: number } | null {
  const range = cell.ownerDocument.createRange();
  range.selectNodeContents(cell);
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.height > 0 && rect.width >= 0,
  );
  range.detach();
  if (rects.length === 0) {
    const cellRect = cell.getBoundingClientRect();
    return cellRect.height > 0
      ? { firstTop: cellRect.top, lastBottom: cellRect.bottom }
      : null;
  }

  return rects.reduce(
    (bounds, rect) => ({
      firstTop: Math.min(bounds.firstTop, rect.top),
      lastBottom: Math.max(bounds.lastBottom, rect.bottom),
    }),
    { firstTop: Number.POSITIVE_INFINITY, lastBottom: Number.NEGATIVE_INFINITY },
  );
}

function firstUsefulRect(rects: DOMRectList): DOMRect | null {
  for (let index = 0; index < rects.length; index++) {
    const rect = rects.item(index);
    if (rect && rect.height > 0) {
      return rect;
    }
  }

  return null;
}

function focusCellAtEnd(cell: HTMLElement): void {
  cell.focus();
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const range = document.createRange();
  range.selectNodeContents(cell);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}
