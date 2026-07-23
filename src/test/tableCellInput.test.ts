import assert from "node:assert/strict";
import {
  CellBeforeInputDecision,
  computeCellBeforeInputDecision,
  graphemeBoundaries,
  nextGraphemeBoundary,
  previousGraphemeBoundary,
} from "../shared/tableCellInput";

function applied(decision: CellBeforeInputDecision): {
  value: string;
  caretOffset: number;
} {
  assert.equal(decision.kind, "apply");
  return decision.kind === "apply"
    ? decision.snapshot
    : { value: "", caretOffset: -1 };
}

for (const grapheme of ["😀", "👩‍💻", "🇺🇸", "e\u0301"]) {
  const value = `A${grapheme}B`;
  const before = 1;
  const after = before + grapheme.length;
  assert.equal(previousGraphemeBoundary(value, after), before);
  assert.equal(nextGraphemeBoundary(value, before), after);

  assert.deepEqual(
    applied(
      computeCellBeforeInputDecision({
        value,
        selection: { anchor: after, head: after },
        inputType: "deleteContentBackward",
        data: null,
      }),
    ),
    { value: "AB", caretOffset: 1 },
    `Backspace must delete the whole ${JSON.stringify(grapheme)} grapheme`,
  );
  assert.deepEqual(
    applied(
      computeCellBeforeInputDecision({
        value,
        selection: { anchor: before, head: before },
        inputType: "deleteContentForward",
        data: null,
      }),
    ),
    { value: "AB", caretOffset: 1 },
    `Delete must delete the whole ${JSON.stringify(grapheme)} grapheme`,
  );
}

assert.deepEqual(
  graphemeBoundaries("A😀👩‍💻e\u0301B"),
  [0, 1, 3, 8, 10, 11],
  "whole-cell grapheme scans expose each safe caret boundary once",
);
assert.deepEqual(graphemeBoundaries(""), [0]);

assert.deepEqual(
  applied(
    computeCellBeforeInputDecision({
      value: "alpha beta gamma",
      selection: { anchor: 10, head: 10 },
      targetSelection: { anchor: 6, head: 10 },
      inputType: "deleteWordBackward",
      data: null,
    }),
  ),
  { value: "alpha  gamma", caretOffset: 6 },
  "native word-deletion target ranges are honored",
);

assert.deepEqual(
  applied(
    computeCellBeforeInputDecision({
      value: "misspeled word",
      selection: { anchor: 14, head: 14 },
      targetSelection: { anchor: 0, head: 9 },
      inputType: "insertReplacementText",
      data: "misspelled",
    }),
  ),
  { value: "misspelled word", caretOffset: 10 },
  "spellcheck replacement uses its target range rather than the DOM caret",
);

assert.deepEqual(
  applied(
    computeCellBeforeInputDecision({
      value: "left right",
      selection: { anchor: 4, head: 4 },
      inputType: "insertFromPaste",
      data: "\r\nnext",
    }),
  ),
  { value: "left\nnext right", caretOffset: 9 },
  "pasted cell text normalizes line endings without creating source rows",
);

for (const inputType of [
  "insertFromPasteAsQuotation",
  "insertReplacementText",
  "insertFromYank",
  "insertTranspose",
]) {
  assert.deepEqual(
    applied(
      computeCellBeforeInputDecision({
        value: "left OLD right",
        selection: { anchor: 8, head: 8 },
        targetSelection: { anchor: 5, head: 8 },
        inputType,
        data: "NEW",
      }),
    ),
    { value: "left NEW right", caretOffset: 8 },
    `${inputType} remains a safe plain-text replacement`,
  );
}

assert.equal(
  computeCellBeforeInputDecision({
    value: "keep",
    selection: { anchor: 0, head: 4 },
    inputType: "insertFromYank",
    data: null,
  }).kind,
  "block",
  "replacement input without provable plain text fails closed",
);

assert.equal(
  computeCellBeforeInputDecision({
    value: "safe",
    selection: null,
    inputType: "deleteContentBackward",
    data: null,
  }).kind,
  "block",
  "a mutation with a cross-cell or otherwise unresolvable selection fails closed",
);

assert.equal(
  computeCellBeforeInputDecision({
    value: "safe",
    selection: { anchor: 4, head: 4 },
    targetSelection: null,
    inputType: "deleteWordBackward",
    data: null,
  }).kind,
  "block",
  "an explicitly unsafe browser target range cannot fall back to the caret",
);

assert.equal(
  computeCellBeforeInputDecision({
    value: "composing",
    selection: { anchor: 9, head: 9 },
    inputType: "insertCompositionText",
    data: "日",
  }).kind,
  "native",
  "IME composition remains browser-owned inside a proven-safe cell range",
);

assert.equal(
  computeCellBeforeInputDecision({
    value: "plain",
    selection: { anchor: 0, head: 5 },
    inputType: "formatBold",
    data: null,
  }).kind,
  "block",
  "formatting mutations cannot introduce nested contenteditable DOM",
);

console.log("table cell input reliability tests passed");
