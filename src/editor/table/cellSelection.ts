/**
 * Native DOM selection helpers for rendered table cells.
 *
 * A cell is one plain-text editing host. Chromium remains the sole owner of
 * caret affinity and ordinary character/line movement; these helpers only
 * translate between DOM points and display-text offsets and contain a native
 * vertical move when Chromium tries to leave the active cell.
 */

export const TABLE_CELL_SELECTOR = ".mlrt-table-cell";

/** Resolves the rendered table cell containing an event target, if any. */
export function findCell(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) {
    return null;
  }
  return target.closest<HTMLElement>(TABLE_CELL_SELECTOR);
}

/** Reads the cell's visible plain-text value. */
export function readCellDisplayValue(cell: HTMLElement): string {
  const value = isSimpleCellContent(cell)
    ? readSimpleCellText(cell)
    : cell.innerText;
  return value.replace(/\u00a0/g, " ");
}

/**
 * Replaces the cell's content with plain text, reusing its text node when
 * possible so native selection and IME state remain stable.
 *
 * Empty values and values ending in a newline get a trailing `<br>` sentinel
 * so Chromium paints a caret line for those otherwise empty positions.
 */
export function setCellPlainText(cell: HTMLElement, value: string): void {
  const needsSentinel = cellValueNeedsCaretSentinel(value);
  const nodes = cell.childNodes;

  if (!needsSentinel && nodes.length === 1 && cell.firstChild instanceof Text) {
    if (cell.firstChild.data !== value) {
      cell.firstChild.data = value;
    }
    return;
  }

  if (
    needsSentinel &&
    nodes.length === 2 &&
    cell.firstChild instanceof Text &&
    cell.lastChild instanceof HTMLBRElement
  ) {
    if (cell.firstChild.data !== value) {
      cell.firstChild.data = value;
    }
    return;
  }

  if (!needsSentinel && nodes.length === 0) {
    cell.append(cell.ownerDocument.createTextNode(value));
    return;
  }

  cell.replaceChildren(
    cell.ownerDocument.createTextNode(value),
    ...(needsSentinel ? [cell.ownerDocument.createElement("br")] : []),
  );
}

/** Whether a plain-text cell value needs a DOM line-box sentinel. */
export function cellValueNeedsCaretSentinel(value: string): boolean {
  return value.length === 0 || value.endsWith("\n");
}

/**
 * Whether the cell contains only text nodes, optionally followed by one
 * trailing `<br>` sentinel.
 */
function isSimpleCellContent(cell: HTMLElement): boolean {
  const nodes = cell.childNodes;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node instanceof Text) {
      continue;
    }
    if (node instanceof HTMLBRElement && index === nodes.length - 1) {
      continue;
    }
    return false;
  }
  return true;
}

function readSimpleCellText(cell: HTMLElement): string {
  let text = "";
  for (const node of Array.from(cell.childNodes)) {
    if (node instanceof Text) {
      text += node.data;
    }
  }
  return text;
}

/** Caret offset within the cell text, or the text length when unavailable. */
export function getCellCaretOffset(cell: HTMLElement): number {
  const selection = cell.ownerDocument.defaultView?.getSelection();
  if (
    !selection ||
    selection.rangeCount === 0 ||
    !isNodeInside(selection.anchorNode, cell) ||
    !isNodeInside(selection.focusNode, cell)
  ) {
    return readCellDisplayValue(cell).length;
  }

  return getCellNodeOffset(
    cell,
    selection.focusNode,
    selection.focusOffset,
  );
}

/** Anchor/head offsets of the current selection inside the cell, if any. */
export function getCellSelectionOffsets(
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
    anchor: getCellNodeOffset(
      cell,
      selection.anchorNode,
      selection.anchorOffset,
    ),
    head: getCellNodeOffset(cell, selection.focusNode, selection.focusOffset),
  };
}

/** Places a collapsed caret at the given display-text offset. */
export function setCellCaretOffset(cell: HTMLElement, offset: number): void {
  setCellSelectionOffsets(cell, offset, offset);
}

/** Places a native, direction-preserving selection inside one cell. */
export function setCellSelectionOffsets(
  cell: HTMLElement,
  anchor: number,
  head: number,
): void {
  const selection = cell.ownerDocument.defaultView?.getSelection();
  if (!selection) {
    return;
  }

  const valueLength = readCellDisplayValue(cell).length;
  const anchorPoint = getCellTextPosition(
    cell,
    Math.max(0, Math.min(valueLength, anchor)),
  );
  const headPoint = getCellTextPosition(
    cell,
    Math.max(0, Math.min(valueLength, head)),
  );
  if (!anchorPoint || !headPoint) {
    setCellSelectionAtEnd(cell);
    return;
  }

  if (typeof selection.setBaseAndExtent === "function") {
    selection.setBaseAndExtent(
      anchorPoint.node,
      anchorPoint.offset,
      headPoint.node,
      headPoint.offset,
    );
    return;
  }

  const range = cell.ownerDocument.createRange();
  const forward = anchor <= head;
  const start = forward ? anchorPoint : headPoint;
  const end = forward ? headPoint : anchorPoint;
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  selection.removeAllRanges();
  selection.addRange(range);
  range.detach();
}

