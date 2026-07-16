import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { editorDragPosition } from "../editor/dragPosition";
import {
  mapNormalizedDocumentChangesToHost,
  normalizeDocumentText,
} from "../shared/documentChangeMapping";
import { measureTableColumnSizing } from "../shared/tableColumnSizing";
import {
  formatMarkdownCell,
  formatMarkdownRow,
  formatTableCellEdit,
  formatTableCellSourceEdit,
  getParsedTables,
  markdownCellToDisplayText,
  parseMarkdownTables,
  positionAfterTable,
  positionBeforeTable,
  rowToDisplayValues,
} from "../shared/tableModel";
import {
  deleteTableColumnEdit,
  deleteTableRowEdit,
  insertTableColumnEdit,
  insertTableRowEdit,
} from "../shared/tableStructureEdits";

const standard = [
  "# Heading",
  "",
  "| Name | Notes | Count |",
  "| :--- | :---: | ---: |",
  "| Alpha | plain text | 1 |",
  "| Beta | contains &#124; pipe | 2 |",
  "",
  "Done",
].join("\n");

const dragCoordinates: { x: number; y: number }[] = [];
const dragView = {
  dom: {
    getBoundingClientRect: () => ({
      left: 10,
      right: 110,
      top: 20,
      bottom: 120,
      width: 100,
    }),
  },
  state: { doc: { length: 500 } },
  posAtCoords: (coordinates: { x: number; y: number }) => {
    dragCoordinates.push(coordinates);
    return 42;
  },
} as unknown as Parameters<typeof editorDragPosition>[0];
assert.equal(editorDragPosition(dragView, -200, 60), 42);
assert.deepEqual(dragCoordinates.pop(), { x: 10.5, y: 60 });
assert.equal(editorDragPosition(dragView, 400, 60), 42);
assert.deepEqual(dragCoordinates.pop(), { x: 109.5, y: 60 });
assert.equal(editorDragPosition(dragView, 40, 10), 0);
assert.equal(editorDragPosition(dragView, 40, 130), 500);

const standardTables = parseMarkdownTables(standard);
assert.equal(standardTables.length, 1);
assert.deepEqual(standardTables[0].alignments, ["left", "center", "right"]);
assert.equal(standardTables[0].columnCount, 3);
assert.deepEqual(rowToDisplayValues(standardTables[0].body[1], 3), [
  "Beta",
  "contains | pipe",
  "2",
]);

const noOuterPipes = [
  "Name | Empty | Notes",
  "--- | --- | ---",
  "Alpha |  | wraps<br>inside",
].join("\n");
const noOuterTables = parseMarkdownTables(noOuterPipes);
assert.equal(noOuterTables.length, 1);
assert.deepEqual(rowToDisplayValues(noOuterTables[0].body[0], 3), [
  "Alpha",
  "",
  "wraps\ninside",
]);

const escapedPipes = [
  "| A | B |",
  "| --- | --- |",
  "| one \\| literal | two |",
].join("\n");
const escapedTables = parseMarkdownTables(escapedPipes);
assert.equal(escapedTables.length, 1);
assert.deepEqual(rowToDisplayValues(escapedTables[0].body[0], 2), [
  "one \\| literal",
  "two",
]);

assert.equal(markdownCellToDisplayText(" a<br>b &#124; c "), "a\nb | c");
assert.equal(formatMarkdownCell("a\nb | c"), "a<br>b &#124; c");
assert.equal(formatMarkdownRow(["A", "", "B | C"]), "| A |  | B &#124; C |");

const edited = formatTableCellEdit(
  noOuterTables[0].body[0],
  3,
  2,
  "new\nvalue",
);
assert.equal(edited, "| Alpha |  | new<br>value |");
const sourceEdit = formatTableCellSourceEdit(
  noOuterTables[0].body[0],
  noOuterTables[0].columnCount,
  2,
  "new\nvalue",
);
assert.deepEqual(sourceEdit, {
  from: noOuterPipes.indexOf(" wraps<br>inside"),
  to: noOuterPipes.indexOf(" wraps<br>inside") + " wraps<br>inside".length,
  insert: " new<br>value",
});
assert.equal(
  noOuterPipes.slice(0, sourceEdit.from) +
    sourceEdit.insert +
    noOuterPipes.slice(sourceEdit.to),
  ["Name | Empty | Notes", "--- | --- | ---", "Alpha |  | new<br>value"].join(
    "\n",
  ),
);

