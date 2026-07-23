import assert from "node:assert/strict";
import MarkdownIt from "markdown-it";
import { buildGridPasteEdit, gridToMarkdown } from "../shared/clipboardModel";
import {
  ensureTableCellSeparatorSafe,
  formatTableCellSourceEdit,
  parseMarkdownTables,
  rowToDisplayValues,
} from "../shared/tableModel";
import { insertTableColumnEdit } from "../shared/tableStructureEdits";

function applyEdit(
  source: string,
  edit: { from: number; to: number; insert: string },
): string {
  return source.slice(0, edit.from) + edit.insert + source.slice(edit.to);
}

function onlyVisibleTable(source: string): ReturnType<typeof parseMarkdownTables>[number] {
  const tables = parseMarkdownTables(source);
  assert.equal(tables.length, 1, "expected exactly one visible Markdown table");
  return tables[0];
}

const mismatchedMarkerFence = [
  "```markdown",
  "~~~",
  "| Hidden | Backtick fence is still open |",
  "| --- | --- |",
  "| no | table |",
  "```",
  "",
  "| Visible | Table |",
  "| --- | --- |",
  "| yes | ok |",
].join("\n");
const visibleAfterMismatchedMarker = onlyVisibleTable(mismatchedMarkerFence);
assert.equal(
  visibleAfterMismatchedMarker.from,
  mismatchedMarkerFence.indexOf("| Visible | Table |"),
);
assert.deepEqual(
  rowToDisplayValues(
    visibleAfterMismatchedMarker.body[0],
    visibleAfterMismatchedMarker.columnCount,
  ),
  ["yes", "ok"],
);

const shorterClosingFence = [
  "````typescript",
  "```",
  "| Hidden | Four-backtick fence is still open |",
  "| --- | --- |",
  "| no | table |",
  "````",
  "| Visible | Again |",
  "| --- | --- |",
  "| yes | ok |",
].join("\n");
const visibleAfterShortFence = onlyVisibleTable(shorterClosingFence);
assert.equal(
  visibleAfterShortFence.from,
  shorterClosingFence.indexOf("| Visible | Again |"),
);

const indentedCodeAndTable = [
  "    | Code | Not a table |",
  "    | --- | --- |",
  "    | keep | literal |",
  "",
  "   | Three-space | Table |",
  "   | --- | --- |",
  "   | yes | ok |",
].join("\n");
const threeSpaceTable = onlyVisibleTable(indentedCodeAndTable);
assert.equal(
  threeSpaceTable.from,
  indentedCodeAndTable.indexOf("   | Three-space | Table |"),
);
assert.deepEqual(
  rowToDisplayValues(threeSpaceTable.body[0], threeSpaceTable.columnCount),
  ["yes", "ok"],
);

const tabIndentedCode = [
  "\t| Code | Not a table |",
  "\t| --- | --- |",
  "\t| keep | literal |",
].join("\n");
assert.deepEqual(parseMarkdownTables(tabIndentedCode), []);

const htmlCommentAndTable = [
  "  <!--",
  "| Hidden | Comment content |",
  "| --- | --- |",
  "| no | table |",
  "  -->",
  "| Visible | Table |",
  "| --- | --- |",
  "| yes | ok |",
].join("\n");
const visibleAfterComment = onlyVisibleTable(htmlCommentAndTable);
assert.equal(
  visibleAfterComment.from,
  htmlCommentAndTable.indexOf("| Visible | Table |"),
);

const singleLineComment = [
  "<!-- | Fake | Table | -->",
  "| Visible | Table |",
  "| --- | --- |",
  "| yes | ok |",
].join("\n");
const visibleAfterSingleLineComment = onlyVisibleTable(singleLineComment);
assert.equal(
  visibleAfterSingleLineComment.from,
  singleLineComment.indexOf("| Visible | Table |"),
);

const ordinaryCrlfTable = [
  "prefix",
  "| Header A | Header B |",
  "| --- | --- |",
  "| value a | value b |",
  "suffix",
].join("\r\n");
const ordinaryTable = onlyVisibleTable(ordinaryCrlfTable);
const ordinaryHeaderFrom = ordinaryCrlfTable.indexOf("| Header A | Header B |");
const ordinaryBodyText = "| value a | value b |";
const ordinaryBodyFrom = ordinaryCrlfTable.indexOf(ordinaryBodyText);
assert.equal(ordinaryTable.from, ordinaryHeaderFrom);
assert.equal(ordinaryTable.to, ordinaryBodyFrom + ordinaryBodyText.length);
assert.equal(
  ordinaryTable.header.cells[0].start,
  ordinaryHeaderFrom + "|".length,
);
assert.equal(
  ordinaryTable.body[0].cells[1].end,
  ordinaryBodyFrom + ordinaryBodyText.lastIndexOf("|"),
);

