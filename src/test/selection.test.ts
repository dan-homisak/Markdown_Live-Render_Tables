import assert from "node:assert/strict";
import {
  documentSelectionProjectionsEqual,
  cellRectangle,
  clearDocumentSelectionProjection,
  DocumentTableSelectionRegion,
  fullTableRectangle,
  getDocumentSelectionProjection,
  proseToTableRectangle,
  setDocumentSelectionProjection,
  tableToProseRectangle,
} from "../editor/documentSelectionState";

const dimensions = { rowCount: 4, columnCount: 5 };

// Prose above a table grows from the entry edge and preserves both x/y
// granularity until the pointer crosses the far vertical edge.
assert.deepEqual(
  proseToTableRectangle("forward", { row: 1, column: 0 }, dimensions),
  { top: 0, bottom: 1, left: 0, right: 0 },
);
assert.deepEqual(
  proseToTableRectangle("forward", { row: 1, column: 4 }, dimensions),
  { top: 0, bottom: 1, left: 0, right: 4 },
);

// Reverse drags are symmetrical from the bottom-right entry edge.
assert.deepEqual(
  proseToTableRectangle("backward", { row: 2, column: 3 }, dimensions),
  { top: 2, bottom: 3, left: 3, right: 4 },
);

// Leaving a cell selection vertically expands all traversed rows to the full
// table width, including the row where the gesture began.
assert.deepEqual(
  tableToProseRectangle("below", { row: 1, column: 2 }, dimensions),
  { top: 1, bottom: 3, left: 0, right: 4 },
);
assert.deepEqual(
  tableToProseRectangle("above", { row: 2, column: 2 }, dimensions),
  { top: 0, bottom: 2, left: 0, right: 4 },
);

// Cell-to-cell drag remains a conventional reversible rectangle.
assert.deepEqual(
  cellRectangle(
    { row: 3, column: 4 },
    { row: 1, column: 2 },
    dimensions,
  ),
  { top: 1, bottom: 3, left: 2, right: 4 },
);

assert.deepEqual(fullTableRectangle(dimensions), {
  top: 0,
  bottom: 3,
  left: 0,
  right: 4,
});

// Pointer coordinates outside a table are clamped rather than allowed to
// manufacture negative or beyond-document cell addresses.
assert.deepEqual(
  proseToTableRectangle("forward", { row: 99, column: -4 }, dimensions),
  { top: 0, bottom: 3, left: 0, right: 0 },
);
assert.deepEqual(
  proseToTableRectangle("backward", { row: -9, column: 99 }, dimensions),
  { top: 0, bottom: 3, left: 4, right: 4 },
);
assert.deepEqual(
  tableToProseRectangle("below", { row: -3, column: 99 }, dimensions),
  { top: 0, bottom: 3, left: 0, right: 4 },
);
assert.deepEqual(
  cellRectangle(
    { row: -1, column: 99 },
    { row: 99, column: -1 },
    dimensions,
  ),
  { top: 0, bottom: 3, left: 0, right: 4 },
);

// A mixed projection is tied to one exact linear range. Region input and
// returned snapshots are defensively copied and normalized so later pointer
// updates cannot mutate stored geometry by alias.
const documentOne = {} as Document;
const inputRegions: DocumentTableSelectionRegion[] = [
  { tableFrom: 40, top: 3, bottom: 1, left: 4, right: 2 },
  { tableFrom: 90, top: 0, bottom: 2, left: 0, right: 1 },
];
setDocumentSelectionProjection(documentOne, {
  anchor: 12,
  head: 104,
  tableRegions: inputRegions,
});
inputRegions[0].top = 99;
inputRegions.push({ tableFrom: 120, top: 0, bottom: 0, left: 0, right: 0 });
const firstSnapshot = getDocumentSelectionProjection(documentOne, {
  anchor: 12,
  head: 104,
});
assert.deepEqual(firstSnapshot, {
  anchor: 12,
  head: 104,
  tableRegions: [
    { tableFrom: 40, top: 1, bottom: 3, left: 2, right: 4 },
    { tableFrom: 90, top: 0, bottom: 2, left: 0, right: 1 },
  ],
});
(firstSnapshot?.tableRegions as DocumentTableSelectionRegion[])[0].left = 99;
assert.equal(
  getDocumentSelectionProjection(documentOne, { anchor: 12, head: 104 })
    ?.tableRegions[0].left,
  2,
);

// Compatibility mouse events should be able to recognize that the pointer
// event already published the exact same mixed-selection geometry.
assert.equal(
  documentSelectionProjectionsEqual(
    {
      anchor: 10,
      head: 80,
      tableRegions: [
        { tableFrom: 20, top: 0, bottom: 2, left: 0, right: 1 },
      ],
    },
    {
      anchor: 10,
      head: 80,
      tableRegions: [
        { tableFrom: 20, top: 0, bottom: 2, left: 0, right: 1 },
      ],
    },
  ),
  true,
);
assert.equal(
  documentSelectionProjectionsEqual(
    {
      anchor: 10,
      head: 80,
      tableRegions: [
        { tableFrom: 20, top: 0, bottom: 2, left: 0, right: 1 },
      ],
    },
    {
      anchor: 10,
      head: 80,
      tableRegions: [
        { tableFrom: 20, top: 0, bottom: 2, left: 0, right: 2 },
      ],
    },
  ),
  false,
);

// Any unrelated selection invalidates the projection instead of leaving stale
// cell rectangles that can reappear if the old endpoints are visited later.
assert.equal(
  getDocumentSelectionProjection(documentOne, { anchor: 13, head: 104 }),
  null,
);
assert.equal(
  getDocumentSelectionProjection(documentOne, { anchor: 12, head: 104 }),
  null,
);

const documentTwo = {} as Document;
setDocumentSelectionProjection(documentTwo, {
  anchor: 1,
  head: 2,
  tableRegions: [],
});
assert.ok(getDocumentSelectionProjection(documentTwo, { anchor: 1, head: 2 }));
clearDocumentSelectionProjection(documentTwo);
assert.equal(getDocumentSelectionProjection(documentTwo), null);

console.log("selection tests passed");
