#!/usr/bin/env node
// Launch an isolated VS Code Extension Development Host, open TestTable.md,
// capture stock Monaco geometry, toggle the Markdown Live Editor, then capture
// live CodeMirror/table geometry in the same workbench window.
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
const userDataDir = mkdtempSync(path.join(os.tmpdir(), "mlrt-edh-"));
const qaDir = path.join(repoRoot, "qa");
const pixelTolerance = 0.5;
await mkdir(qaDir, { recursive: true });
const fixturePath = path.join(userDataDir, "TestTable.md");
await writeFile(
  fixturePath,
  [
    "Text up here at. ",
    "",
    "More text. ",
    "",
    "- list",
    "  - nested bullet",
    "  - 2",
    "- continued",
    "",
    "",
    "11",
    "",
    "| Key | Value |",
    "|---|---|",
    "| Long | This is a very long cell intended to test wrapping behavior in table renderers. It includes **bold text**, `inline code`, a [link](https://example.com), and a long token: abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz. Test edit. Another. This is another edit. |",
    "",
    "17",
    "",
    "",
    "20",
    "",
    "| Key | Value |  |",
    "|---|---| --- |",
    "|  |  |  |",
    "| Short | short cell. This is resizing the cell now |  |",
    "|  |  |  |",
    "|  |  | test |",
    "",
    "26",
    "",
    "more test here",
    "",
  ].join("\n"),
  "utf8",
);
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
    fixturePath,
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
  const eventHandlers = [];
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      for (const h of eventHandlers) h(msg);
    }
  });
  const ready = new Promise((r) =>
    ws.addEventListener("open", r, { once: true }),
  );
  const send = (method, params = {}) =>
    new Promise((res) => {
      const mid = ++id;
      pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return { ws, ready, send, onEvent: (h) => eventHandlers.push(h) };
}

try {
  // Wait for the workbench renderer to come up.
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
        lastTargets.map((target) => ({
          type: target.type,
          url: target.url,
        })),
      )}`,
    );
  }

  const wb = connect(workbench.webSocketDebuggerUrl);
  await wb.ready;
  await wb.send("Runtime.enable");
  await wb.send("Page.enable");

  // Give the editor time to open the file, capture stock geometry, then trigger
  // the toggle command.
  await sleep(4000);
  await captureWorkbenchScreenshot(wb, path.join(qaDir, "edh-stock.png"));
  const stockMetrics = await evaluateJson(wb, stockMetricsExpression());
  console.log("STOCK METRICS:", stockMetrics);

  // Trigger the command palette and run the toggle command by simulating input.
  // Use CDP Input to open Command Palette (Cmd+Shift+P) then type the command.
  const key = async (opts) => wb.send("Input.dispatchKeyEvent", opts);
  const typeText = async (text) => wb.send("Input.insertText", { text });

  // Open command palette: Meta+Shift+P
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
  await typeText("Toggle Markdown Live Editor");
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

  await captureWorkbenchScreenshot(wb, path.join(qaDir, "edh-live.png"));

  // Verify a webview iframe exists (live editor active) and measure the table
  // by locating the webview target among CDP targets.
  const afterTargets = await listTargets();
  const webviewTargets = afterTargets.filter(
    (t) =>
      t.type === "iframe" ||
      /vscode-webview|index-no-csp|fake\.html/.test(t.url || ""),
  );
  console.log(
    "Webview-ish targets:",
    webviewTargets.map((t) => t.url).slice(0, 10),
  );

  let liveMetrics = null;
  let liveClient = null;
  for (const wv of webviewTargets) {
    try {
      const c = connect(wv.webSocketDebuggerUrl);
      await c.ready;
      await c.send("Runtime.enable");
      const metrics = await evaluateJson(c, liveMetricsExpression());
      if (metrics) {
        liveMetrics = metrics;
        liveClient = c;
        console.log("LIVE METRICS:", liveMetrics);
        break;
      }
      c.ws.close();
    } catch {}
  }

  assertPixelParity(stockMetrics, liveMetrics);
  if (!liveClient) {
    throw new Error("Enter exit check failed: live webview client was not found.");
  }
  const gutterAlignment = await evaluateJson(
    liveClient,
    tableGutterAlignmentExpression(),
  );
  assertTableGutterAlignment(gutterAlignment);
  console.log("TABLE GUTTER ALIGNMENT CHECK:", gutterAlignment);
  const responsiveScroll = await evaluateJson(
    liveClient,
    tableResponsiveScrollExpression(),
  );
  assertTableResponsiveScroll(responsiveScroll);
  console.log("TABLE RESPONSIVE SCROLL CHECK:", responsiveScroll);
  const responsivePreview = await evaluateJson(
    liveClient,
    setTableResponsiveScrollPreviewExpression(),
  );
  if (!responsivePreview?.ok) {
    throw new Error(
      `Table responsive scroll preview setup failed: ${JSON.stringify(responsivePreview)}`,
    );
  }
  await captureWorkbenchScreenshot(
    wb,
    path.join(qaDir, "edh-table-responsive-scroll.png"),
  );
  await evaluateJson(liveClient, restoreTableResponsiveScrollPreviewExpression());
  const liveResize = await evaluateJson(liveClient, tableLiveResizeExpression());
  assertTableLiveResize(liveResize);
  console.log("TABLE LIVE RESIZE CHECK:", liveResize);
  const gutterStability = await evaluateJson(
    liveClient,
    tableGutterStabilityExpression(),
  );
  assertTableGutterStability(gutterStability);
  console.log("TABLE GUTTER STABILITY CHECK:", gutterStability);
  const tableRenderStability = await evaluateJson(
    liveClient,
    tableRenderStabilityExpression(),
  );
  assertTableRenderStability(tableRenderStability);
  console.log("TABLE RENDER STABILITY CHECK:", tableRenderStability);
  const staleAckStability = await evaluateJson(
    liveClient,
    tableStaleWebviewAckStabilityExpression(),
  );
  assertTableStaleWebviewAckStability(staleAckStability);
  console.log("TABLE STALE WEBVIEW ACK STABILITY CHECK:", staleAckStability);
  const hostSyncStability = await evaluateJson(
    liveClient,
    tableHostSyncStabilityExpression(),
  );
  assertTableHostSyncStability(hostSyncStability);
  console.log("TABLE HOST SYNC STABILITY CHECK:", hostSyncStability);
  const sequentialCellToEditorTyping = await evaluateJson(
    liveClient,
    tableSequentialCellToEditorTypingExpression(),
  );
  assertTableSequentialCellToEditorTyping(sequentialCellToEditorTyping);
  console.log(
    "TABLE SEQUENTIAL CELL TO EDITOR TYPING CHECK:",
    sequentialCellToEditorTyping,
  );
  const whitespaceDeletion = await evaluateJson(
    liveClient,
    tableWhitespaceDeletionExpression(),
  );
  assertTableWhitespaceDeletion(whitespaceDeletion);
  console.log("TABLE WHITESPACE DELETION CHECK:", whitespaceDeletion);
  const editShortcuts = await evaluateJson(
    liveClient,
    tableCellEditShortcutsExpression(),
  );
  assertTableCellEditShortcuts(editShortcuts);
  console.log("TABLE CELL EDIT SHORTCUTS CHECK:", editShortcuts);
  const clipboardSelection = await evaluateJson(
    liveClient,
    tableClipboardSelectionExpression(),
  );
  assertTableClipboardSelection(clipboardSelection);
  console.log("TABLE CLIPBOARD SELECTION CHECK:", clipboardSelection);
  await captureWorkbenchScreenshot(
    wb,
    path.join(qaDir, "edh-table-selection.png"),
  );
  const trustedCopySetup = await evaluateJson(
    liveClient,
    tableTrustedCopySetupExpression(),
  );
  assertTableTrustedCopySetup(trustedCopySetup);
  await liveClient.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    modifiers: 4,
    key: "c",
    code: "KeyC",
    windowsVirtualKeyCode: 67,
  });
  await liveClient.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: 4,
    key: "c",
    code: "KeyC",
    windowsVirtualKeyCode: 67,
  });
  await sleep(150);
  const trustedCopy = await evaluateJson(
    liveClient,
    tableTrustedCopyResultExpression(),
  );
  assertTableTrustedCopy(trustedCopy);
  console.log("TABLE TRUSTED COPY CHECK:", trustedCopy);
  const clipboardMenu = await evaluateJson(
    liveClient,
    tableClipboardMenuExpression(),
  );
  assertTableClipboardMenu(clipboardMenu);
  console.log("TABLE CLIPBOARD MENU CHECK:", clipboardMenu);
  await captureWorkbenchScreenshot(
    wb,
    path.join(qaDir, "edh-table-clipboard-menu.png"),
  );
  const crossBoundarySetup = await evaluateJson(
    liveClient,
    tableCrossBoundaryDragSetupExpression(),
  );
  assertTableCrossBoundaryDragSetup(crossBoundarySetup);
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: crossBoundarySetup.startX,
    y: crossBoundarySetup.startY,
    button: "left",
    clickCount: 1,
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: crossBoundarySetup.plainX,
    y: crossBoundarySetup.plainY,
    button: "left",
  });
  await sleep(80);
  const crossBoundaryIntermediate = await evaluateJson(
    liveClient,
    tableCrossBoundaryDragResultExpression(),
  );
  assertTableCrossBoundaryDrag(crossBoundaryIntermediate, 1);
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: crossBoundarySetup.endX,
    y: crossBoundarySetup.endY,
    button: "left",
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: crossBoundarySetup.endX,
    y: crossBoundarySetup.endY,
    button: "left",
    clickCount: 1,
  });
  await sleep(150);
  const crossBoundaryDrag = await evaluateJson(
    liveClient,
    tableCrossBoundaryDragResultExpression(),
  );
  assertTableCrossBoundaryDrag(crossBoundaryDrag, 2);
  console.log("TABLE CROSS-BOUNDARY DRAG CHECK:", crossBoundaryDrag);
  await captureWorkbenchScreenshot(
    wb,
    path.join(qaDir, "edh-table-document-drag.png"),
  );
  await evaluateJson(liveClient, clearCrossBoundaryDragExpression());
  const documentToTableSetup = await evaluateJson(
    liveClient,
    documentToTableDragSetupExpression(),
  );
  assertDocumentToTableDragSetup(documentToTableSetup);
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: documentToTableSetup.startX,
    y: documentToTableSetup.startY,
    button: "left",
    clickCount: 1,
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: documentToTableSetup.firstX,
    y: documentToTableSetup.firstY,
    button: "left",
  });
  await sleep(80);
  const firstMixedCell = await evaluateJson(
    liveClient,
    documentToTableDragResultExpression(),
  );
  assertDocumentToTableDragResult(firstMixedCell, 1);
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: documentToTableSetup.secondX,
    y: documentToTableSetup.secondY,
    button: "left",
  });
  await sleep(80);
  const secondMixedCell = await evaluateJson(
    liveClient,
    documentToTableDragResultExpression(),
  );
  assertDocumentToTableDragResult(secondMixedCell, 2);
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: documentToTableSetup.finalX,
    y: documentToTableSetup.finalY,
    button: "left",
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: documentToTableSetup.finalX,
    y: documentToTableSetup.finalY,
    button: "left",
    clickCount: 1,
  });
  await sleep(120);
  const finalMixedCells = await evaluateJson(
    liveClient,
    documentToTableDragResultExpression(),
  );
  assertDocumentToTableDragResult(finalMixedCells, 8);
  console.log("DOCUMENT-TO-TABLE CELL DRAG CHECK:", finalMixedCells);
  await captureWorkbenchScreenshot(
    wb,
    path.join(qaDir, "edh-document-to-table-cells.png"),
  );
  const mixedDelete = await evaluateJson(
    liveClient,
    documentToTableDeleteExpression(),
  );
  assertDocumentToTableDelete(mixedDelete);
  console.log("MIXED DOCUMENT/TABLE DELETE CHECK:", mixedDelete);
  const documentClipboard = await evaluateJson(
    liveClient,
    documentClipboardExpression(),
  );
  assertDocumentClipboard(documentClipboard);
  console.log("DOCUMENT CLIPBOARD CHECK:", documentClipboard);
  const trustedUndoSetup = await evaluateJson(
    liveClient,
    tableTrustedUndoSetupExpression(),
  );
  assertTableTrustedUndoSetup(trustedUndoSetup);
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: trustedUndoSetup.clickX,
    y: trustedUndoSetup.clickY,
    button: "left",
    clickCount: 1,
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: trustedUndoSetup.clickX,
    y: trustedUndoSetup.clickY,
    button: "left",
    clickCount: 1,
  });
  await sleep(100);
  const trustedDelete = await evaluateJson(
    liveClient,
    tableTrustedDeleteSetupExpression(),
  );
  assertTableTrustedDeleteSetup(trustedDelete);
  await liveClient.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    modifiers: 4,
    key: "z",
    code: "KeyZ",
    windowsVirtualKeyCode: 90,
  });
  await liveClient.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: 4,
    key: "z",
    code: "KeyZ",
    windowsVirtualKeyCode: 90,
  });
  await sleep(150);
  const trustedUndo = await evaluateJson(
    liveClient,
    tableTrustedUndoResultExpression(),
  );
  assertTableTrustedUndo(trustedUndo);
  console.log("TABLE TRUSTED UNDO CHECK:", trustedUndo);
  const hostUndoFocus = await evaluateJson(
    liveClient,
    tableHostUndoFocusExpression(),
  );
  assertTableHostUndoFocus(hostUndoFocus);
  console.log("TABLE HOST UNDO FOCUS CHECK:", hostUndoFocus);
  const hostCharacterUndoFocus = await evaluateJson(
    liveClient,
    tableHostCharacterUndoFocusExpression(),
  );
  assertTableHostCharacterUndoFocus(hostCharacterUndoFocus);
  console.log("TABLE HOST CHARACTER UNDO FOCUS CHECK:", hostCharacterUndoFocus);
  const mixedUndoFocus = await evaluateJson(
    liveClient,
    tableThenEditorUndoFocusExpression(),
  );
  assertTableThenEditorUndoFocus(mixedUndoFocus);
  console.log("TABLE THEN EDITOR UNDO FOCUS CHECK:", mixedUndoFocus);
  const globalUndoBridge = await evaluateJson(
    liveClient,
    tableGlobalUndoBridgeExpression(),
  );
  assertTableGlobalUndoBridge(globalUndoBridge);
  console.log("TABLE GLOBAL UNDO BRIDGE CHECK:", globalUndoBridge);
  const outsideTypingFocus = await evaluateJson(
    liveClient,
    tableOutsideTypingFocusExpression(),
  );
  assertTableOutsideTypingFocus(outsideTypingFocus);
  console.log("TABLE OUTSIDE TYPING FOCUS CHECK:", outsideTypingFocus);
  const focusState = await evaluateJson(
    liveClient,
    tableCellFocusExpression(),
  );
  assertTableCellFocus(focusState);
  console.log("TABLE CELL FOCUS CHECK:", focusState);
  await captureWorkbenchScreenshot(
    wb,
    path.join(qaDir, "edh-table-cell-focus.png"),
  );
  const sourceProtection = await evaluateJson(
    liveClient,
    tableSourceProtectionExpression(),
  );
  assertTableSourceProtection(sourceProtection);
  console.log("TABLE SOURCE PROTECTION CHECK:", sourceProtection);
  const enterExit = await evaluateJson(liveClient, tableEnterExitExpression());
  assertTableEnterExit(enterExit);
  console.log("TABLE ENTER EXIT CHECK:", enterExit);
  const arrowNavigation = await evaluateJson(
    liveClient,
    tableArrowNavigationExpression(),
  );
  assertTableArrowNavigation(arrowNavigation);
  console.log("TABLE ARROW NAVIGATION CHECK:", arrowNavigation);
  const selectionGeometry = await evaluateJson(
    liveClient,
    tableSelectionGeometryExpression(),
  );
  assertTableSelectionGeometry(selectionGeometry);
  console.log("TABLE SELECTION GEOMETRY CHECK:", selectionGeometry);
  await captureWorkbenchScreenshot(
    wb,
    path.join(qaDir, "edh-table-selection-geometry.png"),
  );
  await captureWorkbenchScreenshot(
    wb,
    path.join(qaDir, "edh-enter-after-table.png"),
  );
  liveClient.ws.close();

  await key({
    type: "keyDown",
    modifiers: 4 | 2,
    key: "M",
    code: "KeyM",
    windowsVirtualKeyCode: 77,
  });
  await key({
    type: "keyUp",
    modifiers: 4 | 2,
    key: "M",
    code: "KeyM",
    windowsVirtualKeyCode: 77,
  });
  await sleep(2500);
  const shortcutSourceMetrics = await evaluateJson(wb, stockMetricsExpression());
  if (!shortcutSourceMetrics?.hasMonaco) {
    throw new Error(
      "Shortcut toggle check failed: Cmd+Ctrl+M did not return to the Monaco source editor.",
    );
  }
  console.log("SHORTCUT TOGGLE CHECK:", {
    hasMonaco: shortcutSourceMetrics.hasMonaco,
  });
  wb.ws.close();
} finally {
  await sleep(500);
  child.kill("SIGTERM");
}

async function captureWorkbenchScreenshot(client, outputPath) {
  const shot = await client.send("Page.captureScreenshot", { format: "png" });
  if (shot.result?.data) {
    await writeFile(outputPath, Buffer.from(shot.result.data, "base64"));
    console.log(`Saved ${path.relative(repoRoot, outputPath)}`);
  }
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
    throw new Error(`Expected JSON string from evaluation, got ${JSON.stringify(value)}`);
  }
  return value ? JSON.parse(value) : null;
}

function stockMetricsExpression() {
  return `(() => {
    const box = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    const textBox = (element) => {
      if (!element) return null;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let textNode = null;
      while ((textNode = walker.nextNode())) {
        if (textNode.nodeValue && textNode.nodeValue.trim()) break;
      }
      if (!textNode) return null;
      const range = document.createRange();
      range.selectNodeContents(textNode);
      const rect = range.getBoundingClientRect();
      range.detach();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    const editor = document.querySelector('.monaco-editor');
    const firstLine = editor?.querySelector('.view-lines .view-line');
    const firstLineNumber = editor?.querySelector('.margin-view-overlays .line-numbers');
    const margin = editor?.querySelector('.margin');
    const content = editor?.querySelector('.monaco-scrollable-element.editor-scrollable');
    const activeLine = editor?.querySelector('.view-overlays .current-line');
    const activeLineMargin = editor?.querySelector('.margin-view-overlays .current-line-margin');
    const firstLineStyle = firstLine ? getComputedStyle(firstLine) : null;
    return JSON.stringify({
      hasMonaco: !!editor,
      editor: box(editor),
      margin: box(margin),
      content: box(content),
      firstLine: box(firstLine),
      firstLineText: textBox(firstLine),
      firstLineNumber: box(firstLineNumber),
      firstLineNumberText: textBox(firstLineNumber),
      activeLine: box(activeLine),
      activeLineMargin: box(activeLineMargin),
      activeLineMarginBackground: activeLineMargin ? getComputedStyle(activeLineMargin).backgroundColor : null,
      firstLineFontFamily: firstLineStyle?.fontFamily ?? null,
      firstLineFontSize: firstLineStyle?.fontSize ?? null,
      firstLineLineHeight: firstLineStyle?.lineHeight ?? null,
    });
  })()`;
}

function liveMetricsExpression() {
  return `(() => {
    const box = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    const textBox = (root, element) => {
      if (!element) return null;
      const walker = root.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let textNode = null;
      while ((textNode = walker.nextNode())) {
        if (textNode.nodeValue && textNode.nodeValue.trim()) break;
      }
      if (!textNode) return null;
      const range = root.createRange();
      range.selectNodeContents(textNode);
      const rect = range.getBoundingClientRect();
      range.detach();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try {
        return frame.contentDocument;
      } catch {
        return null;
      }
    }).filter(Boolean)];
    for (const root of roots) {
      const scroller = root.querySelector('.cm-scroller');
      const table = root.querySelector('.mlrt-table');
      if (!scroller || !table) continue;
      const gutter = root.querySelector('.cm-gutters');
      const lineNumber = root.querySelector('.cm-lineNumbers .cm-gutterElement:not([style*="visibility: hidden"])');
      const line = root.querySelector('.cm-line');
      const activeLine = root.querySelector('.cm-activeLine');
      const activeLineGutter = root.querySelector('.cm-activeLineGutter');
      const tableScroll = root.querySelector('.mlrt-table-scroll');
      const tableScrollbar = root.querySelector('.mlrt-table-scrollbar');
      const sourceLine = root.querySelector('.mlrt-table-source-line');
      const tableCell = root.querySelector('.mlrt-table-cell');
      const lineStyle = line ? getComputedStyle(line) : null;
      return JSON.stringify({
        url: location.href.slice(0, 80),
        scrollerClientWidth: scroller.clientWidth,
        scrollerScrollWidth: scroller.scrollWidth,
        overflow: scroller.scrollWidth > scroller.clientWidth + 1,
        scroller: box(scroller),
        gutter: box(gutter),
        lineNumber: box(lineNumber),
        lineNumberText: textBox(root, lineNumber),
        line: box(line),
        lineText: textBox(root, line),
        activeLine: box(activeLine),
        activeLineGutter: box(activeLineGutter),
        activeLineGutterBackground: activeLineGutter ? getComputedStyle(activeLineGutter).backgroundColor : null,
        tableScroll: box(tableScroll),
        tableScrollClientWidth: tableScroll?.clientWidth ?? 0,
        tableScrollScrollWidth: tableScroll?.scrollWidth ?? 0,
        tableScrollOverflow: tableScroll ? tableScroll.scrollWidth > tableScroll.clientWidth + 1 : false,
        tableScrollLeft: tableScroll?.scrollLeft ?? 0,
        tableScrollbar: box(tableScrollbar),
        tableScrollbarHidden: tableScrollbar?.hidden ?? null,
        table: box(table),
        sourceLine: box(sourceLine),
        sourceLineText: textBox(root, sourceLine),
        tableCell: box(tableCell),
        tableCellText: textBox(root, tableCell),
        tableSourceLineNumber: Number(sourceLine?.getAttribute('data-source-line') ?? 0),
        lineFontFamily: lineStyle?.fontFamily ?? null,
        lineFontSize: lineStyle?.fontSize ?? null,
        lineLineHeight: lineStyle?.lineHeight ?? null,
        cssLiveGutterWidth: getComputedStyle(scroller).getPropertyValue('--mlrt-live-gutter-width').trim(),
      });
    }
    return null;
  })()`;
}

function tableGutterAlignmentExpression() {
  return `(() => {
    const box = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        width: rect.width,
      };
    };
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
    const scroller = root.querySelector('.cm-scroller');
    const table = root.querySelector('.mlrt-table');
    const tableSourceLines = Array.from(root.querySelectorAll('.mlrt-table-source-line'));
    const nativeRows = Array.from(root.querySelectorAll('.cm-lineNumbers .cm-gutterElement')).map((element) => {
      const rect = element.getBoundingClientRect();
      const style = root.defaultView.getComputedStyle(element);
      return {
        text: element.textContent.trim(),
        className: element.className,
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
        visible:
          rect.height > 0.5 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          (!scroller || (rect.bottom > scroller.getBoundingClientRect().top && rect.top < scroller.getBoundingClientRect().bottom)),
        inTableBand:
          Boolean(table) &&
          rect.height > 0.5 &&
          rect.bottom > table.getBoundingClientRect().top + 0.5 &&
          rect.top < table.getBoundingClientRect().bottom - 0.5,
      };
    });
    const visibleTextRows = nativeRows
      .filter((row) => row.visible && row.text)
      .sort((a, b) => a.top - b.top);
    const numericRows = visibleTextRows
      .map((row) => Number(row.text))
      .filter((value) => Number.isFinite(value));
    const hiddenNativeRows = nativeRows.filter((row) =>
      row.className.includes('mlrt-hidden-table-source-gutter')
    );
    const hiddenContentLines = Array.from(root.querySelectorAll('.cm-line.mlrt-hidden-table-source-line')).map((element) => box(element));
    return JSON.stringify({
      ok: true,
      table: box(table),
      nativeRowsInTableBand: nativeRows.filter((row) => row.visible && row.inTableBand),
      visibleNativeTexts: visibleTextRows.map((row) => row.text),
      nativeNumbersStrictlyIncrease: numericRows.every((value, index) =>
        index === 0 || value > numericRows[index - 1]
      ),
      hiddenNativeRowCount: hiddenNativeRows.length,
      hiddenNativeRowsHaveZeroHeight: hiddenNativeRows.every((row) => row.height <= 0.5),
      hiddenContentLineCount: hiddenContentLines.length,
      hiddenContentLinesHaveZeroHeight: hiddenContentLines.every((row) => !row || row.height <= 0.5),
      tableSourceLineCount: tableSourceLines.length,
      tableSourceLineTexts: tableSourceLines.map((line) => line.textContent.trim()),
    });
  })()`;
}

function tableGutterStabilityExpression() {
  return `(async () => {
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
    const waitForRender = () => new Promise((done) => {
      root.defaultView.requestAnimationFrame(() => {
        root.defaultView.requestAnimationFrame(done);
      });
    });
    const waitForHostEcho = () => new Promise((done) => {
      root.defaultView.setTimeout(done, 250);
    });
    const visibleNativeRows = () => Array.from(root.querySelectorAll('.cm-lineNumbers .cm-gutterElement')).filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = root.defaultView.getComputedStyle(element);
      return rect.height > 0.5 && style.visibility !== 'hidden' && style.display !== 'none';
    });
    const nativeRowsInTableBand = () => {
      const table = root.querySelector('.mlrt-table');
      if (!table) return [];
      const tableRect = table.getBoundingClientRect();
      return visibleNativeRows().filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom > tableRect.top + 0.5 && rect.top < tableRect.bottom - 0.5;
      }).map((element) => element.textContent.trim());
    };
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    const cell = root.querySelector('.mlrt-table-cell[data-row-kind="body"][data-column="1"]');
    const gutter = root.querySelector('.cm-lineNumbers');
    if (!view || !cell || !gutter) {
      return JSON.stringify({
        ok: false,
        reason: 'missing gutter stability targets',
        hasView: Boolean(view),
        hasCell: Boolean(cell),
        hasGutter: Boolean(gutter),
      });
    }

    const beforeDoc = view.state.doc.toString();
    cell.focus();
    const range = root.createRange();
    range.selectNodeContents(cell);
    range.collapse(false);
    const selection = root.defaultView.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    await waitForRender();
    const beforeRows = visibleNativeRows();
    const beforeTexts = beforeRows.map((row) => row.textContent.trim());
    let childListMutations = 0;
    let visibleAttributeMutations = 0;
    const observer = new root.defaultView.MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          childListMutations++;
        }
        if (
          mutation.type === 'attributes' &&
          mutation.target instanceof root.defaultView.HTMLElement
        ) {
          const rect = mutation.target.getBoundingClientRect();
          if (rect.height > 0.5) {
            visibleAttributeMutations++;
          }
        }
      }
    });
    observer.observe(gutter, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    cell.dispatchEvent(new root.defaultView.InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: 'x',
    }));
    await waitForRender();
    observer.disconnect();
    const afterRows = visibleNativeRows();
    const afterTexts = afterRows.map((row) => row.textContent.trim());
    const preservedVisibleRows =
      beforeRows.length === afterRows.length &&
      beforeRows.every((row, index) => row === afterRows[index]);
    const afterDoc = view.state.doc.toString();
    await waitForHostEcho();
    root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
      data: {
        type: 'setDocument',
        text: beforeDoc,
        revision: 999020,
        debug: false,
      },
    }));
    await waitForRender();
    return JSON.stringify({
      ok: true,
      docChanged: afterDoc !== beforeDoc,
      restoredDoc: view.state.doc.toString() === beforeDoc,
      beforeTexts,
      afterTexts,
      preservedVisibleRows,
      childListMutations,
      visibleAttributeMutations,
      nativeRowsInTableBandAfter: nativeRowsInTableBand(),
    });
  })()`;
}

function tableRenderStabilityExpression() {
  return `(async () => {
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
    const waitForRender = () => new Promise((done) => {
      root.defaultView.requestAnimationFrame(() => {
        root.defaultView.requestAnimationFrame(done);
      });
    });
    const waitForHostEcho = () => new Promise((done) => {
      root.defaultView.setTimeout(done, 250);
    });
    const box = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      };
    };
    const readCell = () => root.querySelector('.mlrt-table-cell[data-row-kind="body"][data-column="1"]');
    const setCaretAtEnd = (targetCell) => {
      const range = root.createRange();
      range.selectNodeContents(targetCell);
      range.collapse(false);
      const selection = root.defaultView.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    const widget = root.querySelector('.mlrt-table-widget');
    const table = root.querySelector('.mlrt-table');
    const tableSourceLine = root.querySelector('.mlrt-table-source-line');
    const scroller = root.querySelector('.cm-scroller');
    const activeLine = root.querySelector('.cm-activeLine');
    const activeLineGutter = root.querySelector('.cm-activeLineGutter');
    const cursorLayer = root.querySelector('.cm-cursorLayer');
    const selectionLayer = root.querySelector('.cm-selectionLayer');
    let cell = readCell();
    if (!view || !widget || !table || !cell || !tableSourceLine || !scroller) {
      return JSON.stringify({
        ok: false,
        reason: 'missing render stability targets',
        hasView: Boolean(view),
        hasWidget: Boolean(widget),
        hasTable: Boolean(table),
        hasCell: Boolean(cell),
        hasTableSourceLine: Boolean(tableSourceLine),
        hasScroller: Boolean(scroller),
      });
    }

    const beforeDoc = view.state.doc.toString();
    cell.focus();
    setCaretAtEnd(cell);
    await waitForRender();
    const beforeEditorSelection = view.state.selection.toJSON();
    const beforeScrollTop = scroller.scrollTop;
    let widgetChildListMutations = 0;
    let cellChildListMutations = 0;
    let cellCharacterDataMutations = 0;
    let tableSourceLineChildListMutations = 0;
    let activeLineMutations = 0;
    let activeLineGutterMutations = 0;
    let cursorLayerChildListMutations = 0;
    let selectionLayerChildListMutations = 0;
    let scrollerScrollEvents = 0;
    const widgetObserver = new root.defaultView.MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          widgetChildListMutations++;
        }
      }
    });
    const cellObserver = new root.defaultView.MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          cellChildListMutations++;
        }
        if (mutation.type === 'characterData') {
          cellCharacterDataMutations++;
        }
      }
    });
    const tableSourceLineObserver = new root.defaultView.MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          tableSourceLineChildListMutations++;
        }
      }
    });
    const activeLineObserver = new root.defaultView.MutationObserver((mutations) => {
      activeLineMutations += mutations.length;
    });
    const activeLineGutterObserver = new root.defaultView.MutationObserver((mutations) => {
      activeLineGutterMutations += mutations.length;
    });
    const cursorLayerObserver = new root.defaultView.MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          cursorLayerChildListMutations++;
        }
      }
    });
    const selectionLayerObserver = new root.defaultView.MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          selectionLayerChildListMutations++;
        }
      }
    });
    const onScroll = () => {
      scrollerScrollEvents++;
    };
    widgetObserver.observe(widget, { childList: true, subtree: true });
    cellObserver.observe(cell, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    tableSourceLineObserver.observe(tableSourceLine, {
      childList: true,
      subtree: true,
    });
    activeLineObserver.observe(activeLine ?? root.body, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    activeLineGutterObserver.observe(activeLineGutter ?? root.body, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    if (cursorLayer) {
      cursorLayerObserver.observe(cursorLayer, { childList: true, subtree: true });
    }
    if (selectionLayer) {
      selectionLayerObserver.observe(selectionLayer, { childList: true, subtree: true });
    }
    scroller.addEventListener('scroll', onScroll);
    const frames = [];
    const beforeCellText = cell.textContent;
    for (const character of ['x', 'y', 'z']) {
      cell.dispatchEvent(new root.defaultView.InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: character,
      }));
      frames.push({
        phase: 'sync-' + character,
        sameWidget: root.querySelector('.mlrt-table-widget') === widget,
        sameTable: root.querySelector('.mlrt-table') === table,
        sameCell: readCell() === cell,
        sameTableSourceLine: root.querySelector('.mlrt-table-source-line') === tableSourceLine,
        activeIsCell: root.activeElement === cell,
        cellTextLength: cell.textContent.length,
        tableBox: box(table),
        cellBox: box(cell),
        sourceLineBox: box(tableSourceLine),
        editorSelection: view.state.selection.toJSON(),
        scrollTop: scroller.scrollTop,
      });
      await waitForRender();
      frames.push({
        phase: 'raf-' + character,
        sameWidget: root.querySelector('.mlrt-table-widget') === widget,
        sameTable: root.querySelector('.mlrt-table') === table,
        sameCell: readCell() === cell,
        sameTableSourceLine: root.querySelector('.mlrt-table-source-line') === tableSourceLine,
        activeIsCell: root.activeElement === cell,
        cellTextLength: cell.textContent.length,
        tableBox: box(table),
        cellBox: box(cell),
        sourceLineBox: box(tableSourceLine),
        editorSelection: view.state.selection.toJSON(),
        scrollTop: scroller.scrollTop,
      });
    }
    widgetObserver.disconnect();
    cellObserver.disconnect();
    tableSourceLineObserver.disconnect();
    activeLineObserver.disconnect();
    activeLineGutterObserver.disconnect();
    cursorLayerObserver.disconnect();
    selectionLayerObserver.disconnect();
    scroller.removeEventListener('scroll', onScroll);
    const afterDoc = view.state.doc.toString();
    const afterCellText = cell.textContent;
    const afterEditorSelection = view.state.selection.toJSON();
    await waitForHostEcho();
    root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
      data: {
        type: 'setDocument',
        text: beforeDoc,
        revision: 999025,
        debug: false,
      },
    }));
    await waitForRender();
    const blankFrames = frames.filter((frame) =>
      !frame.sameWidget ||
      !frame.sameTable ||
      !frame.sameCell ||
      !frame.sameTableSourceLine ||
      !frame.activeIsCell ||
      frame.cellTextLength === 0 ||
      !frame.tableBox ||
      !frame.cellBox ||
      !frame.sourceLineBox ||
      frame.tableBox.width <= 0 ||
      frame.tableBox.height <= 0 ||
      frame.cellBox.width <= 0 ||
      frame.cellBox.height <= 0 ||
      frame.sourceLineBox.width <= 0 ||
      frame.sourceLineBox.height <= 0
    );
    return JSON.stringify({
      ok: true,
      docChanged: afterDoc !== beforeDoc,
      restoredDoc: view.state.doc.toString() === beforeDoc,
      beforeCellText,
      afterCellText,
      widgetChildListMutations,
      cellChildListMutations,
      cellCharacterDataMutations,
      tableSourceLineChildListMutations,
      activeLineMutations,
      activeLineGutterMutations,
      cursorLayerChildListMutations,
      selectionLayerChildListMutations,
      scrollerScrollEvents,
      beforeEditorSelection,
      afterEditorSelection,
      beforeScrollTop,
      afterScrollTop: scroller.scrollTop,
      blankFrames,
      frames,
    });
  })()`;
}

function tableStaleWebviewAckStabilityExpression() {
  return `(async () => {
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
    const waitForRender = () => new Promise((done) => {
      root.defaultView.requestAnimationFrame(() => {
        root.defaultView.requestAnimationFrame(done);
      });
    });
    const sendHostDocument = (text, revision, source, ackId) => {
      root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
        data: {
          type: 'setDocument',
          text,
          revision,
          debug: false,
          source,
          ackId,
        },
      }));
    };
    const setCaretAtEnd = (targetCell) => {
      const range = root.createRange();
      range.selectNodeContents(targetCell);
      range.collapse(false);
      const selection = root.defaultView.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const readShortCell = () => {
      const cells = Array.from(root.querySelectorAll('.mlrt-table-cell[data-row-kind="body"][data-column="1"]'));
      return cells.find((candidate) => candidate.textContent.includes('short cell')) ?? cells[cells.length - 1] ?? null;
    };
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    const widget = root.querySelector('.mlrt-table-widget');
    const content = root.querySelector('.cm-content');
    const gutter = root.querySelector('.cm-lineNumbers');
    let cell = readShortCell();
    if (!view || !widget || !content || !gutter || !cell) {
      return JSON.stringify({
        ok: false,
        reason: 'missing stale ack stability targets',
        hasView: Boolean(view),
        hasWidget: Boolean(widget),
        hasContent: Boolean(content),
        hasGutter: Boolean(gutter),
        hasCell: Boolean(cell),
      });
    }

    const beforeDoc = view.state.doc.toString();
    cell.focus();
    setCaretAtEnd(cell);
    await waitForRender();

    const docsAfterType = [];
    const rowTextAfterType = [];
    const textsAfterType = [];
    for (const character of ['a', 'b', 'c']) {
      cell = readShortCell();
      cell.focus();
      setCaretAtEnd(cell);
      cell.dispatchEvent(new root.defaultView.InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: character,
      }));
      docsAfterType.push(view.state.doc.toString());
      textsAfterType.push(cell.textContent);
    }
    await waitForRender();

    const finalLocalDoc = view.state.doc.toString();
    const finalLocalText = readShortCell()?.textContent ?? null;
    const changeIds = (root.defaultView.__MLRT_DEBUG_EVENTS__ ?? [])
      .filter((event) => event.event === 'post-change')
      .slice(-3)
      .map((event) => event.details?.changeId);
    let contentChildListMutations = 0;
    let widgetChildListMutations = 0;
    let gutterChildListMutations = 0;
    const contentObserver = new root.defaultView.MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          contentChildListMutations++;
        }
      }
    });
    const widgetObserver = new root.defaultView.MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          widgetChildListMutations++;
        }
      }
    });
    const gutterObserver = new root.defaultView.MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          gutterChildListMutations++;
        }
      }
    });
    contentObserver.observe(content, { childList: true, subtree: true });
    widgetObserver.observe(widget, { childList: true, subtree: true });
    gutterObserver.observe(gutter, { childList: true, subtree: true });

    sendHostDocument(docsAfterType[0], 999301, 'webviewAck', changeIds[0]);
    await waitForRender();
    const afterFirstAckDoc = view.state.doc.toString();
    const afterFirstAckText = readShortCell()?.textContent ?? null;
    sendHostDocument(docsAfterType[1], 999302, 'webviewAck', changeIds[1]);
    await waitForRender();
    const afterSecondAckDoc = view.state.doc.toString();
    const afterSecondAckText = readShortCell()?.textContent ?? null;

    contentObserver.disconnect();
    widgetObserver.disconnect();
    gutterObserver.disconnect();
    const sameWidget = root.querySelector('.mlrt-table-widget') === widget;
    const sameCell = readShortCell() === cell;

    sendHostDocument(beforeDoc, 999303, 'host');
    await waitForRender();

    return JSON.stringify({
      ok: true,
      changeIds,
      textsAfterType,
      finalLocalText,
      finalLocalDocChanged: finalLocalDoc !== beforeDoc,
      afterFirstAckDocMatchesFinal: afterFirstAckDoc === finalLocalDoc,
      afterSecondAckDocMatchesFinal: afterSecondAckDoc === finalLocalDoc,
      afterFirstAckText,
      afterSecondAckText,
      afterSecondAckTextMatchesFinal: afterSecondAckText === finalLocalText,
      sameWidget,
      sameCell,
      contentChildListMutations,
      widgetChildListMutations,
      gutterChildListMutations,
      restoredDoc: view.state.doc.toString() === beforeDoc,
    });
  })()`;
}

function tableHostSyncStabilityExpression() {
  return `(async () => {
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
    const waitForRender = () => new Promise((done) => {
      root.defaultView.requestAnimationFrame(() => {
        root.defaultView.requestAnimationFrame(done);
      });
    });
    const sendHostDocument = (text, revision) => {
      root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
        data: {
          type: 'setDocument',
          text,
          revision,
          debug: false,
          source: 'host',
        },
      }));
    };
    const setCaretAtEnd = (targetCell) => {
      const range = root.createRange();
      range.selectNodeContents(targetCell);
      range.collapse(false);
      const selection = root.defaultView.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const widget = root.querySelector('.mlrt-table-widget');
    const content = root.querySelector('.cm-content');
    const gutter = root.querySelector('.cm-lineNumbers');
    const cell = widget?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-column="1"]');
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    if (!widget || !content || !gutter || !cell || !view) {
      return JSON.stringify({
        ok: false,
        reason: 'missing host sync stability targets',
        hasWidget: Boolean(widget),
        hasContent: Boolean(content),
        hasGutter: Boolean(gutter),
        hasCell: Boolean(cell),
        hasView: Boolean(view),
      });
    }

    const beforeDoc = view.state.doc.toString();
    cell.focus();
    setCaretAtEnd(cell);
    cell.dispatchEvent(new root.defaultView.InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: ' HOSTSYNC',
    }));
    await waitForRender();
    const afterEditDoc = view.state.doc.toString();

    let contentChildListMutations = 0;
    let widgetChildListMutations = 0;
    let gutterChildListMutations = 0;
    const contentObserver = new root.defaultView.MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          contentChildListMutations++;
        }
      }
    });
    const widgetObserver = new root.defaultView.MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          widgetChildListMutations++;
        }
      }
    });
    const gutterObserver = new root.defaultView.MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          gutterChildListMutations++;
        }
      }
    });
    contentObserver.observe(content, { childList: true, subtree: true });
    widgetObserver.observe(widget, { childList: true, subtree: true });
    gutterObserver.observe(gutter, { childList: true, subtree: true });

    sendHostDocument(beforeDoc, 999351);
    await waitForRender();
    contentObserver.disconnect();
    widgetObserver.disconnect();
    gutterObserver.disconnect();

    return JSON.stringify({
      ok: true,
      docChangedBeforeSync: afterEditDoc !== beforeDoc,
      restoredDoc: view.state.doc.toString() === beforeDoc,
      sameWidget: root.querySelector('.mlrt-table-widget') === widget,
      sameCell: root.querySelector('.mlrt-table-cell[data-row-kind="body"][data-column="1"]') === cell,
      contentChildListMutations,
      widgetChildListMutations,
      gutterChildListMutations,
    });
  })()`;
}

function tableSequentialCellToEditorTypingExpression() {
  return `(async () => {
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
    const waitForRender = () => new Promise((done) => {
      root.defaultView.requestAnimationFrame(() => {
        root.defaultView.requestAnimationFrame(done);
      });
    });
    const sendHostDocument = (text, revision) => {
      root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
        data: {
          type: 'setDocument',
          text,
          revision,
          debug: false,
          source: 'host',
        },
      }));
    };
    const setCaretAtEnd = (targetCell) => {
      const range = root.createRange();
      range.selectNodeContents(targetCell);
      range.collapse(false);
      const selection = root.defaultView.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const widgets = Array.from(root.querySelectorAll('.mlrt-table-widget'));
    const widget = widgets[widgets.length - 1];
    const headerKeyCell = widget?.querySelector('.mlrt-table-cell[data-row-kind="header"][data-column="0"]');
    const keyCell = Array.from(widget?.querySelectorAll('.mlrt-table-cell[data-row-kind="body"][data-column="0"]') ?? [])
      .find((cell) => cell.textContent === 'Short');
    const keyRowIndex = keyCell?.dataset.rowIndex;
    const valueCell = keyRowIndex == null
      ? null
      : widget?.querySelector(\`.mlrt-table-cell[data-row-kind="body"][data-row-index="\${keyRowIndex}"][data-column="1"]\`);
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    if (!widget || !headerKeyCell || !keyCell || !valueCell || !view) {
      return JSON.stringify({
        ok: false,
        reason: 'missing sequential cell/editor targets',
        hasWidget: Boolean(widget),
        hasHeaderKeyCell: Boolean(headerKeyCell),
        hasKeyCell: Boolean(keyCell),
        hasValueCell: Boolean(valueCell),
        hasView: Boolean(view),
      });
    }

    const beforeDoc = view.state.doc.toString();
    headerKeyCell.focus();
    setCaretAtEnd(headerKeyCell);
    headerKeyCell.dispatchEvent(new root.defaultView.InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: 'H',
    }));
    await waitForRender();

    keyCell.focus();
    setCaretAtEnd(keyCell);
    keyCell.dispatchEvent(new root.defaultView.InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: 'X',
    }));
    await waitForRender();

    const beforeValueSourceFrom = Number(valueCell.dataset.sourceFrom);
    const beforeValueSourceTo = Number(valueCell.dataset.sourceTo);
    const beforeValueSourceText =
      Number.isFinite(beforeValueSourceFrom) && Number.isFinite(beforeValueSourceTo)
        ? view.state.doc.sliceString(beforeValueSourceFrom, beforeValueSourceTo)
        : null;
    const beforeValueTrailingWhitespace = valueCell.dataset.sourceTrailingWhitespace ?? null;
    const beforeValueRowText = Number.isFinite(beforeValueSourceFrom)
      ? view.state.doc.lineAt(beforeValueSourceFrom).text
      : '';

    valueCell.focus();
    setCaretAtEnd(valueCell);
    valueCell.dispatchEvent(new root.defaultView.InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: ' VALUE',
    }));
    await waitForRender();

    const afterCellDoc = view.state.doc.toString();
    const headerKeyTextAfterCells = headerKeyCell.textContent;
    const keyTextAfterCells = keyCell.textContent;
    const valueTextAfterCells = valueCell.textContent;
    const headerSourceFrom = Number(headerKeyCell.dataset.sourceFrom);
    const headerTextAfterCells = Number.isFinite(headerSourceFrom)
      ? view.state.doc.lineAt(headerSourceFrom).text
      : '';
    const rowSourceFrom = Number(valueCell.dataset.sourceFrom);
    const rowTextAfterCells = Number.isFinite(rowSourceFrom)
      ? view.state.doc.lineAt(rowSourceFrom).text
      : '';
    const outsideMarker = 'outside editor text ';
    const outsideInsertFrom = view.state.doc.toString().indexOf('more test here');
    if (outsideInsertFrom < 0) {
      sendHostDocument(beforeDoc, 999403);
      await waitForRender();
      return JSON.stringify({ ok: false, reason: 'missing outside insertion target' });
    }

    view.focus();
    view.dispatch({ selection: { anchor: outsideInsertFrom } });
    await waitForRender();
    const activeBeforeOutsideType = root.activeElement?.className ?? null;
    const execCommandResult = root.execCommand('insertText', false, outsideMarker);
    await waitForRender();

    const afterOutsideDoc = view.state.doc.toString();
    const activeAfterOutsideType = root.activeElement?.className ?? null;
    const headerKeyTextAfterOutside = headerKeyCell.textContent;
    const keyTextAfterOutside = keyCell.textContent;
    const valueTextAfterOutside = valueCell.textContent;
    const headerTextAfterOutside = Number.isFinite(headerSourceFrom)
      ? view.state.doc.lineAt(headerSourceFrom).text
      : '';
    const rowTextAfterOutside = Number.isFinite(rowSourceFrom)
      ? view.state.doc.lineAt(rowSourceFrom).text
      : '';
    const outsideIndex = afterOutsideDoc.indexOf(outsideMarker);
    const moreIndex = afterOutsideDoc.indexOf('more test here');
    const outsideBeforeNormalText = outsideIndex >= 0 && moreIndex >= 0 && outsideIndex < moreIndex;
    const tableContainsOutsideText =
      (headerKeyTextAfterOutside ?? '').includes(outsideMarker.trim()) ||
      (keyTextAfterOutside ?? '').includes(outsideMarker.trim()) ||
      (valueTextAfterOutside ?? '').includes(outsideMarker.trim()) ||
      headerTextAfterOutside.includes(outsideMarker.trim()) ||
      rowTextAfterOutside.includes(outsideMarker.trim());

    sendHostDocument(beforeDoc, 999404);
    await waitForRender();

    return JSON.stringify({
      ok: true,
      headerKeyTextAfterCells,
      keyTextAfterCells,
      valueTextAfterCells,
      beforeValueSourceFrom,
      beforeValueSourceTo,
      beforeValueSourceText,
      beforeValueTrailingWhitespace,
      beforeValueRowText,
      headerTextAfterCells,
      rowTextAfterCells,
      afterCellDocChanged: afterCellDoc !== beforeDoc,
      execCommandResult,
      activeBeforeOutsideType,
      activeAfterOutsideType,
      outsideBeforeNormalText,
      tableContainsOutsideText,
      headerKeyTextAfterOutside,
      keyTextAfterOutside,
      valueTextAfterOutside,
      headerTextAfterOutside,
      rowTextAfterOutside,
      restoredDoc: view.state.doc.toString() === beforeDoc,
    });
  })()`;
}

function tableResponsiveScrollExpression() {
  return `(() => {
    const box = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try {
        return frame.contentDocument;
      } catch {
        return null;
      }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mlrt-table-scroll'));
    if (!root) {
      return JSON.stringify({ ok: false, reason: 'missing live root' });
    }
    const scroller = root.querySelector('.cm-scroller');
    const tableScroll = root.querySelector('.mlrt-table-scroll');
    const tableScrollbar = root.querySelector('.mlrt-table-scrollbar');
    const sourceLine = root.querySelector('.mlrt-table-source-line');
    const tableCell = root.querySelector('.mlrt-table-cell');
    const normalLine = root.querySelector('.cm-line');
    if (!scroller || !tableScroll || !tableScrollbar || !sourceLine || !tableCell || !normalLine) {
      return JSON.stringify({
        ok: false,
        reason: 'missing responsive scroll targets',
        hasScroller: Boolean(scroller),
        hasTableScroll: Boolean(tableScroll),
        hasTableScrollbar: Boolean(tableScrollbar),
        hasSourceLine: Boolean(sourceLine),
        hasTableCell: Boolean(tableCell),
        hasNormalLine: Boolean(normalLine),
      });
    }

    const previousWidth = tableScroll.style.width;
    const previousMaxWidth = tableScroll.style.maxWidth;
    const previousScrollLeft = tableScroll.scrollLeft;
    tableScroll.style.width = '360px';
    tableScroll.style.maxWidth = '360px';
    tableScroll.scrollLeft = 0;
    tableScroll.dispatchEvent(new root.defaultView.Event('scroll'));
    const sourceLineBeforeScroll = box(sourceLine);
    const tableCellBeforeScroll = box(tableCell);
    const tableScrollBefore = box(tableScroll);
    const normalLineBefore = box(normalLine);
    tableScroll.scrollLeft = Math.max(0, tableScroll.scrollWidth - tableScroll.clientWidth);
    tableScroll.dispatchEvent(new root.defaultView.Event('scroll'));
    const tableScrollbarAfterScroll = box(tableScrollbar);
    const sourceLineAfterScroll = box(sourceLine);
    const tableCellAfterScroll = box(tableCell);
    const result = {
      ok: true,
      scrollerClientWidth: scroller.clientWidth,
      scrollerScrollWidth: scroller.scrollWidth,
      editorOverflow: scroller.scrollWidth > scroller.clientWidth + 1,
      scroller: box(scroller),
      tableScrollClientWidth: tableScroll.clientWidth,
      tableScrollScrollWidth: tableScroll.scrollWidth,
      tableScrollOverflow: tableScroll.scrollWidth > tableScroll.clientWidth + 1,
      tableScrollLeft: tableScroll.scrollLeft,
      tableScroll: tableScrollBefore,
      tableScrollbar: tableScrollbarAfterScroll,
      tableScrollbarHidden: tableScrollbar.hidden,
      sourceLineBeforeScroll,
      sourceLineAfterScroll,
      tableCellBeforeScroll,
      tableCellAfterScroll,
      normalLineBefore,
    };
    tableScroll.style.width = previousWidth;
    tableScroll.style.maxWidth = previousMaxWidth;
    tableScroll.scrollLeft = previousScrollLeft;
    tableScroll.dispatchEvent(new root.defaultView.Event('scroll'));
    return JSON.stringify(result);
  })()`;
}

function setTableResponsiveScrollPreviewExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try {
        return frame.contentDocument;
      } catch {
        return null;
      }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mlrt-table-scroll'));
    const tableScroll = root?.querySelector('.mlrt-table-scroll');
    if (!root || !tableScroll) {
      return JSON.stringify({ ok: false, reason: 'missing table scroll' });
    }
    root.defaultView.__MLRT_RESPONSIVE_SCROLL_PREVIEW__ = {
      width: tableScroll.style.width,
      maxWidth: tableScroll.style.maxWidth,
      scrollLeft: tableScroll.scrollLeft,
    };
    tableScroll.style.width = '360px';
    tableScroll.style.maxWidth = '360px';
    tableScroll.scrollLeft = Math.max(0, tableScroll.scrollWidth - tableScroll.clientWidth);
    tableScroll.dispatchEvent(new root.defaultView.Event('scroll'));
    return JSON.stringify({
      ok: true,
      clientWidth: tableScroll.clientWidth,
      scrollWidth: tableScroll.scrollWidth,
      scrollLeft: tableScroll.scrollLeft,
    });
  })()`;
}

function restoreTableResponsiveScrollPreviewExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try {
        return frame.contentDocument;
      } catch {
        return null;
      }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mlrt-table-scroll'));
    const tableScroll = root?.querySelector('.mlrt-table-scroll');
    const previous = root?.defaultView.__MLRT_RESPONSIVE_SCROLL_PREVIEW__;
    if (!root || !tableScroll || !previous) {
      return JSON.stringify({ ok: false, reason: 'missing responsive scroll preview state' });
    }
    tableScroll.style.width = previous.width;
    tableScroll.style.maxWidth = previous.maxWidth;
    tableScroll.scrollLeft = previous.scrollLeft;
    tableScroll.dispatchEvent(new root.defaultView.Event('scroll'));
    delete root.defaultView.__MLRT_RESPONSIVE_SCROLL_PREVIEW__;
    return JSON.stringify({ ok: true });
  })()`;
}

