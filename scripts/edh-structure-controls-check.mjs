#!/usr/bin/env node
// Launch an isolated VS Code Extension Development Host, open TestTable.md in
// the Markdown Live Editor, and exercise the table structure controls:
// hover-reveal handles, flyout menus, insert/delete row and column actions,
// and the append "+" buttons. Saves screenshots of the revealed controls and
// open menu to qa/ and fails when any behavior or source edit is wrong.
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
const port = 9400 + Math.floor(Math.random() * 400);
const userDataDir = mkdtempSync(path.join(os.tmpdir(), "mlrt-edh-controls-"));
const qaDir = path.join(repoRoot, "qa");
await mkdir(qaDir, { recursive: true });
console.log(`Using Electron DevTools port ${port}`);

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
  { stdio: "ignore", env: createElectronEnv() },
);
let childExit = null;
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
 * sees `root` (that document) and `win` (its window) and must return a JSON
 * string.
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
  console.log(`${label}:`, result);
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
      )}`,
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

  // Record all cell-commit events so any unexpected write can be attributed.
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

  // Park the pointer away from the table so :hover cannot leak into the
  // rest-state assertion (the physical mouse may sit over the new window).
  await wb.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
  await live.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 1,
    y: 1,
  });
  await sleep(300);

  // 1. Controls exist and stay hidden (and inert) at rest.
  const restState = await evaluateJson(
    live,
    liveExpression(`
      const wrapper = root.querySelector(".mlrt-table-widget");
      const layer = wrapper.querySelector(".mlrt-table-controls-layer");
      if (!layer) {
        return JSON.stringify({ ok: false, reason: "missing controls layer" });
      }
      const style = win.getComputedStyle(layer);
      return JSON.stringify({
        ok: style.opacity === "0" && style.pointerEvents === "none",
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
        colHandles: layer.querySelectorAll(".mlrt-table-col-handle").length,
        rowHandles: layer.querySelectorAll(".mlrt-table-row-handle").length,
        appendButtons: layer.querySelectorAll(".mlrt-table-append-button").length,
      });
    `),
  );
  expectOk("CONTROLS REST STATE", restState);
  if (
    restState.colHandles !== 2 ||
    restState.rowHandles !== 2 ||
    restState.appendButtons !== 2
  ) {
    throw new Error(
      `Unexpected handle counts for a 2x(1+1) table: ${JSON.stringify(restState)}`,
    );
  }

  // 2. Reveal the controls and verify their geometry against the table.
  await evaluateJson(
    live,
    liveExpression(`
      root.querySelector(".mlrt-table-widget").classList.add("mlrt-table-controls-open");
      return JSON.stringify({ ok: true });
    `),
  );
  await sleep(400);
  const revealState = await evaluateJson(
    live,
    liveExpression(`
      const wrapper = root.querySelector(".mlrt-table-widget");
      const layer = wrapper.querySelector(".mlrt-table-controls-layer");
      const style = win.getComputedStyle(layer);
      const wrapperRect = wrapper.getBoundingClientRect();
      const tableRect = wrapper.querySelector(".mlrt-table").getBoundingClientRect();
      const headerCell = wrapper.querySelector("thead .mlrt-table-cell").getBoundingClientRect();
      const colHandle = layer.querySelector(".mlrt-table-col-handle").getBoundingClientRect();
      const rowHandle = layer.querySelector(".mlrt-table-row-handle").getBoundingClientRect();
      const appendCol = layer.querySelector(".mlrt-table-append-column").getBoundingClientRect();
      const appendRow = layer.querySelector(".mlrt-table-append-row").getBoundingClientRect();
      const near = (a, b, tol) => Math.abs(a - b) <= tol;
      return JSON.stringify({
        ok:
          style.opacity === "1" &&
          near(colHandle.left, headerCell.left, 3) &&
          colHandle.top < tableRect.top &&
          colHandle.bottom > tableRect.top &&
          rowHandle.right <= wrapperRect.left + 1 &&
          rowHandle.left >= tableRect.left - 1 &&
          appendCol.left > headerCell.right &&
          appendRow.top < tableRect.bottom &&
          appendRow.bottom > tableRect.bottom,
        opacity: style.opacity,
        colHandle: { left: colHandle.left, top: colHandle.top, width: colHandle.width },
        headerCellLeft: headerCell.left,
        tableTop: tableRect.top,
        tableBottom: tableRect.bottom,
        rowHandle: { left: rowHandle.left, right: rowHandle.right, top: rowHandle.top },
        wrapperLeft: wrapperRect.left,
        appendCol: { left: appendCol.left, top: appendCol.top },
        appendRow: { left: appendRow.left, top: appendRow.top },
      });
    `),
  );
  expectOk("CONTROLS REVEAL GEOMETRY", revealState);
  await captureWorkbenchScreenshot(
    wb,
    path.join(qaDir, "edh-structure-controls.png"),
  );

  // 3. Open the first column's flyout menu.
  const menuState = await evaluateJson(
    live,
    liveExpression(`
      const wrapper = root.querySelector(".mlrt-table-widget");
      wrapper.querySelector(".mlrt-table-col-handle").click();
      const menu = wrapper.querySelector(".mlrt-table-structure-menu");
      if (!menu) {
        return JSON.stringify({ ok: false, reason: "menu did not open" });
      }
      const items = [...menu.querySelectorAll(".mlrt-table-structure-menu-item")];
      return JSON.stringify({
        ok:
          items.length === 3 &&
          items.every((item) => !item.disabled) &&
          wrapper.classList.contains("mlrt-table-controls-open"),
        labels: items.map((item) => item.textContent),
      });
    `),
  );
  expectOk("COLUMN MENU", menuState);
  await captureWorkbenchScreenshot(
    wb,
    path.join(qaDir, "edh-structure-menu.png"),
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

  // 4. Insert column right from the menu; the source gains an empty column.
  const insertColumnClick = await evaluateJson(
    live,
    liveExpression(`
      const items = [...root.querySelectorAll(".mlrt-table-structure-menu-item")];
      const item = items.find((entry) => entry.textContent === "Insert column right");
      if (!item) {
        return JSON.stringify({ ok: false, reason: "item not found" });
      }
      item.click();
      return JSON.stringify({ ok: true });
    `),
  );
  expectOk("INSERT COLUMN RIGHT CLICK", insertColumnClick);
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

  // 5. Delete the inserted column via its handle menu.
  const deleteColumnClick = await evaluateJson(
    live,
    liveExpression(`
      const wrapper = root.querySelector(".mlrt-table-widget");
      wrapper.classList.add("mlrt-table-controls-open");
      const handles = wrapper.querySelectorAll(".mlrt-table-col-handle");
      handles[1].click();
      const items = [...wrapper.querySelectorAll(".mlrt-table-structure-menu-item")];
      const item = items.find((entry) => entry.textContent === "Delete column");
      if (!item) {
        return JSON.stringify({ ok: false, reason: "item not found" });
      }
      item.click();
      return JSON.stringify({ ok: true, handles: handles.length });
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

  // 6. Append a row with the bottom-edge "+" button.
  await evaluateJson(
    live,
    liveExpression(`
      const wrapper = root.querySelector(".mlrt-table-widget");
      wrapper.classList.add("mlrt-table-controls-open");
      wrapper.querySelector(".mlrt-table-append-row").click();
      return JSON.stringify({ ok: true });
    `),
  );
  await sleep(400);
  const afterAppendRow = await docLines();
  expectOk("APPEND ROW SOURCE", {
    ok: afterAppendRow.lines[headerLineIndex + 3] === "|  |  |",
    appended: afterAppendRow.lines[headerLineIndex + 3],
  });

  // 7. Delete the appended row from its row-handle menu.
  const deleteRowClick = await evaluateJson(
    live,
    liveExpression(`
      const wrapper = root.querySelector(".mlrt-table-widget");
      wrapper.classList.add("mlrt-table-controls-open");
      const handles = wrapper.querySelectorAll(".mlrt-table-row-handle");
      handles[2].click();
      const items = [...wrapper.querySelectorAll(".mlrt-table-structure-menu-item")];
      const item = items.find((entry) => entry.textContent === "Delete row");
      if (!item) {
        return JSON.stringify({ ok: false, reason: "item not found" });
      }
      item.click();
      return JSON.stringify({ ok: true, handles: handles.length });
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

  // 8. Append a column with the right-edge "+" button, then delete it.
  await evaluateJson(
    live,
    liveExpression(`
      const wrapper = root.querySelector(".mlrt-table-widget");
      wrapper.classList.add("mlrt-table-controls-open");
      wrapper.querySelector(".mlrt-table-append-column").click();
      return JSON.stringify({ ok: true });
    `),
  );
  await sleep(400);
  const afterAppendColumn = await docLines();
  expectOk("APPEND COLUMN SOURCE", {
    ok: afterAppendColumn.lines[headerLineIndex] === "| Key | Value |  |",
    header: afterAppendColumn.lines[headerLineIndex],
  });
  await evaluateJson(
    live,
    liveExpression(`
      const wrapper = root.querySelector(".mlrt-table-widget");
      wrapper.classList.add("mlrt-table-controls-open");
      const handles = wrapper.querySelectorAll(".mlrt-table-col-handle");
      handles[handles.length - 1].click();
      const items = [...wrapper.querySelectorAll(".mlrt-table-structure-menu-item")];
      items.find((entry) => entry.textContent === "Delete column").click();
      return JSON.stringify({ ok: true });
    `),
  );
  await sleep(400);

  // 9. Header row handle offers only "Insert row below"; use it.
  const headerRowMenu = await evaluateJson(
    live,
    liveExpression(`
      const wrapper = root.querySelector(".mlrt-table-widget");
      wrapper.classList.add("mlrt-table-controls-open");
      wrapper.querySelector(".mlrt-table-row-handle").click();
      const items = [...wrapper.querySelectorAll(".mlrt-table-structure-menu-item")];
      const labels = items.map((item) => item.textContent);
      const item = items.find((entry) => entry.textContent === "Insert row below");
      if (!item) {
        return JSON.stringify({ ok: false, labels });
      }
      item.click();
      return JSON.stringify({ ok: labels.length === 1, labels });
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

  // 10. The new row's first cell is focused for immediate typing.
  const focusState = await evaluateJson(
    live,
    liveExpression(`
      const active = root.activeElement;
      return JSON.stringify({
        ok:
          Boolean(active) &&
          active.classList.contains("mlrt-table-cell") &&
          active.dataset.rowKind === "body" &&
          active.dataset.rowIndex === "0" &&
          active.dataset.column === "0",
        rowKind: active?.dataset?.rowKind,
        rowIndex: active?.dataset?.rowIndex,
        column: active?.dataset?.column,
      });
    `),
  );
  expectOk("FOCUS AFTER INSERT", focusState);

  // Clean up the inserted row so the doc ends as it started.
  await evaluateJson(
    live,
    liveExpression(`
      const wrapper = root.querySelector(".mlrt-table-widget");
      wrapper.classList.add("mlrt-table-controls-open");
      wrapper.querySelectorAll(".mlrt-table-row-handle")[1].click();
      const items = [...wrapper.querySelectorAll(".mlrt-table-structure-menu-item")];
      items.find((entry) => entry.textContent === "Delete row").click();
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