// Editing the first cell of a row without outer pipes must first introduce a
// structural leading pipe. Otherwise an empty value turns `A|B` into `|B`
// (one cell), while fence/comment-shaped values can make the row stop being a
// table altogether.
const compactNoOuterSource = [
  "A|B",
  "---|---",
  "x|KEEP",
  "last|SAFE",
].join("\n");
for (const value of ["", "```", "<!--", "plain"]) {
  const compactNoOuterTable = onlyVisibleTable(compactNoOuterSource);
  const headerEdit = formatTableCellSourceEdit(
    compactNoOuterTable.header,
    compactNoOuterTable.columnCount,
    0,
    value,
  );
  const sourceAfterHeaderEdit = applyEdit(compactNoOuterSource, headerEdit);
  assert.ok(sourceAfterHeaderEdit.startsWith("|"));
  const tableAfterHeaderEdit = onlyVisibleTable(sourceAfterHeaderEdit);
  assert.deepEqual(
    rowToDisplayValues(
      tableAfterHeaderEdit.header,
      tableAfterHeaderEdit.columnCount,
    ),
    [value, "B"],
  );
  assert.deepEqual(
    tableAfterHeaderEdit.body.map((row) =>
      rowToDisplayValues(row, tableAfterHeaderEdit.columnCount),
    ),
    [
      ["x", "KEEP"],
      ["last", "SAFE"],
    ],
  );

  const bodyEdit = formatTableCellSourceEdit(
    compactNoOuterTable.body[0],
    compactNoOuterTable.columnCount,
    0,
    value,
  );
  const sourceAfterBodyEdit = applyEdit(compactNoOuterSource, bodyEdit);
  assert.ok(sourceAfterBodyEdit.split("\n")[2].startsWith("|"));
  const tableAfterBodyEdit = onlyVisibleTable(sourceAfterBodyEdit);
  assert.equal(tableAfterBodyEdit.body.length, 2);
  assert.deepEqual(
    rowToDisplayValues(
      tableAfterBodyEdit.body[0],
      tableAfterBodyEdit.columnCount,
    ),
    [value, "KEEP"],
  );
  assert.deepEqual(
    rowToDisplayValues(
      tableAfterBodyEdit.body[1],
      tableAfterBodyEdit.columnCount,
    ),
    ["last", "SAFE"],
  );
}

const delimiterLookingBodySource = [
  "| A | B |",
  "| --- | --- |",
  "| first | row |",
  "| --- | --- |",
  "| final | survives |",
].join("\n");
const tableWithDelimiterLookingBody = onlyVisibleTable(
  delimiterLookingBodySource,
);
assert.equal(tableWithDelimiterLookingBody.body.length, 3);
assert.deepEqual(
  tableWithDelimiterLookingBody.body.map((row) =>
    rowToDisplayValues(row, tableWithDelimiterLookingBody.columnCount),
  ),
  [
    ["first", "row"],
    ["---", "---"],
    ["final", "survives"],
  ],
);
assert.equal(tableWithDelimiterLookingBody.to, delimiterLookingBodySource.length);

// Header text is unrestricted. In particular, a delimiter-looking header is
// still a header when the following row is the actual delimiter. Treating the
// first row as syntax makes a one-column table disappear as soon as a user
// types `---` into its header cell.
for (const headerValue of ["---", ":---", "---:", ":---:"]) {
  const delimiterHeaderSource = [
    `| ${headerValue} |`,
    "| --- |",
    "| data |",
  ].join("\n");
  const delimiterHeaderTable = onlyVisibleTable(delimiterHeaderSource);
  assert.deepEqual(
    rowToDisplayValues(
      delimiterHeaderTable.header,
      delimiterHeaderTable.columnCount,
    ),
    [headerValue],
  );
  assert.deepEqual(
    rowToDisplayValues(
      delimiterHeaderTable.body[0],
      delimiterHeaderTable.columnCount,
    ),
    ["data"],
  );
}

assert.equal(ensureTableCellSeparatorSafe("path\\"), "path\\ ");
assert.equal(ensureTableCellSeparatorSafe("path\\\\"), "path\\\\ ");
assert.equal(ensureTableCellSeparatorSafe("path\\ "), "path\\ ");

