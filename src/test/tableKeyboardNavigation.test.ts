import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EditorState } from "@codemirror/state";
import {
  tableNavigationModifierCompartment,
  tableNavigationModifierFacet,
} from "../editor/tableNavigation";
import {
  adjacentTableCell,
  DEFAULT_TABLE_NAVIGATION_MODIFIER_KEY,
  normalizeTableNavigationModifierKey,
  TableNavigationKeyState,
  TABLE_NAVIGATION_MODIFIER_KEYS,
} from "../shared/tableKeyboardNavigation";

const packageJson = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
) as {
  contributes?: {
    configuration?: {
      properties?: Record<
        string,
        {
          type?: unknown;
          scope?: unknown;
          enum?: unknown;
          default?: unknown;
          markdownDescription?: unknown;
        }
      >;
    };
  };
};

const setting =
  packageJson.contributes?.configuration?.properties?.[
    "markdownLiveRenderTables.tableNavigation.modifierKey"
  ];
assert.ok(setting, "expected the table-navigation modifier setting");
assert.equal(setting.type, "string");
assert.equal(setting.scope, "window");
assert.deepEqual(setting.enum, [...TABLE_NAVIGATION_MODIFIER_KEYS]);
assert.equal(setting.default, DEFAULT_TABLE_NAVIGATION_MODIFIER_KEY);
assert.match(
  String(setting.markdownDescription),
  /hold.*arrow key.*adjacent rendered table cell/i,
);

for (const key of TABLE_NAVIGATION_MODIFIER_KEYS) {
  assert.equal(normalizeTableNavigationModifierKey(key), key);
}
assert.equal(
  normalizeTableNavigationModifierKey(undefined),
  DEFAULT_TABLE_NAVIGATION_MODIFIER_KEY,
);
assert.equal(
  normalizeTableNavigationModifierKey("F13"),
  DEFAULT_TABLE_NAVIGATION_MODIFIER_KEY,
);
assert.equal(
  normalizeTableNavigationModifierKey("f2", "F8"),
  "F8",
);

const initialState = EditorState.create({
  extensions: [
    tableNavigationModifierCompartment.of(
      tableNavigationModifierFacet.of("F2"),
    ),
  ],
});
assert.equal(initialState.facet(tableNavigationModifierFacet), "F2");
const reconfiguredState = initialState.update({
  effects: tableNavigationModifierCompartment.reconfigure(
    tableNavigationModifierFacet.of("F8"),
  ),
}).state;
assert.equal(reconfiguredState.facet(tableNavigationModifierFacet), "F8");

const grid = { rowCount: 3, columnCount: 3 };
assert.deepEqual(adjacentTableCell({ row: 1, column: 1 }, "up", grid), {
  row: 0,
  column: 1,
});
assert.deepEqual(adjacentTableCell({ row: 1, column: 1 }, "down", grid), {
  row: 2,
  column: 1,
});
assert.deepEqual(adjacentTableCell({ row: 1, column: 1 }, "left", grid), {
  row: 1,
  column: 0,
});
assert.deepEqual(adjacentTableCell({ row: 1, column: 1 }, "right", grid), {
  row: 1,
  column: 2,
});
assert.equal(adjacentTableCell({ row: 0, column: 1 }, "up", grid), null);
assert.equal(adjacentTableCell({ row: 2, column: 1 }, "down", grid), null);
assert.equal(adjacentTableCell({ row: 1, column: 0 }, "left", grid), null);
assert.equal(adjacentTableCell({ row: 1, column: 2 }, "right", grid), null);

const heldKeys = new TableNavigationKeyState();
heldKeys.keyDown("F2");
assert.equal(heldKeys.isHeld("F2"), true);
heldKeys.keyDown("ArrowRight");
assert.equal(heldKeys.isHeld("F2"), true);
heldKeys.keyUp("F2");
assert.equal(heldKeys.isHeld("F2"), false);
heldKeys.keyDown("F8");
heldKeys.clear();
assert.equal(heldKeys.isHeld("F8"), false);

console.log("table keyboard navigation configuration tests passed");
