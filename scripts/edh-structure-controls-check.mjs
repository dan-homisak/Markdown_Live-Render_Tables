#!/usr/bin/env node
// Launch an isolated VS Code Extension Development Host, open TestTable.md in
// the Markdown Live Editor, and exercise the proximity-driven table structure
// controls: pointer-following border indicators (hairline -> three-dot
// handle), focused-cell accent hairlines, flyout menus with insert/delete
// actions, and the thin "+" append rails outside the right/bottom edges.
// Saves screenshots to qa/ and fails when any behavior or source edit is
// wrong.
//
// Pointer choreography notes:
// - Pointer moves MUST be trusted CDP Input.dispatchMouseEvent calls; plain
//   synthetic mousemove events are clobbered whenever Chromium re-synthesizes
//   hover state from its real pointer position.
// - Input.setIgnoreInputEvents(true) shields the run from the PHYSICAL mouse
//   (the spawned window opens under the user's cursor, whose hardware events
//   would otherwise race the scripted ones). CDP-injected input still works.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "undici";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const codeBin = "/Applications/Visual Studio Code.app/Contents/MacOS/Electron";
const port = await findFreePort(9800, 200);
const userDataDir = mkdtempSync(path.join(os.tmpdir(), "mlrt-edh-controls-"));
const qaDir = path.join(repoRoot, "qa");
await mkdir(qaDir, { recursive: true });
console.log(`Using Electron DevTools port ${port}`);

async function findFreePort(start, count) {
  for (let offset = 0; offset < count; offset++) {
    const port = start + offset;
    if (await looksIdle(port)) {
      return port;
    }
  }
  throw new Error(`No free DevTools port found in ${start}-${start + count - 1}`);
}

async function looksIdle(port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 250);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json`, {
      signal: controller.signal,
    });
    return !response.ok;
  } catch {
    return true;
  } finally {
    clearTimeout(timeout);
  }
}

const child = spawn(
  codeBin,
  [
    `--extensionDevelopmentPath=${repoRoot}`,
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    "--new-window",
    "--disable-workspace-trust",
    "--skip-release-notes",
    "--skip-welcome",
    path.join(repoRoot, "TestTable.md"),
  ],
  { stdio: ["ignore", "pipe", "pipe"], env: createElectronEnv() },
);
let childExit = null;
let childOutput = "";
const captureChildOutput = (chunk) => {
  childOutput += chunk.toString();
  if (childOutput.length > 12000) {
    childOutput = childOutput.slice(-12000);
  }
};
child.stdout?.on("data", captureChildOutput);
child.stderr?.on("data", captureChildOutput);
child.on("exit", (code, signal) => {
  childExit = { code, signal };
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createElectronEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("npm_") ||
      key === "NODE_OPTIONS" ||
      key === "ELECTRON_RUN_AS_NODE"
    ) {
      delete env[key];
    }
  }
  if (env.PATH) {
    env.PATH = env.PATH.split(path.delimiter)
      .filter(
        (segment) =>
          !segment.endsWith(`${path.sep}node_modules${path.sep}.bin`) &&
          !segment.endsWith(`${path.sep}node-gyp-bin`),
      )
      .join(path.delimiter);
  }
  env.ELECTRON_NO_ATTACH_CONSOLE = "1";
  return env;
}

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${port}/json`);
  return res.json();
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((r) =>
    ws.addEventListener("open", r, { once: true }),
  );
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res) => {
      const mid = ++id;
      pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return { ws, ready, send };
}

async function captureWorkbenchScreenshot(client, outputPath) {
  const shot = await client.send("Page.captureScreenshot", { format: "png" });
  if (shot.result?.data) {
    await writeFile(outputPath, Buffer.from(shot.result.data, "base64"));
    console.log(`Saved ${path.relative(repoRoot, outputPath)}`);
  }
}