const spacedSource =
  "| Key  | Value     |\n| ---- | --------- |\n| Long | keep this |";
const spacedTable = parseMarkdownTables(spacedSource)[0];
const spacedEdit = formatTableCellSourceEdit(
  spacedTable.body[0],
  spacedTable.columnCount,
  1,
  "Test Edit.",
);
assert.equal(
  spacedSource.slice(0, spacedEdit.from) +
    spacedEdit.insert +
    spacedSource.slice(spacedEdit.to),
  "| Key  | Value     |\n| ---- | --------- |\n| Long | Test Edit. |",
);
const emptyCellEdit = formatTableCellSourceEdit(
  noOuterTables[0].body[0],
  noOuterTables[0].columnCount,
  1,
  "filled",
);
assert.equal(
  noOuterPipes.slice(0, emptyCellEdit.from) +
    emptyCellEdit.insert +
    noOuterPipes.slice(emptyCellEdit.to),
  [
    "Name | Empty | Notes",
    "--- | --- | ---",
    "Alpha | filled | wraps<br>inside",
  ].join("\n"),
);

const fenced = [
  "```",
  "| Not | A table |",
  "| --- | --- |",
  "```",
  "",
  "| Real | Table |",
  "| --- | --- |",
  "| yes | ok |",
].join("\n");
const fencedTables = parseMarkdownTables(fenced);
assert.equal(fencedTables.length, 1);
assert.deepEqual(rowToDisplayValues(fencedTables[0].body[0], 2), ["yes", "ok"]);

// Memoized parse: same immutable document object => same parse result
// instance; equal text in a different object => fresh parse.
const memoDoc = {
  length: standard.length,
  sliceString: (from: number, to: number) => standard.slice(from, to),
  toString: () => standard,
};
assert.equal(getParsedTables(memoDoc), getParsedTables(memoDoc));
assert.notEqual(getParsedTables(memoDoc), getParsedTables({ ...memoDoc }));
assert.equal(getParsedTables(memoDoc).length, 1);
assert.equal(getParsedTables(memoDoc)[0].from, standard.indexOf("| Name |"));
assert.equal(getParsedTables(memoDoc)[0].startLine, 2);
assert.equal(getParsedTables(memoDoc)[0].endLine, 5);

// Position helpers used for cursor placement around rendered tables.
const positionedTable = getParsedTables(memoDoc)[0];
assert.equal(
  positionAfterTable(memoDoc, positionedTable),
  positionedTable.to + 1,
);
assert.equal(positionBeforeTable(positionedTable), positionedTable.from - 1);

const compactSizing = measureTableColumnSizing(
  parseMarkdownTables("| # | Value |\n| --- | --- |\n| 10 | B |")[0],
);
assert.ok(
  compactSizing.dataWidthCh <= 24,
  `expected compact tables to fit content, got ${compactSizing.dataWidthCh}ch`,
);
assert.ok(
  compactSizing.columns[0].widthCh >= 4.5 &&
    compactSizing.columns[0].widthCh < 12,
  `expected numeric ID column to stay compact while preserving two-digit values, got ${compactSizing.columns[0].widthCh}ch`,
);

const mixedSizing = measureTableColumnSizing(
  parseMarkdownTables(
    [
      "| ID | Notes |",
      "| --- | --- |",
      "| A1 | This long notes column should receive most available width so short ID text does not force extra wrapping. |",
    ].join("\n"),
  )[0],
);
assert.ok(
  mixedSizing.columns[0].preferredWidthCh < 12,
  `expected narrow ID column, got ${mixedSizing.columns[0].preferredWidthCh}ch`,
);
assert.ok(
  mixedSizing.columns[1].preferredWidthCh > 80,
  `expected long notes column to receive wrapping priority, got ${mixedSizing.columns[1].preferredWidthCh}ch`,
);
assert.ok(
  mixedSizing.widthPercentages[0] < 12,
  `expected narrow ID percentage, got ${mixedSizing.widthPercentages[0]}%`,
);
assert.ok(
  mixedSizing.widthPercentages[1] > 88,
  `expected long notes percentage, got ${mixedSizing.widthPercentages[1]}%`,
);

