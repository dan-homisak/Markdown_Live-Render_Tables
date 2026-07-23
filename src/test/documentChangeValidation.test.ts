import assert from "node:assert/strict";
import {
  DocumentChangeClaim,
  validateDocumentChangeClaim,
} from "../shared/documentChangeValidation";

function expectFailure(
  result: ReturnType<typeof validateDocumentChangeClaim>,
  code: Exclude<typeof result, { ok: true }>["code"],
  location: { groupIndex?: number; changeIndex?: number } = {},
): void {
  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.code, code);
  assert.equal(result.groupIndex, location.groupIndex);
  assert.equal(result.changeIndex, location.changeIndex);
}

// Simultaneous changes all use offsets from the same starting snapshot. A
// length-changing first edit must not shift a later range during replay.
const simultaneousBefore = "abcdef";
const simultaneous = validateDocumentChangeClaim(simultaneousBefore, {
  beforeText: simultaneousBefore,
  finalText: "aXXcdYYf",
  changes: [
    { from: 1, to: 2, text: "XX" },
    { from: 4, to: 5, text: "YY" },
  ],
});
assert.deepEqual(simultaneous, {
  ok: true,
  finalText: "aXXcdYYf",
  mode: "simultaneous",
  changeCount: 2,
});

// Rapid cell keystrokes can remain on one host revision while each queued
// group targets the document produced by the preceding group.
const rapidBefore = [
  "| A | B |",
  "| --- | --- |",
  "| r1 | x |",
  "| r2 | y |",
].join("\n");
const yFrom = rapidBefore.lastIndexOf("y");
const rapidFinal = `${rapidBefore.slice(0, yFrom)}abc${rapidBefore.slice(yFrom + 1)}`;
const rapid = validateDocumentChangeClaim(rapidBefore, {
  beforeText: rapidBefore,
  finalText: rapidFinal,
  changeGroups: [
    [{ from: yFrom, to: yFrom + 1, text: "a" }],
    [{ from: yFrom, to: yFrom + 1, text: "ab" }],
    [{ from: yFrom, to: yFrom + 2, text: "abc" }],
  ],
});
assert.deepEqual(rapid, {
  ok: true,
  finalText: rapidFinal,
  mode: "sequential",
  changeCount: 3,
});

// A sender whose ranges were calculated before an authoritative host edit is
// rejected before any replay is attempted.
expectFailure(
  validateDocumentChangeClaim(`\n${rapidBefore}`, {
    beforeText: rapidBefore,
    finalText: rapidFinal,
    changes: [{ from: yFrom, to: yFrom + 1, text: "abc" }],
  }),
  "before-text-mismatch",
);

// Even if a stale sender incorrectly claims the current base, replaying its
// old offsets cannot prove the safe expected result. This is the row-damage
// case where the stale range consumes a separator and the original cell.
const authoritativeWithPrefix = `\n${rapidBefore}`;
const paddedYFrom = rapidBefore.lastIndexOf(" y ");
const safeMergedFinal = `\n${rapidBefore.slice(0, paddedYFrom)} edited ${rapidBefore.slice(paddedYFrom + 3)}`;
expectFailure(
  validateDocumentChangeClaim(authoritativeWithPrefix, {
    beforeText: authoritativeWithPrefix,
    finalText: safeMergedFinal,
    changes: [
      { from: paddedYFrom, to: paddedYFrom + 3, text: " edited " },
    ],
  }),
  "final-text-mismatch",
);

expectFailure(
  validateDocumentChangeClaim("abc", {
    beforeText: "abc",
    finalText: "abc!",
    changes: [{ from: 3, to: 4, text: "!" }],
  }),
  "out-of-range",
  { groupIndex: 0, changeIndex: 0 },
);

expectFailure(
  validateDocumentChangeClaim("abcdef", {
    beforeText: "abcdef",
    finalText: "irrelevant",
    changes: [
      { from: 4, to: 5, text: "X" },
      { from: 1, to: 2, text: "Y" },
    ],
  }),
  "unsorted-changes",
  { groupIndex: 0, changeIndex: 1 },
);

expectFailure(
  validateDocumentChangeClaim("abcdef", {
    beforeText: "abcdef",
    finalText: "irrelevant",
    changes: [
      { from: 1, to: 4, text: "X" },
      { from: 3, to: 5, text: "Y" },
    ],
  }),
  "overlapping-changes",
  { groupIndex: 0, changeIndex: 1 },
);

// Two point edits at one offset have host-dependent ordering and are rejected
// as an ambiguous overlap.
expectFailure(
  validateDocumentChangeClaim("abc", {
    beforeText: "abc",
    finalText: "aXYbc",
    changes: [
      { from: 1, to: 1, text: "X" },
      { from: 1, to: 1, text: "Y" },
    ],
  }),
  "overlapping-changes",
  { groupIndex: 0, changeIndex: 1 },
);

// Group two is measured against the shortened result of group one, so a range
// that was valid only in the original snapshot must fail.
expectFailure(
  validateDocumentChangeClaim("abcdef", {
    beforeText: "abcdef",
    finalText: "irrelevant",
    changeGroups: [
      [{ from: 0, to: 6, text: "x" }],
      [{ from: 5, to: 6, text: "y" }],
    ],
  }),
  "out-of-range",
  { groupIndex: 1, changeIndex: 0 },
);

expectFailure(
  validateDocumentChangeClaim("abc", {
    beforeText: "abc",
    finalText: "claimed-but-wrong",
    changes: [{ from: 1, to: 2, text: "B" }],
  }),
  "final-text-mismatch",
);

// Runtime callers can still hand the module malformed data despite the static
// union, so both/neither mode shapes are rejected defensively.
expectFailure(
  validateDocumentChangeClaim("abc", {
    beforeText: "abc",
    finalText: "abc",
    changes: [],
    changeGroups: [],
  } as unknown as DocumentChangeClaim),
  "invalid-claim",
);
expectFailure(
  validateDocumentChangeClaim("abc", {
    beforeText: "abc",
    finalText: "abc",
  } as unknown as DocumentChangeClaim),
  "invalid-claim",
);

expectFailure(
  validateDocumentChangeClaim("abc", {
    beforeText: "abc",
    finalText: "abc",
    changes: [{ from: 0.5, to: 1, text: "" }],
  } as DocumentChangeClaim),
  "invalid-change",
  { groupIndex: 0, changeIndex: 0 },
);

console.log("document change validation tests passed");
