/**
 * DOM caret, selection, and focus utilities for rendered table cells.
 *
 * Cells are `contenteditable` elements that hold plain text (single text node
 * in the common case). All offsets are measured in display characters, with
 * non-breaking spaces normalized to regular spaces to match the markdown
 * source values.
 */

export const TABLE_CELL_SELECTOR = ".mlrt-table-cell";

/** Resolves the rendered table cell that contains an event target, if any. */
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
 * Replaces the cell's content with plain text, reusing the existing text node
 * when possible so the browser keeps selection and IME state stable.
 *
 * A value ending in a newline gets a trailing `<br>` sentinel: in a
 * `white-space: pre-wrap` contenteditable a trailing `\n` alone renders no
 * line box, so without the sentinel the caret could never sit on the new
 * empty line (Shift+Enter at the end of a cell would appear to do nothing).
 */
export function setCellPlainText(cell: HTMLElement, value: string): void {
  const needsSentinel = value.endsWith("\n");
  const nodes = cell.childNodes;

  if (
    !needsSentinel &&
    nodes.length === 1 &&
    cell.firstChild instanceof Text
  ) {
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

/**
 * Whether the cell contains only text nodes, optionally followed by one
 * trailing `<br>` sentinel. Anything else (e.g. HTML from a native paste)
 * falls back to `innerText` reading.
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
  const nodes = cell.childNodes;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
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
    anchor: getCellNodeOffset(cell, selection.anchorNode, selection.anchorOffset),
    head: getCellNodeOffset(cell, selection.focusNode, selection.focusOffset),
  };
}

/** Places a collapsed caret at the given text offset inside the cell. */
export function setCellCaretOffset(cell: HTMLElement, offset: number): void {
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

/** Focuses the cell and collapses the selection to its end. */
export function focusCellAtEnd(cell: HTMLElement): void {
  cell.focus();
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

/**
 * Whether the caret sits on the first (`rowDelta` -1) or last (`rowDelta` 1)
 * visual line of the cell, meaning an unmodified vertical arrow should leave
 * the cell instead of moving within wrapped text.
 */
export function isCaretAtVerticalBoundary(
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

/**
 * Client rect for a collapsed caret range. Empty text positions (start of an
 * empty line) report no rects, so a zero-width marker is inserted briefly to
 * measure the caret location, then the original selection is restored.
 */
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
