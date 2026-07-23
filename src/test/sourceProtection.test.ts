import assert from "node:assert/strict";
import { EditorSelection, EditorState } from "@codemirror/state";
import {
  allowTableSourceChange,
  createTableSourceChangeFilter,
} from "../shared/tableSourceProtection";
import { parseMarkdownTables } from "../shared/tableModel";

interface TestChange {
  from: number;
  to: number;
  insert: string;
}

function applyChange(
  source: string,
  selection: number,
  change: TestChange,
  annotated = false,
): string {
  const state = EditorState.create({
    doc: source,
    selection: EditorSelection.cursor(selection),
    extensions: [createTableSourceChangeFilter()],
  });
  const transaction = state.update({
    changes: change,
    ...(annotated
      ? { annotations: allowTableSourceChange.of(true) }
      : {}),
  });
  return transaction.newDoc.toString();
}

const source = [
  "before",
  "| A | B |",
  "| --- | --- |",
  "| 1 | 2 |",
  "after",
].join("\n");
const table = parseMarkdownTables(source)[0]!;
const outsideSelection = source.length;

// A change is protected based on what it edits, not where the cursor happens
// to be. Commands and asynchronous input can produce a table edit while the
// selection is already outside the replacement widget.
const bodyValue = table.body[0].cells[0].start + 1;
assert.equal(
  applyChange(source, outsideSelection, {
    from: bodyValue,
    to: bodyValue,
    insert: "X",
  }),
  source,
);

// Deleting either separator newline would join prose to a table row and make
// the Markdown parser reinterpret the row's data/column count.
assert.equal(
  applyChange(source, table.from - 1, {
    from: table.from - 1,
    to: table.from,
    insert: "",
  }),
  source,
);
assert.equal(
  applyChange(source, table.to + 1, {
    from: table.to,
    to: table.to + 1,
    insert: "",
  }),
  source,
);

// Ordinary prose edits on either side of the protected separators remain
// available.
const beforeInsert = table.from - 1;
assert.equal(
  applyChange(source, beforeInsert, {
    from: beforeInsert,
    to: beforeInsert,
    insert: "!",
  }),
  `${source.slice(0, beforeInsert)}!${source.slice(beforeInsert)}`,
);
const afterInsert = table.to + 1;
assert.equal(
  applyChange(source, afterInsert, {
    from: afterInsert,
    to: afterInsert,
    insert: "!",
  }),
  `${source.slice(0, afterInsert)}!${source.slice(afterInsert)}`,
);

// Rendered-cell, clipboard, structure, and host updates explicitly opt in to
// changing table source through this annotation.
assert.equal(
  applyChange(
    source,
    outsideSelection,
    { from: bodyValue, to: bodyValue, insert: "X" },
    true,
  ),
  `${source.slice(0, bodyValue)}X${source.slice(bodyValue)}`,
);

const eofSource = [
  "| A | B |",
  "| --- | --- |",
  "| 1 | 2 |",
].join("\n");
const eofTable = parseMarkdownTables(eofSource)[0]!;

// With no trailing newline, the document-end position is also the end of the
// final table row. Plain text there corrupts the row, while a leading newline
// safely starts prose after the table.
assert.equal(
  applyChange(eofSource, eofSource.length, {
    from: eofTable.to,
    to: eofTable.to,
    insert: "corrupt",
  }),
  eofSource,
);
assert.equal(
  applyChange(eofSource, eofSource.length, {
    from: eofTable.to,
    to: eofTable.to,
    insert: "\nafter",
  }),
  `${eofSource}\nafter`,
);