const featureSizing = measureTableColumnSizing(
  parseMarkdownTables(
    [
      "| # | Feature | Markdown In Table Cell |",
      "| ---: | --- | --- |",
      "| 9 | Relative link | [README](./README.md) |",
      "| 10 | Fragment link | [Headings](#headings) |",
      "| 11 | Autolink URL | <https://example.com> |",
      "| 12 | Autolink email | <test@example.com> |",
    ].join("\n"),
  )[0],
  84,
);
assert.ok(
  featureSizing.columns[0].widthCh < 12,
  `expected screenshot-style # column to stay compact, got ${featureSizing.columns[0].widthCh}ch`,
);
assert.ok(
  featureSizing.columns[1].minWidthCh < 12,
  `expected screenshot-style feature column minimum to be allowed below 12ch when content permits, got ${featureSizing.columns[1].minWidthCh}ch`,
);
assert.ok(
  featureSizing.columns[2].minWidthCh >= 12,
  `expected screenshot-style markdown content column to preserve 12ch readable minimum, got ${featureSizing.columns[2].minWidthCh}ch`,
);

const constrainedSizing = measureTableColumnSizing(
  parseMarkdownTables(
    [
      "| First long column | Second long column |",
      "| --- | --- |",
      "| alpha beta gamma delta epsilon zeta eta theta iota kappa lambda | alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma |",
    ].join("\n"),
  )[0],
  60,
);
assert.ok(
  constrainedSizing.columns[1].widthCh > constrainedSizing.columns[0].widthCh,
  `expected constrained layout to give more width to the column with higher wrap reduction, got ${constrainedSizing.columns.map((column) => column.widthCh).join(", ")}`,
);

const overflowSizing = measureTableColumnSizing(
  parseMarkdownTables(
    [
      "| A | B | C | D |",
      "| --- | --- | --- | --- |",
      "| alpha beta gamma delta epsilon zeta eta | theta iota kappa lambda mu nu xi omicron | pi rho sigma tau upsilon phi chi psi | omega alpha beta gamma delta epsilon zeta |",
    ].join("\n"),
  )[0],
  40,
);
assert.ok(
  overflowSizing.dataWidthCh > 40,
  `expected narrow available width to preserve readable prose columns and overflow locally, got ${overflowSizing.dataWidthCh}ch`,
);
assert.ok(
  overflowSizing.columns.every((column) => column.widthCh >= 12),
  `expected prose columns to preserve 12ch minimum widths, got ${overflowSizing.columns.map((column) => column.widthCh).join(", ")}`,
);

const compactOverflowSizing = measureTableColumnSizing(
  parseMarkdownTables(
    [
      "| A | B | C | D | E |",
      "| --- | --- | --- | --- | --- |",
      "| one | two | three | four | five |",
    ].join("\n"),
  )[0],
  40,
);
assert.ok(
  compactOverflowSizing.dataWidthCh <= 40,
  `expected compact columns to fit below the old blanket 12ch minimum, got ${compactOverflowSizing.dataWidthCh}ch`,
);
assert.ok(
  compactOverflowSizing.columns.every((column) => column.widthCh < 12),
  `expected compact columns to stay below 12ch, got ${compactOverflowSizing.columns.map((column) => column.widthCh).join(", ")}`,
);

const liveEditSource = [
  "| Key | Value |",
  "| --- | --- |",
  "| Short | tiny |",
].join("\n");
const liveEditTable = parseMarkdownTables(liveEditSource)[0];
const initialLiveEditSizing = measureTableColumnSizing(liveEditTable, 80);
const expandedLiveEditSizing = measureTableColumnSizing(liveEditTable, 80, {
  rowKind: "body",
  rowIndex: 0,
  column: 1,
  value: "tiny value that should widen while the user is still typing",
});
assert.ok(
  expandedLiveEditSizing.columns[1].widthCh >
    initialLiveEditSizing.columns[1].widthCh,
  `expected transient cell text to widen the edited column from ${initialLiveEditSizing.columns[1].widthCh}ch, got ${expandedLiveEditSizing.columns[1].widthCh}ch`,
);
assert.equal(
  rowToDisplayValues(liveEditTable.body[0], liveEditTable.columnCount)[1],
  "tiny",
  "expected transient sizing override to leave the parsed table model unchanged",
);

