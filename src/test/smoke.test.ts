import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTableFirstParser } from "../live-v4/parser/TableFirstParser";
import {
  formatMarkdownCell,
  formatMarkdownRow,
  formatTableCellEdit,
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
    (command) => command.command === "markdownLiveRenderTables.openLiveEditor",
  ),
);
assert.ok(
  packageJson.contributes?.commands?.some(
    (command) => command.command === "markdownLiveRenderTables.openSourceEditor",
  ),
);
assert.ok(
  packageJson.contributes?.menus?.["editor/title"]?.some(
    (item) =>
      item.command === "markdownLiveRenderTables.openLiveEditor" &&
      item.when?.includes("resourceLangId == markdown"),
  ),
);
assert.ok(
  packageJson.contributes?.menus?.["editor/title"]?.some(
    (item) =>
      item.command === "markdownLiveRenderTables.openSourceEditor" &&
      item.when?.includes("activeCustomEditorId == markdownLiveRenderTables.liveEditor"),
  ),
);

console.log("Markdown live editor smoke tests passed.");
