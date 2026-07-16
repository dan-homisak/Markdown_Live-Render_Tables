export interface CellTextSelection {
  anchor: number;
  head: number;
}

export interface CellTextEditSnapshot {
  value: string;
  caretOffset: number;
}

export type CellBeforeInputDecision =
  | { kind: "apply"; snapshot: CellTextEditSnapshot }
  | { kind: "native" }
  | { kind: "block" };

export interface CellBeforeInputOptions {
  value: string;
  selection: CellTextSelection | null;
  targetSelection?: CellTextSelection | null;
  inputType: string;
  data: string | null;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

/**
 * Computes a safe plain-text replacement for a contenteditable beforeinput
 * event. Browser target ranges take precedence over the live DOM selection:
 * they encode platform-native word, line, spellcheck, and grapheme behavior.
 *
 * A mutation whose range cannot be proven to stay inside one table cell is
 * blocked. This is deliberately fail-closed—letting Chromium apply such a
 * mutation can merge sibling cells or remove an entire rendered row before
 * the source editor has a chance to validate it.
 */
export function computeCellBeforeInputDecision(
  options: CellBeforeInputOptions,
): CellBeforeInputDecision {
  const { value, inputType, data } = options;
  const selection = normalizeSelection(
    value,
    options.targetSelection === undefined
      ? options.selection
      : options.targetSelection,
  );

  if (!selection) {
    return { kind: "block" };
  }

  const from = Math.min(selection.anchor, selection.head);
  const to = Math.max(selection.anchor, selection.head);

  if (inputType === "insertText") {
    return data === null
      ? { kind: "native" }
      : applyReplacement(value, from, to, data);
  }

  if (
    inputType === "insertFromPaste" ||
    inputType === "insertFromPasteAsQuotation" ||
    inputType === "insertFromDrop" ||
    inputType === "insertReplacementText" ||
    inputType === "insertFromYank" ||
    inputType === "insertTranspose"
  ) {
    return data === null
      ? { kind: "block" }
      : applyReplacement(value, from, to, normalizeLineEndings(data));
  }

  if (
    inputType === "insertLineBreak" ||
    inputType === "insertParagraph"
  ) {
    return applyReplacement(value, from, to, "\n");
  }

  if (
    inputType === "insertCompositionText" ||
    inputType === "deleteCompositionText"
  ) {
    return { kind: "native" };
  }

  if (inputType.startsWith("delete")) {
    // A browser target range (or an ordinary non-empty selection) already
    // describes the exact deletion, including whole emoji and word/line
    // shortcuts. Use it without trying to reproduce platform semantics.
    if (from !== to) {
      return applyReplacement(value, from, to, "");
    }

    if (inputType === "deleteContentBackward") {
      const previous = previousGraphemeBoundary(value, from);
      return applyReplacement(value, previous, to, "");
    }

    if (inputType === "deleteContentForward") {
      const next = nextGraphemeBoundary(value, to);
      return applyReplacement(value, from, next, "");
    }

    // Cut with a collapsed selection is a safe no-op. Word/line/drag deletes
    // without a browser target range are not guessed—the safe behavior is to
    // leave the cell unchanged.
    return {
      kind: "apply",
      snapshot: { value, caretOffset: from },
    };
  }

  // Formatting/list/unknown input types are not valid plain-text cell edits.
  return { kind: "block" };
}

export function previousGraphemeBoundary(
  value: string,
  offset: number,
): number {
  const clamped = clampOffset(value, offset);
  let previous = 0;
  for (const segment of graphemeSegmenter.segment(value)) {
    if (segment.index >= clamped) {
      break;
    }
    previous = segment.index;
  }
  return previous;
}

export function nextGraphemeBoundary(value: string, offset: number): number {
  const clamped = clampOffset(value, offset);
  for (const segment of graphemeSegmenter.segment(value)) {
    if (segment.index > clamped) {
      return segment.index;
    }
  }
  return value.length;
}

function normalizeSelection(
  value: string,
  selection: CellTextSelection | null,
): CellTextSelection | null {
  if (
    !selection ||
    !Number.isInteger(selection.anchor) ||
    !Number.isInteger(selection.head) ||
    selection.anchor < 0 ||
    selection.head < 0 ||
    selection.anchor > value.length ||
    selection.head > value.length
  ) {
    return null;
  }

  return selection;
}

function applyReplacement(
  value: string,
  from: number,
  to: number,
  insert: string,
): CellBeforeInputDecision {
  return {
    kind: "apply",
    snapshot: {
      value: `${value.slice(0, from)}${insert}${value.slice(to)}`,
      caretOffset: from + insert.length,
    },
  };
}

function clampOffset(value: string, offset: number): number {
  return Math.min(value.length, Math.max(0, offset));
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}