const headerPrioritySizing = measureTableColumnSizing(
  parseMarkdownTables(
    [
      "| Extremely Long Header Title That Should Not Dominate Short Data | Notes |",
      "| --- | --- |",
      "| A | This body content should remain the primary width driver for the table. |",
    ].join("\n"),
  )[0],
  90,
);
assert.ok(
  headerPrioritySizing.columns[0].preferredWidthCh <= 27,
  `expected long headers to be capped below body-driven content widths, got ${headerPrioritySizing.columns[0].preferredWidthCh}ch`,
);
assert.ok(
  headerPrioritySizing.columns[1].preferredWidthCh >
    headerPrioritySizing.columns[0].preferredWidthCh,
  `expected body content column to receive width priority over long header-only column, got ${headerPrioritySizing.columns.map((column) => column.preferredWidthCh).join(", ")}`,
);

const spaciousHeaderText =
  "Extremely Long Header Title That Should Fit When Space Allows";
const spaciousHeaderSizing = measureTableColumnSizing(
  parseMarkdownTables(
    [
      `| ${spaciousHeaderText} | Notes |`,
      "| --- | --- |",
      "| A | short |",
    ].join("\n"),
  )[0],
  160,
);
assert.ok(
  spaciousHeaderSizing.columns[0].widthCh >= spaciousHeaderText.length + 2,
  `expected abundant width to un-wrap the long header title, got ${spaciousHeaderSizing.columns[0].widthCh}ch for ${spaciousHeaderText.length}ch of text`,
);
assert.ok(
  spaciousHeaderSizing.columns[0].preferredWidthCh <= 27,
  `expected the contention-capped preference to stay body-driven, got ${spaciousHeaderSizing.columns[0].preferredWidthCh}ch`,
);
assert.ok(
  spaciousHeaderSizing.dataWidthCh <= 160,
  `expected the expanded table to stay within available width, got ${spaciousHeaderSizing.dataWidthCh}ch`,
);

const longTokenSizing = measureTableColumnSizing(
  parseMarkdownTables(
    [
      "| ID | Token |",
      "| --- | --- |",
      "| 1 | abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz |",
    ].join("\n"),
  )[0],
  30,
);
assert.ok(
  longTokenSizing.columns[1].widthCh <= 36,
  `expected long token guardrail to cap the token column, got ${longTokenSizing.columns[1].widthCh}ch`,
);

// --- Table structure edits (insert/delete rows and columns) ---

function applyStructureEdit(
  source: string,
  edit: { from: number; to: number; insert: string } | null,
): string {
  assert.ok(edit, "expected a structure edit");
  return source.slice(0, edit.from) + edit.insert + source.slice(edit.to);
}

const structurePrefix = "Intro\n\n";
const structureLines = [
  "| A | B |",
  "| :--- | ---: |",
  "| a1 | b1 |",
  "| a2 | b2 |",
];
const structureSource = `${structurePrefix}${structureLines.join("\n")}\n\nOutro`;
const structureTable = parseMarkdownTables(structureSource)[0];

// Append a column to the right edge.
const appendedColumnSource = applyStructureEdit(
  structureSource,
  insertTableColumnEdit(structureTable, structureTable.columnCount),
);
const appendedColumnTable = parseMarkdownTables(appendedColumnSource)[0];
assert.equal(appendedColumnTable.columnCount, 3);
assert.deepEqual(appendedColumnTable.alignments, ["left", "right", "left"]);
assert.deepEqual(rowToDisplayValues(appendedColumnTable.header, 3), [
  "A",
  "B",
  "",
]);
assert.deepEqual(rowToDisplayValues(appendedColumnTable.body[1], 3), [
  "a2",
  "b2",
  "",
]);
assert.ok(appendedColumnSource.startsWith(structurePrefix));
assert.ok(appendedColumnSource.endsWith("\n\nOutro"));