function tableLiveResizeExpression() {
  return `(async () => {
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
    const waitForRender = () => new Promise((done) => {
      root.defaultView.requestAnimationFrame(() => {
        root.defaultView.requestAnimationFrame(done);
      });
    });
    const waitForHostEcho = () => new Promise((done) => {
      root.defaultView.setTimeout(done, 250);
    });
    const restoreDocument = async (revision) => {
      root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
        data: {
          type: 'setDocument',
          text: beforeDoc,
          revision,
          debug: false,
        },
      }));
      await waitForRender();
    };
    const widgets = Array.from(root.querySelectorAll('.mlrt-table-widget'));
    const widget = widgets[widgets.length - 1];
    const table = widget?.querySelector('.mlrt-table');
    const cell = widget?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-column="1"]');
    const columns = Array.from(widget?.querySelectorAll('.mlrt-table-sized-col') ?? []);
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    if (!widget || !table || !cell || columns.length < 2 || !view) {
      return JSON.stringify({
        ok: false,
        reason: 'missing live resize targets',
        hasWidget: Boolean(widget),
        hasTable: Boolean(table),
        hasCell: Boolean(cell),
        columnCount: columns.length,
        hasView: Boolean(view),
      });
    }

    const beforeDoc = view.state.doc.toString();
    const beforeWidth = columns[1].getBoundingClientRect().width;
    const beforeTableWidth = table.getBoundingClientRect().width;
    const beforeGutter = root.querySelector('.cm-lineNumbers .cm-gutterElement');
    cell.focus();
    const range = root.createRange();
    range.selectNodeContents(cell);
    const selection = root.defaultView.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    cell.dispatchEvent(new root.defaultView.InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: 'short cell with enough live typed text to expand the value column immediately',
    }));
    await waitForRender();
    const currentWidgets = Array.from(root.querySelectorAll('.mlrt-table-widget'));
    const currentWidget = currentWidgets[currentWidgets.length - 1];
    const currentTable = currentWidget?.querySelector('.mlrt-table');
    const currentColumns = Array.from(currentWidget?.querySelectorAll('.mlrt-table-sized-col') ?? []);
    const currentCell = currentWidget?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-column="1"]');
    const currentGutter = root.querySelector('.cm-lineNumbers .cm-gutterElement');
    const afterWidth = currentColumns[1]?.getBoundingClientRect().width ?? 0;
    const afterTableWidth = currentTable?.getBoundingClientRect().width ?? 0;
    const afterDoc = view.state.doc.toString();
    await waitForHostEcho();
    await restoreDocument(999000);
    await restoreDocument(999001);
    return JSON.stringify({
      ok: true,
      beforeWidth,
      afterWidth,
      widthDelta: afterWidth - beforeWidth,
      beforeTableWidth,
      afterTableWidth,
      tableWidthDelta: afterTableWidth - beforeTableWidth,
      docChanged: afterDoc !== beforeDoc,
      restoredDoc: view.state.doc.toString() === beforeDoc,
      activeElementClass: currentCell?.className ?? root.activeElement?.className ?? null,
      cellPreserved: currentCell === cell,
      gutterPreserved: currentGutter === beforeGutter,
    });
	  })()`;
	}