/**
 * Wraps an expression body so it runs against the document that actually
 * contains the live editor (the webview nests it inside an iframe). The body
 * sees `root` (that document) and `win` (its window) plus `rect(el)` which
 * returns a plain bounding box. The body must return a JSON string.
 */
function liveExpression(body) {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try {
        return frame.contentDocument;
      } catch {
        return null;
      }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mlrt-table-widget'));
    if (!root) {
      return JSON.stringify({ ok: false, reason: 'missing live root' });
    }
    const win = root.defaultView;
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    ${body}
  })()`;
}

async function evaluateJson(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.result?.exceptionDetails) {
    throw new Error(
      `Evaluation failed: ${JSON.stringify(result.result.exceptionDetails)}`,
    );
  }
  const value = result.result?.result?.value;
  if (typeof value !== "string") {
    throw new Error(
      `Expected JSON string from evaluation, got ${JSON.stringify(value)}`,
    );
  }
  return value ? JSON.parse(value) : null;
}

function expectOk(label, result) {
  console.log(`${label}:`, JSON.stringify(result));
  if (!result?.ok) {
    throw new Error(`${label} failed: ${JSON.stringify(result)}`);
  }
}

try {
  let workbench = null;
  let lastTargets = [];
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const targets = await listTargets().catch(() => []);
    lastTargets = targets;
    workbench = targets.find(
      (t) => t.type === "page" && /workbench\.html/.test(t.url),
    );
    if (workbench) break;
  }
  if (!workbench) {
    throw new Error(
      `Workbench target not found. childExit=${JSON.stringify(childExit)} targets=${JSON.stringify(
        lastTargets.map((target) => ({ type: target.type, url: target.url })),
      )} output=${JSON.stringify(childOutput)}`,
    );
  }

  const wb = connect(workbench.webSocketDebuggerUrl);
  await wb.ready;
  await wb.send("Runtime.enable");
  await wb.send("Page.enable");
  await sleep(4000);

  // Toggle the live editor via the command palette.
  const key = async (opts) => wb.send("Input.dispatchKeyEvent", opts);
  await key({
    type: "keyDown",
    modifiers: 4 | 8,
    key: "P",
    code: "KeyP",
    windowsVirtualKeyCode: 80,
  });
  await key({
    type: "keyUp",
    modifiers: 4 | 8,
    key: "P",
    code: "KeyP",
    windowsVirtualKeyCode: 80,
  });
  await sleep(800);
  await wb.send("Input.insertText", { text: "Toggle Markdown Live Editor" });
  await sleep(1200);
  await key({
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await key({
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await sleep(5000);

  // Find the live editor webview client.
  const afterTargets = await listTargets();
  const webviewTargets = afterTargets.filter(
    (t) =>
      t.type === "iframe" ||
      /vscode-webview|index-no-csp|fake\.html/.test(t.url || ""),
  );
  let live = null;
  for (const wv of webviewTargets) {
    try {
      const c = connect(wv.webSocketDebuggerUrl);
      await c.ready;
      await c.send("Runtime.enable");
      const probe = await evaluateJson(
        c,
        liveExpression(
          `return JSON.stringify({ ok: Boolean(win.__MLRT_EDITOR_VIEW__) });`,
        ),
      );
      if (probe?.ok) {
        live = c;
        break;
      }
      c.ws.close();
    } catch {}
  }
  if (!live) {
    throw new Error("Live editor webview client was not found.");
  }

  // Record all cell-commit events so any stray write can be attributed.
  await evaluateJson(
    live,
    liveExpression(`
      if (!win.__COMMIT_LOG__) {
        win.__COMMIT_LOG__ = [];
        root.addEventListener("mlrt:table-cell-commit", (event) => {
          win.__COMMIT_LOG__.push({ ...event.detail });
        }, true);
      }
      return JSON.stringify({ ok: true });
    `),
  );

  // NOTE: do not use Input.setIgnoreInputEvents anywhere here. On the
  // workbench target it also swallows CDP input injected on the webview
  // target (OOPIF input routes through the root frame's pipeline), and on
  // the webview target it swallows our own injected pointer moves. Physical
  // mouse races are handled by moveAndCheck's retry loop instead.

  /**
   * Moves the webview's trusted pointer to coordinates computed inside the
   * webview by `coordsBody` (which must return `{ ok, x, y }`).
   */
  const movePointerTo = async (coordsBody) => {
    const target = await evaluateJson(live, liveExpression(coordsBody));
    if (!target?.ok) {
      throw new Error(`Pointer target failed: ${JSON.stringify(target)}`);
    }
    await live.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: target.x,
      y: target.y,
    });
    await sleep(200);
    return target;
  };

  /**
   * Runs move + check up to three times; layout can shift between computing
   * coordinates and the move landing (e.g. right after a widget rebuild).
   */
  const moveAndCheck = async (label, coordsBody, checkBody) => {
    let result = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      await movePointerTo(coordsBody);
      result = await evaluateJson(live, liveExpression(checkBody));
      if (result?.ok) {
        break;
      }
      await sleep(300);
    }
    expectOk(label, result);
    return result;
  };

  // Park the pointer far from the table so nothing is revealed at rest.
  await movePointerTo(`return JSON.stringify({ ok: true, x: 2, y: 2 });`);

  // 1. All controls hidden at rest.
  const restState = await evaluateJson(
    live,
    liveExpression(`
      const wrapper = root.querySelector(".mlrt-table-widget");
      const layer = wrapper.querySelector(".mlrt-table-controls-layer");
      if (!layer) {
        return JSON.stringify({ ok: false, reason: "missing controls layer" });
      }
      const hidden = (selector) => layer.querySelector(selector)?.hidden === true;
      const detail = {
        col: hidden(".mlrt-table-col-indicator"),
        row: hidden(".mlrt-table-row-indicator"),
        focusCol: hidden(".mlrt-table-focus-indicator.mlrt-table-focus-col-indicator"),
        appendCol: hidden(".mlrt-table-append-column"),
        appendRow: hidden(".mlrt-table-append-row"),
      };
      return JSON.stringify({
        ok: detail.col && detail.row && detail.focusCol && detail.appendCol && detail.appendRow,
        detail,
      });
    `),
  );
  expectOk("CONTROLS HIDDEN AT REST", restState);

  // 2. Hovering mid-cell shows exactly one hairline indicator per axis, ON
  //    the border, with the minimum-cell width cap.
  await moveAndCheck(
    "HAIRLINE INDICATORS ON BORDER",
    `
      const wrapper = root.querySelector(".mlrt-table-widget");
      const cell = wrapper.querySelector('td.mlrt-table-cell[data-column="1"]');
      const r = rect(cell);
      return JSON.stringify({ ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 });
    `,
    `
      const wrapper = root.querySelector(".mlrt-table-widget");
      const wrapperRect = rect(wrapper);
      const tableRect = rect(wrapper.querySelector(".mlrt-table"));
      const headerCell = wrapper.querySelector('th.mlrt-table-cell[data-column="1"]');
      const headerRect = rect(headerCell);
      const bodyRow = wrapper.querySelector("tbody tr");
      const rowRect = rect(bodyRow);
      const col = wrapper.querySelector(".mlrt-table-col-indicator");
      const row = wrapper.querySelector(".mlrt-table-row-indicator");
      const colRect = rect(col);
      const rowRectI = rect(row);
      const near = (a, b, tol) => Math.abs(a - b) <= tol;
      const chWidth = (() => {
        const probe = root.createElement("span");
        probe.textContent = "0";
        probe.style.cssText = "position:absolute;left:-9999px;white-space:pre;";
        wrapper.querySelector(".mlrt-table").append(probe);
        const w = probe.getBoundingClientRect().width;
        probe.remove();
        return w;
      })();
      const expectedWidth = Math.min(Math.max(12, 3 * chWidth), headerRect.width - 4);
      return JSON.stringify({
        ok:
          !col.hidden &&
          !row.hidden &&
          col.dataset.state === "line" &&
          row.dataset.state === "line" &&
          colRect.height <= 4 &&
          rowRectI.width <= 4 &&
          near(colRect.top + colRect.height / 2, tableRect.top, 2) &&
          near(rowRectI.left + rowRectI.width / 2, wrapperRect.left, 2) &&
          near(colRect.width, expectedWidth, 2) &&
          near((colRect.left + colRect.right) / 2, (headerRect.left + headerRect.right) / 2, 2) &&
          rowRectI.top >= rowRect.top &&
          rowRectI.bottom <= rowRect.bottom,
        colState: col.dataset.state,
        colHidden: col.hidden,
        rowState: row.dataset.state,
        colRect,
        rowRect: rowRectI,
        expectedWidth,
        tableTop: tableRect.top,
      });
    `,
  );

  // 3. Moving near the top border grows the column indicator into the
  //    three-dot handle.
  await moveAndCheck(
    "COLUMN INDICATOR GROWS TO DOTS",
    `
      const wrapper = root.querySelector(".mlrt-table-widget");
      const headerCell = wrapper.querySelector('th.mlrt-table-cell[data-column="0"]');
      const r = rect(headerCell);
      return JSON.stringify({ ok: true, x: r.left + r.width / 2, y: r.top + 4 });
    `,
    `
      const wrapper = root.querySelector(".mlrt-table-widget");
      const tableRect = rect(wrapper.querySelector(".mlrt-table"));
      const col = wrapper.querySelector(".mlrt-table-col-indicator");
      const colRect = rect(col);
      const dots = col.querySelectorAll(".mlrt-table-indicator-dot");
      return JSON.stringify({
        ok:
          !col.hidden &&
          col.dataset.state === "dots" &&
          colRect.height >= 10 &&
          colRect.bottom <= tableRect.top + 2 &&
          dots.length === 3,
        state: col.dataset.state,
        hidden: col.hidden,
        colRect,
        tableTop: tableRect.top,
      });
    `,
  );
  await captureWorkbenchScreenshot(
    wb,
    path.join(qaDir, "edh-structure-controls.png"),
  );

  const docLines = () =>
    evaluateJson(
      live,
      liveExpression(`
        const doc = win.__MLRT_EDITOR_VIEW__.state.doc.toString();
        return JSON.stringify({ ok: true, lines: doc.split("\\n") });
      `),
    );

  const before = await docLines();
  const headerLineIndex = before.lines.findIndex(
    (line) => line === "| Key | Value |",
  );
  if (headerLineIndex < 0) {
    throw new Error("Could not find the first table header line.");
  }

  // 4. Click the dot handle: emoji menu opens with all column actions.
  const menuState = await evaluateJson(
    live,
    liveExpression(`
      const wrapper = root.querySelector(".mlrt-table-widget");
      wrapper.querySelector(".mlrt-table-col-indicator").click();
      const menu = wrapper.querySelector(".mlrt-table-structure-menu");
      if (!menu) {
        return JSON.stringify({ ok: false, reason: "menu did not open" });
      }
      const items = [...menu.querySelectorAll(".mlrt-table-structure-menu-item")];
      return JSON.stringify({
        ok:
          items.length === 3 &&
          items.every((item) => !item.disabled) &&
          items.map((item) => item.dataset.action).join(",") ===
            "insert-column-left,insert-column-right,delete-column" &&
          items.some((item) => item.textContent.includes("🗑")) &&
          items.some((item) => item.textContent.includes("⬅")),
        actions: items.map((item) => item.dataset.action),
        labels: items.map((item) => item.textContent),
      });
    `),
  );
  expectOk("COLUMN MENU", menuState);
  await captureWorkbenchScreenshot(
    wb,
    path.join(qaDir, "edh-structure-menu.png"),
  );

  // 5. Insert column right; source gains an empty column.
  await evaluateJson(
    live,
    liveExpression(`
      root.querySelector('[data-action="insert-column-right"]').click();
      return JSON.stringify({ ok: true });
    `),
  );
  await sleep(400);
  const afterInsertColumn = await docLines();
  expectOk("INSERT COLUMN RIGHT SOURCE", {
    ok:
      afterInsertColumn.lines[headerLineIndex] === "| Key |  | Value |" &&
      afterInsertColumn.lines[headerLineIndex + 1] === "|---| --- |---|" &&
      afterInsertColumn.lines[headerLineIndex + 2].startsWith("| Long |  |"),
    header: afterInsertColumn.lines[headerLineIndex],
    delimiter: afterInsertColumn.lines[headerLineIndex + 1],
  });
  const menuClosed = await evaluateJson(
    live,
    liveExpression(`
      return JSON.stringify({ ok: !root.querySelector(".mlrt-table-structure-menu") });
    `),
  );
  expectOk("MENU CLOSED AFTER ACTION", menuClosed);

  // 6. Delete the inserted column via its dot handle.
  await moveAndCheck(
    "DELETE COLUMN HANDLE READY",
    `
      const wrapper = root.querySelector(".mlrt-table-widget");
      const headerCell = wrapper.querySelector('th.mlrt-table-cell[data-column="1"]');
      const r = rect(headerCell);
      return JSON.stringify({ ok: true, x: r.left + r.width / 2, y: r.top + 4 });
    `,
    `
      const wrapper = root.querySelector(".mlrt-table-widget");
      const col = wrapper.querySelector(".mlrt-table-col-indicator");
      return JSON.stringify({
        ok: !col.hidden && col.dataset.state === "dots",
        hidden: col.hidden,
        state: col.dataset.state,
      });
    `,
  );
  const deleteColumnClick = await evaluateJson(
    live,
    liveExpression(`
      const wrapper = root.querySelector(".mlrt-table-widget");
      wrapper.querySelector(".mlrt-table-col-indicator").click();
      const item = wrapper.querySelector('[data-action="delete-column"]');
      if (!item) {
        return JSON.stringify({ ok: false, reason: "item not found" });
      }
      item.click();
      return JSON.stringify({ ok: true });
    `),
  );
  expectOk("DELETE COLUMN CLICK", deleteColumnClick);
  await sleep(400);
  const afterDeleteColumn = await docLines();
  expectOk("DELETE COLUMN SOURCE", {
    ok:
      afterDeleteColumn.lines[headerLineIndex] === "| Key | Value |" &&
      afterDeleteColumn.lines[headerLineIndex + 1] === "|---|---|",
    header: afterDeleteColumn.lines[headerLineIndex],
    delimiter: afterDeleteColumn.lines[headerLineIndex + 1],
  });

  // 7. Approach from BELOW the table (outside it): the bottom "+" rail
  //    appears as a thin rectangle outside the bottom border.
  await moveAndCheck(
    "BOTTOM APPEND RAIL OUTSIDE ON APPROACH",
    `
      const wrapper = root.querySelector(".mlrt-table-widget");
      const tableRect = rect(wrapper.querySelector(".mlrt-table"));
      return JSON.stringify({ ok: true, x: (tableRect.left + tableRect.right) / 2, y: tableRect.bottom + 18 });
    `,
    `
      const wrapper = root.querySelector(".mlrt-table-widget");
      const tableRect = rect(wrapper.querySelector(".mlrt-table"));
      const rail = wrapper.querySelector(".mlrt-table-append-row");
      const railRect = rect(rail);
      return JSON.stringify({
        ok:
          !rail.hidden &&
          railRect.top >= tableRect.bottom &&
          railRect.height <= 12 &&
          railRect.width > railRect.height * 4,
        hidden: rail.hidden,
        railRect,
        tableBottom: tableRect.bottom,
      });
    `,
  );
  await captureWorkbenchScreenshot(
    wb,
    path.join(qaDir, "edh-structure-append-rails.png"),
  );
  await evaluateJson(
    live,
    liveExpression(`
      root.querySelector(".mlrt-table-append-row").click();
      return JSON.stringify({ ok: true });
    `),
  );
  await sleep(400);
  const afterAppendRow = await docLines();
  expectOk("APPEND ROW SOURCE", {
    ok: afterAppendRow.lines[headerLineIndex + 3] === "|  |  |",
    appended: afterAppendRow.lines[headerLineIndex + 3],
  });

  // 8. Delete the appended row from its row dot handle (pointer near the
  //    left border of that row).
  await moveAndCheck(
    "DELETE ROW HANDLE READY",
    `
      const wrapper = root.querySelector(".mlrt-table-widget");
      const rows = wrapper.querySelectorAll("tbody tr");
      const r = rect(rows[rows.length - 1]);
      const wrapperRect = rect(wrapper);
      return JSON.stringify({ ok: true, x: wrapperRect.left + 6, y: r.top + r.height / 2 });
    `,
    `
      const wrapper = root.querySelector(".mlrt-table-widget");
      const row = wrapper.querySelector(".mlrt-table-row-indicator");
      return JSON.stringify({
        ok: !row.hidden && row.dataset.state === "dots",
        hidden: row.hidden,
        state: row.dataset.state,
      });
    `,
  );
  const deleteRowClick = await evaluateJson(
    live,
    liveExpression(`
      const wrapper = root.querySelector(".mlrt-table-widget");
      wrapper.querySelector(".mlrt-table-row-indicator").click();
      const items = [...wrapper.querySelectorAll(".mlrt-table-structure-menu-item")];
      const actions = items.map((item) => item.dataset.action);
      const item = wrapper.querySelector('[data-action="delete-row"]');
      if (!item) {
        return JSON.stringify({ ok: false, actions });
      }
      item.click();
      return JSON.stringify({ ok: actions.length === 3, actions });
    `),
  );
  expectOk("DELETE ROW CLICK", deleteRowClick);
  await sleep(400);
  const afterDeleteRow = await docLines();
  expectOk("DELETE ROW SOURCE", {
    ok:
      afterDeleteRow.lines[headerLineIndex + 3] === "" &&
      afterDeleteRow.lines[headerLineIndex + 2].startsWith("| Long |"),
    rowAfterTable: afterDeleteRow.lines[headerLineIndex + 3],
  });

  // 9. Approach from the RIGHT of the table (outside it): the right "+"
  //    rail appears outside the right border; click appends a column, then
  //    remove it again.
  await moveAndCheck(
    "RIGHT APPEND RAIL OUTSIDE ON APPROACH",
    `
      const wrapper = root.querySelector(".mlrt-table-widget");
      const tableRect = rect(wrapper.querySelector(".mlrt-table"));
      const wrapperRect = rect(wrapper);
      const dataRight = Math.min(tableRect.right, wrapperRect.right);
      return JSON.stringify({ ok: true, x: dataRight + 16, y: (tableRect.top + tableRect.bottom) / 2 });
    `,
    `
      const wrapper = root.querySelector(".mlrt-table-widget");
      const tableRect = rect(wrapper.querySelector(".mlrt-table"));
      const wrapperRect = rect(wrapper);
      const dataRight = Math.min(tableRect.right, wrapperRect.right);
      const rail = wrapper.querySelector(".mlrt-table-append-column");
      const railRect = rect(rail);
      return JSON.stringify({
        ok:
          !rail.hidden &&
          railRect.left >= dataRight &&
          railRect.width <= 12 &&
          railRect.height > railRect.width * 4,
        hidden: rail.hidden,
        railRect,
        dataRight,
      });
    `,
  );
  await evaluateJson(
    live,
    liveExpression(`
      root.querySelector(".mlrt-table-append-column").click();
      return JSON.stringify({ ok: true });
    `),
  );
  await sleep(400);
  const afterAppendColumn = await docLines();
  expectOk("APPEND COLUMN SOURCE", {
    ok: afterAppendColumn.lines[headerLineIndex] === "| Key | Value |  |",
    header: afterAppendColumn.lines[headerLineIndex],
  });
  await moveAndCheck(
    "APPENDED COLUMN HANDLE READY",
    `
      const wrapper = root.querySelector(".mlrt-table-widget");
      const headerCell = wrapper.querySelector('th.mlrt-table-cell[data-column="2"]');
      const r = rect(headerCell);
      return JSON.stringify({ ok: true, x: r.left + r.width / 2, y: r.top + 4 });
    `,
    `
      const wrapper = root.querySelector(".mlrt-table-widget");
      const col = wrapper.querySelector(".mlrt-table-col-indicator");
      return JSON.stringify({
        ok: !col.hidden && col.dataset.state === "dots",
        hidden: col.hidden,
        state: col.dataset.state,
      });
    `,
  );
  await evaluateJson(
    live,
    liveExpression(`
      const wrapper = root.querySelector(".mlrt-table-widget");
      wrapper.querySelector(".mlrt-table-col-indicator").click();
      wrapper.querySelector('[data-action="delete-column"]').click();
      return JSON.stringify({ ok: true });
    `),
  );
  await sleep(400);

  // 10. Header row handle: pointer near the left border of the header row;
  //     menu offers only "Insert row below" (with emoji); use it.
  await moveAndCheck(
    "HEADER ROW HANDLE READY",
    `
      const wrapper = root.querySelector(".mlrt-table-widget");
      const headerRow = wrapper.querySelector("thead tr");
      const r = rect(headerRow);
      const wrapperRect = rect(wrapper);
      return JSON.stringify({ ok: true, x: wrapperRect.left + 6, y: r.top + r.height / 2 });
    `,
    `
      const wrapper = root.querySelector(".mlrt-table-widget");
      const row = wrapper.querySelector(".mlrt-table-row-indicator");
      return JSON.stringify({
        ok: !row.hidden && row.dataset.state === "dots",
        hidden: row.hidden,
        state: row.dataset.state,
      });
    `,
  );
  const headerRowMenu = await evaluateJson(
    live,
    liveExpression(`
      const wrapper = root.querySelector(".mlrt-table-widget");
      wrapper.querySelector(".mlrt-table-row-indicator").click();
      const items = [...wrapper.querySelectorAll(".mlrt-table-structure-menu-item")];
      const actions = items.map((item) => item.dataset.action);
      const hasEmoji = items.every((item) =>
        item.querySelector(".mlrt-table-structure-menu-emoji")?.textContent.length > 0,
      );
      const item = wrapper.querySelector('[data-action="insert-row-below"]');
      if (!item) {
        return JSON.stringify({ ok: false, actions });
      }
      item.click();
      return JSON.stringify({ ok: actions.length === 1 && hasEmoji, actions });
    `),
  );
  expectOk("HEADER ROW MENU", headerRowMenu);
  await sleep(400);
  const afterHeaderInsert = await docLines();
  expectOk("INSERT ROW BELOW HEADER SOURCE", {
    ok:
      afterHeaderInsert.lines[headerLineIndex + 2] === "|  |  |" &&
      afterHeaderInsert.lines[headerLineIndex + 3].startsWith("| Long |"),
    inserted: afterHeaderInsert.lines[headerLineIndex + 2],
  });

  // 11. The new row's first cell is focused; with the pointer parked away,
  //     the focused cell's column and row keep accent hairlines.
  await moveAndCheck(
    "FOCUS HAIRLINES WHILE POINTER AWAY",
    `return JSON.stringify({ ok: true, x: 2, y: 2 });`,
    `
      const wrapper = root.querySelector(".mlrt-table-widget");
      const active = root.activeElement;
      const focusCol = wrapper.querySelector(".mlrt-table-focus-col-indicator");
      const focusRow = wrapper.querySelector(".mlrt-table-focus-row-indicator");
      const mouseCol = wrapper.querySelector(".mlrt-table-col-indicator");
      const focusColRect = rect(focusCol);
      const headerRect = rect(wrapper.querySelector('th.mlrt-table-cell[data-column="0"]'));
      const near = (a, b, tol) => Math.abs(a - b) <= tol;
      return JSON.stringify({
        ok:
          Boolean(active) &&
          active.classList.contains("mlrt-table-cell") &&
          active.dataset.rowKind === "body" &&
          active.dataset.rowIndex === "0" &&
          active.dataset.column === "0" &&
          !focusCol.hidden &&
          !focusRow.hidden &&
          mouseCol.hidden &&
          focusColRect.height <= 4 &&
          near((focusColRect.left + focusColRect.right) / 2, (headerRect.left + headerRect.right) / 2, 2),
        active: active?.dataset ? { rowKind: active.dataset.rowKind, rowIndex: active.dataset.rowIndex, column: active.dataset.column } : null,
        focusColHidden: focusCol.hidden,
        focusRowHidden: focusRow.hidden,
        mouseColHidden: mouseCol.hidden,
        focusColRect,
      });
    `,
  );
  await captureWorkbenchScreenshot(
    wb,
    path.join(qaDir, "edh-structure-focus.png"),
  );

  // 12. Clean up the inserted row so the doc ends as it started.
  await moveAndCheck(
    "CLEANUP ROW HANDLE READY",
    `
      const wrapper = root.querySelector(".mlrt-table-widget");
      const bodyRow = wrapper.querySelector("tbody tr");
      const r = rect(bodyRow);
      const wrapperRect = rect(wrapper);
      return JSON.stringify({ ok: true, x: wrapperRect.left + 6, y: r.top + r.height / 2 });
    `,
    `
      const wrapper = root.querySelector(".mlrt-table-widget");
      const row = wrapper.querySelector(".mlrt-table-row-indicator");
      return JSON.stringify({
        ok: !row.hidden && row.dataset.state === "dots",
        hidden: row.hidden,
        state: row.dataset.state,
      });
    `,
  );
  await evaluateJson(
    live,
    liveExpression(`
      const wrapper = root.querySelector(".mlrt-table-widget");
      wrapper.querySelector(".mlrt-table-row-indicator").click();
      wrapper.querySelector('[data-action="delete-row"]').click();
      return JSON.stringify({ ok: true });
    `),
  );
  await sleep(400);
  const finalDoc = await docLines();
  const diff = [];
  const maxLines = Math.max(finalDoc.lines.length, before.lines.length);
  for (let i = 0; i < maxLines; i++) {
    if (finalDoc.lines[i] !== before.lines[i]) {
      diff.push({ line: i, before: before.lines[i], after: finalDoc.lines[i] });
    }
  }
  expectOk("DOC RESTORED AFTER ROUND TRIP", {
    ok: finalDoc.lines.join("\n") === before.lines.join("\n"),
    diff,
  });

  // Structural operations never type into cells, so any cell-commit event in
  // the log is a stray write (e.g. a recycled widget DOM committing another
  // table's value through stale metadata).
  const commitLog = await evaluateJson(
    live,
    liveExpression(`
      const commits = win.__COMMIT_LOG__ ?? [];
      return JSON.stringify({ ok: commits.length === 0, commits });
    `),
  );
  expectOk("NO STRAY CELL COMMITS", commitLog);

  console.log("Structure controls EDH checks passed.");
  live.ws.close();
  wb.ws.close();
} finally {
  await sleep(500);
  child.kill("SIGTERM");
}