// Insert a column left of the first column, preserving alignments.
const insertLeftSource = applyStructureEdit(
  structureSource,
  insertTableColumnEdit(structureTable, 0),
);
const insertLeftTable = parseMarkdownTables(insertLeftSource)[0];
assert.equal(insertLeftTable.columnCount, 3);
assert.deepEqual(insertLeftTable.alignments, ["left", "left", "right"]);
assert.deepEqual(rowToDisplayValues(insertLeftTable.body[0], 3), [
  "",
  "a1",
  "b1",
]);

// Insert a column between existing columns; existing raw padding is kept.
const insertMiddleSource = applyStructureEdit(
  structureSource,
  insertTableColumnEdit(structureTable, 1),
);
const insertMiddleTable = parseMarkdownTables(insertMiddleSource)[0];
assert.deepEqual(rowToDisplayValues(insertMiddleTable.header, 3), [
  "A",
  "",
  "B",
]);
assert.ok(insertMiddleSource.includes("| a1 |  | b1 |"));

// Delete the first column.
const deleteColumnSource = applyStructureEdit(
  structureSource,
  deleteTableColumnEdit(structureTable, 0),
);
const deleteColumnTable = parseMarkdownTables(deleteColumnSource)[0];
assert.equal(deleteColumnTable.columnCount, 1);
assert.deepEqual(deleteColumnTable.alignments, ["right"]);
assert.deepEqual(rowToDisplayValues(deleteColumnTable.body[0], 1), ["b1"]);

// The final remaining column cannot be deleted.
assert.equal(deleteTableColumnEdit(deleteColumnTable, 0), null);
assert.equal(deleteTableColumnEdit(structureTable, 2), null);
assert.equal(deleteTableColumnEdit(structureTable, -1), null);
assert.equal(insertTableColumnEdit(structureTable, 3), null);

// Insert a row above the first body row without touching other lines.
const insertRowAboveSource = applyStructureEdit(
  structureSource,
  insertTableRowEdit(structureTable, 0),
);
const insertRowAboveTable = parseMarkdownTables(insertRowAboveSource)[0];
assert.equal(insertRowAboveTable.body.length, 3);
assert.deepEqual(rowToDisplayValues(insertRowAboveTable.body[0], 2), ["", ""]);
assert.deepEqual(rowToDisplayValues(insertRowAboveTable.body[1], 2), [
  "a1",
  "b1",
]);
assert.ok(insertRowAboveSource.includes("| :--- | ---: |\n|  |  |\n| a1 |"));

// Insert a row below the last body row (append to the bottom edge).
const appendRowSource = applyStructureEdit(
  structureSource,
  insertTableRowEdit(structureTable, structureTable.body.length),
);
const appendRowTable = parseMarkdownTables(appendRowSource)[0];
assert.equal(appendRowTable.body.length, 3);
assert.deepEqual(rowToDisplayValues(appendRowTable.body[2], 2), ["", ""]);
assert.ok(appendRowSource.includes("| a2 | b2 |\n|  |  |\n\nOutro"));

// Delete a body row; the remaining rows keep their exact source text.
const deleteRowSource = applyStructureEdit(
  structureSource,
  deleteTableRowEdit(structureTable, 0),
);
const deleteRowTable = parseMarkdownTables(deleteRowSource)[0];
assert.equal(deleteRowTable.body.length, 1);
assert.deepEqual(rowToDisplayValues(deleteRowTable.body[0], 2), ["a2", "b2"]);
assert.ok(deleteRowSource.includes("| :--- | ---: |\n| a2 | b2 |"));

// Deleting every body row leaves a valid header-only table.
const headerOnlySource = applyStructureEdit(
  deleteRowSource,
  deleteTableRowEdit(deleteRowTable, 0),
);
const headerOnlyTable = parseMarkdownTables(headerOnlySource)[0];
assert.equal(headerOnlyTable.body.length, 0);
assert.equal(headerOnlyTable.columnCount, 2);
assert.equal(deleteTableRowEdit(headerOnlyTable, 0), null);
assert.equal(deleteTableRowEdit(structureTable, 2), null);
assert.equal(insertTableRowEdit(structureTable, 3), null);