function tableWhitespaceDeletionExpression() {
  return `(async () => {
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
    const readCell = () => {
      const widgets = Array.from(root.querySelectorAll('.mlrt-table-widget'));
      const widget = widgets[widgets.length - 1];
      return widget?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-column="1"]');
    };
    const waitForRender = () => new Promise((done) => {
      root.defaultView.requestAnimationFrame(() => {
        root.defaultView.requestAnimationFrame(done);
      });
    });
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    let cell = readCell();
    if (!cell || !view) {
      return JSON.stringify({
        ok: false,
        reason: 'missing whitespace deletion targets',
        hasCell: Boolean(cell),
        hasView: Boolean(view),
      });
    }

    const beforeDoc = view.state.doc.toString();
    cell.focus();
    cell.textContent = 'alpha now';
    cell.dispatchEvent(new root.defaultView.InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertReplacementText',
      data: 'alpha now',
    }));
    await waitForRender();
    cell = readCell();
    const textNode = cell?.firstChild;
    let selectedN = false;
    if (cell && textNode && textNode.nodeType === root.defaultView.Node.TEXT_NODE) {
      const nIndex = textNode.textContent.indexOf('now');
      if (nIndex >= 0) {
        const range = root.createRange();
        range.setStart(textNode, nIndex);
        range.setEnd(textNode, nIndex + 1);
        const selection = root.defaultView.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        selectedN = true;
      }
    }
    if (cell) {
      cell.dispatchEvent(new root.defaultView.InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'deleteContentBackward',
        data: null,
      }));
    }
    await waitForRender();
    cell = readCell();
    const afterDeleteText = cell?.innerText ?? null;
    const afterDeleteDoc = view.state.doc.toString();
    root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
      data: {
        type: 'setDocument',
        text: beforeDoc,
        revision: 999005,
        debug: false,
      },
    }));
    await waitForRender();
    return JSON.stringify({
      ok: true,
      selectedN,
      afterDeleteText,
      sourceContainsExpected: afterDeleteDoc.includes('alpha ow'),
      sourceContainsCollapsed: afterDeleteDoc.includes('alphaow'),
      restoredDoc: view.state.doc.toString() === beforeDoc,
    });
  })()`;
}

