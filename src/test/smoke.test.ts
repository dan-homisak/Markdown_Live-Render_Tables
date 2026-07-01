import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTableFirstParser } from "../live-v4/parser/TableFirstParser";
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

const packageJson = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
) as {
  contributes?: {
    commands?: Array<{ command?: string }>;
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
assert.doesNotMatch(
  liveEditorSource,
  /toggleMode|toggleRenderedMode|renderedMode|renderModeCompartment/,
);
assert.match(liveRuntimeSource, /lineNumberMarkers/);
assert.match(liveRuntimeSource, /hiddenLineNumberMarker/);
assert.match(tableWidgetSource, /dataset\.sourceLine/);
assert.match(tableWidgetSource, /measureColumnWidthPercentages/);
assert.doesNotMatch(tableWidgetSource, /appendLineNumberCell/);
assert.doesNotMatch(liveRuntimeSource, /class TableRowLineNumberMarker/);
assert.doesNotMatch(liveRuntimeSource, /lineNumberWidgetMarker/);

console.log("Markdown live editor smoke tests passed.");