// Ragged rows and rows without outer pipes are normalized with empty cells.
const raggedColumnSource = applyStructureEdit(
  noOuterPipes,
  insertTableColumnEdit(noOuterTables[0], 3),
);
const raggedColumnTable = parseMarkdownTables(raggedColumnSource)[0];
assert.equal(raggedColumnTable.columnCount, 4);
assert.deepEqual(rowToDisplayValues(raggedColumnTable.body[0], 4), [
  "Alpha",
  "",
  "wraps\ninside",
  "",
]);

// CRLF tables keep their line separator when inserting rows and columns.
const crlfSource = structureLines.join("\r\n");
const crlfTable = parseMarkdownTables(crlfSource)[0];
const crlfRowSource = applyStructureEdit(
  crlfSource,
  insertTableRowEdit(crlfTable, 1),
);
assert.ok(crlfRowSource.includes("| a1 | b1 |\r\n|  |  |\r\n| a2 |"));
assert.equal(parseMarkdownTables(crlfRowSource)[0].body.length, 3);
const crlfColumnSource = applyStructureEdit(
  crlfSource,
  insertTableColumnEdit(crlfTable, 2),
);
assert.ok(crlfColumnSource.includes("| A | B |  |\r\n"));
assert.equal(parseMarkdownTables(crlfColumnSource)[0].columnCount, 3);

// Webview edits are expressed against CodeMirror's LF-normalized document.
// Host application must map those offsets by line/character so CRLF files on
// Windows do not apply edits to an earlier table row.
const hostCrlfEditSource = [
  "| A | B |",
  "| --- | --- |",
  "| 1 | 2 |",
  "plain row",
].join("\r\n");
const webviewLfEditSource = normalizeDocumentText(hostCrlfEditSource);
const plainRowFrom = webviewLfEditSource.indexOf("plain");
const mappedHostChanges = mapNormalizedDocumentChangesToHost(
  hostCrlfEditSource,
  [{ from: plainRowFrom, to: plainRowFrom + "plain".length, text: "edited" }],
);
assert.deepEqual(mappedHostChanges, [
  {
    from: { line: 3, character: 0 },
    to: { line: 3, character: 5 },
    text: "edited",
  },
]);

const mappedHostNewlineChanges = mapNormalizedDocumentChangesToHost(
  hostCrlfEditSource,
  [
    {
      from: webviewLfEditSource.length,
      to: webviewLfEditSource.length,
      text: "\nnext",
    },
  ],
);
assert.equal(mappedHostNewlineChanges[0].text, "\r\nnext");

const packageJson = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
) as {
  contributes?: {
    commands?: Array<{ command?: string }>;
    keybindings?: Array<{
      command?: string;
      key?: string;
      mac?: string;
      when?: string;
    }>;
    menus?: { "editor/title"?: Array<{ command?: string; when?: string }> };
    customEditors?: Array<{
      viewType?: string;
      displayName?: string;
      priority?: string;
    }>;
    configuration?: {
      properties?: Record<
        string,
        { default?: unknown; enum?: unknown[]; type?: string }
      >;
    };
  };
};
const extensionSource = fs.readFileSync(
  path.join(process.cwd(), "src", "extension.ts"),
  "utf8",
);
const liveEditorSource = fs.readFileSync(
  path.join(process.cwd(), "src", "webview", "liveEditor.ts"),
  "utf8",
);
const liveEditorCss = fs.readFileSync(
  path.join(process.cwd(), "media", "liveEditor.css"),
  "utf8",
);
const tableDecorationsSource = fs.readFileSync(
  path.join(process.cwd(), "src", "editor", "tableDecorations.ts"),
  "utf8",
);
const geometrySyncSource = fs.readFileSync(
  path.join(process.cwd(), "src", "editor", "editorGeometrySync.ts"),
  "utf8",
);
const tableWidgetSource = fs.readFileSync(
  path.join(process.cwd(), "src", "editor", "table", "TableWidget.ts"),
  "utf8",
);

