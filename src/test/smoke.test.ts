import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTableFirstParser } from "../live-v4/parser/TableFirstParser";
import { measureTableColumnSizing } from "../shared/tableColumnSizing";
import {
  formatMarkdownCell,
  formatMarkdownRow,
  formatTableCellEdit,
  formatTableCellSourceEdit,
  markdownCellToDisplayText,
  parseMarkdownTables,
  rowToDisplayValues,
} from "../shared/tableModel";

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

const edited = formatTableCellEdit(noOuterTables[0].body[0], 3, 2, "new\nvalue");
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

const spacedSource = "| Key  | Value     |\n| ---- | --------- |\n| Long | keep this |";
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
  ["Name | Empty | Notes", "--- | --- | ---", "Alpha | filled | wraps<br>inside"].join(
    "\n",
  ),
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

const parser = createTableFirstParser();
const model = parser.parse(standard);
assert.equal(model.meta.dialect, "markdown-live-v4");
assert.equal(model.meta.parser, "table-first");
assert.equal(model.blocks.length, 1);
assert.equal(model.blocks[0].type, "table");
assert.equal(model.blocks[0].from, standard.indexOf("| Name |"));
assert.equal(model.blocks[0].lineFrom, 3);
assert.equal(model.blocks[0].lineTo, 6);

const compactSizing = measureTableColumnSizing(
  parseMarkdownTables("| # | Value |\n| --- | --- |\n| 10 | B |")[0],
);
assert.ok(
  compactSizing.dataWidthCh <= 24,
  `expected compact tables to fit content, got ${compactSizing.dataWidthCh}ch`,
);
assert.ok(
  compactSizing.columns[0].widthCh >= 4.5 && compactSizing.columns[0].widthCh < 12,
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

const packageJson = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
) as {
  contributes?: {
    commands?: Array<{ command?: string }>;
    keybindings?: Array<{ command?: string; key?: string; mac?: string; when?: string }>;
    menus?: { "editor/title"?: Array<{ command?: string; when?: string }> };
    customEditors?: Array<{
      viewType?: string;
      displayName?: string;
      priority?: string;
    }>;
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
const liveRuntimeSource = fs.readFileSync(
  path.join(process.cwd(), "src", "live-v4", "LiveRuntime.ts"),
  "utf8",
);
const tableWidgetSource = fs.readFileSync(
  path.join(process.cwd(), "src", "live-v4", "render", "TableWidget.ts"),
  "utf8",
);

assert.equal(
  packageJson.contributes?.customEditors?.[0]?.viewType,
  "markdownLiveRenderTables.liveEditor",
);
assert.equal(packageJson.contributes?.customEditors?.[0]?.priority, "option");
assert.ok(
  packageJson.contributes?.customEditors?.some(
    (editor) => editor.viewType === "markdownLiveRenderTables.tableEditor",
  ),
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
assert.doesNotMatch(extensionSource, /Loading Markdown live editor/);
assert.doesNotMatch(
  liveEditorSource,
  /toggleMode|toggleRenderedMode|renderedMode|renderModeCompartment/,
);
assert.match(liveRuntimeSource, /lineNumberMarkers/);
assert.match(liveRuntimeSource, /hiddenLineNumberMarker/);
assert.match(liveRuntimeSource, /ResizeObserver/);
assert.match(tableWidgetSource, /dataset\.sourceLine/);
assert.match(tableWidgetSource, /measureTableColumnSizing/);
assert.doesNotMatch(tableWidgetSource, /appendLineNumberCell/);
assert.doesNotMatch(liveRuntimeSource, /class TableRowLineNumberMarker/);
assert.doesNotMatch(liveRuntimeSource, /lineNumberWidgetMarker/);

console.log("Markdown live editor smoke tests passed.");
