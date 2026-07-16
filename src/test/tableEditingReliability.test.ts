import assert from "node:assert/strict";
import {
  formatMarkdownCell,
  formatTableCellSourceEdit,
  markdownCellToDisplayText,
  parseMarkdownTables,
  rowToDisplayValues,
} from "../shared/tableModel";
import {
  deleteTableColumnEdit,
  deleteTableRowEdit,
  insertTableColumnEdit,
  insertTableRowEdit,
} from "../shared/tableStructureEdits";

interface ShadowTable {
  header: string[];
  body: string[][];
}

interface SourceEdit {
  from: number;
  to: number;
  insert: string;
}

const prefix = "RELIABILITY_PREFIX\n\n";
const suffix = "\n\nRELIABILITY_SUFFIX";
const initialHeader = ["Key", "Value", "Notes"];
const initialBody = [
  ["row 0", "alpha", "keep 0"],
  ["row 1", "beta", "keep 1"],
  ["row 2", "gamma", "keep 2"],
];
const bodyValuePool = [
  "",
  "plain",
  "with | pipe",
  "line\nbreak",
  "😀",
  "👩‍💻",
  "🇺🇸",
  "e\u0301",
  "ends with slash\\",
  "two slashes\\\\",
  "---",
  ":---:",
  "<br>literal",
  "non-breaking\u00a0space",
];
const headerValuePool = bodyValuePool;

for (let seed = 1; seed <= 40; seed++) {
  let randomState = seed >>> 0;
  const random = (): number => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 0x1_0000_0000;
  };
  const integer = (limit: number): number => Math.floor(random() * limit);

  let source = `${prefix}| ${initialHeader.join(" | ")} |\n| --- | --- | --- |\n${initialBody
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n")}${suffix}`;
  const shadow: ShadowTable = {
    header: [...initialHeader],
    body: initialBody.map((row) => [...row]),
  };

  for (let step = 0; step < 250; step++) {
    const table = parseMarkdownTables(source)[0];
    assert.ok(table, `seed ${seed} step ${step}: table disappeared before edit`);
    const operation = integer(5);

    if (operation === 0 || shadow.body.length === 0) {
      const editHeader = shadow.body.length === 0 || integer(5) === 0;
      const rowIndex = editHeader ? -1 : integer(shadow.body.length);
      const column = integer(shadow.header.length);
      const pool = editHeader ? headerValuePool : bodyValuePool;
      const input = `${pool[integer(pool.length)]}${step % 7 === 0 ? ` ${seed}:${step}` : ""}`;
      const sourceRow = editHeader ? table.header : table.body[rowIndex];
      source = applyEdit(
        source,
        formatTableCellSourceEdit(
          sourceRow,
          table.columnCount,
          column,
          input,
        ),
      );
      const expected = displayValueAfterCellFormat(input);
      if (editHeader) {
        shadow.header[column] = expected;
      } else {
        shadow.body[rowIndex][column] = expected;
      }
    } else if (operation === 1 && shadow.body.length < 8) {
      const rowIndex = integer(shadow.body.length + 1);
      source = applyEdit(source, insertTableRowEdit(table, rowIndex));
      shadow.body.splice(
        rowIndex,
        0,
        Array.from({ length: shadow.header.length }, () => ""),
      );
    } else if (operation === 2 && shadow.body.length > 0) {
      const rowIndex = integer(shadow.body.length);
      source = applyEdit(source, deleteTableRowEdit(table, rowIndex));
      shadow.body.splice(rowIndex, 1);
    } else if (operation === 3 && shadow.header.length < 7) {
      const column = integer(shadow.header.length + 1);
      source = applyEdit(source, insertTableColumnEdit(table, column));
      shadow.header.splice(column, 0, "");
      shadow.body.forEach((row) => row.splice(column, 0, ""));
    } else if (shadow.header.length > 1) {
      const column = integer(shadow.header.length);
      source = applyEdit(source, deleteTableColumnEdit(table, column));
      shadow.header.splice(column, 1);
      shadow.body.forEach((row) => row.splice(column, 1));
    }

    assertTableMatchesShadow(source, shadow, seed, step);
  }
}

function applyEdit(source: string, edit: SourceEdit | null): string {
  assert.ok(edit, "expected a valid table edit");
  return `${source.slice(0, edit.from)}${edit.insert}${source.slice(edit.to)}`;
}

function displayValueAfterCellFormat(value: string): string {
  return markdownCellToDisplayText(formatMarkdownCell(value));
}

function assertTableMatchesShadow(
  source: string,
  shadow: ShadowTable,
  seed: number,
  step: number,
): void {
  const label = `seed ${seed} step ${step}`;
  assert.ok(source.startsWith(prefix), `${label}: prefix changed`);
  assert.ok(source.endsWith(suffix), `${label}: suffix changed`);
  assert.equal(hasUnpairedSurrogate(source), false, `${label}: invalid Unicode`);

  const tables = parseMarkdownTables(source);
  assert.equal(tables.length, 1, `${label}: expected one parseable table`);
  const table = tables[0];
  assert.equal(table.columnCount, shadow.header.length, `${label}: columns`);
  assert.equal(table.body.length, shadow.body.length, `${label}: rows`);
  assert.deepEqual(
    rowToDisplayValues(table.header, table.columnCount),
    shadow.header,
    `${label}: header values`,
  );
  assert.deepEqual(
    table.body.map((row) => rowToDisplayValues(row, table.columnCount)),
    shadow.body,
    `${label}: body values`,
  );
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

console.log("10,000-operation table editing reliability fuzz passed");
