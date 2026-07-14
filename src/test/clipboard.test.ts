import assert from "node:assert/strict";
import {
  buildGridClearEdit,
  buildGridPasteEdit,
  ClipboardCell,
  gridToHtml,
  gridToMarkdown,
  MLRT_CLIPBOARD_VERSION,
  parseClipboardPayload,
  parseDelimitedGrid,
  resolveGridPasteRows,
  serializeDelimitedGrid,
  tableRectanglePayload,
  validateClipboardPayload,
} from "../shared/clipboardModel";
import { parseMarkdownTables } from "../shared/tableModel";

const source = [
  "Before",
  "| Name | Value | Notes |",
  "| :--- | ---: | :---: |",
  "| Alpha | 1 | A &#124; B |",
  "| Emoji | 2 | 😀<br>line two |",
  "After",
].join("\n");
const table = parseMarkdownTables(source)[0];
assert.ok(table, "fixture table parses");

const payload = tableRectanglePayload(
  table,
  { top: 0, bottom: 2, left: 0, right: 2 },
  "file:///fixture.md",
);
assert.equal(payload.version, MLRT_CLIPBOARD_VERSION);
assert.equal(payload.rows[1][2].text, "A | B");
assert.equal(payload.rows[2][2].text, "😀\nline two");
assert.equal(payload.exactMarkdown, source.split("\n").slice(1, 5).join("\n"));

const roundTrip = parseClipboardPayload(JSON.stringify(payload));
assert.deepEqual(roundTrip, payload, "private payload validates losslessly");
assert.equal(
  validateClipboardPayload({ ...payload, version: 2 }),
  null,
  "unknown payload versions are rejected",
);
assert.equal(
  validateClipboardPayload({ ...payload, rows: [[{ text: "x" }], []] }),
  null,
  "ragged private grids are rejected",
);

const unsafeRawPayload = validateClipboardPayload({
  version: MLRT_CLIPBOARD_VERSION,
  kind: "grid",
  sourceDocument: "file:///fixture.md",
  rows: [
    [
      {
        text: "safe display\n# not a table row",
        markdown: " safe display\n# not a table row ",
      },
    ],
  ],
  alignments: ["left"],
  includesHeader: false,
});
assert.ok(unsafeRawPayload?.kind === "grid");
assert.deepEqual(
  unsafeRawPayload.rows[0][0],
  { text: "safe display\n# not a table row" },
  "private cells discard raw Markdown containing a line break",
);
const unsafeRawPasteEdit = buildGridPasteEdit(table, {
  rows: unsafeRawPayload.rows,
  destination: { top: 1, bottom: 1, left: 0, right: 0 },
});
assert.doesNotMatch(unsafeRawPasteEdit.insert, /\n# not a table row/);
const tableAfterUnsafeRawPaste = parseMarkdownTables(unsafeRawPasteEdit.insert);
assert.equal(tableAfterUnsafeRawPaste.length, 1);
assert.equal(tableAfterUnsafeRawPaste[0].columnCount, table.columnCount);
assert.equal(tableAfterUnsafeRawPaste[0].body.length, table.body.length);

const delimitedRows = [
  ["plain", "tab\tinside", "quote \"inside\""],
  ["line\none", "😀", ""],
];
const tsv = serializeDelimitedGrid(delimitedRows, "\t");
assert.deepEqual(parseDelimitedGrid(tsv, "\t"), delimitedRows);
const csv = serializeDelimitedGrid(delimitedRows, ",");
assert.deepEqual(parseDelimitedGrid(csv, ","), delimitedRows);
assert.equal(parseDelimitedGrid('"unterminated', "\t"), null);

const markdownCells: ClipboardCell[][] = [
  [{ text: "A | B" }, { text: "C" }],
  [{ text: "😀" }, { text: "line\ntwo" }],
];
assert.equal(
  gridToMarkdown(markdownCells, ["left", "right"]),
  [
    "| A &#124; B | C |",
    "| --- | ---: |",
    "| 😀 | line<br>two |",
  ].join("\n"),
);
const html = gridToHtml(markdownCells, {
  embeddedPayload: "payload<&\"",
});
assert.match(html, /<table/);
assert.match(html, /A \| B/);
assert.doesNotMatch(html, /A & B/);
assert.match(html, /name="mlrt-clipboard"/);

assert.deepEqual(
  resolveGridPasteRows(
    [[{ text: "a" }, { text: "b" }]],
    { top: 1, bottom: 2, left: 0, right: 3 },
  ),
  [
    [{ text: "a" }, { text: "b" }, { text: "a" }, { text: "b" }],
    [{ text: "a" }, { text: "b" }, { text: "a" }, { text: "b" }],
  ],
  "exact multiples tile like Excel",
);
assert.equal(
  resolveGridPasteRows(
    [[{ text: "a" }, { text: "b" }]],
    { top: 0, bottom: 2, left: 0, right: 2 },
  ),
  null,
  "incompatible destination sizes are rejected",
);

const pasteEdit = buildGridPasteEdit(table, {
  rows: [
    [{ text: "Ω" }, { text: "x | y" }],
    [{ text: "new" }, { text: "last" }],
  ],
  sourceAlignments: ["center", "right"],
  destination: { top: 2, bottom: 3, left: 2, right: 3 },
});
assert.equal(pasteEdit.from, table.from);
assert.equal(pasteEdit.to, table.to);
assert.match(pasteEdit.insert, /A &#124; B/);
assert.match(pasteEdit.insert, /x &#124; y/);
const expanded = parseMarkdownTables(pasteEdit.insert)[0];
assert.ok(expanded);
assert.equal(expanded.columnCount, 4);
assert.equal(expanded.body.length, 3);
assert.equal(expanded.alignments[3], "right");

const clearEdit = buildGridClearEdit(table, {
  top: 1,
  bottom: 2,
  left: 1,
  right: 1,
});
const cleared = parseMarkdownTables(clearEdit.insert)[0];
assert.ok(cleared);
assert.equal(cleared.body[0].cells[0].raw, table.body[0].cells[0].raw);
assert.equal(cleared.body[0].cells[1].raw.trim(), "");
assert.equal(cleared.body[1].cells[1].raw.trim(), "");

console.log("clipboard model tests passed");