/** Focuses the cell and collapses the selection to its start. */
export function focusCellAtStart(cell: HTMLElement): void {
  cell.focus();
  setCellCaretOffset(cell, 0);
}

/** Focuses the cell and collapses the selection to its end. */
export function focusCellAtEnd(cell: HTMLElement): void {
  cell.focus();
  setCellCaretOffset(cell, readCellDisplayValue(cell).length);
}

/**
 * Applies Chromium's native visual-line boundary movement while containing
 * the result to one editing host. Escaped or failed moves are restored
 * synchronously before another event can observe them.
 */
export function moveCellSelectionToLineBoundary(
  cell: HTMLElement,
  side: "start" | "end",
  extend: boolean,
): boolean {
  const selection = cell.ownerDocument.defaultView?.getSelection();
  const original = getCellSelectionOffsets(cell);
  if (!selection || !original || typeof selection.modify !== "function") {
    return false;
  }

  try {
    selection.modify(
      extend ? "extend" : "move",
      side === "start" ? "backward" : "forward",
      "lineboundary",
    );
    if (getCellSelectionOffsets(cell)) {
      return true;
    }
  } catch {
    // Restore the snapshot below.
  }

  cell.focus({ preventScroll: true });
  setCellSelectionOffsets(cell, original.anchor, original.head);
  return false;
}

/**
 * Extends the selection by one native visual line, accepting the operation
 * only while both endpoints remain in this editing host. The call is
 * synchronous, so an escaped browser selection is restored before any later
 * key or input event can observe it.
 */
export function extendCellSelectionVertically(
  cell: HTMLElement,
  rowDelta: -1 | 1,
): { movedWithinCell: boolean; preferredX: null } {
  const selection = cell.ownerDocument.defaultView?.getSelection();
  const original = getCellSelectionOffsets(cell);
  if (!selection || !original || typeof selection.modify !== "function") {
    return { movedWithinCell: false, preferredX: null };
  }

  try {
    selection.modify(
      "extend",
      rowDelta < 0 ? "backward" : "forward",
      "line",
    );
    const result = getCellSelectionOffsets(cell);
    if (
      result &&
      (result.anchor !== original.anchor || result.head !== original.head)
    ) {
      return { movedWithinCell: true, preferredX: null };
    }
  } catch {
    // Restore the snapshot below.
  }

  cell.focus({ preventScroll: true });
  setCellSelectionOffsets(cell, original.anchor, original.head);
  return { movedWithinCell: false, preferredX: null };
}

/**
 * Moves by one native visual line. A result that leaves this editing host—or
 * an unchanged result at its vertical edge—is restored and reported to the
 * caller as a cell-boundary move.
 */
export function moveCellCaretVertically(
  cell: HTMLElement,
  rowDelta: -1 | 1,
): { movedWithinCell: boolean; preferredX: number | null } {
  const selection = cell.ownerDocument.defaultView?.getSelection();
  const original = getCellSelectionOffsets(cell);
  if (!selection || !original || typeof selection.modify !== "function") {
    return { movedWithinCell: false, preferredX: null };
  }
  const preferredX = getCollapsedCaretX(cell, selection);

  try {
    selection.modify(
      "move",
      rowDelta < 0 ? "backward" : "forward",
      "line",
    );
    const result = getCellSelectionOffsets(cell);
    if (
      result &&
      (result.anchor !== original.anchor || result.head !== original.head)
    ) {
      return { movedWithinCell: true, preferredX };
    }
  } catch {
    // Restore the snapshot below.
  }

  cell.focus({ preventScroll: true });
  setCellSelectionOffsets(cell, original.anchor, original.head);
  return { movedWithinCell: false, preferredX };
}

/**
 * Focuses a deterministic logical edge when entering a cell vertically.
 * Downward entry uses the start; upward entry uses the end.
 */