assert.equal(
  packageJson.contributes?.customEditors?.[0]?.viewType,
  "markdownLiveRenderTables.liveEditor",
);
assert.deepEqual(
  packageJson.contributes?.configuration?.properties?.[
    "markdownLiveRenderTables.clipboard.defaultCopyMode"
  ]?.enum,
  ["smart", "rich", "plain", "markdown"],
);
assert.equal(
  packageJson.contributes?.configuration?.properties?.[
    "markdownLiveRenderTables.clipboard.defaultCopyMode"
  ]?.default,
  "smart",
);
assert.deepEqual(
  packageJson.contributes?.configuration?.properties?.[
    "markdownLiveRenderTables.clipboard.defaultPasteMode"
  ]?.enum,
  ["auto", "rich", "plain", "markdown"],
);
assert.equal(
  packageJson.contributes?.configuration?.properties?.[
    "markdownLiveRenderTables.clipboard.defaultPasteMode"
  ]?.default,
  "auto",
);
assert.equal(packageJson.contributes?.customEditors?.[0]?.priority, "option");
assert.equal(
  packageJson.contributes?.customEditors?.length,
  1,
  "expected the legacy table editor registration to stay removed",
);
assert.ok(
  packageJson.contributes?.commands?.some(
    (command) => command.command === "markdownLiveRenderTables.toggleEditor",
  ),
);
assert.ok(
  packageJson.contributes?.keybindings?.some(
    (item) =>
      item.command === "markdownLiveRenderTables.toggleEditor" &&
      item.key === "ctrl+alt+m" &&
      item.mac === "cmd+ctrl+m" &&
      item.when === undefined,
  ),
);
assert.ok(
  packageJson.contributes?.menus?.["editor/title"]?.some(
    (item) =>
      item.command === "markdownLiveRenderTables.toggleEditor" &&
      item.when?.includes("resourceExtname == .md") &&
      item.when?.includes("resourceExtname == .markdown"),
  ),
);
assert.equal(
  packageJson.contributes?.menus?.["editor/title"]?.filter((item) =>
    item.command?.startsWith("markdownLiveRenderTables."),
  ).length,
  1,
);
assert.match(extensionSource, /reopenActiveEditorWith/);
assert.match(extensionSource, /const DEFAULT_EDITOR_ID = "default"/);
assert.match(liveEditorSource, /doc: initialDocument/);
assert.match(liveEditorCss, /--mlrt-selection-accent:\s*#3b9cff;/);
assert.match(
  liveEditorCss,
  /var\(--mlrt-selection-accent\) 13%,\s*transparent/,
);
assert.doesNotMatch(
  liveEditorCss,
  /--mlrt-selection-fill:\s*var\(\s*--vscode-editor-selectionBackground/,
);
assert.match(
  liveEditorCss,
  /\.mlrt-prose-selection\s*\{[\s\S]*?background-color:\s*var\(--mlrt-text-selection-fill\)\s*!important;[\s\S]*?box-decoration-break:\s*clone;/,
);
assert.match(
  liveEditorCss,
  /\.mlrt-prose-selection::before\s*\{\s*content:\s*none;\s*\}/,
);
assert.doesNotMatch(extensionSource, /Loading Markdown live editor/);
assert.doesNotMatch(
  liveEditorSource,
  /toggleMode|toggleRenderedMode|renderedMode|renderModeCompartment/,
);
assert.match(tableDecorationsSource, /lineNumberMarkers/);
assert.match(tableDecorationsSource, /hiddenLineNumberMarker/);
assert.match(geometrySyncSource, /ResizeObserver/);
assert.match(tableWidgetSource, /dataset\.sourceLine/);
assert.match(tableWidgetSource, /measureTableColumnSizing/);
assert.doesNotMatch(tableWidgetSource, /appendLineNumberCell/);
assert.doesNotMatch(geometrySyncSource, /class TableRowLineNumberMarker/);
assert.doesNotMatch(geometrySyncSource, /lineNumberWidgetMarker/);

console.log("Markdown live editor smoke tests passed.");