function tableCellEditShortcutsExpression() {
  return `(async () => {
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
    const queryCell = () => {
      const widgets = Array.from(root.querySelectorAll('.mlrt-table-widget'));
      const widget = widgets[widgets.length - 1];
      return widget?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-column="1"]');
    };
    const waitForRender = () => new Promise((done) => {
      root.defaultView.requestAnimationFrame(() => {
        root.defaultView.requestAnimationFrame(done);
      });
    });
    let cell = queryCell();
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    if (!cell || !view) {
      return JSON.stringify({
        ok: false,
        reason: 'missing edit shortcut targets',
        hasCell: Boolean(cell),
        hasView: Boolean(view),
      });
    }

    const beforeDoc = view.state.doc.toString();
    const beforeCellText = cell.innerText;
    const selectCellContents = (targetCell) => {
      const range = root.createRange();
      range.selectNodeContents(targetCell);
      const selection = root.defaultView.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const setCaretAtCellEnd = (targetCell) => {
      const range = root.createRange();
      range.selectNodeContents(targetCell);
      range.collapse(false);
      const selection = root.defaultView.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const selectTextOffsets = (targetCell, from, to) => {
      const text = targetCell.firstChild;
      if (!text || text.nodeType !== root.defaultView.Node.TEXT_NODE) {
        return false;
      }
      const range = root.createRange();
      range.setStart(text, from);
      range.setEnd(text, to);
      const selection = root.defaultView.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    };
    const key = (targetCell, options) => targetCell.dispatchEvent(new root.defaultView.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ...options,
    }));

    cell.focus();
    selectCellContents(cell);
    cell.dispatchEvent(new root.defaultView.InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: 'base',
    }));
    await waitForRender();
    cell = queryCell();
    const selectedForDelete = cell ? selectTextOffsets(cell, 3, 4) : false;
    if (!cell) {
      return JSON.stringify({ ok: false, reason: 'missing cell after base insert' });
    }
    cell.dispatchEvent(new root.defaultView.InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'deleteContentBackward',
      data: null,
    }));
    await waitForRender();
    cell = queryCell();
    const afterDeleteText = cell?.innerText ?? null;
    const undoDefaultAllowed = cell ? key(cell, {
      key: 'z',
      code: 'KeyZ',
      metaKey: true,
      keyCode: 90,
      which: 90,
    }) : null;
    await waitForRender();
    cell = queryCell();
    const afterUndoText = cell?.innerText ?? null;
    const selectionAfterUndo = root.defaultView.getSelection();
    const undoSelectionCollapsed = selectionAfterUndo?.isCollapsed ?? false;
    if (cell) {
      setCaretAtCellEnd(cell);
    }
    const shiftEnterDefaultAllowed = cell ? key(cell, {
      key: 'Enter',
      code: 'Enter',
      shiftKey: true,
      keyCode: 13,
      which: 13,
    }) : null;
    if (shiftEnterDefaultAllowed && cell) {
      cell.dispatchEvent(new root.defaultView.InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertLineBreak',
        data: null,
      }));
    }
    await waitForRender();
    cell = queryCell();
    if (cell) {
      setCaretAtCellEnd(cell);
    }
    if (cell) {
      cell.dispatchEvent(new root.defaultView.InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: 'next',
      }));
    }
    await waitForRender();
    cell = queryCell();
    const afterShiftEnterText = cell?.innerText ?? null;
    let saveShortcutBubbled = false;
    const commandBoundary = cell?.closest('.mlrt-table-widget')?.parentElement;
    const observeSaveShortcut = (event) => {
      if (event.key === 's' && event.metaKey) {
        saveShortcutBubbled = true;
        // Stop at the table's parent so this synthetic event exercises the
        // table boundary without invoking the actual workbench Save command.
        event.stopPropagation();
      }
    };
    commandBoundary?.addEventListener('keydown', observeSaveShortcut);
    const saveShortcutDefaultAllowed = cell ? key(cell, {
      key: 's',
      code: 'KeyS',
      metaKey: true,
      keyCode: 83,
      which: 83,
    }) : null;
    commandBoundary?.removeEventListener('keydown', observeSaveShortcut);
    const afterDoc = view.state.doc.toString();
    root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
      data: {
        type: 'setDocument',
        text: beforeDoc,
        revision: 999010,
        debug: false,
      },
    }));
    await waitForRender();
    return JSON.stringify({
      ok: true,
      selectedForDelete,
      undoDefaultAllowed,
      shiftEnterDefaultAllowed,
      beforeCellText,
      afterDeleteText,
      afterUndoText,
      undoSelectionCollapsed,
      afterShiftEnterText,
      hasLineBreak: /\\n/.test(afterShiftEnterText ?? ''),
      saveShortcutDefaultAllowed,
      saveShortcutBubbled,
      docChanged: afterDoc !== beforeDoc,
      restoredDoc: view.state.doc.toString() === beforeDoc,
    });
  })()`;
}

function tableClipboardSelectionExpression() {
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mlrt-table-widget'));
    if (!root) return JSON.stringify({ ok: false, reason: 'missing live root' });
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    const wrapper = root.querySelector('.mlrt-table-widget');
    const cell = wrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="0"]');
    if (!view || !wrapper || !cell) {
      return JSON.stringify({ ok: false, reason: 'missing clipboard targets' });
    }
    const beforeDoc = view.state.doc.toString();
    const wait = () => new Promise((done) => root.defaultView.requestAnimationFrame(() => root.defaultView.requestAnimationFrame(done)));
    const key = (target, keyValue, options = {}) => target.dispatchEvent(new root.defaultView.KeyboardEvent('keydown', {
      key: keyValue, bubbles: true, cancelable: true, ...options,
    }));
    cell.focus();
    const escapedDefault = key(cell, 'Escape');
    await wait();
    const singleSelected = wrapper.querySelectorAll('.mlrt-table-cell-selected').length;
    const wrapperFocused = root.activeElement === wrapper;
    key(wrapper, 'ArrowRight', { shiftKey: true });
    await wait();
    const rangeSelected = wrapper.querySelectorAll('.mlrt-table-cell-selected').length;

    const outsideLine = Array.from(root.querySelectorAll('.cm-line')).find((line) =>
      !line.classList.contains('mlrt-hidden-table-source-line')
    );
    outsideLine?.dispatchEvent(new root.defaultView.PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 77,
    }));
    outsideLine?.dispatchEvent(new root.defaultView.PointerEvent('pointerup', {
      bubbles: true, cancelable: true, button: 0, buttons: 0, pointerId: 77,
    }));
    await wait();
    const outsideClickCleared = wrapper.querySelectorAll('.mlrt-table-cell-selected').length === 0;
    cell.focus();
    key(cell, 'Escape');
    key(wrapper, 'ArrowRight', { shiftKey: true });
    await wait();

    const transfer = new root.defaultView.DataTransfer();
    const copyEvent = new root.defaultView.ClipboardEvent('copy', {
      clipboardData: transfer, bubbles: true, cancelable: true,
    });
    wrapper.dispatchEvent(copyEvent);
    const smartPlain = transfer.getData('text/plain');
    const smartHtml = transfer.getData('text/html');
    const privateData = transfer.getData('application/x-markdown-live-editor+json');

    cell.focus();
    key(cell, 'Escape');
    await wait();
    const cutTransfer = new root.defaultView.DataTransfer();
    wrapper.dispatchEvent(new root.defaultView.ClipboardEvent('cut', {
      clipboardData: cutTransfer, bubbles: true, cancelable: true,
    }));
    const cutDidNotChangeSource = view.state.doc.toString() === beforeDoc;
    const hasPendingCutClass = wrapper.classList.contains('mlrt-table-cut-pending');
    const moveSourceText = cell.innerText;
    const moveDestination = wrapper.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="1"]');
    if (moveDestination) {
      moveDestination.focus();
      key(moveDestination, 'Escape');
      wrapper.dispatchEvent(new root.defaultView.ClipboardEvent('paste', {
        clipboardData: cutTransfer, bubbles: true, cancelable: true,
      }));
      await wait();
    }
    const afterMoveWrapper = root.querySelector('.mlrt-table-widget');
    const movedSource = afterMoveWrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="0"]');
    const movedDestination = afterMoveWrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="1"]');
    const moveCompleted = (movedSource?.innerText ?? '') === '' && movedDestination?.innerText === moveSourceText;

    root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
      data: { type: 'setDocument', text: beforeDoc, revision: 999039, debug: false },
    }));
    await wait();

    const pasteWrapper = root.querySelector('.mlrt-table-widget');
    const pasteCell = pasteWrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="0"]');
    pasteCell?.focus();
    if (pasteCell) key(pasteCell, 'Escape');
    const pasteTransfer = new root.defaultView.DataTransfer();
    pasteTransfer.setData('text/plain', 'Clip A\\tClip B\\r\\nClip C\\tClip D');
    pasteWrapper?.dispatchEvent(new root.defaultView.ClipboardEvent('paste', {
      clipboardData: pasteTransfer, bubbles: true, cancelable: true,
    }));
    await wait();
    const afterPaste = view.state.doc.toString();
    const pasteApplied = ['Clip A', 'Clip B', 'Clip C', 'Clip D'].every((value) => afterPaste.includes(value));

    root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
      data: { type: 'setDocument', text: beforeDoc, revision: 999040, debug: false },
    }));
    await wait();
    const htmlWrapper = root.querySelector('.mlrt-table-widget');
    const htmlCell = htmlWrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="0"]');
    if (htmlWrapper && htmlCell) {
      htmlCell.focus();
      key(htmlCell, 'Escape');
      const htmlTransfer = new root.defaultView.DataTransfer();
      htmlTransfer.setData('text/html', '<table><tr><td>Visible 42<span style="display:none">FormulaSecret</span></td><td>Word</td></tr><tr><td rowspan="2">Merged</td><td>Second</td></tr><tr><td>Third</td></tr></table>');
      htmlTransfer.setData('text/plain', 'Visible 42\\tWord\\r\\nMerged\\tSecond\\r\\n\\tThird');
      htmlWrapper.dispatchEvent(new root.defaultView.ClipboardEvent('paste', {
        clipboardData: htmlTransfer, bubbles: true, cancelable: true,
      }));
      await wait();
    }
    const afterHtmlPaste = view.state.doc.toString();
    const htmlPasteApplied = ['Visible 42', 'Word', 'Merged', 'Second', 'Third'].every((value) => afterHtmlPaste.includes(value));
    const hiddenOfficeTextExcluded = !afterHtmlPaste.includes('FormulaSecret');

    root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
      data: { type: 'setDocument', text: beforeDoc, revision: 999041, debug: false },
    }));
    await wait();
    const restoredWrapper = root.querySelector('.mlrt-table-widget');
    const restoredCell = restoredWrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="0"]');
    if (restoredWrapper && restoredCell) {
      restoredCell.focus();
      key(restoredCell, 'Escape');
      key(restoredWrapper, 'ArrowRight', { shiftKey: true });
      await wait();
    }
    return JSON.stringify({
      ok: true,
      escapedDefault,
      singleSelected,
      rangeSelected,
      outsideClickCleared,
      wrapperFocused,
      smartHasTabs: smartPlain.includes('\\t'),
      smartHasPipes: smartPlain.includes('|'),
      smartHasHtmlTable: smartHtml.includes('<table'),
      hasPrivateData: privateData.length > 0,
      cutDidNotChangeSource,
      hasPendingCutClass,
      moveCompleted,
      pasteApplied,
      htmlPasteApplied,
      hiddenOfficeTextExcluded,
      restoredDoc: view.state.doc.toString() === beforeDoc,
    });
  })()`;
}

function tableSelectionGeometryExpression() {
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mlrt-table-widget'));
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    if (!root || !view) return JSON.stringify({ ok: false, reason: 'missing live root' });
    const wait = () => new Promise((done) => root.defaultView.requestAnimationFrame(() => root.defaultView.requestAnimationFrame(done)));
    const key = (target, keyValue, options = {}) => target.dispatchEvent(new root.defaultView.KeyboardEvent('keydown', {
      key: keyValue, bubbles: true, cancelable: true, ...options,
    }));
    const text = [
      '| Key | Value | Note |',
      '| --- | --- | --- |',
      '| One | Alpha | First |',
      '| Two | Bravo | Second |',
      '| Three | Charlie | Third |',
      '| Four | Delta | Fourth |',
    ].join('\\n');
    root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
      data: { type: 'setDocument', text, revision: 999071, debug: false },
    }));
    await wait();
    const wrapper = root.querySelector('.mlrt-table-widget');
    const cell = wrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="0"]');
    if (!wrapper || !cell) return JSON.stringify({ ok: false, reason: 'missing geometry table' });
    cell.focus();
    key(cell, 'Escape');
    key(wrapper, 'ArrowRight', { shiftKey: true });
    key(wrapper, 'ArrowDown', { shiftKey: true });
    key(wrapper, 'ArrowDown', { shiftKey: true });
    await wait();
    const rect = (element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    };
    const selected = Array.from(wrapper.querySelectorAll('.mlrt-table-cell-selected'));
    const selectedRects = selected.map(rect);
    const bounds = {
      left: Math.min(...selectedRects.map((box) => box.left)),
      top: Math.min(...selectedRects.map((box) => box.top)),
      right: Math.max(...selectedRects.map((box) => box.right)),
      bottom: Math.max(...selectedRects.map((box) => box.bottom)),
    };
    const outline = wrapper.querySelector('.mlrt-table-selection-outline');
    const outlineRect = outline ? rect(outline) : null;
    const rightNeighbor = wrapper.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="2"]');
    const bottomNeighbor = wrapper.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="3"][data-column="0"]');
    const outlineStyles = outline ? {
      borderTopColor: root.defaultView.getComputedStyle(outline).borderTopColor,
      borderTopWidth: root.defaultView.getComputedStyle(outline).borderTopWidth,
      borderRadius: root.defaultView.getComputedStyle(outline).borderRadius,
    } : null;
    const hasInsetShadow = (cell) => root.defaultView.getComputedStyle(cell).boxShadow.includes('inset');
    const interiorDividerCells = [selected[1], selected[2], selected[3], selected[4], selected[5]];
    const outlineMatchesSelectedBounds = () => {
      const currentOutline = wrapper.querySelector('.mlrt-table-selection-outline');
      const currentSelected = Array.from(wrapper.querySelectorAll('.mlrt-table-cell-selected')).map(rect);
      if (!currentOutline || currentSelected.length === 0) return false;
      const currentBounds = {
        left: Math.min(...currentSelected.map((box) => box.left)),
        top: Math.min(...currentSelected.map((box) => box.top)),
        right: Math.max(...currentSelected.map((box) => box.right)),
        bottom: Math.max(...currentSelected.map((box) => box.bottom)),
      };
      const currentOutlineRect = rect(currentOutline);
      return ['left', 'top', 'right', 'bottom'].every((side) => Math.abs(currentOutlineRect[side] - currentBounds[side]) <= 0.5);
    };
    const editor = root.querySelector('.cm-editor');
    const originalWidth = editor?.style.width ?? '';
    if (editor) editor.style.width = '460px';
    view.requestMeasure();
    await wait();
    await wait();
    const resizeOutlineAligned = outlineMatchesSelectedBounds();
    if (editor) editor.style.width = originalWidth;
    view.requestMeasure();
    return JSON.stringify({
      ok: Boolean(outline) && selected.length === 6,
      selectedCount: selected.length,
      outlineBoundsAligned: Boolean(outlineRect) && ['left', 'top', 'right', 'bottom'].every((side) => Math.abs(outlineRect[side] - bounds[side]) <= 0.5),
      interiorDividersPresent: interiorDividerCells.every(hasInsetShadow),
      resizeOutlineAligned,
      rightNeighborAligned: Boolean(rightNeighbor) && Math.abs(rect(rightNeighbor).left - bounds.right) <= 0.5,
      bottomNeighborAligned: Boolean(bottomNeighbor) && Math.abs(rect(bottomNeighbor).top - bounds.bottom) <= 0.5,
      outlineStyles,
      edgeClasses: selected.map((cell) => cell.className),
      bounds, outlineRect,
    });
  })()`;
}

function tableTrustedCopySetupExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mlrt-table-widget'));
    const wrapper = root?.querySelector('.mlrt-table-widget');
    const cell = wrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="0"]');
    if (!root || !wrapper || !cell) {
      return JSON.stringify({ ok: false, reason: 'missing trusted copy targets' });
    }
    const key = (target, keyValue, options = {}) => target.dispatchEvent(new root.defaultView.KeyboardEvent('keydown', {
      key: keyValue, bubbles: true, cancelable: true, ...options,
    }));
    cell.focus();
    key(cell, 'Escape');
    key(wrapper, 'ArrowRight', { shiftKey: true });
    root.defaultView.__MLRT_TRUSTED_COPY_RESULT__ = { seen: false };
    root.addEventListener('copy', (event) => {
      const transfer = event.clipboardData;
      root.defaultView.__MLRT_TRUSTED_COPY_RESULT__ = {
        seen: true,
        plain: transfer?.getData('text/plain') ?? '',
        html: transfer?.getData('text/html') ?? '',
        privateData: transfer?.getData('application/x-markdown-live-editor+json') ?? '',
      };
    }, { once: true });
    return JSON.stringify({
      ok: true,
      wrapperFocused: root.activeElement === wrapper,
      selectedCount: wrapper.querySelectorAll('.mlrt-table-cell-selected').length,
    });
  })()`;
}

function tableTrustedCopyResultExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_TRUSTED_COPY_RESULT__);
    const result = root?.defaultView.__MLRT_TRUSTED_COPY_RESULT__ ?? { seen: false };
    return JSON.stringify({
      ok: true,
      seen: result.seen,
      plainHasTabs: result.plain?.includes('\\t') ?? false,
      plainHasPipes: result.plain?.includes('|') ?? false,
      htmlHasTable: result.html?.includes('<table') ?? false,
      hasPrivateData: (result.privateData?.length ?? 0) > 0,
    });
  })()`;
}

function tableCrossBoundaryDragSetupExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mlrt-table-widget'));
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const wrappers = Array.from(root?.querySelectorAll('.mlrt-table-widget') ?? []);
    const wrapper = wrappers[0];
    const destinationWrapper = wrappers[1];
    const cell = wrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="0"]');
    const destinationCell = destinationWrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="1"]');
    if (!root || !view || !wrapper || !cell || !destinationCell) {
      return JSON.stringify({ ok: false, reason: 'missing cross-boundary drag targets' });
    }
    root.querySelector('.mlrt-clipboard-menu')?.remove();
    const cellRect = cell.getBoundingClientRect();
    const tableFrom = Number(wrapper.dataset.srcFrom);
    const afterTableText = view.state.doc.toString().indexOf('17', tableFrom);
    const plain = view.coordsAtPos(afterTableText >= 0 ? afterTableText : view.state.doc.length);
    const destinationRect = destinationCell.getBoundingClientRect();
    root.defaultView.__MLRT_CROSS_DRAG_TABLE__ = {
      from: tableFrom,
      to: Number(wrapper.dataset.srcTo ?? tableFrom),
    };
    return JSON.stringify({
      ok: Boolean(plain),
      startX: cellRect.left + Math.min(12, cellRect.width / 2),
      startY: cellRect.top + Math.min(10, cellRect.height / 2),
      plainX: (plain?.left ?? cellRect.left) + 8,
      plainY: (plain?.top ?? cellRect.bottom + 24) + 8,
      endX: destinationRect.left + Math.min(12, destinationRect.width / 2),
      endY: destinationRect.top + Math.min(10, destinationRect.height / 2),
    });
  })()`;
}

function tableCrossBoundaryDragResultExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_CROSS_DRAG_TABLE__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const table = root?.defaultView.__MLRT_CROSS_DRAG_TABLE__;
    const range = view?.state.selection.main;
    const selectedTables = Array.from(root?.querySelectorAll('.mlrt-table-widget') ?? [])
      .filter((wrapper) => wrapper.querySelector('.mlrt-document-range-selected'));
    return JSON.stringify({
      ok: Boolean(root && view && table && range),
      selectionEmpty: range?.empty ?? true,
      selectionFrom: range?.from ?? null,
      selectionTo: range?.to ?? null,
      tableFrom: table?.from ?? null,
      selectedDocumentCells: root?.querySelectorAll('.mlrt-document-range-selected').length ?? 0,
      selectedDocumentTables: selectedTables.length,
      completelySelectedDocumentTables: selectedTables.filter((wrapper) =>
        wrapper.querySelectorAll('.mlrt-document-range-selected').length ===
          wrapper.querySelectorAll('.mlrt-table-cell').length
      ).length,
      selectedRangeCells: root?.querySelectorAll('.mlrt-table-cell-selected').length ?? 0,
    });
  })()`;
}

function clearCrossBoundaryDragExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_CROSS_DRAG_TABLE__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    view?.dispatch({ selection: { anchor: 0 } });
    return JSON.stringify({ ok: Boolean(view) });
  })()`;
}

function documentToTableDragSetupExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelectorAll('.mlrt-table-widget').length >= 2);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const wrappers = Array.from(root?.querySelectorAll('.mlrt-table-widget') ?? []);
    const target = wrappers[1];
    const first = target?.querySelector('.mlrt-table-cell[data-row-kind="header"][data-column="0"]');
    const second = target?.querySelector('.mlrt-table-cell[data-row-kind="header"][data-column="1"]');
    const final = target?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="1"][data-column="1"]');
    if (!root || !view || !first || !second || !final) {
      return JSON.stringify({ ok: false, reason: 'missing document-to-table drag targets' });
    }
    const source = view.state.doc.toString();
    const startPosition = source.indexOf('\\n20\\n') + 1;
    const start = view.coordsAtPos(startPosition);
    const firstRect = first.getBoundingClientRect();
    const secondRect = second.getBoundingClientRect();
    const finalRect = final.getBoundingClientRect();
    root.defaultView.__MLRT_DOCUMENT_TABLE_DRAG__ = {
      beforeDoc: source,
      targetTableFrom: Number(target.dataset.srcFrom),
    };
    return JSON.stringify({
      ok: Boolean(start),
      startX: (start?.left ?? 0) + 3,
      startY: (start?.top ?? 0) + 8,
      firstX: firstRect.left + Math.min(8, firstRect.width / 2),
      firstY: firstRect.top + Math.min(8, firstRect.height / 2),
      secondX: secondRect.left + Math.min(8, secondRect.width / 2),
      secondY: secondRect.top + Math.min(8, secondRect.height / 2),
      finalX: finalRect.left + Math.min(8, finalRect.width / 2),
      finalY: finalRect.top + Math.min(8, finalRect.height / 2),
    });
  })()`;
}

function documentToTableDragResultExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_DOCUMENT_TABLE_DRAG__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const state = root?.defaultView.__MLRT_DOCUMENT_TABLE_DRAG__;
    const wrapper = Array.from(root?.querySelectorAll('.mlrt-table-widget') ?? [])
      .find((candidate) => Number(candidate.dataset.srcFrom) === state?.targetTableFrom);
    const range = view?.state.selection.main;
    const nativeSelection = root?.defaultView.getSelection();
    return JSON.stringify({
      ok: Boolean(root && view && wrapper && range),
      selectionEmpty: range?.empty ?? true,
      selectedCellCount: wrapper?.querySelectorAll('.mlrt-document-range-selected').length ?? 0,
      rectangularCellCount: root?.querySelectorAll('.mlrt-table-cell-selected').length ?? 0,
      nativeSelectionCollapsed: nativeSelection?.isCollapsed ?? true,
    });
  })()`;
}

function documentToTableDeleteExpression() {
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_DOCUMENT_TABLE_DRAG__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const state = root?.defaultView.__MLRT_DOCUMENT_TABLE_DRAG__;
    if (!root || !view || !state) {
      return JSON.stringify({ ok: false, reason: 'missing mixed delete state' });
    }
    root.dispatchEvent(new root.defaultView.KeyboardEvent('keydown', {
      key: 'Delete', code: 'Delete', bubbles: true, cancelable: true,
    }));
    await new Promise((done) => root.defaultView.requestAnimationFrame(() => root.defaultView.requestAnimationFrame(done)));
    const afterDelete = view.state.doc.toString();
    const targetTableRemoved = !Array.from(root.querySelectorAll('.mlrt-table-widget'))
      .some((wrapper) => Number(wrapper.dataset.srcFrom) === state.targetTableFrom);
    const firstTableRemains = afterDelete.includes('| Key | Value |') && afterDelete.includes('| Long |');
    root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
      data: { type: 'setDocument', text: state.beforeDoc, revision: 999044, debug: false },
    }));
    await new Promise((done) => root.defaultView.requestAnimationFrame(() => root.defaultView.requestAnimationFrame(done)));
    return JSON.stringify({
      ok: true,
      docChanged: afterDelete !== state.beforeDoc,
      targetTableRemoved,
      firstTableRemains,
      restoredDoc: view.state.doc.toString() === state.beforeDoc,
    });
  })()`;
}

function tableClipboardMenuExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mlrt-table-widget'));
    const wrapper = root?.querySelector('.mlrt-table-widget');
    const cell = wrapper?.querySelector('.mlrt-table-cell-selected') ?? wrapper?.querySelector('.mlrt-table-cell');
    if (!root || !wrapper || !cell) {
      return JSON.stringify({ ok: false, reason: 'missing menu target' });
    }
    const rect = cell.getBoundingClientRect();
    const selectedBeforeRightClick = wrapper.querySelectorAll('.mlrt-table-cell-selected').length;
    cell.dispatchEvent(new root.defaultView.PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 2,
      buttons: 2,
      pointerId: 91,
      clientX: rect.left + Math.min(20, rect.width / 2),
      clientY: rect.top + Math.min(10, rect.height / 2),
    }));
    cell.dispatchEvent(new root.defaultView.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: rect.left + Math.min(20, rect.width / 2),
      clientY: rect.top + Math.min(10, rect.height / 2),
    }));
    const menu = wrapper.querySelector('.mlrt-clipboard-menu');
    const actions = Array.from(menu?.querySelectorAll('button') ?? []).map((button) => button.dataset.action);
    const selectedAfterRightClick = wrapper.querySelectorAll('.mlrt-table-cell-selected').length;
    return JSON.stringify({
      ok: true,
      hasMenu: Boolean(menu),
      itemCount: actions.length,
      hasCut: actions.includes('cut'),
      hasSmartCopy: actions.includes('copy-smart'),
      hasMarkdownCopy: actions.includes('copy-markdown'),
      hasAutoPaste: actions.includes('paste-auto'),
      hasMarkdownPaste: actions.includes('paste-markdown'),
      hasSettings: actions.includes('settings'),
      selectedBeforeRightClick,
      selectedAfterRightClick,
    });
  })()`;
}

function documentClipboardExpression() {
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mlrt-table-widget'));
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    if (!root || !view) return JSON.stringify({ ok: false, reason: 'missing document targets' });
    root.querySelector('.mlrt-clipboard-menu')?.remove();
    const beforeDoc = view.state.doc.toString();
    const wait = () => new Promise((done) => root.defaultView.requestAnimationFrame(() => root.defaultView.requestAnimationFrame(done)));
    view.focus();
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    await wait();
    const selectedTableCellCount = root.querySelectorAll('.mlrt-document-range-selected').length;
    const selectedRangeBeforeContext = view.state.selection.main.toJSON();
    const contextCell = root.querySelector('.mlrt-table-cell');
    const contextRect = contextCell?.getBoundingClientRect();
    contextCell?.dispatchEvent(new root.defaultView.PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 2, buttons: 2, pointerId: 92,
      clientX: (contextRect?.left ?? 0) + 6,
      clientY: (contextRect?.top ?? 0) + 6,
    }));
    contextCell?.dispatchEvent(new root.defaultView.MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2,
      clientX: (contextRect?.left ?? 0) + 6,
      clientY: (contextRect?.top ?? 0) + 6,
    }));
    const documentContextMenuPreserved = Boolean(root.querySelector('.mlrt-document-clipboard-menu')) &&
      JSON.stringify(view.state.selection.main.toJSON()) === JSON.stringify(selectedRangeBeforeContext) &&
      root.querySelectorAll('.mlrt-document-range-selected').length === selectedTableCellCount;
    root.querySelector('.mlrt-document-clipboard-menu')?.remove();
    const contextLine = Array.from(root.querySelectorAll('.cm-line')).find((line) =>
      !line.classList.contains('mlrt-hidden-table-source-line') && line.textContent.includes('Text up here')
    );
    const contextLineRect = contextLine?.getBoundingClientRect();
    contextLine?.dispatchEvent(new root.defaultView.PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 2, buttons: 2, pointerId: 93,
      clientX: (contextLineRect?.left ?? 0) + 20,
      clientY: (contextLineRect?.top ?? 0) + 8,
    }));
    contextLine?.dispatchEvent(new root.defaultView.MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2,
      clientX: (contextLineRect?.left ?? 0) + 20,
      clientY: (contextLineRect?.top ?? 0) + 8,
    }));
    const documentTextContextMenuPreserved = Boolean(root.querySelector('.mlrt-document-clipboard-menu')) &&
      JSON.stringify(view.state.selection.main.toJSON()) === JSON.stringify(selectedRangeBeforeContext);
    root.querySelector('.mlrt-document-clipboard-menu')?.remove();
    const transfer = new root.defaultView.DataTransfer();
    view.contentDOM.dispatchEvent(new root.defaultView.ClipboardEvent('copy', {
      clipboardData: transfer, bubbles: true, cancelable: true,
    }));
    const smartPlain = transfer.getData('text/plain');
    const smartHtml = transfer.getData('text/html');
    const privateData = transfer.getData('application/x-markdown-live-editor+json');
    let privateKind = null;
    try { privateKind = JSON.parse(privateData).kind; } catch {}

    root.documentElement.dataset.mlrtDefaultCopyMode = 'rich';
    const richTransfer = new root.defaultView.DataTransfer();
    view.contentDOM.dispatchEvent(new root.defaultView.ClipboardEvent('copy', {
      clipboardData: richTransfer, bubbles: true, cancelable: true,
    }));
    const richHtml = richTransfer.getData('text/html');

    const oldCopyMode = 'smart';
    root.documentElement.dataset.mlrtDefaultCopyMode = 'markdown';
    const markdownTransfer = new root.defaultView.DataTransfer();
    view.contentDOM.dispatchEvent(new root.defaultView.ClipboardEvent('copy', {
      clipboardData: markdownTransfer, bubbles: true, cancelable: true,
    }));
    root.documentElement.dataset.mlrtDefaultCopyMode = oldCopyMode ?? 'smart';
    const markdownPlain = markdownTransfer.getData('text/plain');

    const cutTransfer = new root.defaultView.DataTransfer();
    view.contentDOM.dispatchEvent(new root.defaultView.ClipboardEvent('cut', {
      clipboardData: cutTransfer, bubbles: true, cancelable: true,
    }));
    const cutDeferred = view.state.doc.toString() === beforeDoc;
    const documentCutClass = view.dom.classList.contains('mlrt-document-cut-pending');
    root.dispatchEvent(new root.defaultView.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    }));

    const documentMoveText = beforeDoc.split('\\n')[0];
    view.focus();
    view.dispatch({ selection: { anchor: 0, head: documentMoveText.length } });
    const documentMoveTransfer = new root.defaultView.DataTransfer();
    view.contentDOM.dispatchEvent(new root.defaultView.ClipboardEvent('cut', {
      clipboardData: documentMoveTransfer, bubbles: true, cancelable: true,
    }));
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    view.contentDOM.dispatchEvent(new root.defaultView.ClipboardEvent('paste', {
      clipboardData: documentMoveTransfer, bubbles: true, cancelable: true,
    }));
    await wait();
    const afterDocumentMove = view.state.doc.toString();
    const documentMoveCompleted = !afterDocumentMove.startsWith(documentMoveText) && afterDocumentMove.endsWith(documentMoveText);

    root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
      data: { type: 'setDocument', text: beforeDoc, revision: 999043, debug: false },
    }));
    await wait();

    view.focus();
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    const pasteTransfer = new root.defaultView.DataTransfer();
    pasteTransfer.setData('text/html', '<h2>Imported Heading</h2><ul><li>Imported item</li></ul><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>');
    pasteTransfer.setData('text/plain', 'Imported Heading\\nImported item\\nA\\tB\\n1\\t2');
    view.contentDOM.dispatchEvent(new root.defaultView.ClipboardEvent('paste', {
      clipboardData: pasteTransfer, bubbles: true, cancelable: true,
    }));
    await wait();
    const afterPaste = view.state.doc.toString();
    const importedHeading = afterPaste.includes('Imported Heading') && !afterPaste.includes('<h2');
    const importedList = afterPaste.includes('-   Imported item') || afterPaste.includes('- Imported item');
    const importedTable = afterPaste.includes('| A | B |') && afterPaste.includes('| 1 | 2 |');

    view.focus();
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    const excelTransfer = new root.defaultView.DataTransfer();
    excelTransfer.setData('text/html', '<style>.plain{border:none}.grid{border:1px solid #000000}</style><table><tbody><tr><td class="plain">Text line</td><td class="plain"></td></tr><tr><td class="plain">• item</td><td class="plain"></td></tr><tr><td class="grid"><b>Key</b></td><td class="grid"><b>Value</b></td></tr><tr><td class="grid">Long</td><td class="grid">Visible <b>bold</b></td></tr><tr><td class="plain">After</td><td class="plain"></td></tr></tbody></table>');
    excelTransfer.setData('text/plain', 'Text line\\t\\r\\n• item\\t\\r\\nKey\\tValue\\r\\nLong\\tVisible bold\\r\\nAfter\\t');
    view.contentDOM.dispatchEvent(new root.defaultView.ClipboardEvent('paste', {
      clipboardData: excelTransfer, bubbles: true, cancelable: true,
    }));
    await wait();
    const afterExcelPaste = view.state.doc.toString();
    const excelRoundTripNoRawHtml = !/<table[\\s>]/i.test(afterExcelPaste) &&
      afterExcelPaste.includes('Text line') &&
      afterExcelPaste.includes('- item') &&
      afterExcelPaste.includes('| **Key** | **Value** |') &&
      afterExcelPaste.includes('| Long | Visible **bold** |') &&
      afterExcelPaste.includes('After');

    root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
      data: { type: 'setDocument', text: beforeDoc, revision: 999042, debug: false },
    }));
    await wait();
    return JSON.stringify({
      ok: true,
      selectedTableCellCount,
      documentContextMenuPreserved,
      documentTextContextMenuPreserved,
      smartHasHtmlTable: smartHtml.includes('<table'),
      smartUsesBlackBorders: /border:1px solid #000000/i.test(smartHtml),
      smartUsesWorksheetLayout: smartHtml.includes('data-mlrt-clipboard-layout="worksheet"'),
      smartContainsNestedList: /<(ul|ol)(\\s|>)/i.test(smartHtml),
      smartContainsRichCellMarkup: /<(strong|a)(\\s|>)/i.test(smartHtml),
      richUsesWorksheetLayout: richHtml.includes('data-mlrt-clipboard-layout="worksheet"'),
      richUsesBlackBorders: /border:1px solid #000000/i.test(richHtml),
      richPreservesSupportedFormatting: /<span style="font-weight:700">bold text<\\/span>/i.test(richHtml) && /<a href="https:\\/\\/example.com"/i.test(richHtml),
      smartLeakedPipeTable: smartPlain.includes('| Key |') || smartPlain.includes('| Value |'),
      privateKind,
      markdownHasPipeTable: markdownPlain.includes('| Key |') || markdownPlain.includes('| Value |'),
      cutDeferred,
      documentCutClass,
      documentMoveCompleted,
      importedHeading,
      importedList,
      importedTable,
      excelRoundTripNoRawHtml,
      restoredDoc: view.state.doc.toString() === beforeDoc,
    });
  })()`;
}

function tableTrustedUndoSetupExpression() {
  return `(async () => {
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
    const queryCell = () => {
      const widgets = Array.from(root.querySelectorAll('.mlrt-table-widget'));
      const widget = widgets[widgets.length - 1];
      return widget?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-column="1"]');
    };
    let cell = queryCell();
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    if (!cell || !view) {
      return JSON.stringify({
        ok: false,
        reason: 'missing trusted undo targets',
        hasCell: Boolean(cell),
        hasView: Boolean(view),
      });
    }

    const waitForRender = () => new Promise((done) => {
      root.defaultView.requestAnimationFrame(() => {
        root.defaultView.requestAnimationFrame(done);
      });
    });
    const selectCellContents = (targetCell) => {
      const range = root.createRange();
      range.selectNodeContents(targetCell);
      const selection = root.defaultView.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const setCaretAtCellEnd = (targetCell) => {
      const range = root.createRange();
      range.selectNodeContents(targetCell);
      range.collapse(false);
      const selection = root.defaultView.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const originalDoc = view.state.doc.toString();
    const originalText = cell.textContent ?? '';
    cell.focus();
    selectCellContents(cell);
    root.execCommand('insertText', false, 'base');
    await waitForRender();
    cell = queryCell();
    if (!cell) {
      return JSON.stringify({ ok: false, reason: 'missing trusted cell after base insert' });
    }
    cell.focus();
    setCaretAtCellEnd(cell);
    root.defaultView.__MLRT_TRUSTED_UNDO_STATE__ = {
      originalText,
      originalDoc,
      beforeDoc: view.state.doc.toString(),
    };
    const cellRect = cell.getBoundingClientRect();
    return JSON.stringify({
      ok: true,
      beforeText: cell.innerText,
      clickX: Math.max(cellRect.left, cellRect.right - 4),
      clickY: cellRect.top + cellRect.height / 2,
      activeElementClass: root.activeElement?.className ?? null,
    });
  })()`;
}