export function focusCellAtVerticalEdge(
  cell: HTMLElement,
  rowDelta: -1 | 1,
  preferredX: number | null = null,
): void {
  if (rowDelta > 0) {
    focusCellAtStart(cell);
  } else {
    focusCellAtEnd(cell);
  }

  if (preferredX === null || !Number.isFinite(preferredX)) {
    return;
  }
  const caretPositionFromPoint = cell.ownerDocument.caretPositionFromPoint;
  const cellRect = cell.getBoundingClientRect();
  if (typeof caretPositionFromPoint !== "function" || cellRect.width <= 2) {
    return;
  }

  const contents = cell.ownerDocument.createRange();
  contents.selectNodeContents(cell);
  const lineRects = contents.getClientRects();
  const lineRect = rowDelta > 0
    ? lineRects.item(0)
    : lineRects.item(lineRects.length - 1);
  contents.detach();
  if (!lineRect || lineRect.height <= 0 || lineRect.width <= 0) {
    return;
  }

  const lineInset = Math.min(0.25, lineRect.width / 4);
  const lineLeft = Math.max(cellRect.left + 1, lineRect.left + lineInset);
  const lineRight = Math.min(cellRect.right - 1, lineRect.right - lineInset);
  const x = Math.max(
    lineLeft,
    Math.min(lineRight, preferredX),
  );
  const y = lineRect.top + lineRect.height / 2;
  const caret = caretPositionFromPoint.call(cell.ownerDocument, x, y);
  if (!caret || !isNodeInside(caret.offsetNode, cell)) {
    return;
  }

  try {
    const range = cell.ownerDocument.createRange();
    range.setStart(caret.offsetNode, caret.offset);
    range.collapse(true);
    const selection = cell.ownerDocument.defaultView?.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  } catch {
    // Keep the deterministic start/end fallback established above.
  }
}

/** requestAnimationFrame bound to the element's owner window. */
export function requestElementAnimationFrame(
  element: HTMLElement,
  callback: FrameRequestCallback,
): number {
  const view = element.ownerDocument.defaultView;
  return view
    ? view.requestAnimationFrame(callback)
    : requestAnimationFrame(callback);
}

/** cancelAnimationFrame bound to the element's owner window. */
export function cancelElementAnimationFrame(
  element: HTMLElement,
  frame: number,
): void {
  const view = element.ownerDocument.defaultView;
  if (view) {
    view.cancelAnimationFrame(frame);
    return;
  }
  cancelAnimationFrame(frame);
}

function isNodeInside(node: Node | null, element: HTMLElement): boolean {
  return node === element || (node !== null && element.contains(node));
}

function setCellSelectionAtEnd(cell: HTMLElement): void {
  const selection = cell.ownerDocument.defaultView?.getSelection();
  if (!selection) {
    return;
  }
  const range = cell.ownerDocument.createRange();
  range.selectNodeContents(cell);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function getCellNodeOffset(
  cell: HTMLElement,
  node: Node | null,
  offset: number,
): number {
  if (!node) {
    return readCellDisplayValue(cell).length;
  }
  const range = cell.ownerDocument.createRange();
  range.selectNodeContents(cell);
  range.setEnd(node, offset);
  const measured = range.toString().replace(/\u00a0/g, " ").length;
  range.detach();
  return measured;
}

function getCellTextPosition(
  cell: HTMLElement,
  offset: number,
): { node: Text; offset: number } | null {
  const walker = cell.ownerDocument.createTreeWalker(
    cell,
    NodeFilter.SHOW_TEXT,
  );
  let remaining = Math.max(0, offset);
  let lastText: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text)) {
      continue;
    }
    lastText = node;
    if (remaining <= node.data.length) {
      return { node, offset: remaining };
    }
    remaining -= node.data.length;
  }
  return lastText && remaining === 0
    ? { node: lastText, offset: lastText.data.length }
    : null;
}

function getCollapsedCaretX(
  cell: HTMLElement,
  selection: Selection,
): number | null {
  if (!selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  const caretRange = selection.getRangeAt(0);
  const directRect = caretRange.getBoundingClientRect();
  if (directRect.height > 0 && Number.isFinite(directRect.left)) {
    return directRect.left;
  }

  const offsets = getCellSelectionOffsets(cell);
  const valueLength = readCellDisplayValue(cell).length;
  if (!offsets || valueLength === 0) {
    return null;
  }
  const useLeadingEdge = offsets.head < valueLength;
  const from = useLeadingEdge ? offsets.head : offsets.head - 1;
  const start = getCellTextPosition(cell, from);
  const end = getCellTextPosition(cell, from + 1);
  if (!start || !end) {
    return null;
  }
  const adjacentRange = cell.ownerDocument.createRange();
  adjacentRange.setStart(start.node, start.offset);
  adjacentRange.setEnd(end.node, end.offset);
  const rect = adjacentRange.getBoundingClientRect();
  adjacentRange.detach();
  if (rect.height <= 0 || !Number.isFinite(rect.left)) {
    return null;
  }

  const isRtl = getComputedStyle(cell).direction === "rtl";
  return useLeadingEdge === isRtl ? rect.right : rect.left;
}