const compactCellEditSource = [
  "|a|b|",
  "|---|---|",
  "|x|KEEP|",
].join("\n");
const markdownIt = new MarkdownIt();
for (let slashCount = 1; slashCount <= 4; slashCount++) {
  const compactCellEditTable = onlyVisibleTable(compactCellEditSource);
  const slashValue = `x${"\\".repeat(slashCount)}`;
  const trailingBackslashCellEdit = formatTableCellSourceEdit(
    compactCellEditTable.body[0],
    compactCellEditTable.columnCount,
    0,
    slashValue,
  );
  const sourceAfterCellEdit = applyEdit(
    compactCellEditSource,
    trailingBackslashCellEdit,
  );
  assert.equal(
    sourceAfterCellEdit.split("\n")[2],
    `|${slashValue} |KEEP|`,
  );
  const tableAfterCellEdit = onlyVisibleTable(sourceAfterCellEdit);
  assert.deepEqual(
    rowToDisplayValues(
      tableAfterCellEdit.body[0],
      tableAfterCellEdit.columnCount,
    ),
    [slashValue, "KEEP"],
  );
  assertMarkdownItCells(sourceAfterCellEdit, "td", 2, "KEEP");
}

for (let slashCount = 1; slashCount <= 4; slashCount++) {
  const slashValue = `C:${"\\".repeat(slashCount)}`;
  const compactStructureSource = [
    "A|B",
    "---|---",
    `left|${slashValue}`,
  ].join("\n");
  const compactStructureTable = onlyVisibleTable(compactStructureSource);
  const appendColumnEdit = insertTableColumnEdit(
    compactStructureTable,
    compactStructureTable.columnCount,
  );
  assert.ok(appendColumnEdit);
  const sourceAfterColumnInsert = applyEdit(
    compactStructureSource,
    appendColumnEdit,
  );
  const tableAfterColumnInsert = onlyVisibleTable(sourceAfterColumnInsert);
  assert.deepEqual(
    rowToDisplayValues(
      tableAfterColumnInsert.body[0],
      tableAfterColumnInsert.columnCount,
    ),
    ["left", slashValue, ""],
  );
  assert.equal(tableAfterColumnInsert.columnCount, 3);
  assertMarkdownItCells(sourceAfterColumnInsert, "td", 3);
}

const compactGridDestination = onlyVisibleTable(compactCellEditSource);
for (let slashCount = 1; slashCount <= 4; slashCount++) {
  const slashValue = `C:${"\\".repeat(slashCount)}`;
  const pasteTrailingBackslashEdit = buildGridPasteEdit(
    compactGridDestination,
    {
      rows: [[{ text: slashValue, markdown: slashValue }]],
      destination: { top: 1, bottom: 1, left: 0, right: 0 },
    },
  );
  const sourceAfterGridPaste = applyEdit(
    compactCellEditSource,
    pasteTrailingBackslashEdit,
  );
  const tableAfterGridPaste = onlyVisibleTable(sourceAfterGridPaste);
  assert.deepEqual(
    rowToDisplayValues(
      tableAfterGridPaste.body[0],
      tableAfterGridPaste.columnCount,
    ),
    [slashValue, "KEEP"],
  );
  assertMarkdownItCells(sourceAfterGridPaste, "td", 2, "KEEP");

  const copiedGridMarkdown = gridToMarkdown([
    [
      { text: slashValue, markdown: slashValue },
      { text: "KEEP", markdown: "KEEP" },
    ],
  ]);
  const copiedGridTable = onlyVisibleTable(copiedGridMarkdown);
  assert.deepEqual(
    rowToDisplayValues(copiedGridTable.header, copiedGridTable.columnCount),
    [slashValue, "KEEP"],
  );
  assertMarkdownItCells(copiedGridMarkdown, "th", 2, "KEEP");
}

function assertMarkdownItCells(
  source: string,
  tag: "td" | "th",
  count: number,
  preservedText?: string,
): void {
  const html = markdownIt.render(source);
  assert.equal(
    html.match(new RegExp(`<${tag}(?:\\s[^>]*)?>`, "g"))?.length ?? 0,
    count,
    `markdown-it must render ${count} ${tag} cells from ${JSON.stringify(source)}`,
  );
  if (preservedText) {
    assert.match(html, new RegExp(`<${tag}>${preservedText}</${tag}>`));
  }
}