function tableTrustedUndoResultExpression() {
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try {
        return frame.contentDocument;
      } catch {
        return null;
      }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mlrt-table-widget'));
    const widgets = Array.from(root?.querySelectorAll('.mlrt-table-widget') ?? []);
    const widget = widgets[widgets.length - 1];
    const cell = widget?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-column="1"]');
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const state = root?.defaultView.__MLRT_TRUSTED_UNDO_STATE__;
    if (!root || !cell || !view || !state) {
      return JSON.stringify({
        ok: false,
        reason: 'missing trusted undo result state',
        hasRoot: Boolean(root),
        hasCell: Boolean(cell),
        hasView: Boolean(view),
        hasState: Boolean(state),
      });
    }

    const afterUndoText = cell.innerText;
    const selection = root.defaultView.getSelection();
    const selectionCollapsed = selection?.isCollapsed ?? false;
    const afterDoc = view.state.doc.toString();
    root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
      data: {
        type: 'setDocument',
        text: state.originalDoc,
        revision: 999011,
        debug: false,
      },
    }));
    await new Promise((done) => {
      root.defaultView.requestAnimationFrame(() => {
        root.defaultView.requestAnimationFrame(done);
      });
    });
    delete root.defaultView.__MLRT_TRUSTED_UNDO_STATE__;
    return JSON.stringify({
      ok: true,
      afterUndoText,
      selectionCollapsed,
      beforeDocIncludesBase: state.beforeDoc.includes('base'),
      beforeDocIncludesBas: state.beforeDoc.includes('bas'),
      afterDocIncludesBase: afterDoc.includes('base'),
      afterDocIncludesBas: afterDoc.includes('bas'),
      afterDocMatchesBefore: afterDoc === state.beforeDoc,
      restoredDoc: view.state.doc.toString() === state.originalDoc,
    });
  })()`;
}

function tableTrustedDeleteSetupExpression() {
  return `(async () => {
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
    const widgets = Array.from(root.querySelectorAll('.mlrt-table-widget'));
    const widget = widgets[widgets.length - 1];
    const cell = widget?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-column="1"]');
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    if (!cell || !view) {
      return JSON.stringify({
        ok: false,
        reason: 'missing trusted delete targets',
        hasCell: Boolean(cell),
        hasView: Boolean(view),
      });
    }
    const text = cell.firstChild;
    if (!text || text.nodeType !== root.defaultView.Node.TEXT_NODE) {
      return JSON.stringify({ ok: false, reason: 'missing trusted delete text node' });
    }
    const range = root.createRange();
    range.setStart(text, Math.max(0, text.textContent.length - 1));
    range.setEnd(text, text.textContent.length);
    const selection = root.defaultView.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    cell.focus();
    cell.dispatchEvent(new root.defaultView.InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'deleteContentBackward',
      data: null,
    }));
    await new Promise((done) => {
      root.defaultView.requestAnimationFrame(() => {
        root.defaultView.requestAnimationFrame(done);
      });
    });
    const nextWidgets = Array.from(root.querySelectorAll('.mlrt-table-widget'));
    const nextWidget = nextWidgets[nextWidgets.length - 1];
    const nextCell = nextWidget?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-column="1"]');
    nextCell?.focus();
    return JSON.stringify({
      ok: true,
      afterDeleteText: nextCell?.innerText ?? null,
      afterDeleteDocDiffers: view.state.doc.toString() !== root.defaultView.__MLRT_TRUSTED_UNDO_STATE__?.beforeDoc,
    });
  })()`;
}

function tableHostUndoFocusExpression() {
  return `new Promise((resolve) => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try {
        return frame.contentDocument;
      } catch {
        return null;
      }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mlrt-table-widget'));
    if (!root) {
      resolve(JSON.stringify({ ok: false, reason: 'missing live root' }));
      return;
    }
    const widgets = Array.from(root.querySelectorAll('.mlrt-table-widget'));
    const widget = widgets[widgets.length - 1];
    const readShortValueCell = (targetWidget) => {
      const keyCell = Array.from(targetWidget?.querySelectorAll('.mlrt-table-cell[data-row-kind="body"][data-column="0"]') ?? [])
        .find((candidate) => candidate.textContent === 'Short');
      const rowIndex = keyCell?.dataset.rowIndex;
      return rowIndex == null
        ? null
        : targetWidget?.querySelector(\`.mlrt-table-cell[data-row-kind="body"][data-row-index="\${rowIndex}"][data-column="1"]\`);
    };
    const cell = readShortValueCell(widget);
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    if (!cell || !view) {
      resolve(JSON.stringify({
        ok: false,
        reason: 'missing host undo focus targets',
        hasCell: Boolean(cell),
        hasView: Boolean(view),
      }));
      return;
    }

    const beforeDoc = view.state.doc.toString();
    const beforeText = cell.innerText;
    const textNode = Array.from(cell.childNodes).find((node) => node.nodeType === root.defaultView.Node.TEXT_NODE);
    if (!textNode || !textNode.textContent) {
      resolve(JSON.stringify({ ok: false, reason: 'missing text node' }));
      return;
    }
    const range = root.createRange();
    range.setStart(textNode, Math.max(0, textNode.textContent.length - 1));
    range.setEnd(textNode, textNode.textContent.length);
    const selection = root.defaultView.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    cell.focus();
    cell.dispatchEvent(new root.defaultView.InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'deleteContentBackward',
      data: null,
    }));
    const afterDeleteText = cell.innerText;
    cell.dispatchEvent(new root.defaultView.KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    }));
    setTimeout(() => {
      const afterCommitDoc = view.state.doc.toString();
      root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
        data: {
          type: 'setDocument',
          text: beforeDoc,
          revision: 999001,
          debug: false,
        },
      }));
      root.defaultView.requestAnimationFrame(() => {
        root.defaultView.requestAnimationFrame(() => {
          const active = root.activeElement;
          const currentWidgets = Array.from(root.querySelectorAll('.mlrt-table-widget'));
          const currentWidget = currentWidgets[currentWidgets.length - 1];
          const restoredCell = readShortValueCell(currentWidget);
          const restoredSelection = root.defaultView.getSelection();
          const restoredText = restoredCell?.innerText ?? null;
          const caretOffset = (() => {
            if (!restoredCell || !restoredSelection || restoredSelection.rangeCount === 0) {
              return null;
            }
            const measure = root.createRange();
            measure.selectNodeContents(restoredCell);
            const caret = restoredSelection.getRangeAt(0);
            measure.setEnd(caret.endContainer, caret.endOffset);
            const offset = measure.toString().length;
            measure.detach();
            return offset;
          })();
          resolve(JSON.stringify({
            ok: true,
            beforeText,
            afterDeleteText,
            docChangedOnCommit: afterCommitDoc !== beforeDoc,
            afterUndoDocMatches: view.state.doc.toString() === beforeDoc,
            activeElementClass: active?.className ?? null,
            activeIsRestoredCell: active === restoredCell,
            restoredText,
            selectionCollapsed: restoredSelection?.isCollapsed ?? false,
            caretOffset,
          }));
        });
      });
    }, 100);
  })`;
}

function tableHostCharacterUndoFocusExpression() {
  return `(async () => {
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
    const readCurrentShortCell = () => {
      const currentWidgets = Array.from(root.querySelectorAll('.mlrt-table-widget'));
      const currentWidget = currentWidgets[currentWidgets.length - 1];
      const keyCell = Array.from(currentWidget?.querySelectorAll('.mlrt-table-cell[data-row-kind="body"][data-column="0"]') ?? [])
        .find((candidate) => candidate.textContent === 'Short');
      const rowIndex = keyCell?.dataset.rowIndex;
      return rowIndex == null
        ? null
        : currentWidget?.querySelector(\`.mlrt-table-cell[data-row-kind="body"][data-row-index="\${rowIndex}"][data-column="1"]\`);
    };
    const waitForRender = () => new Promise((done) => {
      root.defaultView.requestAnimationFrame(() => {
        root.defaultView.requestAnimationFrame(done);
      });
    });
    let cell = readCurrentShortCell();
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    if (!cell || !view) {
      return JSON.stringify({
        ok: false,
        reason: 'missing host character undo targets',
        hasCell: Boolean(cell),
        hasView: Boolean(view),
      });
    }

    const setCaretAtCellEnd = (targetCell) => {
      const range = root.createRange();
      range.selectNodeContents(targetCell);
      range.collapse(false);
      const selection = root.defaultView.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const caretOffsetForCell = (targetCell) => {
      const selection = root.defaultView.getSelection();
      if (!targetCell || !selection || selection.rangeCount === 0) {
        return null;
      }
      const measure = root.createRange();
      measure.selectNodeContents(targetCell);
      const caret = selection.getRangeAt(0);
      measure.setEnd(caret.endContainer, caret.endOffset);
      const offset = measure.toString().length;
      measure.detach();
      return offset;
    };
    const sendHostDocument = (text, revision) => {
      root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
        data: {
          type: 'setDocument',
          text,
          revision,
          debug: false,
        },
      }));
    };

    const beforeText = cell.innerText;
    const beforeDoc = view.state.doc.toString();
    const postChangeCountBefore = (root.defaultView.__MLRT_DEBUG_EVENTS__ ?? [])
      .filter((event) => event.event === 'post-change').length;
    const docsAfterType = [];
    const rowTextAfterType = [];
    const textsAfterType = [];
    for (const character of ['a', 'b', 'c']) {
      cell = readCurrentShortCell();
      if (!cell) {
        return JSON.stringify({ ok: false, reason: 'missing cell while typing characters' });
      }
      cell.focus();
      setCaretAtCellEnd(cell);
      cell.dispatchEvent(new root.defaultView.InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: character,
      }));
      await waitForRender();
      cell = readCurrentShortCell();
      docsAfterType.push(view.state.doc.toString());
      rowTextAfterType.push(
        cell?.dataset.sourceFrom
          ? view.state.doc.lineAt(Number(cell.dataset.sourceFrom)).text
          : null,
      );
      textsAfterType.push(cell?.innerText ?? null);
    }
    const afterTypeText = textsAfterType[textsAfterType.length - 1];
    const finalDoc = view.state.doc.toString();
    const postChangeCountAfter = (root.defaultView.__MLRT_DEBUG_EVENTS__ ?? [])
      .filter((event) => event.event === 'post-change').length;

    sendHostDocument(docsAfterType[1], 999201);
    await waitForRender();
    let undoCell = readCurrentShortCell();
    const afterFirstUndoText = undoCell?.innerText ?? null;
    const afterFirstUndoDocMatchesTarget = view.state.doc.toString() === docsAfterType[1];
    const afterFirstUndoRowText =
      undoCell?.dataset.sourceFrom
        ? view.state.doc.lineAt(Number(undoCell.dataset.sourceFrom)).text
        : null;
    const afterFirstUndoCaret = caretOffsetForCell(undoCell);
    const afterFirstUndoActive = root.activeElement === undoCell;

    sendHostDocument(docsAfterType[0], 999202);
    await waitForRender();
    undoCell = readCurrentShortCell();
    const afterSecondUndoText = undoCell?.innerText ?? null;
    const afterSecondUndoDocMatchesTarget = view.state.doc.toString() === docsAfterType[0];
    const afterSecondUndoRowText =
      undoCell?.dataset.sourceFrom
        ? view.state.doc.lineAt(Number(undoCell.dataset.sourceFrom)).text
        : null;
    const afterSecondUndoCaret = caretOffsetForCell(undoCell);
    const afterSecondUndoActive = root.activeElement === undoCell;

    sendHostDocument(beforeDoc, 999203);
    await waitForRender();
    undoCell = readCurrentShortCell();
    const afterThirdUndoText = undoCell?.innerText ?? null;
    const afterThirdUndoDocMatchesTarget = view.state.doc.toString() === beforeDoc;
    const afterThirdUndoRowText =
      undoCell?.dataset.sourceFrom
        ? view.state.doc.lineAt(Number(undoCell.dataset.sourceFrom)).text
        : null;
    const afterThirdUndoCaret = caretOffsetForCell(undoCell);
    const afterThirdUndoActive = root.activeElement === undoCell;

    return JSON.stringify({
      ok: true,
      beforeText,
      afterTypeText,
      textsAfterType,
      rowTextAfterType,
      finalDocChanged: finalDoc !== beforeDoc,
      sourceEditCount: postChangeCountAfter - postChangeCountBefore,
      afterFirstUndoText,
      afterFirstUndoDocMatchesTarget,
      afterFirstUndoRowText,
      afterFirstUndoCaret,
      afterFirstUndoActive,
      afterSecondUndoText,
      afterSecondUndoDocMatchesTarget,
      afterSecondUndoRowText,
      afterSecondUndoCaret,
      afterSecondUndoActive,
      afterThirdUndoText,
      afterThirdUndoDocMatchesTarget,
      afterThirdUndoRowText,
      afterThirdUndoCaret,
      afterThirdUndoActive,
    });
  })()`;
}

function tableThenEditorUndoFocusExpression() {
  return `new Promise((resolve) => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try {
        return frame.contentDocument;
      } catch {
        return null;
      }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mlrt-table-widget'));
    if (!root) {
      resolve(JSON.stringify({ ok: false, reason: 'missing live root' }));
      return;
    }
    const widgets = Array.from(root.querySelectorAll('.mlrt-table-widget'));
    const widget = widgets[widgets.length - 1];
    const readShortValueCell = (targetWidget) => {
      const keyCell = Array.from(targetWidget?.querySelectorAll('.mlrt-table-cell[data-row-kind="body"][data-column="0"]') ?? [])
        .find((candidate) => candidate.textContent === 'Short');
      const rowIndex = keyCell?.dataset.rowIndex;
      return rowIndex == null
        ? null
        : targetWidget?.querySelector(\`.mlrt-table-cell[data-row-kind="body"][data-row-index="\${rowIndex}"][data-column="1"]\`);
    };
    const cell = readShortValueCell(widget);
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    if (!cell || !view) {
      resolve(JSON.stringify({
        ok: false,
        reason: 'missing mixed undo targets',
        hasCell: Boolean(cell),
        hasView: Boolean(view),
      }));
      return;
    }

    const beforeDoc = view.state.doc.toString();
    const beforeText = cell.innerText;
    const textNode = Array.from(cell.childNodes).find((node) => node.nodeType === root.defaultView.Node.TEXT_NODE);
    if (!textNode || !textNode.textContent) {
      resolve(JSON.stringify({ ok: false, reason: 'missing text node' }));
      return;
    }

    const range = root.createRange();
    range.setStart(textNode, Math.max(0, textNode.textContent.length - 1));
    range.setEnd(textNode, textNode.textContent.length);
    const selection = root.defaultView.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    cell.focus();
    cell.dispatchEvent(new root.defaultView.InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'deleteContentBackward',
      data: null,
    }));
    const afterDeleteText = cell.innerText;
    cell.dispatchEvent(new root.defaultView.KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    }));

    setTimeout(() => {
      const afterTableCommitDoc = view.state.doc.toString();
      const marker = '\\nnormal undo marker';
      const normalInsertFrom = afterTableCommitDoc.length;
      view.dispatch({ selection: { anchor: normalInsertFrom } });
      view.dispatch({
        changes: { from: normalInsertFrom, insert: marker },
        selection: { anchor: normalInsertFrom + marker.length },
      });
      const afterNormalEditDoc = view.state.doc.toString();
      root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
        data: {
          type: 'setDocument',
          text: afterTableCommitDoc,
          revision: 999101,
          debug: false,
        },
      }));
      root.defaultView.requestAnimationFrame(() => {
        const afterNormalUndoSelection = view.state.selection.main;
        const afterNormalUndoDoc = view.state.doc.toString();
        root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
          data: {
            type: 'setDocument',
            text: beforeDoc,
            revision: 999102,
            debug: false,
          },
        }));
        root.defaultView.requestAnimationFrame(() => {
          root.defaultView.requestAnimationFrame(() => {
            const active = root.activeElement;
            const currentWidgets = Array.from(root.querySelectorAll('.mlrt-table-widget'));
            const currentWidget = currentWidgets[currentWidgets.length - 1];
            const restoredCell = readShortValueCell(currentWidget);
            const restoredSelection = root.defaultView.getSelection();
            const restoredText = restoredCell?.innerText ?? null;
            const caretOffset = (() => {
              if (!restoredCell || !restoredSelection || restoredSelection.rangeCount === 0) {
                return null;
              }
              const measure = root.createRange();
              measure.selectNodeContents(restoredCell);
              const caret = restoredSelection.getRangeAt(0);
              measure.setEnd(caret.endContainer, caret.endOffset);
              const offset = measure.toString().length;
              measure.detach();
              return offset;
            })();
            resolve(JSON.stringify({
              ok: true,
              beforeText,
              afterDeleteText,
              normalInsertFrom,
              afterNormalEditDocChanged: afterNormalEditDoc !== afterTableCommitDoc,
              afterNormalUndoDocMatches: afterNormalUndoDoc === afterTableCommitDoc,
              afterNormalUndoSelectionFrom: afterNormalUndoSelection.from,
              afterNormalUndoSelectionTo: afterNormalUndoSelection.to,
              afterFinalUndoDocMatches: view.state.doc.toString() === beforeDoc,
              activeElementClass: active?.className ?? null,
              activeIsRestoredCell: active === restoredCell,
              restoredText,
              selectionCollapsed: restoredSelection?.isCollapsed ?? false,
              caretOffset,
            }));
          });
        });
      });
    }, 100);
  })`;
}

function tableGlobalUndoBridgeExpression() {
  return `(async () => {
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
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    const widgets = Array.from(root.querySelectorAll('.mlrt-table-widget'));
    const widget = widgets[widgets.length - 1];
    const keyCell = widget?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-column="0"]');
    const valueCell = widget?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-column="1"]');
    if (!view || !keyCell || !valueCell) {
      return JSON.stringify({
        ok: false,
        reason: 'missing global undo bridge targets',
        hasView: Boolean(view),
        hasKeyCell: Boolean(keyCell),
        hasValueCell: Boolean(valueCell),
      });
    }
    const waitForRender = () => new Promise((done) => {
      root.defaultView.requestAnimationFrame(() => {
        root.defaultView.requestAnimationFrame(done);
      });
    });
    const waitFor = async (predicate, timeoutMs = 2000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (predicate()) {
          return true;
        }
        await new Promise((done) => setTimeout(done, 25));
      }
      return predicate();
    };
    const ackCount = () => (root.defaultView.__MLRT_DEBUG_EVENTS__ ?? [])
      .filter((event) => event.event === 'ack-webview-echo').length;
    const setCaretAtEnd = (targetCell) => {
      const range = root.createRange();
      range.selectNodeContents(targetCell);
      range.collapse(false);
      const selection = root.defaultView.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const insertCellText = async (targetCell, text) => {
      const beforeAckCount = ackCount();
      targetCell.focus();
      setCaretAtEnd(targetCell);
      targetCell.dispatchEvent(new root.defaultView.InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text,
      }));
      await waitForRender();
      await waitFor(() => ackCount() > beforeAckCount);
    };
    const pressUndo = async () => {
      const target = root.activeElement ?? root.body;
      target.dispatchEvent(new root.defaultView.KeyboardEvent('keydown', {
        key: 'z',
        code: 'KeyZ',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }));
      await waitForRender();
    };
    const beforeDoc = view.state.doc.toString();
    const outsideMarker = 'GLOBAL_UNDO_OUTSIDE ';
    await insertCellText(keyCell, 'U');
    const afterKeyDoc = view.state.doc.toString();
    await insertCellText(valueCell, 'V');
    const afterValueDoc = view.state.doc.toString();
    const outsideInsertFrom = view.state.doc.toString().indexOf('more test here');
    if (outsideInsertFrom < 0) {
      return JSON.stringify({ ok: false, reason: 'missing outside text target' });
    }
    const beforeOutsideAckCount = ackCount();
    view.focus();
    view.dispatch({ selection: { anchor: outsideInsertFrom } });
    const outsideExecResult = root.execCommand('insertText', false, outsideMarker);
    await waitForRender();
    await waitFor(() => ackCount() > beforeOutsideAckCount);
    const afterOutsideDoc = view.state.doc.toString();
    await pressUndo();
    const undoOutsideMatched = await waitFor(() => view.state.doc.toString() === afterValueDoc);
    const afterUndoOutsideDoc = view.state.doc.toString();
    await pressUndo();
    const undoValueMatched = await waitFor(() => view.state.doc.toString() === afterKeyDoc);
    const afterUndoValueDoc = view.state.doc.toString();
    await pressUndo();
    const undoKeyMatched = await waitFor(() => view.state.doc.toString() === beforeDoc);
    const afterUndoKeyDoc = view.state.doc.toString();
    if (afterUndoKeyDoc !== beforeDoc) {
      root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
        data: {
          type: 'setDocument',
          text: beforeDoc,
          revision: 999501,
          debug: false,
        },
      }));
      await waitForRender();
    }
    return JSON.stringify({
      ok: true,
      keyChanged: afterKeyDoc !== beforeDoc,
      valueChanged: afterValueDoc !== afterKeyDoc,
      outsideExecResult,
      outsideChanged: afterOutsideDoc !== afterValueDoc,
      undoOutsideMatched,
      undoValueMatched,
      undoKeyMatched,
      afterUndoOutsideDocMatches: afterUndoOutsideDoc === afterValueDoc,
      afterUndoValueDocMatches: afterUndoValueDoc === afterKeyDoc,
      afterUndoKeyDocMatches: afterUndoKeyDoc === beforeDoc,
      afterUndoOutsideStillHasOutside: afterUndoOutsideDoc.includes(outsideMarker),
      afterUndoOutsideEqualsBefore: afterUndoOutsideDoc === beforeDoc,
      afterUndoValueStillHasKey: afterUndoValueDoc.includes('| ShortU |'),
      afterUndoValueStillHasOutside: afterUndoValueDoc.includes(outsideMarker),
      afterUndoValueEqualsBefore: afterUndoValueDoc === beforeDoc,
      afterUndoKeyStillHasKey: afterUndoKeyDoc.includes('| ShortU |'),
      afterUndoKeyStillHasOutside: afterUndoKeyDoc.includes(outsideMarker),
      finalRestored: view.state.doc.toString() === beforeDoc,
    });
  })()`;
}

function tableOutsideTypingFocusExpression() {
  return `(async () => {
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
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    const widgets = Array.from(root.querySelectorAll('.mlrt-table-widget'));
    const widget = widgets[widgets.length - 1];
    const valueCell = widget?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-column="1"]');
    if (!view || !widget || !valueCell) {
      return JSON.stringify({
        ok: false,
        reason: 'missing outside typing focus targets',
        hasView: Boolean(view),
        hasWidget: Boolean(widget),
        hasValueCell: Boolean(valueCell),
      });
    }
    const waitForRender = () => new Promise((done) => {
      root.defaultView.requestAnimationFrame(() => {
        root.defaultView.requestAnimationFrame(done);
      });
    });
    const setCaretAtEnd = (targetCell) => {
      const range = root.createRange();
      range.selectNodeContents(targetCell);
      range.collapse(false);
      const selection = root.defaultView.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const sendHostDocument = (text, revision) => {
      root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
        data: {
          type: 'setDocument',
          text,
          revision,
          debug: false,
        },
      }));
    };
    const readValueRowText = () => {
      const sourceFrom = Number(valueCell.dataset.sourceFrom);
      return Number.isFinite(sourceFrom)
        ? view.state.doc.lineAt(sourceFrom).text
        : null;
    };
    const beforeDoc = view.state.doc.toString();
    const beforeRowText = readValueRowText();
    valueCell.focus();
    setCaretAtEnd(valueCell);
    valueCell.dispatchEvent(new root.defaultView.InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: 'F',
    }));
    await waitForRender();
    const afterCellEditDoc = view.state.doc.toString();
    const activeBeforePointer = root.activeElement?.className ?? null;
    const outsideInsertFrom = view.state.doc.toString().indexOf('more test here');
    const outsideLine = Array.from(root.querySelectorAll('.cm-line'))
      .find((line) => line.textContent?.includes('more test here'));
    if (outsideInsertFrom < 0 || !outsideLine) {
      sendHostDocument(beforeDoc, 999601);
      await waitForRender();
      return JSON.stringify({ ok: false, reason: 'missing outside line target' });
    }
    view.dispatch({ selection: { anchor: outsideInsertFrom } });
    outsideLine.dispatchEvent(new root.defaultView.PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerType: 'mouse',
    }));
    await waitForRender();
    const activeAfterPointer = root.activeElement?.className ?? null;
    view.focus();
    view.dispatch({ selection: { anchor: outsideInsertFrom } });
    const outsideMarker = 'OUTSIDE_FOCUS_MARKER ';
    const execResult = root.execCommand('insertText', false, outsideMarker);
    await waitForRender();
    const afterOutsideDoc = view.state.doc.toString();
    const afterOutsideRowText = readValueRowText();
    const outsideIndex = afterOutsideDoc.indexOf(outsideMarker);
    const tableContainsOutsideText = (afterOutsideRowText ?? '').includes(outsideMarker.trim());
    sendHostDocument(beforeDoc, 999602);
    await waitForRender();
    return JSON.stringify({
      ok: true,
      beforeRowText,
      afterCellEditDocChanged: afterCellEditDoc !== beforeDoc,
      activeBeforePointer,
      activeAfterPointer,
      execResult,
      outsideTextInserted: outsideIndex >= 0,
      tableContainsOutsideText,
      afterOutsideRowText,
      restoredDoc: view.state.doc.toString() === beforeDoc,
    });
  })()`;
}

function tableCellFocusExpression() {
  return `(() => {
    function findLiveRoot() {
      const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
        try {
          return frame.contentDocument;
        } catch {
          return null;
        }
      }).filter(Boolean)];
      return roots.find((candidate) => candidate.querySelector('.mlrt-table'));
    }

    return new Promise((resolve) => {
      const root = findLiveRoot();
      if (!root) {
        resolve(JSON.stringify({ ok: false, reason: 'missing live root' }));
        return;
      }
      const cell = root.querySelector('.mlrt-table-cell[data-row-kind="body"][data-column="1"]');
      const editor = root.querySelector('.cm-editor');
      const activeLine = root.querySelector('.cm-activeLine');
      if (!cell || !editor || !activeLine) {
        resolve(JSON.stringify({ ok: false, reason: 'missing focus targets' }));
        return;
      }
      const range = root.createRange();
      cell.focus();
      range.selectNodeContents(cell);
      range.collapse(false);
      const selection = root.defaultView.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      setTimeout(() => {
        resolve(JSON.stringify({
          activeElementClass: root.activeElement?.className ?? null,
          editorHasTableFocusClass: editor.classList.contains('mlrt-table-cell-focused'),
          activeLineBackground: root.defaultView.getComputedStyle(activeLine).backgroundColor,
        }));
      }, 100);
    });
  })()`;
}

function tableSourceProtectionExpression() {
  return `(() => {
    function findLiveRoot() {
      const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
        try {
          return frame.contentDocument;
        } catch {
          return null;
        }
      }).filter(Boolean)];
      return roots.find((candidate) => candidate.querySelector('.mlrt-table'));
    }

    return new Promise((resolve) => {
      const root = findLiveRoot();
      if (!root) {
        resolve(JSON.stringify({ ok: false, reason: 'missing live root' }));
        return;
      }
      const view = root.defaultView.__MLRT_EDITOR_VIEW__;
      const widget = root.querySelector('.mlrt-table-widget');
      if (!view || !widget) {
        resolve(JSON.stringify({
          ok: false,
          reason: 'missing CodeMirror view or table widget',
          hasView: Boolean(view),
          hasWidget: Boolean(widget),
        }));
        return;
      }
      const from = Number(widget.getAttribute('data-src-from'));
      const to = Number(widget.getAttribute('data-src-to'));
      const before = view.state.doc.toString();
      view.focus();
      view.dispatch({ selection: { anchor: from } });
      view.dispatch({
        changes: { from, insert: 'BAD_TABLE_SOURCE_WRITE' },
        userEvent: 'input.type',
      });
      setTimeout(() => {
        const afterFirstAttempt = view.state.doc.toString();
        const rowEnd = to - 1;
        view.dispatch({ selection: { anchor: rowEnd } });
        view.dispatch({
          changes: { from: rowEnd, insert: 'BAD_TABLE_ROW_END_WRITE' },
          userEvent: 'input.type',
        });
        setTimeout(() => {
        const after = view.state.doc.toString();
        const selection = view.state.selection.main;
        resolve(JSON.stringify({
          ok: true,
          docChanged: afterFirstAttempt !== before,
          containsBadWrite: after.includes('BAD_TABLE_SOURCE_WRITE'),
          edgeDocChanged: after !== afterFirstAttempt,
          edgeContainsBadWrite: after.includes('BAD_TABLE_ROW_END_WRITE'),
          selectionFrom: selection.from,
          selectionTo: selection.to,
          selectionInsideTable:
            selection.from >= from && selection.to < to,
          tableFrom: from,
          tableTo: to,
        }));
        }, 100);
      }, 100);
    });
  })()`;
}

function tableEnterExitExpression() {
  return `new Promise((resolve) => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try {
        return frame.contentDocument;
      } catch {
        return null;
      }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mlrt-table-cell[data-row-kind="body"][data-column="1"]'));
    if (!root) {
      resolve(JSON.stringify({ ok: false, reason: 'missing table cell' }));
      return;
    }
    const cell = root.querySelector('.mlrt-table-cell[data-row-kind="body"][data-column="1"]');
    const wrapper = root.querySelector('.mlrt-table-widget');
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    const expectedActiveLineGutterText = (() => {
      if (!wrapper || !view) {
        return null;
      }
      const tableTo = Number(wrapper.getAttribute('data-src-to'));
      if (!Number.isInteger(tableTo)) {
        return null;
      }
      const afterTable =
        view.state.doc.sliceString(tableTo, tableTo + 1) === '\\n'
          ? tableTo + 1
          : tableTo;
      return String(view.state.doc.lineAt(afterTable).number);
    })();
    const range = root.createRange();
    cell.focus();
    range.selectNodeContents(cell);
    range.collapse(false);
    const selection = root.defaultView.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    cell.dispatchEvent(new root.defaultView.KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    }));
    setTimeout(() => {
      const activeLineGutter = root.querySelector('.cm-activeLineGutter');
      const activeLine = root.querySelector('.cm-activeLine');
      const cursor = root.querySelector('.cm-cursor');
      const table = root.querySelector('.mlrt-table');
      const box = (element) => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        };
      };
      const lastEditorUpdate = [...(root.defaultView.__MLRT_DEBUG_EVENTS__ ?? [])]
        .reverse()
        .find((event) => event.event === 'editor-update' && event.details?.selectionSet);
      resolve(JSON.stringify({
        activeElementClass: root.activeElement?.className ?? null,
        activeLineGutterText: activeLineGutter?.textContent ?? null,
        expectedActiveLineGutterText,
        activeLine: box(activeLine),
        table: box(table),
        lineHeight: parseFloat(root.defaultView.getComputedStyle(root.querySelector('.cm-line')).lineHeight),
        cursor: box(cursor),
        editorSelection: lastEditorUpdate?.details?.editorSelection ?? null,
      }));
    }, 100);
  })`;
}

function tableArrowNavigationExpression() {
  return `new Promise((resolve) => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try {
        return frame.contentDocument;
      } catch {
        return null;
      }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mlrt-table'));
    if (!root) {
      resolve(JSON.stringify({ ok: false, reason: 'missing live root' }));
      return;
    }
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    if (!view) {
      resolve(JSON.stringify({ ok: false, reason: 'missing CodeMirror view' }));
      return;
    }
    const key = (target, keyName) => target.dispatchEvent(new root.defaultView.KeyboardEvent('keydown', {
      key: keyName,
      code: keyName,
      bubbles: true,
      cancelable: true,
    }));
    const isSelectionAtEnd = (cell) => {
      const selection = root.defaultView.getSelection();
      if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
        return false;
      }
      const range = selection.getRangeAt(0);
      const expected = root.createRange();
      expected.selectNodeContents(cell);
      expected.collapse(false);
      return range.compareBoundaryPoints(root.defaultView.Range.START_TO_START, expected) === 0;
    };
    const activeCellDetails = () => {
      const active = root.activeElement;
      if (!(active instanceof root.defaultView.HTMLElement) || !active.classList.contains('mlrt-table-cell')) {
        return null;
      }
      return {
        rowKind: active.getAttribute('data-row-kind'),
        rowIndex: active.getAttribute('data-row-index'),
        column: active.getAttribute('data-column'),
        text: active.textContent,
        selectionAtEnd: isSelectionAtEnd(active),
      };
    };
    const setCellSelection = (cell, atEnd) => {
      const range = root.createRange();
      range.selectNodeContents(cell);
      range.collapse(!atEnd);
      const selection = root.defaultView.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const before = view.state.doc.toString();
    const wrapper = root.querySelector('.mlrt-table-widget');
    const firstSourceLine = root.querySelector('.mlrt-table-source-line');
    const tableHeaderLineNumber = Number(firstSourceLine?.getAttribute('data-source-line') ?? 0);
    const beforeTableLineNumber = Math.max(1, tableHeaderLineNumber - 1);
    const afterTablePosition = (() => {
      if (!wrapper) {
        return view.state.doc.line(tableHeaderLineNumber + 3).from;
      }
      const tableTo = Number(wrapper.getAttribute('data-src-to'));
      if (!Number.isInteger(tableTo)) {
        return view.state.doc.line(tableHeaderLineNumber + 3).from;
      }
      return view.state.doc.sliceString(tableTo, tableTo + 1) === '\\n'
        ? tableTo + 1
        : tableTo;
    })();
    const afterTableLineNumber = view.state.doc.lineAt(afterTablePosition).number;
    view.focus();
    view.dispatch({ selection: { anchor: view.state.doc.line(beforeTableLineNumber).from } });
    key(view.contentDOM, 'ArrowDown');
    setTimeout(() => {
      const fromBeforeTableLine = activeCellDetails();
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.line(afterTableLineNumber).from } });
      key(view.contentDOM, 'ArrowUp');
      setTimeout(() => {
        const fromAfterTableLine = activeCellDetails();
        const activeCell = root.activeElement;
        setCellSelection(activeCell, false);
        const insideDownAllowed = key(activeCell, 'ArrowDown');
        const stayedInCellAfterInsideDown = root.activeElement === activeCell;
        setCellSelection(activeCell, true);
        const exitDownAllowed = key(activeCell, 'ArrowDown');
        setTimeout(() => {
          const activeLineGutter = root.querySelector('.cm-activeLineGutter');
          const after = view.state.doc.toString();
          const afterDownSelection = view.state.selection.main;
          const afterDownLine = view.state.doc.lineAt(afterTablePosition);
          resolve(JSON.stringify({
            ok: true,
            fromBeforeTableLine,
            fromAfterTableLine,
            insideDownAllowed,
            stayedInCellAfterInsideDown,
            exitDownPrevented: !exitDownAllowed,
            afterDownActiveClass: root.activeElement?.className ?? null,
            afterDownGutterText: activeLineGutter?.textContent ?? null,
            expectedAfterDownGutterText: String(afterTableLineNumber),
            afterDownSelectionHead: afterDownSelection.head,
            afterDownLineStart: afterDownLine.from,
            docChanged: after !== before,
          }));
        }, 100);
      }, 100);
    }, 100);
  })`;
}

function assertTableCellFocus(result) {
  if (
    !result?.editorHasTableFocusClass ||
    result.activeLineBackground !== "rgba(0, 0, 0, 0)"
  ) {
    throw new Error(
      `Table cell focus check failed: expected hidden active line, got ${JSON.stringify(
        result,
      )}`,
    );
  }
}

function assertTableResponsiveScroll(result) {
  const sourceLineDelta = Math.abs(
    (result?.sourceLineAfterScroll?.left ?? 0) -
      (result?.sourceLineBeforeScroll?.left ?? 0),
  );
  const tableCellDelta = Math.abs(
    (result?.tableCellAfterScroll?.left ?? 0) -
      (result?.tableCellBeforeScroll?.left ?? 0),
  );
  const normalLineRight = result?.normalLineBefore?.right ?? Number.POSITIVE_INFINITY;
  const scrollerRight = result?.scroller?.right ?? 0;
  const scrollbarLeft = result?.tableScrollbar?.left ?? Number.NEGATIVE_INFINITY;
  const gutterRight = result?.sourceLineBeforeScroll?.right ?? Number.POSITIVE_INFINITY;
  const scrollbarTop = result?.tableScrollbar?.top ?? Number.NEGATIVE_INFINITY;
  const tableBottom = result?.tableScroll?.bottom ?? Number.POSITIVE_INFINITY;

  if (
    !result?.ok ||
    result.editorOverflow ||
    !result.tableScrollOverflow ||
    result.tableScrollbarHidden ||
    result.tableScrollLeft <= 0 ||
    scrollbarLeft < gutterRight - pixelTolerance ||
    scrollbarTop < tableBottom - pixelTolerance ||
    sourceLineDelta > pixelTolerance ||
    tableCellDelta <= pixelTolerance ||
    normalLineRight > scrollerRight + pixelTolerance
  ) {
    throw new Error(
      `Table responsive scroll check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableGutterAlignment(result) {
  if (
    !result?.ok ||
    result.nativeRowsInTableBand?.length !== 0 ||
    !result.nativeNumbersStrictlyIncrease ||
    result.hiddenNativeRowCount <= 0 ||
    !result.hiddenNativeRowsHaveZeroHeight ||
    result.hiddenContentLineCount <= 0 ||
    !result.hiddenContentLinesHaveZeroHeight ||
    result.tableSourceLineCount <= 0
  ) {
    throw new Error(
      `Table gutter alignment check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableLiveResize(result) {
	  if (
	    !result?.ok ||
	    !result.docChanged ||
	    !result.restoredDoc ||
	    !result.cellPreserved ||
	    !result.gutterPreserved ||
	    result.widthDelta <= pixelTolerance ||
	    result.tableWidthDelta <= pixelTolerance
	  ) {
    throw new Error(
      `Table live resize check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableGutterStability(result) {
  if (
    !result?.ok ||
    !result.docChanged ||
    !result.restoredDoc ||
    !result.preservedVisibleRows ||
    result.childListMutations !== 0 ||
    result.nativeRowsInTableBandAfter?.length !== 0
  ) {
    throw new Error(
      `Table gutter stability check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableRenderStability(result) {
  if (
    !result?.ok ||
    !result.docChanged ||
    !result.restoredDoc ||
    result.widgetChildListMutations !== 0 ||
    result.cellChildListMutations !== 0 ||
    result.tableSourceLineChildListMutations !== 0 ||
    result.activeLineMutations !== 0 ||
    result.activeLineGutterMutations !== 0 ||
    result.cursorLayerChildListMutations !== 0 ||
    result.selectionLayerChildListMutations !== 0 ||
    result.scrollerScrollEvents !== 0 ||
    JSON.stringify(result.beforeEditorSelection) !==
      JSON.stringify(result.afterEditorSelection) ||
    result.beforeScrollTop !== result.afterScrollTop ||
    result.cellCharacterDataMutations <= 0 ||
    result.blankFrames?.length !== 0 ||
    !result.afterCellText.endsWith("xyz")
  ) {
    throw new Error(
      `Table render stability check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableStaleWebviewAckStability(result) {
  if (
    !result?.ok ||
    result.changeIds?.length !== 3 ||
    result.changeIds.some((id) => !Number.isInteger(id)) ||
    !result.finalLocalDocChanged ||
    !result.afterFirstAckDocMatchesFinal ||
    !result.afterSecondAckDocMatchesFinal ||
    !result.afterSecondAckTextMatchesFinal ||
    !result.sameWidget ||
    !result.sameCell ||
    result.contentChildListMutations !== 0 ||
    result.widgetChildListMutations !== 0 ||
    result.gutterChildListMutations !== 0 ||
    !result.restoredDoc
  ) {
    throw new Error(
      `Table stale webview ack stability check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableHostSyncStability(result) {
  if (
    !result?.ok ||
    !result.docChangedBeforeSync ||
    !result.restoredDoc ||
    !result.sameWidget ||
    !result.sameCell ||
    result.widgetChildListMutations !== 0 ||
    result.gutterChildListMutations !== 0
  ) {
    throw new Error(
      `Table host sync stability check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableSequentialCellToEditorTyping(result) {
  if (
    !result?.ok ||
    !result.afterCellDocChanged ||
    result.headerKeyTextAfterCells !== "KeyH" ||
    result.keyTextAfterCells !== "ShortX" ||
    result.valueTextAfterCells !==
      "short cell. This is resizing the cell now VALUE" ||
    !result.headerTextAfterCells?.includes("KeyH") ||
    !result.rowTextAfterCells?.includes("ShortX") ||
    !result.rowTextAfterCells?.includes("now VALUE") ||
    !result.execCommandResult ||
    !result.outsideBeforeNormalText ||
    result.tableContainsOutsideText ||
    result.headerKeyTextAfterOutside !== result.headerKeyTextAfterCells ||
    result.keyTextAfterOutside !== result.keyTextAfterCells ||
    result.valueTextAfterOutside !== result.valueTextAfterCells ||
    !result.restoredDoc
  ) {
    throw new Error(
      `Table sequential cell to editor typing check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableWhitespaceDeletion(result) {
  if (
    !result?.ok ||
    !result.selectedN ||
    result.afterDeleteText !== "alpha ow" ||
    !result.sourceContainsExpected ||
    result.sourceContainsCollapsed ||
    !result.restoredDoc
  ) {
    throw new Error(
      `Table whitespace deletion check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableCellEditShortcuts(result) {
	  if (
	    !result?.ok ||
		    !result.selectedForDelete ||
	    result.undoDefaultAllowed ||
	    result.shiftEnterDefaultAllowed ||
	    result.afterDeleteText !== "bas" ||
	    result.afterUndoText === "bas" ||
	    !result.undoSelectionCollapsed ||
	    !result.hasLineBreak ||
	    !result.saveShortcutDefaultAllowed ||
	    !result.saveShortcutBubbled ||
	    !result.afterShiftEnterText.includes("next") ||
	    !result.docChanged ||
	    !result.restoredDoc
	  ) {
    throw new Error(
      `Table cell edit shortcuts check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableClipboardSelection(result) {
  if (
    !result?.ok ||
    result.escapedDefault ||
    result.singleSelected !== 1 ||
    result.rangeSelected !== 2 ||
    !result.outsideClickCleared ||
    !result.wrapperFocused ||
    !result.smartHasTabs ||
    result.smartHasPipes ||
    !result.smartHasHtmlTable ||
    !result.hasPrivateData ||
    !result.cutDidNotChangeSource ||
    !result.hasPendingCutClass ||
    !result.moveCompleted ||
    !result.pasteApplied ||
    !result.htmlPasteApplied ||
    !result.hiddenOfficeTextExcluded ||
    !result.restoredDoc
  ) {
    throw new Error(
      `Table clipboard selection check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableSelectionGeometry(result) {
  if (
    !result?.ok ||
    !result.outlineBoundsAligned ||
    !result.interiorDividersPresent ||
    !result.resizeOutlineAligned ||
    !result.rightNeighborAligned ||
    !result.bottomNeighborAligned ||
    result.outlineStyles?.borderTopColor === "rgba(0, 0, 0, 0)" ||
    result.outlineStyles?.borderTopWidth !== "1px" ||
    result.outlineStyles?.borderRadius !== "0px"
  ) {
    throw new Error(
      `Table selection geometry check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableTrustedCopySetup(result) {
  if (!result?.ok || !result.wrapperFocused || result.selectedCount !== 2) {
    throw new Error(
      `Table trusted copy setup failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableTrustedCopy(result) {
  if (
    !result?.ok ||
    !result.seen ||
    !result.plainHasTabs ||
    result.plainHasPipes ||
    !result.htmlHasTable ||
    !result.hasPrivateData
  ) {
    throw new Error(
      `Table trusted copy check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableCrossBoundaryDragSetup(result) {
  if (
    !result?.ok ||
    ![
      result.startX,
      result.startY,
      result.plainX,
      result.plainY,
      result.endX,
      result.endY,
    ].every(Number.isFinite)
  ) {
    throw new Error(
      `Table cross-boundary drag setup failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableCrossBoundaryDrag(result, expectedTableCount) {
  if (
    !result?.ok ||
    result.selectionEmpty ||
    result.selectionFrom > result.tableFrom ||
    result.selectionTo <= result.tableFrom ||
    result.selectedDocumentCells < 1 ||
    result.selectedDocumentTables !== expectedTableCount ||
    result.completelySelectedDocumentTables !== expectedTableCount ||
    result.selectedRangeCells !== 0
  ) {
    throw new Error(
      `Table cross-boundary drag check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertDocumentToTableDragSetup(result) {
  if (
    !result?.ok ||
    ![
      result.startX,
      result.startY,
      result.firstX,
      result.firstY,
      result.secondX,
      result.secondY,
      result.finalX,
      result.finalY,
    ].every(Number.isFinite)
  ) {
    throw new Error(
      `Document-to-table drag setup failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertDocumentToTableDragResult(result, expectedCellCount) {
  if (
    !result?.ok ||
    result.selectionEmpty ||
    result.selectedCellCount !== expectedCellCount ||
    result.rectangularCellCount !== 0 ||
    !result.nativeSelectionCollapsed
  ) {
    throw new Error(
      `Document-to-table drag check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertDocumentToTableDelete(result) {
  if (
    !result?.ok ||
    !result.docChanged ||
    !result.targetTableRemoved ||
    !result.firstTableRemains ||
    !result.restoredDoc
  ) {
    throw new Error(
      `Mixed document/table delete check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableClipboardMenu(result) {
  if (
    !result?.ok ||
    !result.hasMenu ||
    result.itemCount < 12 ||
    !result.hasCut ||
    !result.hasSmartCopy ||
    !result.hasMarkdownCopy ||
    !result.hasAutoPaste ||
    !result.hasMarkdownPaste ||
    !result.hasSettings ||
    result.selectedBeforeRightClick < 1 ||
    result.selectedAfterRightClick !== result.selectedBeforeRightClick
  ) {
    throw new Error(
      `Table clipboard menu check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertDocumentClipboard(result) {
  if (
    !result?.ok ||
    result.selectedTableCellCount < 1 ||
    !result.documentContextMenuPreserved ||
    !result.documentTextContextMenuPreserved ||
    !result.smartHasHtmlTable ||
    !result.smartUsesBlackBorders ||
    !result.smartUsesWorksheetLayout ||
    result.smartContainsNestedList ||
    result.smartContainsRichCellMarkup ||
    !result.richUsesWorksheetLayout ||
    !result.richUsesBlackBorders ||
    !result.richPreservesSupportedFormatting ||
    result.smartLeakedPipeTable ||
    result.privateKind !== 'document' ||
    !result.markdownHasPipeTable ||
    !result.cutDeferred ||
    !result.documentCutClass ||
    !result.documentMoveCompleted ||
    !result.importedHeading ||
    !result.importedList ||
    !result.importedTable ||
    !result.excelRoundTripNoRawHtml ||
    !result.restoredDoc
  ) {
    throw new Error(
      `Document clipboard check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableTrustedUndoSetup(result) {
  if (
    !result?.ok ||
    result.beforeText !== "base" ||
    typeof result.clickX !== "number" ||
    typeof result.clickY !== "number"
  ) {
    throw new Error(
      `Table trusted undo setup failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableTrustedUndo(result) {
  if (
    !result?.ok ||
    result.afterUndoText === "bas" ||
    !result.selectionCollapsed ||
    result.afterDocIncludesBas ||
    result.afterDocMatchesBefore ||
    !result.restoredDoc
  ) {
    throw new Error(`Table trusted undo check failed: ${JSON.stringify(result)}`);
  }
}

function assertTableTrustedDeleteSetup(result) {
  if (!result?.ok || result.afterDeleteText !== "bas" || !result.afterDeleteDocDiffers) {
    throw new Error(
      `Table trusted delete setup failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableHostUndoFocus(result) {
  if (
    !result?.ok ||
    !result.docChangedOnCommit ||
    !result.afterUndoDocMatches ||
    !result.activeIsRestoredCell ||
    result.restoredText !== result.beforeText ||
    !result.selectionCollapsed ||
    result.caretOffset !== result.beforeText.length
  ) {
    throw new Error(
      `Table host undo focus check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableHostCharacterUndoFocus(result) {
  if (
	    !result?.ok ||
	    !result.finalDocChanged ||
	    result.sourceEditCount < 3 ||
	    result.afterTypeText !== `${result.beforeText}abc` ||
	    result.textsAfterType?.[0] !== `${result.beforeText}a` ||
	    result.textsAfterType?.[1] !== `${result.beforeText}ab` ||
	    result.textsAfterType?.[2] !== `${result.beforeText}abc` ||
    result.afterFirstUndoText !== `${result.beforeText}ab` ||
    result.afterFirstUndoCaret !== result.afterFirstUndoText.length ||
    !result.afterFirstUndoActive ||
    result.afterSecondUndoText !== `${result.beforeText}a` ||
    result.afterSecondUndoCaret !== result.afterSecondUndoText.length ||
    !result.afterSecondUndoActive ||
    result.afterThirdUndoText !== result.beforeText ||
    result.afterThirdUndoCaret !== result.beforeText.length ||
    !result.afterThirdUndoActive
  ) {
    throw new Error(
      `Table host character undo focus check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableThenEditorUndoFocus(result) {
  if (
    !result?.ok ||
    !result.afterNormalEditDocChanged ||
    !result.afterNormalUndoDocMatches ||
    result.afterNormalUndoSelectionFrom !== result.normalInsertFrom ||
    result.afterNormalUndoSelectionTo !== result.normalInsertFrom ||
    result.afterNormalUndoSelectionFrom === 0 ||
    !result.afterFinalUndoDocMatches ||
    !result.activeIsRestoredCell ||
    result.restoredText !== result.beforeText ||
    !result.selectionCollapsed ||
    result.caretOffset !== result.beforeText.length
  ) {
    throw new Error(
      `Table then editor undo focus check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableGlobalUndoBridge(result) {
  const granularUndo =
    result.undoOutsideMatched &&
    result.undoValueMatched &&
    result.undoKeyMatched &&
    result.afterUndoOutsideDocMatches &&
    result.afterUndoValueDocMatches &&
    result.afterUndoKeyDocMatches;
  const nativeGroupedUndo =
    result.afterUndoOutsideEqualsBefore &&
    result.afterUndoValueEqualsBefore &&
    result.afterUndoKeyDocMatches &&
    !result.afterUndoOutsideStillHasOutside &&
    !result.afterUndoValueStillHasOutside &&
    !result.afterUndoKeyStillHasOutside &&
    !result.afterUndoKeyStillHasKey;
  if (
    !result?.ok ||
    !result.keyChanged ||
    !result.valueChanged ||
    !result.outsideExecResult ||
    !result.outsideChanged ||
    (!granularUndo && !nativeGroupedUndo) ||
    !result.finalRestored
  ) {
    throw new Error(
      `Table global undo bridge check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableOutsideTypingFocus(result) {
  if (
    !result?.ok ||
    !result.afterCellEditDocChanged ||
    !String(result.activeBeforePointer ?? "").includes("mlrt-table-cell") ||
    String(result.activeAfterPointer ?? "").includes("mlrt-table-cell") ||
    !result.execResult ||
    !result.outsideTextInserted ||
    result.tableContainsOutsideText ||
    !result.restoredDoc
  ) {
    throw new Error(
      `Table outside typing focus check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableSourceProtection(result) {
  if (
    !result?.ok ||
    result?.docChanged ||
    result?.containsBadWrite ||
    result?.edgeDocChanged ||
    result?.edgeContainsBadWrite ||
    result?.selectionInsideTable
  ) {
    throw new Error(
      `Table source protection check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableArrowNavigation(result) {
  if (
    !result?.ok ||
    result.fromBeforeTableLine?.rowKind !== "header" ||
    result.fromBeforeTableLine?.column !== "0" ||
    !result.fromBeforeTableLine?.selectionAtEnd ||
    result.fromAfterTableLine?.rowKind !== "body" ||
    result.fromAfterTableLine?.column !== "1" ||
    !result.fromAfterTableLine?.selectionAtEnd ||
    !result.insideDownAllowed ||
    !result.stayedInCellAfterInsideDown ||
    !result.exitDownPrevented ||
    result.afterDownGutterText !== result.expectedAfterDownGutterText ||
    result.afterDownSelectionHead !== result.afterDownLineStart ||
    result.docChanged
  ) {
    throw new Error(
      `Table arrow navigation check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableEnterExit(result) {
  if (result?.activeLineGutterText !== result?.expectedActiveLineGutterText) {
    throw new Error(
      `Enter exit check failed: expected active gutter line ${result?.expectedActiveLineGutterText}, got ${JSON.stringify(
        result,
      )}`,
    );
  }

  const selection = result.editorSelection?.ranges?.[0];
  if (!selection?.empty) {
    throw new Error(
      `Enter exit check failed: expected collapsed editor selection, got ${JSON.stringify(
        result,
      )}`,
    );
  }

  const tableBottom =
    result.table === undefined
      ? undefined
      : result.table.top + result.table.height;
  const bottomGap = result.activeLine?.top - tableBottom;
  if (Math.abs(bottomGap) > pixelTolerance) {
    throw new Error(
      `Enter exit check failed: expected line directly below table, got ${JSON.stringify(
        result,
      )}`,
    );
  }
}

function assertPixelParity(stock, live) {
  if (!stock?.hasMonaco) {
    throw new Error("Pixel parity check failed: stock Monaco editor was not detected.");
  }
  if (!live) {
    throw new Error("Pixel parity check failed: live editor webview metrics were not found.");
  }

  const screen = (box) =>
    box
      ? {
          ...box,
          left: box.left + stock.editor.left,
          right: box.right + stock.editor.left,
        }
      : null;
  const liveGutter = screen(live.gutter);
  const liveLine = screen(live.line);
  const liveLineText = screen(live.lineText);
  const liveLineNumberText = screen(live.lineNumberText);
  const liveTableCell = screen(live.tableCell);
  const liveTable = screen(live.table);
  const liveTableScroll = screen(live.tableScroll);
  const liveScroller = screen(live.scroller);
  const rightPadding = stock.content.left - stock.firstLineNumberText?.right;
  const liveLineHeight = parseFloat(live.lineLineHeight);
  const expectedTableTop =
    live.tableSourceLineNumber > 0
      ? liveLineHeight * (live.tableSourceLineNumber - 1)
      : liveLineHeight * 11;

  const checks = [
    compare("gutter width", stock.margin.width, live.gutter?.width),
    compare("content left", stock.content.left, liveLine?.left),
    compare("first glyph left", stock.firstLineText?.left, liveLineText?.left),
    compare(
      "line-number glyph right",
      stock.firstLineNumberText?.right,
      liveLineNumberText?.right,
    ),
    compare("table content left", stock.content.left, liveTableCell?.left),
    compare("font size", parseFloat(stock.firstLineFontSize), parseFloat(live.lineFontSize)),
    compare(
      "line height",
      parseFloat(stock.firstLineLineHeight),
      liveLineHeight,
    ),
    compare("right padding", rightPadding, liveScroller?.right - liveLine?.right),
    compare("table top rhythm", expectedTableTop, live.table?.top),
  ];
  const failures = checks.filter((check) => !check.pass);
  const tableRightLimit = liveScroller?.right - rightPadding;
  if (liveTableScroll?.right > tableRightLimit + pixelTolerance) {
    failures.push({
      name: "table scroll viewport right edge",
      expected: `<= ${tableRightLimit}`,
      actual: liveTableScroll.right,
      delta: liveTableScroll.right - tableRightLimit,
      pass: false,
    });
  }

  if (live.overflow) {
    failures.push({
      name: "editor horizontal overflow",
      expected: false,
      actual: true,
      delta: Number.NaN,
      pass: false,
    });
  }

  if (live.activeLineGutterBackground !== "rgba(0, 0, 0, 0)") {
    failures.push({
      name: "active gutter background",
      expected: "rgba(0, 0, 0, 0)",
      actual: live.activeLineGutterBackground,
      delta: Number.NaN,
      pass: false,
    });
  }

  console.log(
    "PIXEL CHECKS:",
    checks.map(({ name, expected, actual, delta, pass }) => ({
      name,
      expected,
      actual,
      delta,
      pass,
    })),
  );

  if (failures.length > 0) {
    throw new Error(
      `Pixel parity check failed: ${failures
        .map((failure) => `${failure.name} expected ${failure.expected}, got ${failure.actual}`)
        .join("; ")}`,
    );
  }
}

function compare(name, expected, actual) {
  const delta =
    typeof expected === "number" && typeof actual === "number"
      ? Math.abs(expected - actual)
      : Number.POSITIVE_INFINITY;
  return {
    name,
    expected,
    actual,
    delta,
    pass: Number.isFinite(delta) && delta <= pixelTolerance,
  };
}
