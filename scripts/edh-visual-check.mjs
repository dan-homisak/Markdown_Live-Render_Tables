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
const mixedInputOnlyComplete = Symbol("mixed-input-only-complete");
const editingReliabilityOnlyComplete = Symbol(
  "editing-reliability-only-complete",
);
const emptyDeleteOnlyComplete = Symbol("empty-delete-only-complete");
const wrappedSelectionOnlyComplete = Symbol("wrapped-selection-only-complete");
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
let resolveChildExit;
const childExitPromise = new Promise((resolve) => {
  resolveChildExit = resolve;
});
child.on("exit", (code, signal) => {
  childExit = { code, signal };
  resolveChildExit(childExit);
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

  // Trigger the extension's registered macOS shortcut directly. This avoids
  // first-run workbench contributions stealing Command Palette focus in the
  // otherwise isolated profile.
  const key = async (opts) => wb.send("Input.dispatchKeyEvent", opts);
  await key({
    type: "keyDown",
    modifiers: 4 | 2,
    key: "m",
    code: "KeyM",
    windowsVirtualKeyCode: 77,
  });
  await key({
    type: "keyUp",
    modifiers: 4 | 2,
    key: "m",
    code: "KeyM",
    windowsVirtualKeyCode: 77,
  });
  await sleep(5000);

  await captureWorkbenchScreenshot(wb, path.join(qaDir, "edh-live.png"));

  // Verify a webview iframe exists (live editor active) and measure the table
  // by locating the webview target among CDP targets.
  let afterTargets = await listTargets();
  let webviewTargets = afterTargets.filter(
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

  // The command palette can occasionally lose focus to a first-run workbench
  // contribution in a fresh isolated profile. Fall back to the extension's
  // registered shortcut once before treating a missing live webview as a
  // product failure.
  if (!liveClient) {
    await key({
      type: "keyDown",
      modifiers: 4 | 2,
      key: "m",
      code: "KeyM",
      windowsVirtualKeyCode: 77,
    });
    await key({
      type: "keyUp",
      modifiers: 4 | 2,
      key: "m",
      code: "KeyM",
      windowsVirtualKeyCode: 77,
    });
    await sleep(5000);
    afterTargets = await listTargets();
    webviewTargets = afterTargets.filter(
      (target) =>
        target.type === "iframe" ||
        /vscode-webview|index-no-csp|fake\.html/.test(target.url || ""),
    );
    for (const wv of webviewTargets) {
      try {
        const c = connect(wv.webSocketDebuggerUrl);
        await c.ready;
        await c.send("Runtime.enable");
        const metrics = await evaluateJson(c, liveMetricsExpression());
        if (metrics) {
          liveMetrics = metrics;
          liveClient = c;
          console.log("LIVE METRICS AFTER SHORTCUT RETRY:", liveMetrics);
          break;
        }
        c.ws.close();
      } catch {}
    }
  }

  assertPixelParity(stockMetrics, liveMetrics);
  if (!liveClient) {
    throw new Error("Enter exit check failed: live webview client was not found.");
  }
  const documentEndScroll = await evaluateJson(
    liveClient,
    documentEndScrollExpression(),
  );
  assertDocumentEndScroll(documentEndScroll);
  console.log("DOCUMENT END SCROLL CHECK:", documentEndScroll);
  await captureWorkbenchScreenshot(
    wb,
    path.join(qaDir, "edh-scroll-beyond-last-line.png"),
  );
  await evaluateJson(liveClient, resetDocumentScrollExpression());
  const initialSelectionFixture = await evaluateJson(
    liveClient,
    captureSelectionFixtureExpression(),
  );
  if (!initialSelectionFixture?.ok || initialSelectionFixture.tableCount < 2) {
    throw new Error(
      `Selection fixture capture failed: ${JSON.stringify(initialSelectionFixture)}`,
    );
  }
  if (process.argv.includes("--mixed-input-only")) {
    await runMixedTypedInputUndoCheck(liveClient);
    await runMixedImeImmediateUndoCheck(liveClient);
    await runMixedImeQueuedCommandFifoCheck(liveClient);
    await runMixedImeInputUndoCheck(liveClient);
    await runMixedImeHostConflictCheck(liveClient);
    throw mixedInputOnlyComplete;
  }
  if (process.argv.includes("--editing-reliability-only")) {
    await runTrustedTableEditingReliabilityCheck(liveClient);
    await captureWorkbenchScreenshot(
      wb,
      path.join(qaDir, "edh-editing-reliability.png"),
    );
    throw editingReliabilityOnlyComplete;
  }
  if (process.argv.includes("--empty-delete-only")) {
    const beforeTab = await evaluateJson(wb, activeTabStateExpression());
    const setup = await evaluateJson(
      liveClient,
      emptyTableCellDeleteSetupExpression(),
    );
    if (
      !setup?.ok ||
      setup.cellText !== "" ||
      setup.selectedCount !== 1 ||
      beforeTab?.dirty !== false
    ) {
      throw new Error(
        `Empty table-cell Delete setup failed: ${JSON.stringify({ beforeTab, setup })}`,
      );
    }
    await liveClient.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Delete",
      code: "Delete",
      windowsVirtualKeyCode: 46,
    });
    await liveClient.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Delete",
      code: "Delete",
      windowsVirtualKeyCode: 46,
    });
    await sleep(500);
    const result = await evaluateJson(
      liveClient,
      emptyTableCellDeleteResultExpression(),
    );
    const afterTab = await evaluateJson(wb, activeTabStateExpression());
    if (
      !result?.ok ||
      !result.documentUnchanged ||
      result.selectedCount !== 1 ||
      afterTab?.dirty !== false
    ) {
      throw new Error(
        `Empty table-cell Delete no-op check failed: ${JSON.stringify({ afterTab, result })}`,
      );
    }
    console.log("EMPTY TABLE-CELL DELETE NO-OP CHECK:", {
      documentUnchanged: result.documentUnchanged,
      dirtyBefore: beforeTab.dirty,
      dirtyAfter: afterTab.dirty,
    });
    await captureWorkbenchScreenshot(
      wb,
      path.join(qaDir, "edh-empty-delete-noop.png"),
    );
    throw emptyDeleteOnlyComplete;
  }
  if (process.argv.includes("--wrapped-selection-only")) {
    const isolatedHost = await evaluateJson(
      liveClient,
      setTestHostIsolationExpression(true),
    );
    assertTestHostIsolation(isolatedHost, true);
    await runWrappedDownwardSelectionCheck(liveClient, wb);
    throw wrappedSelectionOnlyComplete;
  }
  const gutterAlignment = await evaluateJson(
    liveClient,
    tableGutterAlignmentExpression(),
  );
  assertTableGutterAlignment(gutterAlignment);
  console.log("TABLE GUTTER ALIGNMENT CHECK:", gutterAlignment);
  // Run trusted host-undo checks before mutation-heavy visual scenarios. The
  // latter intentionally fake host restore messages to exercise stale-sync
  // paths and therefore cannot share an authoritative VS Code undo stack.
  await runMixedTypedInputUndoCheck(liveClient);
  await runMixedImeImmediateUndoCheck(liveClient);
  await runMixedImeQueuedCommandFifoCheck(liveClient);
  await runMixedImeInputUndoCheck(liveClient);
  await sleep(300);
  const isolatedHost = await evaluateJson(
    liveClient,
    setTestHostIsolationExpression(true),
  );
  assertTestHostIsolation(isolatedHost, true);
  console.log("SYNTHETIC HOST TEST ISOLATION ENABLED:", isolatedHost);
  const proseSelectionSetup = await evaluateJson(
    liveClient,
    proseCharacterSelectionSetupExpression(),
  );
  assertProseCharacterSelectionSetup(proseSelectionSetup);
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: proseSelectionSetup.anchor.x,
    y: proseSelectionSetup.anchor.y,
    button: "left",
    clickCount: 1,
  });
  for (const point of proseSelectionSetup.heads) {
    await liveClient.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "left",
    });
    await sleep(40);
    const result = await evaluateJson(
      liveClient,
      proseCharacterSelectionResultExpression(),
    );
    assertProseCharacterSelection(result, proseSelectionSetup.anchor.pos, point);
  }
  const proseFinalPoint = proseSelectionSetup.heads.at(-1);
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: proseFinalPoint.x,
    y: proseFinalPoint.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(80);
  const proseReleased = await evaluateJson(
    liveClient,
    proseCharacterSelectionResultExpression(),
  );
  assertProseCharacterSelection(
    proseReleased,
    proseSelectionSetup.anchor.pos,
    proseFinalPoint,
  );
  await captureWorkbenchScreenshot(
    wb,
    path.join(qaDir, "edh-prose-character-selection.png"),
  );
  await wb.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: stockMetrics.editor.right + 60,
    y: stockMetrics.editor.top + 120,
    button: "left",
    clickCount: 1,
  });
  await wb.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: stockMetrics.editor.right + 60,
    y: stockMetrics.editor.top + 120,
    button: "left",
    clickCount: 1,
  });
  await sleep(100);
  const proseUnfocused = await evaluateJson(
    liveClient,
    proseCharacterSelectionResultExpression(),
  );
  assertProseSelectionColorConsistency(proseReleased, proseUnfocused);
  await captureWorkbenchScreenshot(
    wb,
    path.join(qaDir, "edh-prose-character-selection-unfocused.png"),
  );
  const multilineProseSelection = await evaluateJson(
    liveClient,
    proseMultilineSelectionExpression(),
  );
  await sleep(80);
  const multilineProseResult = await evaluateJson(
    liveClient,
    proseMultilineSelectionResultExpression(),
  );
  assertMultilineProseSelection(multilineProseSelection, multilineProseResult);
  await captureWorkbenchScreenshot(
    wb,
    path.join(qaDir, "edh-prose-multiline-selection.png"),
  );
  const blankLineProseSelection = await evaluateJson(
    liveClient,
    proseBlankLineSelectionExpression(),
  );
  await sleep(80);
  const blankLineProseResult = await evaluateJson(
    liveClient,
    proseBlankLineSelectionResultExpression(),
  );
  assertBlankLineProseSelection(blankLineProseSelection, blankLineProseResult);
  await captureWorkbenchScreenshot(
    wb,
    path.join(qaDir, "edh-prose-blank-line-selection.png"),
  );
  console.log("PROSE CHARACTER SELECTION CHECK: passed");

  const focusIsolationSetup = await evaluateJson(
    liveClient,
    cellFocusIsolationSetupExpression(),
  );
  assertCellFocusIsolationSetup(focusIsolationSetup);
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: focusIsolationSetup.x,
    y: focusIsolationSetup.y,
    button: "left",
    clickCount: 1,
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: focusIsolationSetup.x,
    y: focusIsolationSetup.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(100);
  const focusIsolation = await evaluateJson(
    liveClient,
    cellFocusIsolationResultExpression(),
  );
  assertCellFocusIsolation(focusIsolation);
  console.log("CELL FOCUS SELECTION ISOLATION CHECK:", focusIsolation);
  await evaluateJson(liveClient, clearSelectionStateExpression());
  const sameCellSetup = await evaluateJson(
    liveClient,
    sameCellNativeSelectionSetupExpression(),
  );
  assertSameCellNativeSelectionSetup(sameCellSetup);
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: sameCellSetup.start.x,
    y: sameCellSetup.start.y,
    button: "left",
    clickCount: 1,
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: sameCellSetup.end.x,
    y: sameCellSetup.end.y,
    button: "left",
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: sameCellSetup.end.x,
    y: sameCellSetup.end.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(80);
  const sameCellSelection = await evaluateJson(
    liveClient,
    sameCellNativeSelectionResultExpression(),
  );
  assertSameCellNativeSelection(sameCellSelection, sameCellSetup.expectedText);
  assertTextSelectionColorTreatment(proseReleased, sameCellSelection);
  console.log("SAME-CELL NATIVE CHARACTER SELECTION CHECK:", sameCellSelection);
  await evaluateJson(liveClient, clearSelectionStateExpression());
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
  const richCopyFallback = await evaluateJson(
    liveClient,
    tableRichCopyFallbackExpression(),
  );
  assertTableRichCopyFallback(richCopyFallback);
  console.log("TABLE RICH COPY FALLBACK CHECK:", richCopyFallback);
  const tablePointerSetup = await evaluateJson(
    liveClient,
    tablePointerSelectionSetupExpression(),
  );
  assertTablePointerSelectionSetup(tablePointerSetup);
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: tablePointerSetup.startX,
    y: tablePointerSetup.startY,
    button: "left",
    clickCount: 1,
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: tablePointerSetup.insideX,
    y: tablePointerSetup.insideY,
    button: "left",
  });
  await sleep(60);
  const tablePointerInside = await evaluateJson(
    liveClient,
    tablePointerSelectionResultExpression(),
  );
  assertTablePointerSelection(tablePointerInside, "table", [
    "2:0", "2:1", "3:0", "3:1",
  ]);
  const pureTableSelectionStyle = tablePointerInside.selectionStyle;
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: tablePointerSetup.horizontalX,
    y: tablePointerSetup.horizontalY,
    button: "left",
  });
  await sleep(60);
  const tablePointerHorizontal = await evaluateJson(
    liveClient,
    tablePointerSelectionResultExpression(),
  );
  assertTablePointerSelection(tablePointerHorizontal, "table", [
    "2:0", "2:1", "2:2", "3:0", "3:1", "3:2",
  ]);
  const belowTableAddresses = [
    "2:0", "2:1", "2:2", "3:0", "3:1", "3:2", "4:0", "4:1", "4:2",
  ];
  for (const point of tablePointerSetup.belowHeads) {
    await liveClient.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "left",
    });
    const result = await evaluateJson(
      liveClient,
      tablePointerSelectionResultExpression(),
    );
    assertTablePointerProseEndpoint(
      result,
      belowTableAddresses,
      tablePointerSetup.tableFrom,
      point,
    );
  }
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: tablePointerSetup.reentryX,
    y: tablePointerSetup.reentryY,
    button: "left",
  });
  await sleep(60);
  const tablePointerReentry = await evaluateJson(
    liveClient,
    tablePointerSelectionResultExpression(),
  );
  assertTablePointerSelection(tablePointerReentry, "table", ["2:0", "2:1"]);
  const aboveTableAddresses = [
    "0:0", "0:1", "0:2", "1:0", "1:1", "1:2", "2:0", "2:1", "2:2",
  ];
  for (const point of tablePointerSetup.aboveHeads) {
    await liveClient.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "left",
    });
    const result = await evaluateJson(
      liveClient,
      tablePointerSelectionResultExpression(),
    );
    assertTablePointerProseEndpoint(
      result,
      aboveTableAddresses,
      tablePointerSetup.tableTo,
      point,
    );
  }
  const finalAbovePoint = tablePointerSetup.aboveHeads.at(-1);
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: finalAbovePoint.x,
    y: finalAbovePoint.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(100);
  const tablePointerAbove = await evaluateJson(
    liveClient,
    tablePointerSelectionResultExpression(),
  );
  assertTablePointerProseEndpoint(
    tablePointerAbove,
    aboveTableAddresses,
    tablePointerSetup.tableTo,
    finalAbovePoint,
  );
  assertSelectionStyleParity(
    pureTableSelectionStyle,
    tablePointerAbove.selectionStyle,
  );
  assertSelectionArtifactCleanup(tablePointerAbove);
  console.log("TABLE POINTER SELECTION STATE CHECK:", tablePointerAbove);
  await captureWorkbenchScreenshot(
    wb,
    path.join(qaDir, "edh-table-pointer-selection.png"),
  );
  await evaluateJson(liveClient, clearSelectionStateExpression());

  const gutterSetup = await evaluateJson(
    liveClient,
    tableGutterSelectionSetupExpression(),
  );
  assertTableGutterSelectionSetup(gutterSetup);

  // Clicking a rendered line number owns a real full-row selection.
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: gutterSetup.gutterX,
    y: gutterSetup.gutterY,
    button: "left",
    clickCount: 1,
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: gutterSetup.gutterX,
    y: gutterSetup.gutterY,
    button: "left",
    clickCount: 1,
  });
  await sleep(80);
  const gutterClick = await evaluateJson(
    liveClient,
    tablePointerSelectionResultExpression(),
  );
  assertTablePointerSelection(gutterClick, "table", ["2:0", "2:1", "2:2"]);
  await evaluateJson(liveClient, clearSelectionStateExpression());

  // Gutter-origin drags stay full-row selections inside the grid.
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: gutterSetup.gutterX,
    y: gutterSetup.gutterY,
    button: "left",
    clickCount: 1,
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: gutterSetup.insideX,
    y: gutterSetup.insideY,
    button: "left",
  });
  await sleep(60);
  const gutterInside = await evaluateJson(
    liveClient,
    tablePointerSelectionResultExpression(),
  );
  assertTablePointerSelection(gutterInside, "table", [
    "2:0", "2:1", "2:2", "3:0", "3:1", "3:2", "4:0", "4:1", "4:2",
  ]);
  await captureWorkbenchScreenshot(
    wb,
    path.join(qaDir, "edh-table-gutter-selection.png"),
  );
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: gutterSetup.insideX,
    y: gutterSetup.insideY,
    button: "left",
    clickCount: 1,
  });
  await sleep(80);
  await evaluateJson(liveClient, clearSelectionStateExpression());

  // Leaving a gutter row for prose produces one source-backed mixed range.
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: gutterSetup.gutterX,
    y: gutterSetup.gutterY,
    button: "left",
    clickCount: 1,
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: gutterSetup.above.x,
    y: gutterSetup.above.y,
    button: "left",
  });
  await sleep(60);
  const gutterToProse = await evaluateJson(
    liveClient,
    tablePointerSelectionResultExpression(),
  );
  assertTablePointerProseEndpoint(
    gutterToProse,
    ["0:0", "0:1", "0:2", "1:0", "1:1", "1:2", "2:0", "2:1", "2:2"],
    gutterSetup.tableTo,
    gutterSetup.above,
    true,
  );
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: gutterSetup.above.x,
    y: gutterSetup.above.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(80);
  await evaluateJson(liveClient, clearSelectionStateExpression());

  // Entering the table through its gutter also selects whole traversed rows.
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: gutterSetup.above.x,
    y: gutterSetup.above.y,
    button: "left",
    clickCount: 1,
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: gutterSetup.gutterX,
    y: gutterSetup.gutterY,
    button: "left",
  });
  await sleep(60);
  const proseToGutter = await evaluateJson(
    liveClient,
    tablePointerSelectionResultExpression(),
  );
  assertProseToGutterSelection(proseToGutter, gutterSetup);
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: gutterSetup.gutterX,
    y: gutterSetup.gutterY,
    button: "left",
    clickCount: 1,
  });
  await sleep(80);
  await evaluateJson(liveClient, clearSelectionStateExpression());

  // The opposite horizontal excursion clamps to the left edge cell.
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: gutterSetup.cellX,
    y: gutterSetup.cellY,
    button: "left",
    clickCount: 1,
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: gutterSetup.leftX,
    y: gutterSetup.cellY,
    button: "left",
  });
  await sleep(60);
  const cellToLeftMargin = await evaluateJson(
    liveClient,
    tablePointerSelectionResultExpression(),
  );
  assertTablePointerSelection(cellToLeftMargin, "table", ["2:0", "2:1"]);
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: gutterSetup.leftX,
    y: gutterSetup.cellY,
    button: "left",
    clickCount: 1,
  });
  await sleep(80);
  await evaluateJson(liveClient, clearSelectionStateExpression());

  // A wrapped row's full-height gutter remains one reliable hit target.
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: gutterSetup.wrappedGutterX,
    y: gutterSetup.wrappedGutterY,
    button: "left",
    clickCount: 1,
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: gutterSetup.wrappedGutterX,
    y: gutterSetup.wrappedGutterY,
    button: "left",
    clickCount: 1,
  });
  await sleep(80);
  const wrappedGutterClick = await evaluateJson(
    liveClient,
    firstTablePointerSelectionResultExpression(),
  );
  assertWrappedGutterSelection(wrappedGutterClick);
  await evaluateJson(liveClient, clearSelectionStateExpression());
  console.log("TABLE GUTTER/NEUTRAL SURFACE SELECTION CHECK:", {
    gutterClick: gutterClick.tableAddresses,
    gutterInside: gutterInside.tableAddresses,
    gutterToProse: gutterToProse.documentAddresses,
    proseToGutter: proseToGutter.documentAddresses,
    cellToLeftMargin: cellToLeftMargin.tableAddresses,
    wrappedGutterClick: wrappedGutterClick.tableAddresses,
  });

  const tableOwnershipSetup = await evaluateJson(
    liveClient,
    tablePointerSelectionSetupExpression(),
  );
  assertTablePointerSelectionSetup(tableOwnershipSetup);
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: tableOwnershipSetup.startX,
    y: tableOwnershipSetup.startY,
    button: "left",
    clickCount: 1,
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: tableOwnershipSetup.insideX,
    y: tableOwnershipSetup.insideY,
    button: "left",
  });
  await sleep(60);
  const tableOwnershipLoss = await evaluateJson(
    liveClient,
    forceTableDragOwnershipLossExpression(),
  );
  assertTableDragOwnershipLoss(tableOwnershipLoss);
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: tableOwnershipSetup.insideX,
    y: tableOwnershipSetup.insideY,
    button: "left",
    clickCount: 1,
  });
  await evaluateJson(liveClient, clearSelectionStateExpression());
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: tableOwnershipSetup.startX,
    y: tableOwnershipSetup.startY,
    button: "left",
    clickCount: 1,
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: tableOwnershipSetup.insideX,
    y: tableOwnershipSetup.insideY,
    button: "left",
  });
  await sleep(60);
  const tableOwnershipRecovery = await evaluateJson(
    liveClient,
    tablePointerSelectionResultExpression(),
  );
  assertTablePointerSelection(tableOwnershipRecovery, "table", [
    "2:0", "2:1", "3:0", "3:1",
  ]);
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: tableOwnershipSetup.insideX,
    y: tableOwnershipSetup.insideY,
    button: "left",
    clickCount: 1,
  });
  await sleep(80);
  await evaluateJson(liveClient, clearSelectionStateExpression());
  console.log("TABLE DRAG OWNERSHIP LOSS/RECOVERY CHECK:", {
    ...tableOwnershipLoss,
    recoverySelected: tableOwnershipRecovery.tableAddresses,
  });
  const tableMouseRecovery = await evaluateJson(
    liveClient,
    tableMouseFallbackRecoveryExpression(),
  );
  assertTableMouseFallbackRecovery(tableMouseRecovery);
  console.log("TABLE MOUSE FALLBACK RECOVERY CHECK:", tableMouseRecovery);
  const tableDisposalSafety = await evaluateJson(
    liveClient,
    tableActiveDragDisposalExpression(),
  );
  assertTableActiveDragDisposal(tableDisposalSafety);
  console.log("TABLE ACTIVE-DRAG DISPOSAL CHECK:", tableDisposalSafety);

  for (const [direction, payloadKind, revision] of [
    ["above", "plain", 999051],
    ["below", "plain", 999052],
    ["above", "table", 999053],
    ["below", "table", 999054],
  ]) {
    const tableOriginPaste = await runTableOriginMixedPasteCase(
      liveClient,
      direction,
      payloadKind,
      revision,
    );
    assertTableOriginMixedPaste(tableOriginPaste);
    console.log(
      `TABLE-ORIGIN ${direction.toUpperCase()} ${payloadKind.toUpperCase()} PASTE CHECK:`,
      tableOriginPaste,
    );
  }

  const reverseMixedSetup = await evaluateJson(
    liveClient,
    reverseDocumentTableDragSetupExpression(),
  );
  assertReverseDocumentTableDragSetup(reverseMixedSetup);
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: reverseMixedSetup.startX,
    y: reverseMixedSetup.startY,
    button: "left",
    clickCount: 1,
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: reverseMixedSetup.cellX,
    y: reverseMixedSetup.cellY,
    button: "left",
  });
  await sleep(60);
  const reversePartial = await evaluateJson(
    liveClient,
    documentToTableDragResultExpression(),
  );
  const reversePartialAddresses = [
    "2:1", "2:2", "3:1", "3:2", "4:1", "4:2",
  ];
  assertReverseDocumentTableDrag(
    reversePartial,
    reversePartialAddresses,
    reverseMixedSetup.startPosition,
    reverseMixedSetup.partialHead,
    reverseMixedSetup.partialExpectedText,
    false,
  );
  assertSelectionStyleParity(
    pureTableSelectionStyle,
    reversePartial.selectionStyle,
  );
  const reverseFullAddresses = [
    "0:0", "0:1", "0:2", "1:0", "1:1", "1:2", "2:0", "2:1", "2:2",
    "3:0", "3:1", "3:2", "4:0", "4:1", "4:2",
  ];
  for (const point of reverseMixedSetup.aboveHeads) {
    await liveClient.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "left",
    });
    const result = await evaluateJson(
      liveClient,
      documentToTableDragResultExpression(),
    );
    assertReverseDocumentTableDrag(
      result,
      reverseFullAddresses,
      reverseMixedSetup.startPosition,
      point.pos,
      point.expectedText,
      true,
    );
  }
  const reverseFinalPoint = reverseMixedSetup.aboveHeads.at(-1);
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: reverseFinalPoint.x,
    y: reverseFinalPoint.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(100);
  const reverseFull = await evaluateJson(
    liveClient,
    documentToTableDragResultExpression(),
  );
  assertReverseDocumentTableDrag(
    reverseFull,
    reverseFullAddresses,
    reverseMixedSetup.startPosition,
    reverseFinalPoint.pos,
    reverseFinalPoint.expectedText,
    true,
    true,
  );
  assertSelectionStyleParity(
    pureTableSelectionStyle,
    reverseFull.selectionStyle,
  );
  console.log("REVERSE DOCUMENT/TABLE DRAG CHECK:", reverseFull);
  await evaluateJson(liveClient, clearSelectionStateExpression());
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
  assertTableCrossBoundaryDrag(crossBoundaryIntermediate, "prose");
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
  assertTableCrossBoundaryDrag(crossBoundaryDrag, "second-table");
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
  assertDocumentToTableDragResult(firstMixedCell, ["0:0"]);
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
  assertDocumentToTableDragResult(secondMixedCell, ["0:0", "0:1"]);
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
  assertDocumentToTableDragResult(finalMixedCells, [
    "0:0", "0:1", "1:0", "1:1", "2:0", "2:1",
  ], true);
  assertSelectionStyleParity(
    pureTableSelectionStyle,
    finalMixedCells.selectionStyle,
  );
  console.log("DOCUMENT-TO-TABLE CELL DRAG CHECK:", finalMixedCells);
  const partialMixedCopy = await evaluateJson(
    liveClient,
    partialMixedSelectionCopyExpression(),
  );
  assertPartialMixedSelectionCopy(partialMixedCopy);
  console.log("PARTIAL MIXED-SELECTION COPY CHECK:", partialMixedCopy);
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
  const forwardCrossingSetup = await evaluateJson(
    liveClient,
    documentToTableDragSetupExpression(),
  );
  assertDocumentToTableDragSetup(forwardCrossingSetup);
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: forwardCrossingSetup.startX,
    y: forwardCrossingSetup.startY,
    button: "left",
    clickCount: 1,
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: forwardCrossingSetup.finalX,
    y: forwardCrossingSetup.finalY,
    button: "left",
  });
  const fullTargetAddresses = [
    "0:0", "0:1", "0:2", "1:0", "1:1", "1:2", "2:0", "2:1", "2:2",
    "3:0", "3:1", "3:2", "4:0", "4:1", "4:2",
  ];
  for (const point of forwardCrossingSetup.belowHeads) {
    await liveClient.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "left",
    });
    await sleep(40);
    const forwardStep = await evaluateJson(
      liveClient,
      documentToTableDragResultExpression(),
    );
    assertDocumentThroughTableDragResult(
      forwardStep,
      forwardCrossingSetup.startPosition,
      point,
      fullTargetAddresses,
    );
  }
  const forwardFinalPoint = forwardCrossingSetup.belowHeads.at(-1);
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: forwardFinalPoint.x,
    y: forwardFinalPoint.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(80);
  const forwardReleased = await evaluateJson(
    liveClient,
    documentToTableDragResultExpression(),
  );
  assertDocumentThroughTableDragResult(
    forwardReleased,
    forwardCrossingSetup.startPosition,
    forwardFinalPoint,
    fullTargetAddresses,
  );
  console.log("FORWARD DOCUMENT/TABLE/DOCUMENT DRAG CHECK:", forwardReleased);
  await evaluateJson(liveClient, clearSelectionStateExpression());
  const partialPasteSetup = await evaluateJson(
    liveClient,
    documentToTableDragSetupExpression(),
  );
  assertDocumentToTableDragSetup(partialPasteSetup);
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: partialPasteSetup.startX,
    y: partialPasteSetup.startY,
    button: "left",
    clickCount: 1,
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: partialPasteSetup.finalX,
    y: partialPasteSetup.finalY,
    button: "left",
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: partialPasteSetup.finalX,
    y: partialPasteSetup.finalY,
    button: "left",
    clickCount: 1,
  });
  await sleep(80);
  const partialPasteSelection = await evaluateJson(
    liveClient,
    documentToTableDragResultExpression(),
  );
  assertDocumentToTableDragResult(partialPasteSelection, [
    "0:0", "0:1", "1:0", "1:1", "2:0", "2:1",
  ], true);
  const partialMixedPaste = await evaluateJson(
    liveClient,
    partialMixedSelectionPasteExpression(),
  );
  assertPartialMixedSelectionPaste(partialMixedPaste);
  console.log("PARTIAL MIXED-SELECTION PASTE CHECK:", partialMixedPaste);
  await establishPartialMixedSelection(liveClient);
  const partialMixedContextMenu = await evaluateJson(
    liveClient,
    partialMixedContextMenuExpression(999057),
  );
  assertPartialMixedContextMenu(partialMixedContextMenu);
  console.log("PARTIAL MIXED CONTEXT-MENU ROUTING CHECK:", partialMixedContextMenu);

  const ownershipSetup = await evaluateJson(
    liveClient,
    documentToTableDragSetupExpression(),
  );
  assertDocumentToTableDragSetup(ownershipSetup);
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: ownershipSetup.startX,
    y: ownershipSetup.startY,
    button: "left",
    clickCount: 1,
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: ownershipSetup.finalX,
    y: ownershipSetup.finalY,
    button: "left",
  });
  await sleep(60);
  const ownershipLoss = await evaluateJson(
    liveClient,
    forceMixedDragOwnershipLossExpression(),
  );
  assertMixedDragOwnershipLoss(ownershipLoss);
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: ownershipSetup.finalX,
    y: ownershipSetup.finalY,
    button: "left",
    clickCount: 1,
  });
  const successiveOwnership = await evaluateJson(
    liveClient,
    mixedDragSuccessiveGestureExpression(),
  );
  assertMixedDragSuccessiveGesture(successiveOwnership);
  await establishPartialMixedSelection(liveClient);
  await evaluateJson(liveClient, clearSelectionStateExpression());
  console.log("MIXED DRAG OWNERSHIP RECOVERY CHECK:", {
    ownershipLoss,
    successiveOwnership,
  });

  const partialMoveSetup = await evaluateJson(
    liveClient,
    documentToTableDragSetupExpression(),
  );
  assertDocumentToTableDragSetup(partialMoveSetup);
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: partialMoveSetup.startX,
    y: partialMoveSetup.startY,
    button: "left",
    clickCount: 1,
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: partialMoveSetup.finalX,
    y: partialMoveSetup.finalY,
    button: "left",
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: partialMoveSetup.finalX,
    y: partialMoveSetup.finalY,
    button: "left",
    clickCount: 1,
  });
  await sleep(80);
  const partialMoveSelection = await evaluateJson(
    liveClient,
    documentToTableDragResultExpression(),
  );
  assertDocumentToTableDragResult(partialMoveSelection, [
    "0:0", "0:1", "1:0", "1:1", "2:0", "2:1",
  ], true);
  const partialMixedMove = await evaluateJson(
    liveClient,
    partialMixedSelectionMoveToTableExpression(),
  );
  assertPartialMixedSelectionMoveToTable(partialMixedMove);
  console.log("PARTIAL MIXED-SELECTION MOVE-TO-TABLE CHECK:", partialMixedMove);
  const documentClipboard = await evaluateJson(
    liveClient,
    documentClipboardExpression(),
  );
  assertDocumentClipboard(documentClipboard);
  console.log("DOCUMENT CLIPBOARD CHECK:", documentClipboard);
  const clipboardMoveRegressions = await evaluateJson(
    liveClient,
    clipboardMoveRegressionExpression(),
  );
  assertClipboardMoveRegressions(clipboardMoveRegressions);
  console.log("CLIPBOARD MOVE REGRESSION CHECK:", clipboardMoveRegressions);
  const resyncedHost = await evaluateJson(
    liveClient,
    setTestHostIsolationExpression(false),
  );
  assertTestHostIsolation(resyncedHost, false);
  console.log("REAL HOST DOCUMENT RESYNCED:", resyncedHost);
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
  // The scenario intentionally checks only the first undo (bas -> base).
  // Perform the second real host undo so both VS Code and the webview return
  // to the fixture before switching back to synthetic host snapshots.
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
  await sleep(250);
  const trustedUndoCleanup = await evaluateJson(
    liveClient,
    setTestHostIsolationExpression(false),
  );
  assertTestHostIsolation(trustedUndoCleanup, false);
  const simulatedUndoIsolation = await evaluateJson(
    liveClient,
    setTestHostIsolationExpression(true),
  );
  assertTestHostIsolation(simulatedUndoIsolation, true);
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
  const globalUndoHostResync = await evaluateJson(
    liveClient,
    setTestHostIsolationExpression(false),
  );
  assertTestHostIsolation(globalUndoHostResync, false);
  const globalUndoBridge = await evaluateJson(
    liveClient,
    tableGlobalUndoBridgeExpression(),
  );
  assertTableGlobalUndoBridge(globalUndoBridge);
  console.log("TABLE GLOBAL UNDO BRIDGE CHECK:", globalUndoBridge);
  const remainingSyntheticIsolation = await evaluateJson(
    liveClient,
    setTestHostIsolationExpression(true),
  );
  assertTestHostIsolation(remainingSyntheticIsolation, true);
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
  const documentEndSetup = await evaluateJson(
    liveClient,
    documentEndSelectionSetupExpression(),
  );
  assertDocumentEndSelectionSetup(documentEndSetup);
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: documentEndSetup.anchor.x,
    y: documentEndSetup.anchor.y,
    button: "left",
    clickCount: 1,
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: documentEndSetup.blankX,
    y: documentEndSetup.blankY,
    button: "left",
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: documentEndSetup.blankX,
    y: documentEndSetup.blankY,
    button: "left",
    clickCount: 1,
  });
  await sleep(100);
  const documentEndSelection = await evaluateJson(
    liveClient,
    documentEndSelectionResultExpression(),
  );
  assertDocumentEndSelection(documentEndSelection);
  console.log("DOCUMENT-END SELECTION BOUNDS CHECK:", documentEndSelection);
  await captureWorkbenchScreenshot(
    wb,
    path.join(qaDir, "edh-selection-document-end.png"),
  );
  const documentEndTableSetup = await evaluateJson(
    liveClient,
    documentEndTableSelectionSetupExpression(),
  );
  assertDocumentEndSelectionSetup(documentEndTableSetup);
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: documentEndTableSetup.anchor.x,
    y: documentEndTableSetup.anchor.y,
    button: "left",
    clickCount: 1,
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: documentEndTableSetup.blankX,
    y: documentEndTableSetup.blankY,
    button: "left",
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: documentEndTableSetup.blankX,
    y: documentEndTableSetup.blankY,
    button: "left",
    clickCount: 1,
  });
  await sleep(100);
  const documentEndTableSelection = await evaluateJson(
    liveClient,
    documentEndTableSelectionResultExpression(),
  );
  assertDocumentEndTableSelection(documentEndTableSelection);
  console.log(
    "DOCUMENT-END TABLE SELECTION BOUNDS CHECK:",
    documentEndTableSelection,
  );
  await captureWorkbenchScreenshot(
    wb,
    path.join(qaDir, "edh-selection-document-end-table.png"),
  );
  await runWrappedDownwardSelectionCheck(liveClient, wb);
  const restoredSelectionFixture = await evaluateJson(
    liveClient,
    restoreSelectionFixtureExpression(),
  );
  if (!restoredSelectionFixture?.ok || restoredSelectionFixture.tableCount < 2) {
    throw new Error(
      `Selection fixture restore failed: ${JSON.stringify(restoredSelectionFixture)}`,
    );
  }
  await runMixedImeHostConflictCheck(liveClient);
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
} catch (error) {
  if (
    error !== mixedInputOnlyComplete &&
    error !== editingReliabilityOnlyComplete &&
    error !== emptyDeleteOnlyComplete &&
    error !== wrappedSelectionOnlyComplete
  ) {
    throw error;
  }
} finally {
  await sleep(500);
  if (childExit === null) {
    child.kill("SIGTERM");
    await Promise.race([childExitPromise, sleep(5000)]);
  }
}

async function captureWorkbenchScreenshot(client, outputPath) {
  const shot = await client.send("Page.captureScreenshot", { format: "png" });
  if (shot.result?.data) {
    await writeFile(outputPath, Buffer.from(shot.result.data, "base64"));
    console.log(`Saved ${path.relative(repoRoot, outputPath)}`);
  }
}

async function runWrappedDownwardSelectionCheck(liveClient, wb) {
  const setup = await evaluateJson(
    liveClient,
    wrappedDownwardSelectionSetupExpression(),
  );
  assertWrappedDownwardSelectionSetup(setup);
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: setup.startX,
    y: setup.startY,
    button: "left",
    clickCount: 1,
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: setup.endX,
    y: setup.endY,
    button: "left",
  });
  await liveClient.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: setup.endX,
    y: setup.endY,
    button: "left",
    clickCount: 1,
  });
  await sleep(120);
  const result = await evaluateJson(
    liveClient,
    wrappedDownwardSelectionResultExpression(),
  );
  assertWrappedDownwardSelection(setup, result);
  console.log("WRAPPED DOWNWARD SELECTION CHECK:", result);
  await captureWorkbenchScreenshot(
    wb,
    path.join(qaDir, "edh-wrapped-downward-selection.png"),
  );
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

function activeTabStateExpression() {
  return `(() => {
    const activeTab = document.querySelector('.tab.active');
    return JSON.stringify({
      found: Boolean(activeTab),
      dirty: activeTab?.classList.contains('dirty') ?? null,
      className: activeTab?.className ?? null,
      label: activeTab?.getAttribute('aria-label') ?? activeTab?.textContent ?? null,
    });
  })()`;
}

function emptyTableCellDeleteSetupExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mlrt-table-widget'));
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const wrappers = Array.from(root?.querySelectorAll('.mlrt-table-widget') ?? []);
    const wrapper = wrappers[wrappers.length - 1];
    const cell = wrapper?.querySelector(
      '.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="0"]'
    );
    if (!root || !view || !wrapper || !cell) {
      return JSON.stringify({ ok: false, reason: 'missing empty table-cell targets' });
    }
    root.defaultView.__MLRT_EMPTY_DELETE_BEFORE__ = view.state.doc.toString();
    cell.focus();
    cell.dispatchEvent(new root.defaultView.KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true,
    }));
    return JSON.stringify({
      ok: true,
      cellText: cell.innerText.trim(),
      selectedCount: wrapper.querySelectorAll('.mlrt-table-cell-selected').length,
      wrapperFocused: root.activeElement === wrapper,
    });
  })()`;
}

function emptyTableCellDeleteResultExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mlrt-table-widget'));
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const wrappers = Array.from(root?.querySelectorAll('.mlrt-table-widget') ?? []);
    const wrapper = wrappers[wrappers.length - 1];
    if (!root || !view || !wrapper) {
      return JSON.stringify({ ok: false, reason: 'missing empty table-cell result targets' });
    }
    return JSON.stringify({
      ok: true,
      documentUnchanged:
        view.state.doc.toString() === root.defaultView.__MLRT_EMPTY_DELETE_BEFORE__,
      selectedCount: wrapper.querySelectorAll('.mlrt-table-cell-selected').length,
    });
  })()`;
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

function documentEndScrollExpression() {
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try {
        return frame.contentDocument;
      } catch {
        return null;
      }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.cm-scroller'));
    const view = root?.defaultView?.__MLRT_EDITOR_VIEW__;
    const scroller = root?.querySelector('.cm-scroller');
    const content = root?.querySelector('.cm-content');
    if (!root || !view || !scroller || !content) {
      return JSON.stringify({ ok: false, reason: 'missing live scroll targets' });
    }
    scroller.scrollTop = scroller.scrollHeight;
    await new Promise((resolve) => root.defaultView.requestAnimationFrame(() =>
      root.defaultView.requestAnimationFrame(resolve)
    ));
    const scrollerRect = scroller.getBoundingClientRect();
    const finalCaret = view.coordsAtPos(view.state.doc.length);
    const finalPositionDom = view.domAtPos(view.state.doc.length).node;
    const finalPositionElement = finalPositionDom.nodeType === Node.ELEMENT_NODE
      ? finalPositionDom
      : finalPositionDom.parentElement;
    const finalLine = finalPositionElement?.closest('.cm-line');
    return JSON.stringify({
      ok: true,
      clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
      scrollTop: scroller.scrollTop,
      maxScrollTop: scroller.scrollHeight - scroller.clientHeight,
      finalLineViewportTop: finalLine
        ? finalLine.getBoundingClientRect().top - scrollerRect.top
        : null,
      finalCaretViewportTop: finalCaret ? finalCaret.top - scrollerRect.top : null,
      lineHeight: parseFloat(root.defaultView.getComputedStyle(content).lineHeight),
      paddingBottom: parseFloat(root.defaultView.getComputedStyle(content).paddingBottom),
    });
  })()`;
}

function resetDocumentScrollExpression() {
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try {
        return frame.contentDocument;
      } catch {
        return null;
      }
    }).filter(Boolean)];
    const scroller = roots
      .map((root) => root.querySelector('.cm-scroller'))
      .find(Boolean);
    if (!scroller) return JSON.stringify({ ok: false });
    scroller.scrollTop = 0;
    await new Promise((resolve) => scroller.ownerDocument.defaultView.requestAnimationFrame(resolve));
    return JSON.stringify({ ok: scroller.scrollTop === 0 });
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
    const afterBaseDoc = view.state.doc.toString();
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
    if (root.defaultView.__MLRT_TEST_HOST_ISOLATED__) {
      root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
        data: {
          type: 'setDocument',
          text: afterBaseDoc,
          revision: 999009,
          debug: false,
        },
      }));
    }
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
    const liveRoot = root.querySelector('.cm-editor');
    const activeLine = root.querySelector('.cm-activeLine');
    const activeLineGutter = root.querySelector('.cm-activeLineGutter');
    const inactiveLineGutter = Array.from(root.querySelectorAll('.cm-lineNumbers .cm-gutterElement'))
      .find((candidate) => candidate !== activeLineGutter && candidate.textContent.trim());
    const selectionSuppressesActiveLine = Boolean(
      liveRoot?.classList.contains('mlrt-selection-active') &&
      activeLine &&
      ['transparent', 'rgba(0, 0, 0, 0)'].includes(root.defaultView.getComputedStyle(activeLine).backgroundColor) &&
      activeLineGutter &&
      inactiveLineGutter &&
      root.defaultView.getComputedStyle(activeLineGutter).color ===
        root.defaultView.getComputedStyle(inactiveLineGutter).color
    );

    const headerCell = wrapper.querySelector('.mlrt-table-cell[data-row-kind="header"][data-column="0"]');
    headerCell?.focus();
    if (headerCell) key(headerCell, 'Escape');
    await wait();
    if (headerCell) key(wrapper, 'ArrowUp');
    await wait();
    const expectedBeforeTable = Math.max(0, Number(wrapper.dataset.srcFrom) - 1);
    const selectedArrowUpEscaped =
      wrapper.querySelectorAll('.mlrt-table-cell-selected').length === 0 &&
      root.activeElement === view.contentDOM &&
      view.state.selection.main.empty &&
      view.state.selection.main.head === expectedBeforeTable;

    const cells = Array.from(wrapper.querySelectorAll('.mlrt-table-cell'));
    const lastCell = cells[cells.length - 1];
    lastCell?.focus();
    if (lastCell) key(lastCell, 'Escape');
    await wait();
    if (lastCell) key(wrapper, 'ArrowDown');
    await wait();
    const tableTo = Number(wrapper.dataset.srcTo);
    const afterTable = tableTo < view.state.doc.length && view.state.doc.sliceString(tableTo, tableTo + 1) === '\\n'
      ? tableTo + 1
      : tableTo;
    const expectedAfterTable = view.state.doc.lineAt(afterTable).to;
    const selectedArrowDownEscaped =
      wrapper.querySelectorAll('.mlrt-table-cell-selected').length === 0 &&
      root.activeElement === view.contentDOM &&
      view.state.selection.main.empty &&
      view.state.selection.main.head === expectedAfterTable;

    cell.focus();
    key(cell, 'Escape');
    key(wrapper, 'ArrowRight', { shiftKey: true });
    await wait();
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
    const visualCutTransfer = new root.defaultView.DataTransfer();
    restoredWrapper?.dispatchEvent(new root.defaultView.ClipboardEvent('cut', {
      clipboardData: visualCutTransfer, bubbles: true, cancelable: true,
    }));
    await wait();
    const cutOverlay = restoredWrapper?.querySelector('.mlrt-table-selection-overlay');
    const cutGrid = cutOverlay?.querySelector('.mlrt-table-selection-grid');
    const cutFrame = cutOverlay?.querySelector('.mlrt-table-selection-frame');
    const cutGridStyle = cutGrid ? root.defaultView.getComputedStyle(cutGrid) : null;
    const cutFrameStyle = cutFrame ? root.defaultView.getComputedStyle(cutFrame) : null;
    const cutSourceEdge = restoredWrapper?.querySelector('.mlrt-table-cut-source-top.mlrt-table-cut-source-left');
    const cutSourcePseudoStyle = cutSourceEdge
      ? root.defaultView.getComputedStyle(cutSourceEdge, '::before')
      : null;
    return JSON.stringify({
      ok: true,
      escapedDefault,
      singleSelected,
      rangeSelected,
      selectionSuppressesActiveLine,
      selectedArrowUpEscaped,
      selectedArrowDownEscaped,
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
      multiCellCutSelectedCount: restoredWrapper?.querySelectorAll('.mlrt-table-cell-selected').length ?? 0,
      multiCellCutOverlayPreserved: Boolean(cutOverlay && cutGrid && cutFrame),
      multiCellCutInteriorRailCount:
        Number(cutOverlay?.dataset.verticalRailCount ?? 0) +
        Number(cutOverlay?.dataset.horizontalRailCount ?? 0),
      multiCellCutGridVisible: Boolean(cutGridStyle && cutGridStyle.stroke !== 'none' && cutGridStyle.stroke !== 'rgba(0, 0, 0, 0)'),
      multiCellCutFrameDashed: Boolean(cutFrameStyle && cutFrameStyle.strokeDasharray !== 'none'),
      multiCellCutSourcePseudoSuppressed: Boolean(cutSourcePseudoStyle &&
        [cutSourcePseudoStyle.borderTopWidth, cutSourcePseudoStyle.borderRightWidth,
          cutSourcePseudoStyle.borderBottomWidth, cutSourcePseudoStyle.borderLeftWidth]
          .every((width) => Number.parseFloat(width) === 0)),
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
    const frame = () => new Promise((done) => root.defaultView.requestAnimationFrame(done));
    const wait = () => new Promise((done) => root.defaultView.requestAnimationFrame(() => root.defaultView.requestAnimationFrame(done)));
    const key = (target, keyValue, options = {}) => target.dispatchEvent(new root.defaultView.KeyboardEvent('keydown', {
      key: keyValue, bubbles: true, cancelable: true, ...options,
    }));
    const text = [
      '| Key | Value | Note |',
      '| --- | --- | --- |',
      '| One | Alpha wraps repeatedly so the selected row changes height when the editor narrows and widens | First |',
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
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    };
    const nearlyEqual = (left, right, tolerance = 0.25) => Math.abs(left - right) <= tolerance;
    const boxesMatch = (left, right) => Boolean(left && right) &&
      ['left', 'top', 'right', 'bottom'].every((side) => nearlyEqual(left[side], right[side]));
    const uniqueCoordinates = (values) => values.sort((left, right) => left - right).reduce((result, value) => {
      const previous = result[result.length - 1];
      if (previous === undefined || Math.abs(previous - value) > 0.25) result.push(value);
      return result;
    }, []);
    const transparent = (value) => value === 'transparent' ||
      /rgba?\\([^)]*,\\s*0(?:\\.0+)?\\)$/.test(value) || /\\/ 0\\)$/.test(value);
    const parseRails = (value) => value ? value.split(',').map(Number) : [];
    const railsMatch = (actual, expected) => actual.length === expected.length &&
      actual.every((value, index) => nearlyEqual(value, expected[index]));
    const formatCoordinate = (value) => String(Math.round(value * 1000) / 1000);
    const measureGeometry = () => {
      const selected = Array.from(wrapper.querySelectorAll('.mlrt-table-cell-selected'));
      const selectedRects = selected.map(rect);
      const overlay = wrapper.querySelector('.mlrt-table-selection-overlay');
      const grid = overlay?.querySelector('.mlrt-table-selection-grid');
      const frame = overlay?.querySelector('.mlrt-table-selection-frame');
      if (!overlay || !grid || !frame || selectedRects.length === 0) {
        return { ok: false, selectedCount: selected.length, reason: 'missing unified selection overlay' };
      }
      const bounds = {
        left: Math.min(...selectedRects.map((box) => box.left)),
        top: Math.min(...selectedRects.map((box) => box.top)),
        right: Math.max(...selectedRects.map((box) => box.right)),
        bottom: Math.max(...selectedRects.map((box) => box.bottom)),
      };
      bounds.width = bounds.right - bounds.left;
      bounds.height = bounds.bottom - bounds.top;
      const expectedVerticalRails = uniqueCoordinates(selectedRects.map((box) => box.left))
        .filter((value) => value > bounds.left + 0.25 && value < bounds.right - 0.25)
        .map((value) => value - bounds.left);
      const expectedHorizontalRails = uniqueCoordinates(selectedRects.map((box) => box.top))
        .filter((value) => value > bounds.top + 0.25 && value < bounds.bottom - 0.25)
        .map((value) => value - bounds.top);
      const verticalRails = parseRails(overlay.dataset.verticalRails);
      const horizontalRails = parseRails(overlay.dataset.horizontalRails);
      const gridBounds = grid.getBBox();
      const gridStyle = root.defaultView.getComputedStyle(grid);
      const frameStyle = root.defaultView.getComputedStyle(frame);
      const cellStyles = selected.map((item) => root.defaultView.getComputedStyle(item));
      const inset = Math.min(1, bounds.width / 2, bounds.height / 2);
      const expectedGridPath = [
        ...verticalRails.map((x) =>
          'M ' + formatCoordinate(x) + ' ' + formatCoordinate(inset) +
          ' V ' + formatCoordinate(bounds.height - inset)),
        ...horizontalRails.map((y) =>
          'M ' + formatCoordinate(inset) + ' ' + formatCoordinate(y) +
          ' H ' + formatCoordinate(bounds.width - inset)),
      ].join(' ');
      return {
        ok: true,
        selectedCount: selected.length,
        bounds,
        overlayRect: rect(overlay),
        overlayBoundsAligned: boxesMatch(rect(overlay), bounds),
        oneOverlay: wrapper.querySelectorAll('.mlrt-table-selection-overlay').length === 1,
        oneGrid: overlay.querySelectorAll('.mlrt-table-selection-grid').length === 1,
        oneFrame: overlay.querySelectorAll('.mlrt-table-selection-frame').length === 1,
        framePaintedLast: overlay.lastElementChild === frame,
        frameStroke: frameStyle.stroke,
        frameStrokeWidth: frameStyle.strokeWidth,
        frameCoordinatesAligned:
          nearlyEqual(Number(frame.getAttribute('x')), 0.5) &&
          nearlyEqual(Number(frame.getAttribute('y')), 0.5) &&
          nearlyEqual(Number(frame.getAttribute('width')), bounds.width - 1) &&
          nearlyEqual(Number(frame.getAttribute('height')), bounds.height - 1),
        verticalRails,
        horizontalRails,
        expectedVerticalRails,
        expectedHorizontalRails,
        railsAligned:
          railsMatch(verticalRails, expectedVerticalRails) &&
          railsMatch(horizontalRails, expectedHorizontalRails),
        railCount:
          Number(overlay.dataset.verticalRailCount) +
          Number(overlay.dataset.horizontalRailCount),
        railsTrimmedInsideFrame:
          gridBounds.x >= 0.75 &&
          gridBounds.y >= 0.75 &&
          gridBounds.x + gridBounds.width <= bounds.width - 0.75 &&
          gridBounds.y + gridBounds.height <= bounds.height - 0.75,
        gridPath: grid.getAttribute('d'),
        railEndpointsExact: grid.getAttribute('d') === expectedGridPath,
        gridStrokeWidth: gridStyle.strokeWidth,
        gridStrokeLinecap: gridStyle.strokeLinecap,
        gridVectorEffect: gridStyle.vectorEffect,
        gridShapeRendering: gridStyle.shapeRendering,
        frameStrokeLinejoin: frameStyle.strokeLinejoin,
        frameVectorEffect: frameStyle.vectorEffect,
        frameShapeRendering: frameStyle.shapeRendering,
        noCellInsetShadows: cellStyles.every((style) => !style.boxShadow.includes('inset')),
        selectedBordersTransparent: cellStyles.every((style) =>
          [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor].every(transparent)),
        edgeClasses: selected.map((item) => item.className),
      };
    };
    const baseline = measureGeometry();
    const rightNeighbor = wrapper.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="2"]');
    const bottomNeighbor = wrapper.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="3"][data-column="0"]');
    const editor = root.querySelector('.cm-editor');
    const originalWidth = editor?.style.width ?? '';
    const settleGeometry = async () => {
      let previous = null;
      let consecutiveStableFrames = 0;
      let alwaysAligned = true;
      let current = measureGeometry();
      for (let attempt = 1; attempt <= 12; attempt += 1) {
        await frame();
        current = measureGeometry();
        alwaysAligned = alwaysAligned && Boolean(current.overlayBoundsAligned && current.railsAligned);
        if (previous && boxesMatch(previous.overlayRect, current.overlayRect)) {
          consecutiveStableFrames += 1;
        } else {
          consecutiveStableFrames = 0;
        }
        if (consecutiveStableFrames >= 2) {
          return { geometry: current, stable: true, alwaysAligned, attempts: attempt };
        }
        previous = current;
      }
      return { geometry: current, stable: false, alwaysAligned, attempts: 12 };
    };
    const resizeCases = [];
    for (const width of [500, 360, 480, 340, 500]) {
      if (editor) editor.style.width = width + 'px';
      const settled = await settleGeometry();
      const geometry = settled.geometry;
      resizeCases.push({
        width,
        selectedHeight: geometry.bounds?.height ?? 0,
        selectedWidth: geometry.bounds?.width ?? 0,
        aligned: Boolean(geometry.overlayBoundsAligned && geometry.railsAligned),
        alwaysAligned: settled.alwaysAligned,
        stable: settled.stable,
        settleAttempts: settled.attempts,
        railCount: geometry.railCount,
        selectedCount: geometry.selectedCount,
      });
    }
    const tableScroll = wrapper.querySelector('.mlrt-table-scroll');
    const sourceLine = Array.from(wrapper.querySelectorAll('.mlrt-table-source-line')).find((item) => {
      const box = rect(item);
      return box.top < baseline.bounds.bottom && box.bottom > baseline.bounds.top;
    });
    const previousTableScrollWidth = tableScroll?.style.width ?? '';
    const previousTableScrollMaxWidth = tableScroll?.style.maxWidth ?? '';
    const previousTableScrollLeft = tableScroll?.scrollLeft ?? 0;
    let horizontalScrollCase = { ok: false, reason: 'missing scroll targets' };
    if (tableScroll && sourceLine) {
      tableScroll.style.width = '240px';
      tableScroll.style.maxWidth = '240px';
      tableScroll.scrollLeft = 0;
      tableScroll.dispatchEvent(new root.defaultView.Event('scroll'));
      await settleGeometry();
      const sourceBefore = rect(sourceLine);
      const overlayBefore = rect(wrapper.querySelector('.mlrt-table-selection-overlay'));
      const maximumScrollLeft = Math.max(0, tableScroll.scrollWidth - tableScroll.clientWidth);
      const gutterMidpoint = (sourceBefore.left + sourceBefore.right) / 2;
      tableScroll.scrollLeft = Math.min(
        maximumScrollLeft,
        Math.max(1, overlayBefore.left - gutterMidpoint),
      );
      tableScroll.dispatchEvent(new root.defaultView.Event('scroll'));
      await frame();
      const scrolledGeometry = measureGeometry();
      const sourceAfter = rect(sourceLine);
      const overlay = wrapper.querySelector('.mlrt-table-selection-overlay');
      const overlayZIndex = Number(root.defaultView.getComputedStyle(overlay).zIndex);
      const sourceStyle = root.defaultView.getComputedStyle(sourceLine);
      const sourceZIndex = Number(sourceStyle.zIndex);
      horizontalScrollCase = {
        ok: true,
        overflowed: tableScroll.scrollWidth > tableScroll.clientWidth + 1,
        scrolled: tableScroll.scrollLeft > 0,
        geometryAligned: Boolean(scrolledGeometry.overlayBoundsAligned && scrolledGeometry.railsAligned),
        sourceLineStayedSticky: nearlyEqual(sourceBefore.left, sourceAfter.left),
        selectionIntersectsGutter:
          scrolledGeometry.overlayRect.left < sourceAfter.right &&
          scrolledGeometry.overlayRect.right > sourceAfter.left &&
          scrolledGeometry.overlayRect.top < sourceAfter.bottom &&
          scrolledGeometry.overlayRect.bottom > sourceAfter.top,
        gutterPaintsAboveSelection: sourceZIndex > overlayZIndex,
        gutterBackgroundOpaque: !transparent(sourceStyle.backgroundColor),
        overlayZIndex,
        sourceZIndex,
      };
      tableScroll.style.width = previousTableScrollWidth;
      tableScroll.style.maxWidth = previousTableScrollMaxWidth;
      tableScroll.scrollLeft = previousTableScrollLeft;
      tableScroll.dispatchEvent(new root.defaultView.Event('scroll'));
    }
    if (editor) editor.style.width = originalWidth;
    const restoredSettle = await settleGeometry();
    const restored = restoredSettle.geometry;
    const observedHeights = uniqueCoordinates([
      baseline.bounds?.height ?? 0,
      ...resizeCases.map((item) => item.selectedHeight),
    ]);
    return JSON.stringify({
      ok: baseline.ok && baseline.selectedCount === 6,
      baseline,
      restored,
      restoredStable: restoredSettle.stable && restoredSettle.alwaysAligned,
      resizeCases,
      horizontalScrollCase,
      repeatedResizeAligned: resizeCases.every((item) =>
        item.aligned && item.alwaysAligned && item.stable && item.railCount === 3 && item.selectedCount === 6),
      resizeCausedRealReflow: observedHeights.length > 1,
      rightNeighborAligned: Boolean(rightNeighbor) && nearlyEqual(rect(rightNeighbor).left, baseline.bounds.right),
      bottomNeighborAligned: Boolean(bottomNeighbor) && nearlyEqual(rect(bottomNeighbor).top, baseline.bounds.bottom),
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

function proseCharacterSelectionSetupExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_EDITOR_VIEW__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    if (!root || !view) return JSON.stringify({ ok: false, reason: 'missing prose editor' });
    const source = view.state.doc.toString();
    const lineStart = source.indexOf('Text up here at.');
    const anchorPos = lineStart + 2;
    const pointForPos = (pos) => {
      const caret = view.coordsAtPos(pos);
      if (!caret) return null;
      const y = (caret.top + caret.bottom) / 2;
      for (const dx of [-0.45, -0.2, 0.05, 0.2, 0.45, 0.8]) {
        const x = caret.left + dx;
        if (view.posAtCoords({ x, y }) === pos) return { x, y, pos };
      }
      return null;
    };
    const anchor = pointForPos(anchorPos);
    const heads = Array.from({ length: 7 }, (_, index) => pointForPos(anchorPos + index + 1));
    view.focus();
    view.dispatch({ selection: { anchor: 0 } });
    return JSON.stringify({
      ok: Boolean(anchor && heads.every(Boolean)),
      anchor,
      heads: heads.map((point) => ({
        ...point,
        expectedText: source.slice(anchorPos, point?.pos ?? anchorPos),
      })),
    });
  })()`;
}

function proseCharacterSelectionResultExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_EDITOR_VIEW__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const range = view?.state.selection.main;
    if (!root || !view || !range) return JSON.stringify({ ok: false });
    const marks = Array.from(root.querySelectorAll('.mlrt-prose-selection'));
    const boxes = marks.map((mark) => mark.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0);
    const expectedLeft = view.coordsAtPos(range.from)?.left ?? null;
    const expectedRight = view.coordsAtPos(range.to)?.left ?? null;
    const actualLeft = boxes.length ? Math.min(...boxes.map((box) => box.left)) : null;
    const actualRight = boxes.length ? Math.max(...boxes.map((box) => box.right)) : null;
    const markBackgrounds = marks.map((mark) =>
      root.defaultView.getComputedStyle(mark).backgroundColor
    );
    const markedLines = Array.from(new Set(marks.map((mark) => mark.closest('.cm-line')).filter(Boolean)));
    const markedLineBackgrounds = markedLines.map((line) =>
      root.defaultView.getComputedStyle(line).backgroundColor
    );
    const transparent = (value) =>
      value === 'transparent' ||
      /^rgba\\(\\s*0\\s*,\\s*0\\s*,\\s*0\\s*,\\s*0\\s*\\)$/.test(value) ||
      /\\/\\s*0(?:\\.0+)?\\s*\\)$/.test(value);
    return JSON.stringify({
      ok: true,
      anchor: range.anchor,
      head: range.head,
      selectedText: view.state.doc.sliceString(range.from, range.to),
      markCount: marks.length,
      markBoxCount: boxes.length,
      leftDelta: actualLeft === null || expectedLeft === null ? null : Math.abs(actualLeft - expectedLeft),
      rightDelta: actualRight === null || expectedRight === null ? null : Math.abs(actualRight - expectedRight),
      markFillVisible: markBackgrounds.length > 0 && markBackgrounds.every((value) => !transparent(value)),
      markBackgrounds,
      selectionFillBlanketLineCount: markedLineBackgrounds.filter((value) =>
        markBackgrounds.includes(value)
      ).length,
      blanketLineCount: root.querySelectorAll('.mlrt-document-range-selected-line').length,
      visibleCodeMirrorBoxCount: Array.from(root.querySelectorAll('.cm-selectionBackground')).filter((element) => {
        const style = root.defaultView.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && rect.width > 0 && rect.height > 0;
      }).length,
      selectedCellCount: root.querySelectorAll('.mlrt-document-range-selected, .mlrt-table-cell-selected').length,
    });
  })()`;
}

function proseMultilineSelectionExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_EDITOR_VIEW__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    if (!root || !view) return JSON.stringify({ ok: false });
    const source = view.state.doc.toString();
    const firstLine = '- list';
    const lastLine = '- continued';
    const from = source.indexOf(firstLine);
    const to = source.indexOf(lastLine, from) + lastLine.length;
    if (from < 0 || to <= from) return JSON.stringify({ ok: false, reason: 'fixture prose missing' });
    view.focus();
    view.dispatch({ selection: { anchor: from, head: to } });
    return JSON.stringify({
      ok: true,
      expectedText: source.slice(from, to),
    });
  })()`;
}

function proseMultilineSelectionResultExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_EDITOR_VIEW__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    if (!root || !view) return JSON.stringify({ ok: false });
    const marks = Array.from(root.querySelectorAll('.mlrt-prose-selection'));
    const details = marks.map((mark) => {
      const style = root.defaultView.getComputedStyle(mark);
      const rect = mark.getBoundingClientRect();
      return {
        text: mark.textContent,
        continuesFromPrevious: mark.classList.contains('mlrt-prose-selection-continues-from-previous'),
        continuesToNext: mark.classList.contains('mlrt-prose-selection-continues-to-next'),
        connectsTopLeft: mark.classList.contains('mlrt-prose-selection-connects-top-left'),
        connectsTopRight: mark.classList.contains('mlrt-prose-selection-connects-top-right'),
        connectsBottomLeft: mark.classList.contains('mlrt-prose-selection-connects-bottom-left'),
        connectsBottomRight: mark.classList.contains('mlrt-prose-selection-connects-bottom-right'),
        borderTopLeftRadius: style.borderTopLeftRadius,
        borderTopRightRadius: style.borderTopRightRadius,
        borderBottomLeftRadius: style.borderBottomLeftRadius,
        borderBottomRightRadius: style.borderBottomRightRadius,
        background: style.backgroundColor,
        paintedTop: rect.top,
        paintedBottom: rect.bottom,
      };
    });
    return JSON.stringify({
      ok: true,
      selectedText: view.state.doc.sliceString(view.state.selection.main.from, view.state.selection.main.to),
      details,
    });
  })()`;
}

function wrappedDownwardSelectionSetupExpression() {
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_EDITOR_VIEW__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    if (!root || !view) return JSON.stringify({ ok: false, reason: 'missing wrapped selection editor' });
    const text = [
      '# Downward Selection Fixture',
      '',
      'This is a deliberately long prose line with compatibility tests near its middle, followed by enough words to wrap across several visual rows in the live editor.',
      'Another fully selected prose line is also intentionally long so a downward drag must paint every wrapped fragment before it enters the rendered table below.',
      '',
      '| # | Feature | Markdown In Table Cell | Expected Renderer Behavior |',
      '| --- | --- | --- | --- |',
      '| 1 | Plain text | Regular text with numbers 12345 and punctuation. | Baseline cell rendering. |',
      '| 2 | Escaped characters | Not italic and not bold. | Escaped punctuation remains visible. |',
      '| 3 | Entities | Ampersand, less-than, and copyright. | Entities display consistently. |',
      '| 4 | Emphasis | Bold, italic, and strikethrough. | Inline emphasis rendering. |',
      '| 5 | Nested emphasis | Nested inline content. | Nested parsing. |',
    ].join('\\n');
    root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
      data: { type: 'setDocument', text, revision: 999811, debug: false },
    }));
    await new Promise((done) => root.defaultView.requestAnimationFrame(() =>
      root.defaultView.requestAnimationFrame(() => root.defaultView.requestAnimationFrame(done))
    ));
    view.scrollDOM.scrollTop = 0;
    const wrapper = root.querySelector('.mlrt-table-widget');
    const target = wrapper?.querySelector(
      '.mlrt-table-cell[data-row-kind="body"][data-row-index="3"][data-column="1"]'
    );
    const anchor = text.indexOf('compatibility tests');
    const caret = view.coordsAtPos(anchor);
    const y = caret ? (caret.top + caret.bottom) / 2 : 0;
    let start = null;
    if (caret) {
      for (const dx of [-0.45, -0.2, 0.05, 0.2, 0.45, 0.8]) {
        const x = caret.left + dx;
        if (view.posAtCoords({ x, y }) === anchor) { start = { x, y }; break; }
      }
    }
    const targetRect = target?.getBoundingClientRect();
    const head = Number(target?.dataset.sourceTo ?? 'NaN');
    return JSON.stringify({
      ok: Boolean(start && targetRect && Number.isFinite(head)),
      startX: start?.x ?? 0,
      startY: start?.y ?? 0,
      endX: targetRect ? targetRect.left + Math.min(18, targetRect.width / 2) : 0,
      endY: targetRect ? targetRect.top + Math.min(10, targetRect.height / 2) : 0,
      anchor,
      head,
      expectedText: Number.isFinite(head) ? text.slice(anchor, head) : '',
      expectedAddresses: [
        '0:0', '0:1', '1:0', '1:1', '2:0',
        '2:1', '3:0', '3:1', '4:0', '4:1',
      ],
    });
  })()`;
}

function wrappedDownwardSelectionResultExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_EDITOR_VIEW__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const wrapper = root?.querySelector('.mlrt-table-widget');
    const range = view?.state.selection.main;
    if (!root || !view || !wrapper || !range) return JSON.stringify({ ok: false });
    const marks = Array.from(root.querySelectorAll('.mlrt-prose-selection'));
    const transparent = (value) =>
      value === 'transparent' ||
      /^rgba\\(\\s*0\\s*,\\s*0\\s*,\\s*0\\s*,\\s*0\\s*\\)$/.test(value) ||
      /\\/\\s*0(?:\\.0+)?\\s*\\)$/.test(value);
    const fragmentRects = marks.flatMap((mark) =>
      Array.from(mark.getClientRects()).map((rect) => ({
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      }))
    ).filter((rect) => rect.width > 0 && rect.height > 0);
    const wrapRows = Array.from(new Set(fragmentRects.map((rect) => Math.round(rect.top * 2) / 2)));
    const selectedAddresses = Array.from(wrapper.querySelectorAll('.mlrt-document-range-selected'))
      .map((cell) =>
        (cell.dataset.rowKind === 'header' ? 0 : Number(cell.dataset.rowIndex) + 1) +
        ':' + Number(cell.dataset.column)
      ).sort();
    const directBackgrounds = marks.map((mark) =>
      root.defaultView.getComputedStyle(mark).backgroundColor
    );
    const pseudoContents = marks.map((mark) =>
      root.defaultView.getComputedStyle(mark, '::before').content
    );
    return JSON.stringify({
      ok: true,
      anchor: range.anchor,
      head: range.head,
      selectedText: view.state.doc.sliceString(range.from, range.to),
      selectedAddresses,
      markCount: marks.length,
      fragmentCount: fragmentRects.length,
      wrapRowCount: wrapRows.length,
      fragmentRects,
      directBackgrounds,
      everyFragmentUsesDirectFill:
        directBackgrounds.length > 0 && directBackgrounds.every((value) => !transparent(value)),
      pseudoHighlightsDisabled: pseudoContents.every((value) => value === 'none'),
      visibleCodeMirrorBoxCount: Array.from(root.querySelectorAll('.cm-selectionBackground'))
        .filter((element) => {
          const style = root.defaultView.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && rect.width > 0 && rect.height > 0;
        }).length,
      overlayCount: wrapper.querySelectorAll('.mlrt-table-selection-overlay').length,
    });
  })()`;
}

function proseBlankLineSelectionExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_EDITOR_VIEW__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    if (!root || !view) return JSON.stringify({ ok: false });
    const source = view.state.doc.toString();
    const from = view.state.doc.line(9).from;
    const to = view.state.doc.line(12).from;
    view.focus();
    view.dispatch({ selection: { anchor: to, head: from } });
    return JSON.stringify({ ok: true, expectedText: source.slice(from, to) });
  })()`;
}

function proseBlankLineSelectionResultExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_EDITOR_VIEW__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    if (!root || !view) return JSON.stringify({ ok: false });
    const markers = Array.from(root.querySelectorAll('.mlrt-prose-selection-empty-line'));
    const details = markers.map((marker) => {
      const style = root.defaultView.getComputedStyle(marker, '::before');
      return {
        continuesFromPrevious: marker.classList.contains('mlrt-prose-selection-continues-from-previous'),
        continuesToNext: marker.classList.contains('mlrt-prose-selection-continues-to-next'),
        width: style.width,
        height: style.height,
        background: style.backgroundColor,
        borderTopLeftRadius: style.borderTopLeftRadius,
        borderBottomLeftRadius: style.borderBottomLeftRadius,
      };
    });
    return JSON.stringify({
      ok: true,
      selectedText: view.state.doc.sliceString(view.state.selection.main.from, view.state.selection.main.to),
      markerCount: markers.length,
      details,
    });
  })()`;
}

function documentEndSelectionSetupExpression() {
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_EDITOR_VIEW__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    if (!root || !view) return JSON.stringify({ ok: false, reason: 'missing end editor' });
    root.defaultView.__MLRT_SELECTION_FIXTURE__ ??= view.state.doc.toString();
    const shortText = 'alpha beta gamma\\nfinal yz';
    root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
      data: { type: 'setDocument', text: shortText, revision: 999801, debug: false },
    }));
    await new Promise((done) => root.defaultView.requestAnimationFrame(() => root.defaultView.requestAnimationFrame(done)));
    const anchorPos = shortText.indexOf('beta');
    const caret = view.coordsAtPos(anchorPos);
    const y = caret ? (caret.top + caret.bottom) / 2 : 0;
    let anchor = null;
    if (caret) {
      for (const dx of [-0.45, -0.2, 0.05, 0.2, 0.45, 0.8]) {
        const x = caret.left + dx;
        if (view.posAtCoords({ x, y }) === anchorPos) { anchor = { x, y, pos: anchorPos }; break; }
      }
    }
    const scroller = view.scrollDOM.getBoundingClientRect();
    return JSON.stringify({
      ok: Boolean(anchor),
      anchor,
      blankX: Math.max(scroller.left + 80, caret?.left ?? 80),
      blankY: scroller.bottom - 24,
      docLength: view.state.doc.length,
    });
  })()`;
}

function captureSelectionFixtureExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_EDITOR_VIEW__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    if (!root || !view) return JSON.stringify({ ok: false });
    root.defaultView.__MLRT_SELECTION_FIXTURE__ = view.state.doc.toString();
    return JSON.stringify({
      ok: true,
      documentLength: view.state.doc.length,
      tableCount: root.querySelectorAll('.mlrt-table-widget').length,
    });
  })()`;
}

function setTestHostIsolationExpression(isolated) {
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_EDITOR_VIEW__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const setIsolation = root?.defaultView.__MLRT_TEST_SET_HOST_ISOLATION__;
    if (!root || !view || typeof setIsolation !== 'function') {
      return JSON.stringify({
        ok: false,
        reason: 'missing test host isolation hook',
        hasRoot: Boolean(root),
        hasView: Boolean(view),
        hasHook: typeof setIsolation === 'function',
      });
    }
    setIsolation(${isolated ? "true" : "false"});
    const deadline = Date.now() + 3000;
    while (
      root.defaultView.__MLRT_TEST_HOST_RESYNC_PENDING__ &&
      Date.now() < deadline
    ) {
      await new Promise((done) => root.defaultView.setTimeout(done, 25));
    }
    await new Promise((done) => {
      root.defaultView.requestAnimationFrame(() => {
        root.defaultView.requestAnimationFrame(done);
      });
    });
    const fixture = root.defaultView.__MLRT_SELECTION_FIXTURE__;
    return JSON.stringify({
      ok: true,
      isolated: root.defaultView.__MLRT_TEST_HOST_ISOLATED__ === true,
      resyncPending:
        root.defaultView.__MLRT_TEST_HOST_RESYNC_PENDING__ === true,
      matchesFixture:
        typeof fixture === 'string' && view.state.doc.toString() === fixture,
      documentLength: view.state.doc.length,
    });
  })()`;
}

function documentEndSelectionResultExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_EDITOR_VIEW__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const range = view?.state.selection.main;
    if (!root || !view || !range) return JSON.stringify({ ok: false });
    const finalLine = view.state.doc.line(view.state.doc.lines);
    const finalLineElement = Array.from(root.querySelectorAll('.cm-line:not(.mlrt-hidden-table-source-line)')).find((line) => {
      try { return view.posAtDOM(line, 0) === finalLine.from; } catch { return false; }
    });
    const finalLineRect = finalLineElement?.getBoundingClientRect();
    const markRects = Array.from(root.querySelectorAll('.mlrt-prose-selection'))
      .map((mark) => mark.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    const maxMarkBottom = markRects.length ? Math.max(...markRects.map((rect) => rect.bottom)) : null;
    const maxMarkRightOnFinalLine = finalLineRect
      ? Math.max(...markRects.filter((rect) => rect.bottom > finalLineRect.top && rect.top < finalLineRect.bottom).map((rect) => rect.right), -Infinity)
      : null;
    const endCaret = view.coordsAtPos(view.state.doc.length);
    return JSON.stringify({
      ok: true,
      head: range.head,
      anchor: range.anchor,
      docLength: view.state.doc.length,
      selectedText: view.state.doc.sliceString(range.from, range.to),
      finalLineBottom: finalLineRect?.bottom ?? null,
      maxMarkBottom,
      finalLineMarkCount: finalLineRect
        ? markRects.filter((rect) => rect.bottom > finalLineRect.top && rect.top < finalLineRect.bottom).length
        : 0,
      finalRightDelta: Number.isFinite(maxMarkRightOnFinalLine) && endCaret
        ? Math.abs(maxMarkRightOnFinalLine - endCaret.left)
        : null,
      blankLineSelectionCount: root.querySelectorAll('.mlrt-document-range-selected-line').length,
      visibleCodeMirrorBoxCount: Array.from(root.querySelectorAll('.cm-selectionBackground')).filter((element) => {
        const style = root.defaultView.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && rect.width > 0 && rect.height > 0;
      }).length,
      selectedCellCount: root.querySelectorAll('.mlrt-document-range-selected, .mlrt-table-cell-selected').length,
    });
  })()`;
}

function documentEndTableSelectionSetupExpression() {
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_EDITOR_VIEW__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    if (!root || !view) return JSON.stringify({ ok: false });
    const shortText = [
      'alpha beta',
      '',
      '| H0 | H1 |',
      '| --- | --- |',
      '| A0 | A1 |',
    ].join('\\n');
    root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
      data: { type: 'setDocument', text: shortText, revision: 999803, debug: false },
    }));
    await new Promise((done) => root.defaultView.requestAnimationFrame(() =>
      root.defaultView.requestAnimationFrame(done)
    ));
    const anchorPos = shortText.indexOf('beta');
    const caret = view.coordsAtPos(anchorPos);
    const y = caret ? (caret.top + caret.bottom) / 2 : 0;
    let anchor = null;
    if (caret) {
      for (const dx of [-0.45, -0.2, 0.05, 0.2, 0.45, 0.8]) {
        const x = caret.left + dx;
        if (view.posAtCoords({ x, y }) === anchorPos) {
          anchor = { x, y, pos: anchorPos };
          break;
        }
      }
    }
    const scroller = view.scrollDOM.getBoundingClientRect();
    return JSON.stringify({
      ok: Boolean(anchor && root.querySelector('.mlrt-table-widget')),
      anchor,
      blankX: Math.max(scroller.left + 80, caret?.left ?? 80),
      blankY: scroller.bottom - 24,
      docLength: view.state.doc.length,
    });
  })()`;
}

function documentEndTableSelectionResultExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_EDITOR_VIEW__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const wrapper = root?.querySelector('.mlrt-table-widget');
    const range = view?.state.selection.main;
    const selectedCells = Array.from(wrapper?.querySelectorAll('.mlrt-document-range-selected') ?? []);
    const allCells = Array.from(wrapper?.querySelectorAll('.mlrt-table-cell') ?? []);
    const overlay = wrapper?.querySelector('.mlrt-table-selection-overlay');
    const cellRects = selectedCells.map((cell) => cell.getBoundingClientRect());
    const allCellRects = allCells.map((cell) => cell.getBoundingClientRect());
    const selectedBottom = cellRects.length
      ? Math.max(...cellRects.map((rect) => rect.bottom))
      : null;
    const finalTableBottom = allCellRects.length
      ? Math.max(...allCellRects.map((rect) => rect.bottom))
      : null;
    const overlayRect = overlay?.getBoundingClientRect() ?? null;
    const proseRects = Array.from(root?.querySelectorAll('.mlrt-prose-selection') ?? [])
      .map((mark) => mark.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    const maxSelectionBottom = Math.max(
      overlayRect?.bottom ?? -Infinity,
      ...proseRects.map((rect) => rect.bottom),
    );
    return JSON.stringify({
      ok: Boolean(root && view && wrapper && range && overlayRect),
      anchor: range?.anchor ?? null,
      head: range?.head ?? null,
      docLength: view?.state.doc.length ?? null,
      selectedCellCount: selectedCells.length,
      totalCellCount: allCells.length,
      selectedBottom,
      finalTableBottom,
      overlayBottom: overlayRect?.bottom ?? null,
      maxSelectionBottom: Number.isFinite(maxSelectionBottom) ? maxSelectionBottom : null,
      overlayBoundsFinalRow:
        selectedBottom !== null &&
        overlayRect !== null &&
        Math.abs(selectedBottom - overlayRect.bottom) <= 0.5,
      visibleCodeMirrorBoxCount: Array.from(root?.querySelectorAll('.cm-selectionBackground') ?? [])
        .filter((element) => {
          const style = root.defaultView.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && rect.width > 0 && rect.height > 0;
        }).length,
      visibleStructureIndicatorCount: Array.from(wrapper?.querySelectorAll(
        '.mlrt-table-col-indicator, .mlrt-table-row-indicator, .mlrt-table-focus-indicator'
      ) ?? []).filter((indicator) => {
        const style = root.defaultView.getComputedStyle(indicator);
        const rect = indicator.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          Number(style.opacity || '1') > 0 && rect.width > 0 && rect.height > 0;
      }).length,
    });
  })()`;
}

function restoreSelectionFixtureExpression() {
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_SELECTION_FIXTURE__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const text = root?.defaultView.__MLRT_SELECTION_FIXTURE__;
    if (!root || !view || typeof text !== 'string') return JSON.stringify({ ok: false });
    root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
      data: { type: 'setDocument', text, revision: 999802, debug: false },
    }));
    await new Promise((done) => root.defaultView.requestAnimationFrame(() =>
      root.defaultView.requestAnimationFrame(() => root.defaultView.requestAnimationFrame(done))
    ));
    view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true });
    view.scrollDOM.scrollTop = 0;
    return JSON.stringify({
      ok: view.state.doc.toString() === text,
      documentLength: view.state.doc.length,
      tableCount: root.querySelectorAll('.mlrt-table-widget').length,
    });
  })()`;
}

function cellFocusIsolationSetupExpression() {
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_EDITOR_VIEW__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const cell = root?.querySelector('.mlrt-table-cell');
    if (!root || !view || !cell) return JSON.stringify({ ok: false });
    view.focus();
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    await new Promise((done) => root.defaultView.requestAnimationFrame(() => root.defaultView.requestAnimationFrame(done)));
    const rect = cell.getBoundingClientRect();
    return JSON.stringify({
      ok: true,
      x: rect.left + Math.min(12, rect.width / 2),
      y: rect.top + Math.min(10, rect.height / 2),
      preselectedCells: root.querySelectorAll('.mlrt-document-range-selected').length,
      preselectedMarks: root.querySelectorAll('.mlrt-prose-selection').length,
    });
  })()`;
}

function cellFocusIsolationResultExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_EDITOR_VIEW__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const active = root?.activeElement;
    const nativeSelection = root?.defaultView.getSelection();
    return JSON.stringify({
      ok: Boolean(root && view),
      editorSelectionEmpty: view?.state.selection.main.empty ?? false,
      activeIsCell: active?.classList?.contains('mlrt-table-cell') ?? false,
      nativeSelectionCollapsed: nativeSelection?.isCollapsed ?? false,
      nativeCaretInsideCell: Boolean(active && nativeSelection?.anchorNode && active.contains(nativeSelection.anchorNode)),
      documentSelectedCells: root?.querySelectorAll('.mlrt-document-range-selected').length ?? -1,
      tableSelectedCells: root?.querySelectorAll('.mlrt-table-cell-selected').length ?? -1,
      proseSelectionMarks: root?.querySelectorAll('.mlrt-prose-selection').length ?? -1,
      overlayCount: root?.querySelectorAll('.mlrt-table-selection-overlay').length ?? -1,
    });
  })()`;
}

function sameCellNativeSelectionSetupExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_EDITOR_VIEW__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const wrapper = root?.querySelectorAll('.mlrt-table-widget')?.[1];
    const cell = wrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="1"][data-column="1"]');
    const walker = cell ? root.createTreeWalker(cell, root.defaultView.NodeFilter.SHOW_TEXT) : null;
    let textNode = walker?.nextNode() ?? null;
    while (textNode && (textNode.textContent?.length ?? 0) < 12) textNode = walker.nextNode();
    if (!root || !view || !cell || !textNode) return JSON.stringify({ ok: false });
    const pointForOffset = (offset) => {
      const range = root.createRange();
      range.setStart(textNode, offset);
      range.collapse(true);
      const rect = range.getBoundingClientRect();
      const y = (rect.top + rect.bottom) / 2;
      for (const dx of [-0.45, -0.2, 0.05, 0.2, 0.45, 0.8]) {
        const x = rect.left + dx;
        const caret = root.caretPositionFromPoint?.(x, y);
        if (caret?.offsetNode === textNode && caret.offset === offset) return { x, y };
      }
      return null;
    };
    const startOffset = 2;
    const endOffset = 9;
    const start = pointForOffset(startOffset);
    const end = pointForOffset(endOffset);
    view.focus();
    view.dispatch({ selection: { anchor: 0 } });
    return JSON.stringify({
      ok: Boolean(start && end),
      start,
      end,
      expectedText: textNode.textContent.slice(startOffset, endOffset),
    });
  })()`;
}

function sameCellNativeSelectionResultExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_EDITOR_VIEW__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const selection = root?.defaultView.getSelection();
    const active = root?.activeElement;
    const nativeSelectionStyle = active
      ? root.defaultView.getComputedStyle(active, '::selection')
      : null;
    return JSON.stringify({
      ok: Boolean(root && view && selection && active),
      selectedText: selection?.toString() ?? '',
      nativeSelectionCollapsed: selection?.isCollapsed ?? true,
      nativeRangeInsideCell: Boolean(
        active?.classList?.contains('mlrt-table-cell') &&
        selection?.anchorNode && active.contains(selection.anchorNode) &&
        selection?.focusNode && active.contains(selection.focusNode)
      ),
      activeIsCell: active?.classList?.contains('mlrt-table-cell') ?? false,
      editorSelectionEmpty: view?.state.selection.main.empty ?? false,
      tableSelectedCells: root?.querySelectorAll('.mlrt-table-cell-selected').length ?? -1,
      documentSelectedCells: root?.querySelectorAll('.mlrt-document-range-selected').length ?? -1,
      proseSelectionMarks: root?.querySelectorAll('.mlrt-prose-selection').length ?? -1,
      overlayCount: root?.querySelectorAll('.mlrt-table-selection-overlay').length ?? -1,
      nativeSelectionBackground: nativeSelectionStyle?.backgroundColor ?? null,
      nativeSelectionForeground: nativeSelectionStyle?.color ?? null,
    });
  })()`;
}

function clearSelectionStateExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_EDITOR_VIEW__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    view?.focus();
    view?.dispatch({ selection: { anchor: 0 }, scrollIntoView: true });
    if (view) view.scrollDOM.scrollTop = 0;
    return JSON.stringify({ ok: Boolean(view) });
  })()`;
}

function tablePointerSelectionSetupExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelectorAll('.mlrt-table-widget').length >= 2);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const wrapper = root?.querySelectorAll('.mlrt-table-widget')?.[1];
    const start = wrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="1"][data-column="0"]');
    const inside = wrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="2"][data-column="1"]');
    const reentry = wrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="1"][data-column="1"]');
    const table = wrapper?.querySelector('.mlrt-table');
    if (!root || !view || !wrapper || !start || !inside || !reentry || !table) {
      return JSON.stringify({ ok: false, reason: 'missing table pointer targets' });
    }
    const source = view.state.doc.toString();
    const tableFrom = Number(wrapper.dataset.srcFrom);
    const tableTo = Number(wrapper.dataset.srcTo);
    const beforePosition = source.lastIndexOf('\\n20\\n', tableFrom) + 1;
    const afterTextStart = source.indexOf('more test here', tableTo);
    const pointForPos = (pos) => {
      const caret = view.coordsAtPos(pos);
      if (!caret) return null;
      const y = (caret.top + caret.bottom) / 2;
      for (const dx of [-0.45, -0.2, 0.05, 0.2, 0.45, 0.8]) {
        const x = caret.left + dx;
        if (view.posAtCoords({ x, y }) === pos) return { x, y, pos };
      }
      return null;
    };
    const belowHeads = Array.from({ length: 3 }, (_, index) =>
      pointForPos(afterTextStart + index + 1)
    );
    const aboveHeads = [beforePosition + 1, beforePosition].map(pointForPos);
    const startRect = start.getBoundingClientRect();
    const insideRect = inside.getBoundingClientRect();
    const reentryRect = reentry.getBoundingClientRect();
    const tableRect = table.getBoundingClientRect();
    root.defaultView.__MLRT_TABLE_POINTER__ = {
      beforeDoc: source,
      targetTableFrom: tableFrom,
    };
    return JSON.stringify({
      ok: Boolean(
        Number.isFinite(tableFrom) &&
        Number.isFinite(tableTo) &&
        beforePosition >= 0 &&
        afterTextStart >= 0 &&
        belowHeads.every(Boolean) &&
        aboveHeads.every(Boolean)
      ),
      tableFrom,
      tableTo,
      startX: startRect.left + Math.min(10, startRect.width / 2),
      startY: startRect.top + Math.min(10, startRect.height / 2),
      insideX: insideRect.left + Math.min(10, insideRect.width / 2),
      insideY: insideRect.top + Math.min(10, insideRect.height / 2),
      horizontalX: tableRect.right + 36,
      horizontalY: insideRect.top + Math.min(10, insideRect.height / 2),
      belowHeads: belowHeads.map((point) => ({
        ...point,
        expectedText: source.slice(tableFrom, point?.pos ?? tableFrom),
      })),
      reentryX: reentryRect.left + Math.min(10, reentryRect.width / 2),
      reentryY: reentryRect.top + Math.min(10, reentryRect.height / 2),
      aboveHeads: aboveHeads.map((point) => ({
        ...point,
        expectedText: source.slice(point?.pos ?? tableTo, tableTo),
      })),
    });
  })()`;
}

function tableGutterSelectionSetupExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelectorAll('.mlrt-table-widget').length >= 2);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const wrappers = root?.querySelectorAll('.mlrt-table-widget');
    const wrapper = wrappers?.[1];
    const wrappedWrapper = wrappers?.[0];
    const rowCell = wrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="1"][data-column="0"]');
    const gutter = rowCell?.parentElement?.querySelector('.mlrt-table-source-line');
    const inside = wrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="3"][data-column="1"]');
    const cellStart = wrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="1"][data-column="1"]');
    const wrappedCell = wrappedWrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="0"]');
    const wrappedGutter = wrappedCell?.parentElement?.querySelector('.mlrt-table-source-line');
    const table = wrapper?.querySelector('.mlrt-table');
    if (!root || !view || !wrapper || !wrappedWrapper || !rowCell || !gutter || !inside || !cellStart || !wrappedCell || !wrappedGutter || !table) {
      return JSON.stringify({ ok: false, reason: 'missing gutter selection targets' });
    }
    const source = view.state.doc.toString();
    const tableFrom = Number(wrapper.dataset.srcFrom);
    const tableTo = Number(wrapper.dataset.srcTo);
    const beforePosition = source.lastIndexOf('\\n20\\n', tableFrom) + 1;
    const caret = view.coordsAtPos(beforePosition);
    const gutterRect = gutter.getBoundingClientRect();
    const insideRect = inside.getBoundingClientRect();
    const cellRect = cellStart.getBoundingClientRect();
    const wrappedGutterRect = wrappedGutter.getBoundingClientRect();
    const tableRect = table.getBoundingClientRect();
    const gutterX = (gutterRect.left + gutterRect.right) / 2;
    const gutterY = (gutterRect.top + gutterRect.bottom) / 2;
    const target = root.elementFromPoint(gutterX, gutterY);
    const above = caret ? {
      x: caret.left + 0.05,
      y: (caret.top + caret.bottom) / 2,
      pos: beforePosition,
      expectedText: source.slice(beforePosition, tableTo),
    } : null;
    return JSON.stringify({
      ok: Boolean(
        Number.isFinite(tableFrom) &&
        Number.isFinite(tableTo) &&
        beforePosition >= 0 &&
        above &&
        view.posAtCoords({ x: above.x, y: above.y }) === beforePosition &&
        Number(rowCell.dataset.sourceTo) > beforePosition &&
        wrappedGutterRect.height > gutterRect.height
      ),
      tableFrom,
      tableTo,
      gutterX,
      gutterY,
      gutterTargetClass: target?.className ?? null,
      gutterSourceTo: Number(rowCell.dataset.sourceTo),
      insideX: insideRect.left + Math.min(10, insideRect.width / 2),
      insideY: insideRect.top + Math.min(10, insideRect.height / 2),
      cellX: cellRect.left + Math.min(10, cellRect.width / 2),
      cellY: cellRect.top + Math.min(10, cellRect.height / 2),
      leftX: tableRect.left - 36,
      wrappedGutterX: (wrappedGutterRect.left + wrappedGutterRect.right) / 2,
      wrappedGutterY: wrappedGutterRect.bottom - 2,
      wrappedGutterHeight: wrappedGutterRect.height,
      ordinaryGutterHeight: gutterRect.height,
      wrapperUserSelect: root.defaultView.getComputedStyle(wrapper).userSelect,
      cellUserSelect: root.defaultView.getComputedStyle(rowCell).userSelect,
      gutterUserSelect: root.defaultView.getComputedStyle(gutter).userSelect,
      above,
    });
  })()`;
}

function firstTablePointerSelectionResultExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_EDITOR_VIEW__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const wrapper = root?.querySelectorAll('.mlrt-table-widget')?.[0];
    if (!root || !view || !wrapper) return JSON.stringify({ ok: false });
    const address = (cell) => (cell.dataset.rowKind === 'header' ? 0 : Number(cell.dataset.rowIndex) + 1) + ':' + Number(cell.dataset.column);
    return JSON.stringify({
      ok: true,
      editorSelectionEmpty: view.state.selection.main.empty,
      tableAddresses: Array.from(wrapper.querySelectorAll('.mlrt-table-cell-selected')).map(address).sort(),
      documentAddresses: Array.from(wrapper.querySelectorAll('.mlrt-document-range-selected')).map(address).sort(),
      nativeSelectionCollapsed: root.defaultView.getSelection()?.isCollapsed ?? false,
      activeIsCell: root.activeElement?.classList?.contains('mlrt-table-cell') ?? false,
      overlayCount: wrapper.querySelectorAll('.mlrt-table-selection-overlay').length,
    });
  })()`;
}

function tablePointerSelectionResultExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_EDITOR_VIEW__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const wrapper = root?.querySelectorAll('.mlrt-table-widget')?.[1];
    if (!root || !view || !wrapper) return JSON.stringify({ ok: false });
    const address = (cell) => (cell.dataset.rowKind === 'header' ? 0 : Number(cell.dataset.rowIndex) + 1) + ':' + Number(cell.dataset.column);
    const tableAddresses = Array.from(wrapper.querySelectorAll('.mlrt-table-cell-selected')).map(address).sort();
    const documentAddresses = Array.from(wrapper.querySelectorAll('.mlrt-document-range-selected')).map(address).sort();
    const selectedCells = Array.from(wrapper.querySelectorAll('.mlrt-table-cell-selected, .mlrt-document-range-selected'));
    const selected = selectedCells[0];
    const overlay = wrapper.querySelector('.mlrt-table-selection-overlay');
    const grid = overlay?.querySelector('.mlrt-table-selection-grid');
    const frame = overlay?.querySelector('.mlrt-table-selection-frame');
    const selectedStyle = selected ? root.defaultView.getComputedStyle(selected) : null;
    const selectedCellStyleSignatures = selectedCells.map((cell) => {
      const style = root.defaultView.getComputedStyle(cell);
      return JSON.stringify([
        style.backgroundColor,
        style.color,
        style.borderTopColor,
        style.borderRightColor,
        style.borderBottomColor,
        style.borderLeftColor,
        style.boxShadow,
      ]);
    });
    const gridStyle = grid ? root.defaultView.getComputedStyle(grid) : null;
    const frameStyle = frame ? root.defaultView.getComputedStyle(frame) : null;
    const nativeSelection = root.defaultView.getSelection();
    const nativeSelectionInsideEditor = Boolean(
      nativeSelection?.anchorNode &&
      nativeSelection?.focusNode &&
      view.contentDOM.contains(nativeSelection.anchorNode) &&
      view.contentDOM.contains(nativeSelection.focusNode)
    );
    const wrapperStyle = root.defaultView.getComputedStyle(wrapper);
    const frameStroke = frameStyle?.stroke ?? '';
    const editorRange = view.state.selection.main;
    const headCoords = editorRange.empty ? null : view.coordsAtPos(editorRange.head);
    const headLineRects = headCoords
      ? Array.from(root.querySelectorAll('.mlrt-prose-selection'))
          .map((mark) => mark.getBoundingClientRect())
          .filter((rect) => rect.bottom > headCoords.top && rect.top < headCoords.bottom)
      : [];
    const proseHeadEdge = headLineRects.length
      ? editorRange.head < editorRange.anchor
        ? Math.min(...headLineRects.map((rect) => rect.left))
        : Math.max(...headLineRects.map((rect) => rect.right))
      : null;
    const cellRects = selectedCells.map((cell) => cell.getBoundingClientRect());
    const selectedBounds = cellRects.length ? {
      left: Math.min(...cellRects.map((rect) => rect.left)),
      top: Math.min(...cellRects.map((rect) => rect.top)),
      right: Math.max(...cellRects.map((rect) => rect.right)),
      bottom: Math.max(...cellRects.map((rect) => rect.bottom)),
    } : null;
    const overlayRect = overlay?.getBoundingClientRect() ?? null;
    const overlayBoundsAligned = Boolean(selectedBounds && overlayRect &&
      Math.abs(selectedBounds.left - overlayRect.left) <= 0.5 &&
      Math.abs(selectedBounds.top - overlayRect.top) <= 0.5 &&
      Math.abs(selectedBounds.right - overlayRect.right) <= 0.5 &&
      Math.abs(selectedBounds.bottom - overlayRect.bottom) <= 0.5);
    const pseudoIsVisible = (cell, pseudo) => {
      const style = root.defaultView.getComputedStyle(cell, pseudo);
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        style.content !== 'none' && style.content !== 'normal' &&
        Number(style.opacity || '1') > 0;
    };
    const visibleStructureIndicatorCount = Array.from(wrapper.querySelectorAll(
      '.mlrt-table-col-indicator, .mlrt-table-row-indicator, .mlrt-table-focus-indicator'
    )).filter((indicator) => {
      const style = root.defaultView.getComputedStyle(indicator);
      const rect = indicator.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        Number(style.opacity || '1') > 0 && rect.width > 0 && rect.height > 0;
    }).length;
    return JSON.stringify({
      ok: true,
      editorSelectionEmpty: view.state.selection.main.empty,
      anchor: editorRange.anchor,
      head: editorRange.head,
      selectedText: view.state.doc.sliceString(editorRange.from, editorRange.to),
      proseHeadEdgeDelta:
        proseHeadEdge === null || !headCoords
          ? null
          : Math.abs(proseHeadEdge - headCoords.left),
      proseHeadLineMarkCount: headLineRects.length,
      tableAddresses,
      documentAddresses,
      proseSelectionMarkCount: root.querySelectorAll('.mlrt-prose-selection').length,
      nativeSelectionCollapsed: nativeSelection?.isCollapsed ?? false,
      nativeSelectionInsideEditor,
      nativeTableSelectionBackground: selected
        ? root.defaultView.getComputedStyle(selected, '::selection').backgroundColor
        : null,
      activeIsCell: root.activeElement?.classList?.contains('mlrt-table-cell') ?? false,
      overlapCellCount: wrapper.querySelectorAll('.mlrt-table-cell-selected.mlrt-document-range-selected').length,
      overlayCount: wrapper.querySelectorAll('.mlrt-table-selection-overlay').length,
      legacyOutlineCount: wrapper.querySelectorAll('.mlrt-table-selection-outline').length,
      wrapperOutlineStyle: wrapperStyle.outlineStyle,
      wrapperOutlineWidth: wrapperStyle.outlineWidth,
      selectedCellsHaveNoShadow: Array.from(wrapper.querySelectorAll('.mlrt-table-cell-selected, .mlrt-document-range-selected')).every((cell) => root.defaultView.getComputedStyle(cell).boxShadow === 'none'),
      selectedCellStylesMatch:
        selectedCellStyleSignatures.length > 0 &&
        new Set(selectedCellStyleSignatures).size === 1,
      visibleFocusIndicatorCount: wrapper.querySelectorAll('.mlrt-table-focus-indicator:not([hidden])').length,
      visibleStructureIndicatorCount,
      selectedCellsHaveNoVisiblePseudo: selectedCells.every((cell) =>
        !pseudoIsVisible(cell, '::before') && !pseudoIsVisible(cell, '::after')
      ),
      overlayBoundsAligned,
      frameStrokeIsWhite: /(?:255[, ]+255[, ]+255|1 1 1)/.test(frameStroke),
      visibleCodeMirrorBoxCount: Array.from(root.querySelectorAll('.cm-selectionBackground')).filter((element) => {
        const style = root.defaultView.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && rect.width > 0 && rect.height > 0;
      }).length,
      selectionStyle: selectedStyle && gridStyle && frameStyle ? {
        backgroundColor: selectedStyle.backgroundColor,
        color: selectedStyle.color,
        borderTopColor: selectedStyle.borderTopColor,
        borderRightColor: selectedStyle.borderRightColor,
        borderBottomColor: selectedStyle.borderBottomColor,
        borderLeftColor: selectedStyle.borderLeftColor,
        boxShadow: selectedStyle.boxShadow,
        gridStroke: gridStyle.stroke,
        gridStrokeWidth: gridStyle.strokeWidth,
        frameStroke: frameStyle.stroke,
        frameStrokeWidth: frameStyle.strokeWidth,
      } : null,
    });
  })()`;
}

function tableOriginMixedPasteExpression(direction, payloadKind, revision) {
  const payload = payloadKind === "table"
    ? "| P | Q |\n| --- | --- |\n| 1 | 2 |"
    : "REPLACED";
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_TABLE_POINTER__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const state = root?.defaultView.__MLRT_TABLE_POINTER__;
    if (!root || !view || !state) {
      return JSON.stringify({ ok: false, reason: 'missing table-origin paste state' });
    }
    const wait = () => new Promise((done) => root.defaultView.requestAnimationFrame(() =>
      root.defaultView.requestAnimationFrame(done)
    ));
    const beforeWrapperCount = root.querySelectorAll('.mlrt-table-widget').length;
    const beforeTarget = Array.from(root.querySelectorAll('.mlrt-table-widget')).find(
      (wrapper) => Number(wrapper.dataset.srcFrom) === state.targetTableFrom
    );
    const address = (cell) =>
      (cell.dataset.rowKind === 'header' ? 0 : Number(cell.dataset.rowIndex) + 1) +
      ':' + Number(cell.dataset.column);
    const beforeCells = Array.from(beforeTarget?.querySelectorAll('.mlrt-table-cell') ?? [])
      .map((cell) => ({
        address: address(cell),
        text: cell.textContent ?? '',
        selected: cell.classList.contains('mlrt-document-range-selected'),
      }));
    const beforeRange = view.state.selection.main;
    const selectedProse = ${JSON.stringify(direction)} === 'above'
      ? view.state.doc.sliceString(beforeRange.from, state.targetTableFrom)
      : view.state.doc.sliceString(Number(beforeTarget?.dataset.srcTo), beforeRange.to);
    const transfer = new root.defaultView.DataTransfer();
    transfer.setData('text/plain', ${JSON.stringify(payload)});
    if (${JSON.stringify(payloadKind)} === 'table') {
      transfer.setData('text/markdown', ${JSON.stringify(payload)});
    }
    const paste = new root.defaultView.ClipboardEvent('paste', {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
    });
    view.contentDOM.dispatchEvent(paste);
    await wait();
    const after = view.state.doc.toString();
    const wrappers = Array.from(root.querySelectorAll('.mlrt-table-widget'));
    const retained = wrappers.find((wrapper) =>
      wrapper.querySelectorAll('.mlrt-table-cell[data-row-kind="header"]').length === 3
    );
    const pastedTable = wrappers.find((wrapper) => {
      const text = wrapper.textContent ?? '';
      return text.includes('P') && text.includes('Q') && text.includes('1') && text.includes('2');
    });
    const retainedText = retained?.textContent ?? '';
    const afterCells = new Map(
      Array.from(retained?.querySelectorAll('.mlrt-table-cell') ?? [])
        .map((cell) => [address(cell), cell.textContent ?? ''])
    );
    const projectionCleared =
      root.querySelectorAll('.mlrt-document-range-selected').length === 0 &&
      root.querySelectorAll('.mlrt-prose-selection').length === 0 &&
      root.querySelectorAll('.mlrt-table-selection-overlay').length === 0;
    const markerIsSeparateBlock = ${JSON.stringify(payloadKind)} === 'table'
      ? Boolean(pastedTable)
      : after.split('\\n').some((line) => line === 'REPLACED');
    const outsideCellsPreserved = beforeCells
      .filter((cell) => !cell.selected)
      .every((cell) => afterCells.get(cell.address) === cell.text);
    const selectedCellsCleared =
      beforeCells.filter((cell) => cell.selected).length === 9 &&
      beforeCells
        .filter((cell) => cell.selected)
        .every((cell) => afterCells.get(cell.address) === '');
    const payloadPosition = ${JSON.stringify(payloadKind)} === 'table'
      ? Number(pastedTable?.dataset.srcFrom)
      : after.indexOf('REPLACED');
    const retainedFrom = Number(retained?.dataset.srcFrom);
    const retainedTo = Number(retained?.dataset.srcTo);
    const result = {
      ok: true,
      direction: ${JSON.stringify(direction)},
      payloadKind: ${JSON.stringify(payloadKind)},
      pastePrevented: paste.defaultPrevented,
      retainedTableParses: Boolean(retained),
      selectedCellsCleared,
      outsideCellsPreserved,
      selectedProseRemoved:
        selectedProse.length > 0 && !after.includes(selectedProse),
      markerIsSeparateBlock,
      payloadAppearsExactlyOnce:
        after.split(${JSON.stringify(payload)}).length - 1 === 1,
      payloadOnAnchorSide: ${JSON.stringify(direction)} === 'above'
        ? payloadPosition > retainedTo
        : payloadPosition < retainedFrom,
      wrapperCountDelta: wrappers.length - beforeWrapperCount,
      pastedTableParses: ${JSON.stringify(payloadKind)} === 'table' ? Boolean(pastedTable) : true,
      unsafeJoinAbsent:
        !after.includes('REPLACED|') &&
        !after.includes('|REPLACED') &&
        !after.includes('|  || P |') &&
        !after.includes('|  ||P |'),
      projectionCleared,
    };
    root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
      data: {
        type: 'setDocument',
        text: state.beforeDoc,
        revision: ${revision},
        debug: false,
      },
    }));
    await wait();
    result.restoredDoc = view.state.doc.toString() === state.beforeDoc;
    return JSON.stringify(result);
  })()`;
}

function reverseDocumentTableDragSetupExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelectorAll('.mlrt-table-widget').length >= 2);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const wrapper = root?.querySelectorAll('.mlrt-table-widget')?.[1];
    const cell = wrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="1"][data-column="1"]');
    if (!root || !view || !wrapper || !cell) return JSON.stringify({ ok: false });
    const source = view.state.doc.toString();
    const tableFrom = Number(wrapper.dataset.srcFrom);
    const tableTo = Number(wrapper.dataset.srcTo);
    const afterTextStart = source.indexOf('more test here', tableTo);
    const startPosition = afterTextStart + 3;
    const abovePosition = source.lastIndexOf('\\n20\\n', tableFrom) + 1;
    const pointForPos = (pos) => {
      const caret = view.coordsAtPos(pos);
      if (!caret) return null;
      const y = (caret.top + caret.bottom) / 2;
      for (const dx of [-0.45, -0.2, 0.05, 0.2, 0.45, 0.8]) {
        const x = caret.left + dx;
        if (view.posAtCoords({ x, y }) === pos) return { x, y, pos };
      }
      return null;
    };
    const start = pointForPos(startPosition);
    const aboveHeads = [abovePosition + 1, abovePosition].map(pointForPos);
    const partialHead = Number(cell.dataset.sourceFrom);
    const cellRect = cell.getBoundingClientRect();
    root.defaultView.__MLRT_DOCUMENT_TABLE_DRAG__ = {
      beforeDoc: source,
      targetTableFrom: tableFrom,
    };
    return JSON.stringify({
      ok: Boolean(
        start &&
        aboveHeads.every(Boolean) &&
        Number.isFinite(partialHead) &&
        afterTextStart >= 0
      ),
      startX: start?.x ?? 0,
      startY: start?.y ?? 0,
      startPosition,
      cellX: cellRect.left + Math.min(10, cellRect.width / 2),
      cellY: cellRect.top + Math.min(10, cellRect.height / 2),
      partialHead,
      partialExpectedText: source.slice(partialHead, startPosition),
      aboveHeads: aboveHeads.map((point) => ({
        ...point,
        expectedText: source.slice(point?.pos ?? startPosition, startPosition),
      })),
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
    const documentSelectionOverlays = selectedTables.map((wrapper) =>
      wrapper.querySelector('.mlrt-table-selection-overlay')
    );
    const documentSelectionCells = selectedTables.flatMap((wrapper) =>
      Array.from(wrapper.querySelectorAll('.mlrt-document-range-selected'))
    );
    const selectedByTable = selectedTables.map((wrapper) => ({
      tableFrom: Number(wrapper.dataset.srcFrom),
      addresses: Array.from(wrapper.querySelectorAll('.mlrt-document-range-selected'))
        .map((cell) => (cell.dataset.rowKind === 'header' ? 0 : Number(cell.dataset.rowIndex) + 1) + ':' + Number(cell.dataset.column))
        .sort(),
    }));
    const selectionBoxes = Array.from(root?.querySelectorAll('.cm-selectionBackground') ?? [])
      .map((element) => element.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0);
    const proseLines = Array.from(root?.querySelectorAll('.cm-line:not(.mlrt-hidden-table-source-line)') ?? [])
      .filter((line) => {
        if (!view || !range) return false;
        const position = view.posAtDOM(line, 0);
        const sourceLine = view.state.doc.lineAt(position);
        return range.from <= sourceLine.from && range.to >= sourceLine.to;
      });
    const proseLinesWithSelectionBox = proseLines.filter((line) => {
      const lineBox = line.getBoundingClientRect();
      return selectionBoxes.some((box) =>
        box.bottom > lineBox.top && box.top < lineBox.bottom &&
        box.right > lineBox.left && box.left < lineBox.right
      );
    });
    const proseSelectionMarks = Array.from(root?.querySelectorAll('.mlrt-prose-selection') ?? []);
    return JSON.stringify({
      ok: Boolean(root && view && table && range),
      selectionEmpty: range?.empty ?? true,
      selectionFrom: range?.from ?? null,
      selectionTo: range?.to ?? null,
      tableFrom: table?.from ?? null,
      selectedDocumentCells: root?.querySelectorAll('.mlrt-document-range-selected').length ?? 0,
      selectedByTable,
      selectedDocumentTables: selectedTables.length,
      completelySelectedDocumentTables: selectedTables.filter((wrapper) =>
        wrapper.querySelectorAll('.mlrt-document-range-selected').length ===
          wrapper.querySelectorAll('.mlrt-table-cell').length
      ).length,
      documentSelectionOverlayCount: documentSelectionOverlays.filter(Boolean).length,
      documentSelectionOverlaysComplete: documentSelectionOverlays.every((overlay) =>
        overlay?.querySelector('.mlrt-table-selection-grid') &&
        overlay?.querySelector('.mlrt-table-selection-frame')
      ),
      documentSelectionHasNoInsetShadows: documentSelectionCells.every((cell) =>
        !root.defaultView.getComputedStyle(cell).boxShadow.includes('inset')
      ),
      selectedRangeCells: root?.querySelectorAll('.mlrt-table-cell-selected').length ?? 0,
      selectionBoxCount: selectionBoxes.length,
      selectedProseLineCount: proseLines.length,
      proseLinesWithSelectionBox: proseLinesWithSelectionBox.length,
      proseSelectionMarkCount: proseSelectionMarks.length,
      blanketProseLineCount: root?.querySelectorAll('.mlrt-document-range-selected-line').length ?? 0,
      selectedProseTexts: proseLines.map((line) => line.textContent),
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
    const pointForPos = (pos) => {
      const caret = view.coordsAtPos(pos);
      if (!caret) return null;
      const y = (caret.top + caret.bottom) / 2;
      for (const dx of [-0.45, -0.2, 0.05, 0.2, 0.45, 0.8]) {
        const x = caret.left + dx;
        if (view.posAtCoords({ x, y }) === pos) return { x, y, pos };
      }
      return null;
    };
    const start = pointForPos(startPosition);
    const targetTo = Number(target.dataset.srcTo ?? target.dataset.srcFrom);
    const belowStart = source.indexOf('more test here', targetTo);
    const belowHeads = Array.from({ length: 3 }, (_, index) =>
      pointForPos(belowStart + index + 1)
    );
    const firstRect = first.getBoundingClientRect();
    const secondRect = second.getBoundingClientRect();
    const finalRect = final.getBoundingClientRect();
    root.defaultView.__MLRT_DOCUMENT_TABLE_DRAG__ = {
      beforeDoc: source,
      targetTableFrom: Number(target.dataset.srcFrom),
      selectedProse: source.slice(startPosition, Number(target.dataset.srcFrom)),
      targetCellValues: Array.from(target.querySelectorAll('.mlrt-table-cell')).map((cell) => ({
        address:
          (cell.dataset.rowKind === 'header' ? 0 : Number(cell.dataset.rowIndex) + 1) +
          ':' + Number(cell.dataset.column),
        text: cell.textContent ?? '',
      })),
    };
    return JSON.stringify({
      ok: Boolean(start && belowStart >= 0 && belowHeads.every(Boolean)),
      startX: start?.x ?? 0,
      startY: start?.y ?? 0,
      startPosition,
      firstX: firstRect.left + Math.min(8, firstRect.width / 2),
      firstY: firstRect.top + Math.min(8, firstRect.height / 2),
      secondX: secondRect.left + Math.min(8, secondRect.width / 2),
      secondY: secondRect.top + Math.min(8, secondRect.height / 2),
      finalX: finalRect.left + Math.min(8, finalRect.width / 2),
      finalY: finalRect.top + Math.min(8, finalRect.height / 2),
      belowHeads: belowHeads.map((point) => ({
        ...point,
        expectedText: source.slice(startPosition, point?.pos ?? startPosition),
      })),
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
    const selectedAddresses = Array.from(wrapper?.querySelectorAll('.mlrt-document-range-selected') ?? [])
      .map((cell) => (cell.dataset.rowKind === 'header' ? 0 : Number(cell.dataset.rowIndex) + 1) + ':' + Number(cell.dataset.column))
      .sort();
    const selectedCells = Array.from(wrapper?.querySelectorAll('.mlrt-document-range-selected') ?? []);
    const selectedProseMark = root?.querySelector('.mlrt-prose-selection');
    const overlay = wrapper?.querySelector('.mlrt-table-selection-overlay');
    const grid = overlay?.querySelector('.mlrt-table-selection-grid');
    const frame = overlay?.querySelector('.mlrt-table-selection-frame');
    const selectedStyle = selectedCells[0]
      ? root.defaultView.getComputedStyle(selectedCells[0])
      : null;
    const selectedCellStyleSignatures = selectedCells.map((cell) => {
      const style = root.defaultView.getComputedStyle(cell);
      return JSON.stringify([
        style.backgroundColor,
        style.color,
        style.borderTopColor,
        style.borderRightColor,
        style.borderBottomColor,
        style.borderLeftColor,
        style.boxShadow,
      ]);
    });
    const gridStyle = grid ? root.defaultView.getComputedStyle(grid) : null;
    const frameStyle = frame ? root.defaultView.getComputedStyle(frame) : null;
    const cellRects = selectedCells.map((cell) => cell.getBoundingClientRect());
    const selectedBounds = cellRects.length ? {
      left: Math.min(...cellRects.map((rect) => rect.left)),
      top: Math.min(...cellRects.map((rect) => rect.top)),
      right: Math.max(...cellRects.map((rect) => rect.right)),
      bottom: Math.max(...cellRects.map((rect) => rect.bottom)),
    } : null;
    const overlayRect = overlay?.getBoundingClientRect() ?? null;
    const overlayBoundsAligned = Boolean(selectedBounds && overlayRect &&
      Math.abs(selectedBounds.left - overlayRect.left) <= 0.5 &&
      Math.abs(selectedBounds.top - overlayRect.top) <= 0.5 &&
      Math.abs(selectedBounds.right - overlayRect.right) <= 0.5 &&
      Math.abs(selectedBounds.bottom - overlayRect.bottom) <= 0.5);
    const headCoords = range ? view.coordsAtPos(range.head) : null;
    const headLineRects = headCoords
      ? Array.from(root.querySelectorAll('.mlrt-prose-selection'))
          .map((mark) => mark.getBoundingClientRect())
          .filter((rect) => rect.bottom > headCoords.top && rect.top < headCoords.bottom)
      : [];
    const proseHeadRightDelta = headCoords && headLineRects.length
      ? Math.abs(Math.max(...headLineRects.map((rect) => rect.right)) - headCoords.left)
      : null;
    const proseHeadEdgeDelta = headCoords && headLineRects.length
      ? Math.abs(
          (range.head < range.anchor
            ? Math.min(...headLineRects.map((rect) => rect.left))
            : Math.max(...headLineRects.map((rect) => rect.right))) -
          headCoords.left
        )
      : null;
    const pseudoIsVisible = (cell, pseudo) => {
      const style = root.defaultView.getComputedStyle(cell, pseudo);
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        style.content !== 'none' && style.content !== 'normal' &&
        Number(style.opacity || '1') > 0;
    };
    return JSON.stringify({
      ok: Boolean(root && view && wrapper && range),
      selectionEmpty: range?.empty ?? true,
      anchor: range?.anchor ?? null,
      head: range?.head ?? null,
      selectedText: range ? view.state.doc.sliceString(range.from, range.to) : '',
      proseHeadRightDelta,
      proseHeadEdgeDelta,
      proseHeadLineMarkCount: headLineRects.length,
      selectedCellCount: wrapper?.querySelectorAll('.mlrt-document-range-selected').length ?? 0,
      totalCellCount: wrapper?.querySelectorAll('.mlrt-table-cell').length ?? 0,
      selectedAddresses,
      rectangularCellCount: root?.querySelectorAll('.mlrt-table-cell-selected').length ?? 0,
      nativeSelectionCollapsed: nativeSelection?.isCollapsed ?? true,
      nativeSelectionInsideEditor: Boolean(
        nativeSelection?.anchorNode && nativeSelection?.focusNode &&
        view?.contentDOM.contains(nativeSelection.anchorNode) &&
        view?.contentDOM.contains(nativeSelection.focusNode)
      ),
      nativeTableSelectionBackground: selectedCells[0]
        ? root.defaultView.getComputedStyle(selectedCells[0], '::selection').backgroundColor
        : null,
      nativeProseSelectionBackground: selectedProseMark
        ? root.defaultView.getComputedStyle(selectedProseMark, '::selection').backgroundColor
        : null,
      proseSelectionMarkCount: root?.querySelectorAll('.mlrt-prose-selection').length ?? 0,
      visibleCodeMirrorSelectionBoxCount: Array.from(root?.querySelectorAll('.cm-selectionBackground') ?? [])
        .filter((element) => {
          const style = root.defaultView.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && rect.width > 0 && rect.height > 0;
        }).length,
      blanketProseLineCount: root?.querySelectorAll('.mlrt-document-range-selected-line').length ?? 0,
      activeIsCell: root?.activeElement?.classList?.contains('mlrt-table-cell') ?? false,
      editorHasFocus: view?.hasFocus ?? false,
      activeElementClass: root?.activeElement?.className ?? '',
      overlayCount: wrapper?.querySelectorAll('.mlrt-table-selection-overlay').length ?? 0,
      overlayBoundsAligned,
      selectedCellsHaveNoVisiblePseudo: selectedCells.every((cell) =>
        !pseudoIsVisible(cell, '::before') && !pseudoIsVisible(cell, '::after')
      ),
      selectedCellStylesMatch:
        selectedCellStyleSignatures.length > 0 &&
        new Set(selectedCellStyleSignatures).size === 1,
      visibleStructureIndicatorCount: Array.from(wrapper?.querySelectorAll(
        '.mlrt-table-col-indicator, .mlrt-table-row-indicator, .mlrt-table-focus-indicator'
      ) ?? []).filter((indicator) => {
        const style = root.defaultView.getComputedStyle(indicator);
        const rect = indicator.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          Number(style.opacity || '1') > 0 && rect.width > 0 && rect.height > 0;
      }).length,
      selectionStyle: selectedStyle && gridStyle && frameStyle ? {
        backgroundColor: selectedStyle.backgroundColor,
        color: selectedStyle.color,
        borderTopColor: selectedStyle.borderTopColor,
        borderRightColor: selectedStyle.borderRightColor,
        borderBottomColor: selectedStyle.borderBottomColor,
        borderLeftColor: selectedStyle.borderLeftColor,
        boxShadow: selectedStyle.boxShadow,
        gridStroke: gridStyle.stroke,
        gridStrokeWidth: gridStyle.strokeWidth,
        frameStroke: frameStyle.stroke,
        frameStrokeWidth: frameStyle.strokeWidth,
      } : null,
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
    const afterWrappers = Array.from(root.querySelectorAll('.mlrt-table-widget'));
    const targetWrapper = afterWrappers[1];
    const clearedVisibleCells = [
      targetWrapper?.querySelector('.mlrt-table-cell[data-row-kind="header"][data-column="0"]'),
      targetWrapper?.querySelector('.mlrt-table-cell[data-row-kind="header"][data-column="1"]'),
      targetWrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="0"]'),
      targetWrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="1"]'),
      targetWrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="1"][data-column="0"]'),
      targetWrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="1"][data-column="1"]'),
    ].every((cell) => cell?.textContent === '');
    const firstTableRemains = afterDelete.includes('| Key | Value |') && afterDelete.includes('| Long |');
    root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
      data: { type: 'setDocument', text: state.beforeDoc, revision: 999044, debug: false },
    }));
    await new Promise((done) => root.defaultView.requestAnimationFrame(() => root.defaultView.requestAnimationFrame(done)));
    return JSON.stringify({
      ok: true,
      docChanged: afterDelete !== state.beforeDoc,
      targetTableRemains: Boolean(targetWrapper),
      clearedVisibleCells,
      firstTableRemains,
      restoredDoc: view.state.doc.toString() === state.beforeDoc,
    });
  })()`;
}

function partialMixedSelectionCopyExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_DOCUMENT_TABLE_DRAG__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    if (!root || !view) return JSON.stringify({ ok: false });
    const transfer = new root.defaultView.DataTransfer();
    view.contentDOM.dispatchEvent(new root.defaultView.ClipboardEvent('copy', {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
    }));
    const plain = transfer.getData('text/plain');
    const html = transfer.getData('text/html');
    let payload = null;
    try { payload = JSON.parse(transfer.getData('application/x-markdown-live-editor+json')); } catch {}
    return JSON.stringify({
      ok: true,
      privateKind: payload?.kind ?? null,
      markdown: payload?.markdown ?? '',
      plainHasSelectedShort: plain.includes('Short') && plain.includes('short cell.'),
      plainHasTabs: plain.includes('\t'),
      htmlHasTable: html.includes('<table'),
      excludesUnselectedTest: !plain.includes('test') && !(payload?.markdown ?? '').includes('test'),
      excludesUnselectedThirdColumn: !(payload?.markdown ?? '').includes('|  |  | test |'),
      selectionStillPartial: root.querySelectorAll('.mlrt-document-range-selected').length === 6,
    });
  })()`;
}

function partialMixedSelectionPasteExpression() {
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_DOCUMENT_TABLE_DRAG__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const state = root?.defaultView.__MLRT_DOCUMENT_TABLE_DRAG__;
    if (!root || !view || !state) return JSON.stringify({ ok: false });
    const transfer = new root.defaultView.DataTransfer();
    transfer.setData('text/plain', 'REPLACED');
    const paste = new root.defaultView.ClipboardEvent('paste', {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
    });
    view.contentDOM.dispatchEvent(paste);
    await new Promise((done) => root.defaultView.requestAnimationFrame(() =>
      root.defaultView.requestAnimationFrame(done)
    ));
    const after = view.state.doc.toString();
    const target = Array.from(root.querySelectorAll('.mlrt-table-widget'))[1];
    const clearedVisibleCells = [
      target?.querySelector('.mlrt-table-cell[data-row-kind="header"][data-column="0"]'),
      target?.querySelector('.mlrt-table-cell[data-row-kind="header"][data-column="1"]'),
      target?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="0"]'),
      target?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="1"]'),
      target?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="1"][data-column="0"]'),
      target?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="1"][data-column="1"]'),
    ].every((cell) => cell?.textContent === '');
    const unselectedTestPreserved = target?.querySelector(
      '.mlrt-table-cell[data-row-kind="body"][data-row-index="3"][data-column="2"]'
    )?.textContent === 'test';
    const projectionCleared =
      root.querySelectorAll('.mlrt-document-range-selected').length === 0 &&
      root.querySelectorAll('.mlrt-prose-selection').length === 0;
    root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
      data: { type: 'setDocument', text: state.beforeDoc, revision: 999045, debug: false },
    }));
    await new Promise((done) => root.defaultView.requestAnimationFrame(() =>
      root.defaultView.requestAnimationFrame(done)
    ));
    return JSON.stringify({
      ok: true,
      pastePrevented: paste.defaultPrevented,
      insertedAtAnchor: after.includes('\\nREPLACED\\n'),
      targetTableRemains: Boolean(target) && after.includes('|  |  | test |'),
      clearedVisibleCells,
      unselectedTestPreserved,
      projectionCleared,
    });
  })()`;
}

function mixedInputReplacementResultExpression(
  expectedText,
  revision,
  restoreDocument,
) {
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_DOCUMENT_TABLE_DRAG__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const state = root?.defaultView.__MLRT_DOCUMENT_TABLE_DRAG__;
    if (!root || !view || !state) {
      return JSON.stringify({ ok: false, reason: 'missing mixed input state' });
    }
    const wait = () => new Promise((done) => root.defaultView.requestAnimationFrame(() =>
      root.defaultView.requestAnimationFrame(done)
    ));
    await wait();
    const after = view.state.doc.toString();
    const target = Array.from(root.querySelectorAll('.mlrt-table-widget')).find((wrapper) =>
      wrapper.querySelectorAll('.mlrt-table-cell[data-row-kind="header"]').length === 3
    );
    const address = (cell) =>
      (cell.dataset.rowKind === 'header' ? 0 : Number(cell.dataset.rowIndex) + 1) +
      ':' + Number(cell.dataset.column);
    const targetValues = new Map(Array.from(target?.querySelectorAll('.mlrt-table-cell') ?? [])
      .map((cell) => [address(cell), cell.textContent ?? '']));
    const selectedAddresses = new Set(['0:0', '0:1', '1:0', '1:1', '2:0', '2:1']);
    const expected = ${JSON.stringify(expectedText)};
    const result = {
      ok: true,
      docChanged: after !== state.beforeDoc,
      insertedExactlyOnce: expected.length > 0 && after.split(expected).length - 1 === 1,
      selectedProseRemoved:
        Boolean(state.selectedProse) &&
        after.split(state.selectedProse).length - 1 ===
          state.beforeDoc.split(state.selectedProse).length - 2,
      targetTableRemains: Boolean(target),
      selectedCellsCleared: [
        target?.querySelector('.mlrt-table-cell[data-row-kind="header"][data-column="0"]'),
        target?.querySelector('.mlrt-table-cell[data-row-kind="header"][data-column="1"]'),
        target?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="0"]'),
        target?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="1"]'),
        target?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="1"][data-column="0"]'),
        target?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="1"][data-column="1"]'),
      ].every((cell) => cell?.textContent === ''),
      unselectedTestPreserved: target?.querySelector(
        '.mlrt-table-cell[data-row-kind="body"][data-row-index="3"][data-column="2"]'
      )?.textContent === 'test',
      unselectedCellsUnchanged: (state.targetCellValues ?? [])
        .filter((cell) => !selectedAddresses.has(cell.address))
        .every((cell) => targetValues.get(cell.address) === cell.text),
      composing: view.composing,
      selectionCollapsed: view.state.selection.main.empty,
      projectionCleared:
        root.querySelectorAll('.mlrt-document-range-selected').length === 0 &&
        root.querySelectorAll('.mlrt-prose-selection').length === 0 &&
        root.querySelectorAll('.mlrt-table-selection-overlay').length === 0,
    };
    state.afterInput = after;
    state.expectedInput = expected;
    if (${restoreDocument}) {
      root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
        data: {
          type: 'setDocument',
          text: state.beforeDoc,
          revision: ${revision},
          debug: false,
        },
      }));
      await wait();
      result.restoredDoc = view.state.doc.toString() === state.beforeDoc;
    } else {
      result.restoredDoc = null;
    }
    return JSON.stringify(result);
  })()`;
}

function mixedCompositionSnapshotExpression(expectedText, previousText) {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_DOCUMENT_TABLE_DRAG__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const state = root?.defaultView.__MLRT_DOCUMENT_TABLE_DRAG__;
    const target = Array.from(root?.querySelectorAll('.mlrt-table-widget') ?? []).find((wrapper) =>
      wrapper.querySelectorAll('.mlrt-table-cell[data-row-kind="header"]').length === 3
    );
    if (!root || !view || !state || !target) return JSON.stringify({ ok: false });
    const address = (cell) =>
      (cell.dataset.rowKind === 'header' ? 0 : Number(cell.dataset.rowIndex) + 1) +
      ':' + Number(cell.dataset.column);
    const values = new Map(Array.from(target.querySelectorAll('.mlrt-table-cell')).map((cell) =>
      [address(cell), cell.textContent ?? '']
    ));
    const selectedAddresses = new Set(['0:0', '0:1', '1:0', '1:1', '2:0', '2:1']);
    const expected = ${JSON.stringify(expectedText)};
    const previous = ${JSON.stringify(previousText)};
    const doc = view.state.doc.toString();
    return JSON.stringify({
      ok: true,
      composing: view.composing,
      currentCandidateExactlyOnce:
        expected.length > 0 && doc.split(expected).length - 1 === 1,
      selectedProseRemoved:
        Boolean(state.selectedProse) &&
        doc.split(state.selectedProse).length - 1 ===
          state.beforeDoc.split(state.selectedProse).length - 2,
      previousCandidateAbsent:
        !previous || !doc.includes(previous),
      selectedCellsCleared: Array.from(selectedAddresses).every((cellAddress) =>
        values.get(cellAddress) === ''
      ),
      unselectedCellsUnchanged: (state.targetCellValues ?? [])
        .filter((cell) => !selectedAddresses.has(cell.address))
        .every((cell) => values.get(cell.address) === cell.text),
      projectionCleared:
        root.querySelectorAll('.mlrt-document-range-selected').length === 0 &&
        root.querySelectorAll('.mlrt-prose-selection').length === 0 &&
        root.querySelectorAll('.mlrt-table-selection-overlay').length === 0,
      targetTableParses: Boolean(target),
    });
  })()`;
}

function injectHostDocumentDuringCompositionExpression(text, revision) {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_DOCUMENT_TABLE_DRAG__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    if (!root || !view) return JSON.stringify({ ok: false });
    root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
      data: {
        type: 'setDocument',
        text: ${JSON.stringify(text)},
        revision: ${revision},
        debug: false,
      },
    }));
    return JSON.stringify({
      ok: true,
      composing: view.composing,
      authoritativeTextApplied:
        view.state.doc.toString() === ${JSON.stringify(text)},
    });
  })()`;
}

function armMixedImeQueuedCommandFifoExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_DOCUMENT_TABLE_DRAG__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    if (!root || !view) return JSON.stringify({ ok: false });
    root.defaultView.__MLRT_DEBUG_EVENTS__ = [];
    const dispatchCommand = (shiftKey) => view.contentDOM.dispatchEvent(
      new root.defaultView.KeyboardEvent('keydown', {
        key: 'z',
        code: 'KeyZ',
        metaKey: true,
        shiftKey,
        bubbles: true,
        cancelable: true,
      })
    );
    view.contentDOM.addEventListener('compositionend', () => {
      // CodeMirror can retain compositionStarted through the event's microtask
      // checkpoint. A zero-delay task runs after that state clears but before
      // the 10 ms production flush, deterministically exercising the direct-
      // command race window.
      root.defaultView.setTimeout(() => dispatchCommand(false), 0);
    }, { capture: true, once: true });
    const redoAllowed = dispatchCommand(true);
    const events = root.defaultView.__MLRT_DEBUG_EVENTS__ ?? [];
    return JSON.stringify({
      ok: true,
      composing: view.composing,
      redoPrevented: !redoAllowed,
      deferredCommands: events
        .filter((event) => event.event === 'defer-editor-command-for-composition')
        .map((event) => event.details?.command),
    });
  })()`;
}

function mixedImeQueuedCommandFifoResultExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_DOCUMENT_TABLE_DRAG__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const state = root?.defaultView.__MLRT_DOCUMENT_TABLE_DRAG__;
    if (!root || !view || !state) return JSON.stringify({ ok: false });
    const events = root.defaultView.__MLRT_DEBUG_EVENTS__ ?? [];
    return JSON.stringify({
      ok: true,
      commands: events
        .filter((event) => event.event === 'post-editor-command')
        .map((event) => event.details?.command),
      deferredCommands: events
        .filter((event) => event.event === 'defer-editor-command-for-composition')
        .map((event) => event.details?.command),
      compositionPublished:
        events.filter((event) => event.event === 'post-change').length === 1,
      sourceRestored: view.state.doc.toString() === state.beforeDoc,
      compositionTextRemoved: !view.state.doc.toString().includes('日本'),
      composing: view.composing,
    });
  })()`;
}

function mixedImeHostConflictResultExpression(text, revision) {
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_DOCUMENT_TABLE_DRAG__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const state = root?.defaultView.__MLRT_DOCUMENT_TABLE_DRAG__;
    if (!root || !view || !state) return JSON.stringify({ ok: false });
    const wait = () => new Promise((done) => root.defaultView.requestAnimationFrame(() =>
      root.defaultView.requestAnimationFrame(done)
    ));
    await wait();
    const settled = view.state.doc.toString();
    const result = {
      ok: true,
      settled,
      composing: view.composing,
      authoritativeTextPreserved: settled === ${JSON.stringify(text)},
      trailingCandidateAbsent: !settled.includes('日本') && !settled.includes('に'),
      projectionCleared:
        root.querySelectorAll('.mlrt-document-range-selected').length === 0 &&
        root.querySelectorAll('.mlrt-prose-selection').length === 0 &&
        root.querySelectorAll('.mlrt-table-selection-overlay').length === 0,
    };
    root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
      data: {
        type: 'setDocument',
        text: state.beforeDoc,
        revision: ${revision},
        debug: false,
      },
    }));
    await wait();
    result.restoredDoc = view.state.doc.toString() === state.beforeDoc;
    return JSON.stringify(result);
  })()`;
}

function mixedInputUndoResultExpression(revision, expectedText = "") {
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_DOCUMENT_TABLE_DRAG__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const state = root?.defaultView.__MLRT_DOCUMENT_TABLE_DRAG__;
    if (!root || !view || !state) return JSON.stringify({ ok: false });
    const wait = () => new Promise((done) => root.defaultView.requestAnimationFrame(() =>
      root.defaultView.requestAnimationFrame(done)
    ));
    await wait();
    const afterUndo = view.state.doc.toString();
    let firstDifference = 0;
    while (
      firstDifference < afterUndo.length &&
      firstDifference < state.beforeDoc.length &&
      afterUndo[firstDifference] === state.beforeDoc[firstDifference]
    ) {
      firstDifference++;
    }
    const result = {
      ok: true,
      oneUndoRestoredSource: afterUndo === state.beforeDoc,
      composedTextRemoved:
        !(state.expectedInput || ${JSON.stringify(expectedText)}) ||
        !afterUndo.includes(state.expectedInput || ${JSON.stringify(expectedText)}),
      originalTableRestored:
        afterUndo.includes('| Short | short cell. This is resizing the cell now |  |') &&
        afterUndo.includes('|  |  | test |'),
      selectedProseRestored:
        Boolean(state.selectedProse) && afterUndo.includes(state.selectedProse),
      beforeLength: state.beforeDoc.length,
      afterUndoLength: afterUndo.length,
      firstDifference,
      beforeDifferenceContext: state.beforeDoc.slice(
        Math.max(0, firstDifference - 30),
        firstDifference + 90,
      ),
      afterDifferenceContext: afterUndo.slice(
        Math.max(0, firstDifference - 30),
        firstDifference + 90,
      ),
      selectionCollapsed: view.state.selection.main.empty,
    };
    if (afterUndo !== state.beforeDoc) {
      root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
        data: {
          type: 'setDocument',
          text: state.beforeDoc,
          revision: ${revision},
          debug: false,
        },
      }));
      await wait();
    }
    result.restoredDoc = view.state.doc.toString() === state.beforeDoc;
    return JSON.stringify(result);
  })()`;
}

function partialMixedContextMenuExpression(revision) {
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_DOCUMENT_TABLE_DRAG__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const state = root?.defaultView.__MLRT_DOCUMENT_TABLE_DRAG__;
    const wrapper = Array.from(root?.querySelectorAll('.mlrt-table-widget') ?? []).find((candidate) =>
      candidate.querySelectorAll('.mlrt-document-range-selected').length === 6
    );
    const selectedCell = wrapper?.querySelector('.mlrt-document-range-selected');
    const unselectedCell = wrapper?.querySelector(
      '.mlrt-table-cell[data-row-kind="body"][data-row-index="3"][data-column="2"]'
    );
    if (!root || !view || !state || !wrapper || !selectedCell || !unselectedCell) {
      return JSON.stringify({ ok: false, reason: 'missing partial context targets' });
    }
    const wait = () => new Promise((done) => root.defaultView.requestAnimationFrame(() =>
      root.defaultView.requestAnimationFrame(done)
    ));
    const address = (cell) =>
      (cell.dataset.rowKind === 'header' ? 0 : Number(cell.dataset.rowIndex) + 1) +
      ':' + Number(cell.dataset.column);
    const initialRange = view.state.selection.main.toJSON();
    const initialAddresses = Array.from(
      wrapper.querySelectorAll('.mlrt-document-range-selected')
    ).map(address).sort();
    const context = (cell, pointerId) => {
      const rect = cell.getBoundingClientRect();
      const pointer = new root.defaultView.PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 2,
        buttons: 2,
        pointerId,
        isPrimary: true,
        clientX: rect.left + Math.min(8, rect.width / 2),
        clientY: rect.top + Math.min(8, rect.height / 2),
      });
      const menu = new root.defaultView.MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: rect.left + Math.min(8, rect.width / 2),
        clientY: rect.top + Math.min(8, rect.height / 2),
      });
      cell.dispatchEvent(pointer);
      cell.dispatchEvent(menu);
      return { pointer, menu };
    };
    const selectedEvents = context(selectedCell, 810);
    const selectedDocumentMenuCount = root.querySelectorAll(
      '.mlrt-document-clipboard-menu'
    ).length;
    const selectedTableMenuCount = root.querySelectorAll(
      '.mlrt-clipboard-menu:not(.mlrt-document-clipboard-menu)'
    ).length;
    const selectedProjectionPreserved =
      JSON.stringify(view.state.selection.main.toJSON()) === JSON.stringify(initialRange) &&
      JSON.stringify(Array.from(
        wrapper.querySelectorAll('.mlrt-document-range-selected')
      ).map(address).sort()) === JSON.stringify(initialAddresses) &&
      root.querySelectorAll('.mlrt-prose-selection').length > 0 &&
      wrapper.querySelectorAll('.mlrt-table-selection-overlay').length === 1 &&
      root.querySelectorAll('.mlrt-table-cell-selected').length === 0;
    const unselectedEvents = context(unselectedCell, 811);
    await wait();
    const tableSelectedCells = Array.from(
      root.querySelectorAll('.mlrt-table-cell-selected')
    );
    const unselectedUsesTableMenu = root.querySelectorAll(
      '.mlrt-clipboard-menu:not(.mlrt-document-clipboard-menu)'
    ).length === 1;
    const unselectedDidNotUseDocumentMenu = root.querySelectorAll(
      '.mlrt-document-clipboard-menu'
    ).length === 0;
    const unselectedCellSelected =
      tableSelectedCells.length === 1 &&
      address(tableSelectedCells[0]) === '4:2' &&
      root.querySelectorAll('.mlrt-table-selection-overlay').length === 1;
    const projectionCleared =
      root.querySelectorAll('.mlrt-document-range-selected').length === 0 &&
      root.querySelectorAll('.mlrt-prose-selection').length === 0 &&
      view.state.selection.main.empty;
    const tableMenuButton = root.querySelector(
      '.mlrt-clipboard-menu:not(.mlrt-document-clipboard-menu) button'
    );
    tableMenuButton?.dispatchEvent(new root.defaultView.KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true,
    }));
    const menuClosedBeforeRestore =
      root.querySelectorAll('.mlrt-clipboard-menu').length === 0;
    root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
      data: {
        type: 'setDocument',
        text: state.beforeDoc,
        revision: ${revision},
        debug: false,
      },
    }));
    await wait();
    return JSON.stringify({
      ok: true,
      selectedPointerPrevented: selectedEvents.pointer.defaultPrevented,
      selectedContextPrevented: selectedEvents.menu.defaultPrevented,
      selectedDocumentMenuCount,
      selectedTableMenuCount,
      selectedProjectionPreserved,
      unselectedPointerPrevented: unselectedEvents.pointer.defaultPrevented,
      unselectedContextPrevented: unselectedEvents.menu.defaultPrevented,
      unselectedUsesTableMenu,
      unselectedDidNotUseDocumentMenu,
      unselectedCellSelected,
      projectionCleared,
      menuClosedBeforeRestore,
      restoredDoc: view.state.doc.toString() === state.beforeDoc,
    });
  })()`;
}

function forceMixedDragOwnershipLossExpression() {
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_DOCUMENT_TABLE_DRAG__);
    const shell = root?.querySelector('#app');
    if (!root || !shell) return JSON.stringify({ ok: false });
    const capturedBefore = Array.from({ length: 32 }, (_, pointerId) => pointerId)
      .filter((pointerId) => shell.hasPointerCapture(pointerId));
    const address = (cell) =>
      (cell.dataset.rowKind === 'header' ? 0 : Number(cell.dataset.rowIndex) + 1) +
      ':' + Number(cell.dataset.column);
    const rangeBefore = root.defaultView.__MLRT_EDITOR_VIEW__.state.selection.main.toJSON();
    const addressesBefore = Array.from(
      root.querySelectorAll('.mlrt-document-range-selected')
    ).map(address).sort();
    if (capturedBefore.length > 0) {
      shell.releasePointerCapture(capturedBefore[0]);
    }
    await Promise.resolve();
    await Promise.resolve();
    const capturedAfter = Array.from({ length: 32 }, (_, pointerId) => pointerId)
      .filter((pointerId) => shell.hasPointerCapture(pointerId));
    const rangeAfter = root.defaultView.__MLRT_EDITOR_VIEW__.state.selection.main.toJSON();
    const addressesAfter = Array.from(
      root.querySelectorAll('.mlrt-document-range-selected')
    ).map(address).sort();
    const staleTarget = root.querySelector(
      '.mlrt-table-widget:nth-of-type(2) .mlrt-table-cell[data-row-kind="header"][data-column="0"]'
    ) ?? root.querySelector(
      '.mlrt-table-cell[data-row-kind="header"][data-column="0"]'
    );
    const staleRect = staleTarget?.getBoundingClientRect();
    if (capturedBefore.length > 0 && staleRect) {
      root.dispatchEvent(new root.defaultView.PointerEvent('pointermove', {
        bubbles: true,
        cancelable: true,
        buttons: 1,
        pointerId: capturedBefore[0],
        pointerType: 'mouse',
        isPrimary: true,
        clientX: staleRect.left + Math.min(8, staleRect.width / 2),
        clientY: staleRect.top + Math.min(8, staleRect.height / 2),
      }));
      await Promise.resolve();
    }
    const rangeAfterStaleMove =
      root.defaultView.__MLRT_EDITOR_VIEW__.state.selection.main.toJSON();
    const addressesAfterStaleMove = Array.from(
      root.querySelectorAll('.mlrt-document-range-selected')
    ).map(address).sort();
    return JSON.stringify({
      ok: true,
      capturedBefore,
      capturedAfter,
      staleTargetFound: Boolean(staleRect),
      selectionFinalized:
        JSON.stringify(rangeAfter) === JSON.stringify(rangeBefore) &&
        JSON.stringify(addressesAfter) === JSON.stringify(addressesBefore),
      staleMoveIgnored:
        JSON.stringify(rangeAfterStaleMove) === JSON.stringify(rangeAfter) &&
        JSON.stringify(addressesAfterStaleMove) === JSON.stringify(addressesAfter),
      addressesBefore,
    });
  })()`;
}

function mixedDragSuccessiveGestureExpression() {
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_DOCUMENT_TABLE_DRAG__);
    const shell = root?.querySelector('#app');
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const state = root?.defaultView.__MLRT_DOCUMENT_TABLE_DRAG__;
    const wrapper = Array.from(root?.querySelectorAll('.mlrt-table-widget') ?? [])
      .find((candidate) => Number(candidate.dataset.srcFrom) === state?.targetTableFrom);
    const first = wrapper?.querySelector(
      '.mlrt-table-cell[data-row-kind="header"][data-column="0"]'
    );
    const final = wrapper?.querySelector(
      '.mlrt-table-cell[data-row-kind="body"][data-row-index="1"][data-column="1"]'
    );
    if (!root || !shell || !view || !first || !final) {
      return JSON.stringify({ ok: false, reason: 'missing successive gesture targets' });
    }
    const startPosition = view.state.doc.toString().indexOf('\\n20\\n') + 1;
    const caret = view.coordsAtPos(startPosition);
    if (startPosition <= 0 || !caret) {
      return JSON.stringify({ ok: false, reason: 'missing successive gesture anchor' });
    }
    const startX = caret.left + 0.05;
    const startY = (caret.top + caret.bottom) / 2;
    const proseTarget = root.elementFromPoint(startX, startY) ?? view.dom;
    const point = (cell) => {
      const rect = cell.getBoundingClientRect();
      return {
        x: rect.left + Math.min(8, rect.width / 2),
        y: rect.top + Math.min(8, rect.height / 2),
      };
    };
    const firstPoint = point(first);
    const finalPoint = point(final);
    const pointerId = 1;
    const dispatch = (target, type, x, y, buttons, button = 0) => {
      const event = new root.defaultView.PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId,
        pointerType: 'mouse',
        isPrimary: true,
        button,
        buttons,
        clientX: x,
        clientY: y,
      });
      target.dispatchEvent(event);
      return event;
    };
    const addresses = () => Array.from(
      wrapper.querySelectorAll('.mlrt-document-range-selected')
    ).map((cell) =>
      (cell.dataset.rowKind === 'header' ? 0 : Number(cell.dataset.rowIndex) + 1) +
      ':' + Number(cell.dataset.column)
    ).sort();

    // Finish one uncaptured prose gesture, then start another one in the same
    // task. Its deferred cleanup must not tear down the replacement gesture.
    dispatch(proseTarget, 'pointerdown', startX, startY, 1);
    dispatch(proseTarget, 'pointerup', startX, startY, 0);
    dispatch(proseTarget, 'pointerdown', startX, startY, 1);

    // A delayed loss from the previous gesture can reuse the mouse pointer id.
    // It is stale because the replacement gesture has not claimed capture.
    dispatch(shell, 'lostpointercapture', startX, startY, 0);
    dispatch(first, 'pointermove', firstPoint.x, firstPoint.y, 1);
    const afterStaleLoss = addresses();
    await new Promise((done) => root.defaultView.setTimeout(done, 20));
    dispatch(final, 'pointermove', finalPoint.x, finalPoint.y, 1);
    const afterOldTimer = addresses();
    const finalRange = view.state.selection.main.toJSON();
    dispatch(final, 'pointerup', finalPoint.x, finalPoint.y, 0);
    await new Promise((done) => root.defaultView.setTimeout(done, 20));
    const afterRelease = addresses();
    return JSON.stringify({
      ok: true,
      afterStaleLoss,
      afterOldTimer,
      afterRelease,
      finalRange,
    });
  })()`;
}

function forceTableDragOwnershipLossExpression() {
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_TABLE_POINTER__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const wrapper = root?.querySelectorAll('.mlrt-table-widget')?.[1];
    if (!root || !view || !wrapper) return JSON.stringify({ ok: false });
    const address = (cell) =>
      (cell.dataset.rowKind === 'header' ? 0 : Number(cell.dataset.rowIndex) + 1) +
      ':' + Number(cell.dataset.column);
    const snapshot = () => ({
      range: view.state.selection.main.toJSON(),
      table: Array.from(wrapper.querySelectorAll('.mlrt-table-cell-selected'))
        .map(address).sort(),
      document: Array.from(wrapper.querySelectorAll('.mlrt-document-range-selected'))
        .map(address).sort(),
    });
    const capturedBefore = Array.from({ length: 32 }, (_, pointerId) => pointerId)
      .filter((pointerId) => wrapper.hasPointerCapture(pointerId));
    const before = snapshot();
    if (capturedBefore.length > 0) {
      wrapper.releasePointerCapture(capturedBefore[0]);
    }
    await Promise.resolve();
    await Promise.resolve();
    const capturedAfter = Array.from({ length: 32 }, (_, pointerId) => pointerId)
      .filter((pointerId) => wrapper.hasPointerCapture(pointerId));
    const afterLoss = snapshot();
    const staleTarget = wrapper.querySelector(
      '.mlrt-table-cell[data-row-kind="header"][data-column="2"]'
    );
    const staleRect = staleTarget?.getBoundingClientRect();
    if (capturedBefore.length > 0 && staleRect) {
      root.dispatchEvent(new root.defaultView.PointerEvent('pointermove', {
        bubbles: true,
        cancelable: true,
        buttons: 1,
        pointerId: capturedBefore[0],
        pointerType: 'mouse',
        isPrimary: true,
        clientX: staleRect.left + Math.min(8, staleRect.width / 2),
        clientY: staleRect.top + Math.min(8, staleRect.height / 2),
      }));
      await Promise.resolve();
    }
    const afterStaleMove = snapshot();
    return JSON.stringify({
      ok: true,
      capturedBefore,
      capturedAfter,
      staleTargetFound: Boolean(staleRect),
      addressesBefore: before.table,
      selectionFinalized: JSON.stringify(afterLoss) === JSON.stringify(before),
      staleMoveIgnored:
        JSON.stringify(afterStaleMove) === JSON.stringify(afterLoss),
    });
  })()`;
}

function tableMouseFallbackRecoveryExpression() {
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelectorAll('.mlrt-table-widget').length >= 2);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const wrapper = root?.querySelectorAll('.mlrt-table-widget')?.[1];
    const firstStart = wrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="1"][data-column="0"]');
    const firstEnd = wrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="2"][data-column="1"]');
    const secondStart = wrapper?.querySelector('.mlrt-table-cell[data-row-kind="header"][data-column="2"]');
    const secondEnd = wrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="1"]');
    if (!root || !view || !wrapper || !firstStart || !firstEnd || !secondStart || !secondEnd) {
      return JSON.stringify({ ok: false, reason: 'missing mouse fallback targets' });
    }
    const point = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.left + Math.min(8, rect.width / 2),
        y: rect.top + Math.min(8, rect.height / 2),
      };
    };
    const fire = (target, type, location, buttons) => target.dispatchEvent(
      new root.defaultView.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons,
        clientX: location.x,
        clientY: location.y,
      })
    );
    const addresses = () => Array.from(wrapper.querySelectorAll('.mlrt-table-cell-selected'))
      .map((cell) =>
        (cell.dataset.rowKind === 'header' ? 0 : Number(cell.dataset.rowIndex) + 1) +
        ':' + Number(cell.dataset.column)
      ).sort();

    fire(firstStart, 'mousedown', point(firstStart), 1);
    fire(firstEnd, 'mousemove', point(firstEnd), 1);
    await Promise.resolve();
    const firstAddresses = addresses();

    // Deliberately omit the first mouseup. A second mouse-only mousedown must
    // retire that stale fallback owner and establish a fresh anchor.
    fire(secondStart, 'mousedown', point(secondStart), 1);
    fire(secondEnd, 'mousemove', point(secondEnd), 1);
    await Promise.resolve();
    const secondAddresses = addresses();
    fire(secondEnd, 'mouseup', point(secondEnd), 0);
    await new Promise((done) => root.defaultView.setTimeout(done, 0));
    const finalAddresses = addresses();
    wrapper.dispatchEvent(new root.defaultView.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Escape',
    }));
    return JSON.stringify({
      ok: true,
      firstAddresses,
      secondAddresses,
      finalAddresses,
      editorSelectionEmpty: view.state.selection.main.empty,
    });
  })()`;
}

function tableActiveDragDisposalExpression() {
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelectorAll('.mlrt-table-widget').length >= 2);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const wrapper = root?.querySelectorAll('.mlrt-table-widget')?.[1];
    const start = wrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="1"][data-column="0"]');
    if (!root || !view || !wrapper || !start) {
      return JSON.stringify({ ok: false, reason: 'missing active-drag disposal targets' });
    }
    const before = view.state.doc.toString();
    const tableFrom = Number(wrapper.dataset.srcFrom);
    const tableTo = Number(wrapper.dataset.srcTo);
    if (!Number.isFinite(tableFrom) || !Number.isFinite(tableTo) || tableTo <= tableFrom) {
      return JSON.stringify({ ok: false, reason: 'replacement fixture not found' });
    }
    const replacement =
      before.slice(0, tableFrom) +
      'table temporarily replaced during drag\\n' +
      before.slice(tableTo);
    const startRect = start.getBoundingClientRect();
    const afterTable = before.indexOf('more test here', tableTo);
    const prose = view.coordsAtPos(afterTable + 4);
    if (!prose) {
      return JSON.stringify({ ok: false, reason: 'missing prose drag target' });
    }
    const startPoint = {
      x: startRect.left + Math.min(8, startRect.width / 2),
      y: startRect.top + Math.min(8, startRect.height / 2),
    };
    const prosePoint = {
      x: prose.left + 1,
      y: (prose.top + prose.bottom) / 2,
    };
    const fire = (target, type, location, buttons) => target.dispatchEvent(
      new root.defaultView.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons,
        clientX: location.x,
        clientY: location.y,
      })
    );
    const errors = [];
    const onError = (event) => errors.push(event.error?.message ?? event.message ?? 'unknown error');
    root.defaultView.addEventListener('error', onError);
    fire(start, 'mousedown', startPoint, 1);
    fire(view.contentDOM, 'mousemove', prosePoint, 1);
    await Promise.resolve();
    const dragRangeBeforeReplacement = view.state.selection.main.toJSON();
    root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
      data: {
        type: 'setDocument',
        text: replacement,
        revision: 999801,
        debug: false,
      },
    }));
    await new Promise((done) => root.defaultView.requestAnimationFrame(() =>
      root.defaultView.requestAnimationFrame(done)
    ));
    const replacementApplied = view.state.doc.toString() === replacement;
    const wrapperDisconnected = !wrapper.isConnected;
    view.dispatch({ selection: { anchor: 0 } });
    fire(view.contentDOM, 'mousemove', prosePoint, 1);
    fire(view.contentDOM, 'mouseup', prosePoint, 0);
    await new Promise((done) => root.defaultView.setTimeout(done, 0));
    const rangeAfterStaleEvents = view.state.selection.main.toJSON();
    root.defaultView.removeEventListener('error', onError);
    root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
      data: {
        type: 'setDocument',
        text: before,
        revision: 999802,
        debug: false,
      },
    }));
    await new Promise((done) => root.defaultView.requestAnimationFrame(() =>
      root.defaultView.requestAnimationFrame(done)
    ));
    return JSON.stringify({
      ok: true,
      dragWasActive: dragRangeBeforeReplacement.anchor !== dragRangeBeforeReplacement.head,
      replacementApplied,
      wrapperDisconnected,
      staleRangeNotRestored:
        rangeAfterStaleEvents.anchor === 0 && rangeAfterStaleEvents.head === 0,
      errors,
      restoredDoc: view.state.doc.toString() === before,
      tableCountAfterRestore: root.querySelectorAll('.mlrt-table-widget').length,
    });
  })()`;
}

function partialMixedSelectionMoveToTableExpression() {
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.defaultView?.__MLRT_DOCUMENT_TABLE_DRAG__);
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    const state = root?.defaultView.__MLRT_DOCUMENT_TABLE_DRAG__;
    const wrappers = Array.from(root?.querySelectorAll('.mlrt-table-widget') ?? []);
    const destinationCell = wrappers[0]?.querySelector(
      '.mlrt-table-cell[data-row-kind="header"][data-column="0"]'
    );
    if (!root || !view || !state || !destinationCell) {
      return JSON.stringify({ ok: false });
    }
    const before = view.state.doc.toString();
    const beforeStandaloneTwentyCount = before
      .split('\\n')
      .filter((line) => line.trim() === '20').length;
    const transfer = new root.defaultView.DataTransfer();
    view.contentDOM.dispatchEvent(new root.defaultView.ClipboardEvent('cut', {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
    }));
    let payload = null;
    try {
      payload = JSON.parse(transfer.getData('application/x-markdown-live-editor+json'));
    } catch {}
    const rejectedBeforeDoc = view.state.doc.toString();
    const rejectedBeforeRange = view.state.selection.main.toJSON();
    const rejectedPaste = new root.defaultView.ClipboardEvent('paste', {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
    });
    view.contentDOM.dispatchEvent(rejectedPaste);
    await new Promise((done) => root.defaultView.requestAnimationFrame(done));
    const address = (cell) =>
      (cell.dataset.rowKind === 'header' ? 0 : Number(cell.dataset.rowIndex) + 1) +
      ':' + Number(cell.dataset.column);
    const rejectedAddresses = Array.from(
      root.querySelectorAll('.mlrt-document-range-selected')
    ).map(address).sort();
    const rejectedMoveKeptPending =
      rejectedPaste.defaultPrevented &&
      view.state.doc.toString() === rejectedBeforeDoc &&
      view.dom.classList.contains('mlrt-document-cut-pending') &&
      JSON.stringify(rejectedAddresses) === JSON.stringify([
        '0:0', '0:1', '1:0', '1:1', '2:0', '2:1'
      ]) &&
      root.querySelectorAll('.mlrt-prose-selection').length > 0 &&
      JSON.stringify(view.state.selection.main.toJSON()) ===
        JSON.stringify(rejectedBeforeRange);
    const destinationSiblingBefore = wrappers[0]?.querySelector(
      '.mlrt-table-cell[data-row-kind="header"][data-column="1"]'
    )?.textContent ?? '';
    destinationCell.focus();
    await new Promise((done) => root.defaultView.requestAnimationFrame(done));
    const focusedDestinationHasNoRange =
      root.activeElement === destinationCell &&
      view.state.selection.main.empty &&
      root.querySelectorAll('.mlrt-table-cell-selected').length === 0 &&
      root.querySelectorAll('.mlrt-document-range-selected').length === 0 &&
      root.querySelectorAll('.mlrt-prose-selection').length === 0;
    const destinationPaste = new root.defaultView.ClipboardEvent('paste', {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
    });
    destinationCell.dispatchEvent(destinationPaste);
    await new Promise((done) => root.defaultView.requestAnimationFrame(() =>
      root.defaultView.requestAnimationFrame(done)
    ));
    const after = view.state.doc.toString();
    const afterWrappers = Array.from(root.querySelectorAll('.mlrt-table-widget'));
    const movedDestination = afterWrappers[0]?.querySelector(
      '.mlrt-table-cell[data-row-kind="header"][data-column="0"]'
    )?.textContent ?? '';
    const destinationSiblingAfter = afterWrappers[0]?.querySelector(
      '.mlrt-table-cell[data-row-kind="header"][data-column="1"]'
    )?.textContent ?? '';
    const source = afterWrappers[1];
    const sourceCellsCleared = [
      source?.querySelector('.mlrt-table-cell[data-row-kind="header"][data-column="0"]'),
      source?.querySelector('.mlrt-table-cell[data-row-kind="header"][data-column="1"]'),
      source?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="0"]'),
      source?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="1"]'),
      source?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="1"][data-column="0"]'),
      source?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="1"][data-column="1"]'),
    ].every((cell) => cell?.textContent === '');
    const afterStandaloneTwentyCount = after
      .split('\\n')
      .filter((line) => line.trim() === '20').length;
    const unselectedTestPreserved = source?.querySelector(
      '.mlrt-table-cell[data-row-kind="body"][data-row-index="3"][data-column="2"]'
    )?.textContent === 'test';
    const pendingVisualCleared =
      !root.querySelector('.mlrt-document-cut-pending') &&
      !root.querySelector('.mlrt-table-cut-source-pending');
    root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
      data: { type: 'setDocument', text: state.beforeDoc, revision: 999046, debug: false },
    }));
    await new Promise((done) => root.defaultView.requestAnimationFrame(() =>
      root.defaultView.requestAnimationFrame(done)
    ));
    return JSON.stringify({
      ok: true,
      payloadKind: payload?.kind ?? null,
      hasCutToken: Boolean(payload?.cutToken),
      rejectedMoveKeptPending,
      focusedDestinationHasNoRange,
      focusedDestinationPastePrevented: destinationPaste.defaultPrevented,
      destinationContainsComposite:
        movedDestination.includes('20') &&
        movedDestination.includes('Short') &&
        movedDestination.includes('short cell.'),
      destinationSiblingPreserved:
        destinationSiblingBefore === 'Value' &&
        destinationSiblingAfter === destinationSiblingBefore,
      sourceCellsCleared,
      sourceProseMoved:
        afterStandaloneTwentyCount === beforeStandaloneTwentyCount - 1,
      sourceTableRemains: Boolean(source),
      unselectedTestPreserved,
      pendingVisualCleared,
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
    const menu = root.querySelector('.mlrt-clipboard-menu');
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

function tableRichCopyFallbackExpression() {
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mlrt-table-widget'));
    const menu = root?.querySelector('.mlrt-clipboard-menu:not(.mlrt-document-clipboard-menu)');
    const richButton = menu?.querySelector('button[data-action="copy-rich"]');
    if (!root || !richButton) {
      return JSON.stringify({ ok: false, reason: 'missing rich-copy menu target' });
    }
    const win = root.defaultView;
    const nav = win.navigator;
    const execDescriptor = Object.getOwnPropertyDescriptor(root, 'execCommand');
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(nav, 'clipboard');
    const clipboardItemDescriptor = Object.getOwnPropertyDescriptor(win, 'ClipboardItem');
    let writtenItems = null;
    let writeCalls = 0;
    class MockClipboardItem {
      constructor(data) {
        this.data = data;
        this.types = Object.keys(data);
      }
      async getType(type) {
        return this.data[type];
      }
    }
    try {
      Object.defineProperty(root, 'execCommand', {
        configurable: true,
        value: () => true,
      });
      Object.defineProperty(nav, 'clipboard', {
        configurable: true,
        value: {
          write: async (items) => {
            writeCalls++;
            writtenItems = items;
          },
        },
      });
      Object.defineProperty(win, 'ClipboardItem', {
        configurable: true,
        value: MockClipboardItem,
      });
      richButton.click();
      await new Promise((done) => win.requestAnimationFrame(() => win.requestAnimationFrame(done)));
      const item = writtenItems?.[0];
      const html = item?.types.includes('text/html')
        ? await (await item.getType('text/html')).text()
        : '';
      const plain = item?.types.includes('text/plain')
        ? await (await item.getType('text/plain')).text()
        : '';
      const parsedHtml = new win.DOMParser().parseFromString(html, 'text/html');
      const mixedLink = Array.from(
        parsedHtml.querySelectorAll('a[href]')
      ).find((candidate) => candidate.textContent === 'link');
      const mixedLinkCell = mixedLink?.closest('td');
      return JSON.stringify({
        ok: true,
        writeCalls,
        types: item?.types ?? [],
        htmlHasTable: html.includes('<table'),
        htmlHasRichFormatting:
          /<span style="font-weight:700">bold text<\\/span>/i.test(html) &&
          /<span style="font-family:monospace">inline code<\\/span>/i.test(html),
        mixedLinkLabelPreserved: parsedHtml.body.textContent.includes('a link'),
        mixedLinkIsInline: Boolean(
          mixedLink &&
          mixedLink.textContent === 'link' &&
          mixedLinkCell?.textContent.includes('It includes bold text, inline code, a link') &&
          mixedLinkCell.textContent !== mixedLink.textContent
        ),
        mixedLinkTargetPreserved:
          mixedLink?.getAttribute('href') === 'https://example.com',
        htmlHasAnchor: /<a(?:\\s|>)/i.test(html),
        plainHasTabs: plain.includes('\\t'),
        status: root.querySelector('.mlrt-clipboard-status')?.textContent ?? '',
      });
    } catch (error) {
      return JSON.stringify({ ok: false, reason: String(error) });
    } finally {
      if (execDescriptor) {
        Object.defineProperty(root, 'execCommand', execDescriptor);
      } else {
        delete root.execCommand;
      }
      if (clipboardDescriptor) {
        Object.defineProperty(nav, 'clipboard', clipboardDescriptor);
      } else {
        delete nav.clipboard;
      }
      if (clipboardItemDescriptor) {
        Object.defineProperty(win, 'ClipboardItem', clipboardItemDescriptor);
      } else {
        delete win.ClipboardItem;
      }
    }
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
    const smartDocument = new root.defaultView.DOMParser()
      .parseFromString(smartHtml, 'text/html');
    const smartFlow = smartDocument.querySelector('[data-mlrt-clipboard-layout="document"]');
    const smartFlowChildren = Array.from(smartFlow?.children ?? []);
    const smart17Index = smartFlowChildren.findIndex((element) => element.textContent.trim() === '17');
    const smart20Index = smartFlowChildren.findIndex((element) => element.textContent.trim() === '20');
    const smartBlankLinesBetween17And20 = smart17Index >= 0 && smart20Index > smart17Index
      ? smartFlowChildren.slice(smart17Index + 1, smart20Index)
        .filter((element) => element.matches('[data-mlrt-blank-line="true"]')).length
      : -1;
    const smartPlainRows = smartPlain.replace(/\\r\\n?/g, '\\n').split('\\n');
    const smartPlain17Index = smartPlainRows.indexOf('17');
    const smartPlain20Index = smartPlainRows.indexOf('20');
    const smartPlainBlankLinesBetween17And20 = smartPlain17Index >= 0 && smartPlain20Index > smartPlain17Index
      ? smartPlainRows.slice(smartPlain17Index + 1, smartPlain20Index)
        .filter((row) => row === '').length
      : -1;
    const privateData = transfer.getData('application/x-markdown-live-editor+json');
    let privateKind = null;
    try { privateKind = JSON.parse(privateData).kind; } catch {}

    root.documentElement.dataset.mlrtDefaultCopyMode = 'rich';
    const richTransfer = new root.defaultView.DataTransfer();
    view.contentDOM.dispatchEvent(new root.defaultView.ClipboardEvent('copy', {
      clipboardData: richTransfer, bubbles: true, cancelable: true,
    }));
    const richHtml = richTransfer.getData('text/html');
    const richText = new root.defaultView.DOMParser()
      .parseFromString(richHtml, 'text/html').body.textContent ?? '';

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
      smartUsesDocumentLayout: Boolean(smartFlow),
      smartOnlyMarkdownTablesAreTables: smartDocument.querySelectorAll('table').length === 2,
      smartProseOutsideTables: Array.from(smartDocument.querySelectorAll('p')).some((element) =>
        element.textContent.includes('Text up here') && !element.closest('table')
      ),
      smartBlankLinesBetween17And20,
      smartPlainBlankLinesBetween17And20,
      smartContainsNestedList: /<(ul|ol)(\\s|>)/i.test(smartHtml),
      smartContainsRichCellMarkup: /<(strong|a)(\\s|>)/i.test(smartHtml),
      richUsesDocumentLayout: richHtml.includes('data-mlrt-clipboard-layout="document"'),
      richUsesBlackBorders: /border:1px solid #000000/i.test(richHtml),
      richPreservesSupportedFormatting: /<span style="font-weight:700">bold text<\\/span>/i.test(richHtml) && /<span style="font-family:monospace">inline code<\\/span>/i.test(richHtml),
      richPreservesLinkLabel: richText.includes('a link'),
      richUsesInlineLink: /<a href="https:\\/\\/example.com"[^>]*>link<\\/a>/i.test(richHtml),
      richPreservesMixedLinkTarget: /href="https:\\/\\/example.com"/i.test(richHtml),
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

function clipboardMoveRegressionExpression() {
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.cm-editor'));
    const view = root?.defaultView.__MLRT_EDITOR_VIEW__;
    if (!root || !view) {
      return JSON.stringify({ ok: false, reason: 'missing clipboard regression root' });
    }
    const originalDocument = view.state.doc.toString();
    const originalCopyMode = root.documentElement.dataset.mlrtDefaultCopyMode ?? 'smart';
    const originalPasteMode = root.documentElement.dataset.mlrtDefaultPasteMode ?? 'auto';
    const originalDocumentToken = root.documentElement.dataset.mlrtDocumentToken ?? '';
    const originalLineWrapping = view.contentDOM.classList.contains('cm-lineWrapping');
    const scrollBeyondLastLineEnabled = () =>
      root.documentElement.style.getPropertyValue('--mlrt-editor-scroll-beyond-last-line') !== '0px';
    const originalScrollBeyondLastLine = scrollBeyondLastLineEnabled();
    const results = { ok: true };
    let revision = 999180;
    const wait = () => new Promise((done) => root.defaultView.requestAnimationFrame(() => root.defaultView.requestAnimationFrame(done)));
    const reset = async (text) => {
      root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
        data: { type: 'setDocument', text, revision: revision++, debug: false },
      }));
      await wait();
    };
    const key = (target, keyValue, options = {}) => target.dispatchEvent(new root.defaultView.KeyboardEvent('keydown', {
      key: keyValue, bubbles: true, cancelable: true, ...options,
    }));
    const required = (value, label) => {
      if (!value) throw new Error('missing ' + label);
      return value;
    };
    const firstWrapper = () => required(root.querySelector('.mlrt-table-widget'), 'table wrapper');
    const bodyCell = (wrapper, row, column) => required(wrapper.querySelector(
      '.mlrt-table-cell[data-row-kind="body"][data-row-index="' + row + '"][data-column="' + column + '"]'
    ), 'body cell ' + row + ':' + column);
    const headerCell = (wrapper, column) => required(wrapper.querySelector(
      '.mlrt-table-cell[data-row-kind="header"][data-column="' + column + '"]'
    ), 'header cell ' + column);
    const selectCell = async (cell) => {
      cell.focus();
      key(cell, 'Escape');
      await wait();
    };
    const clipboardEvent = (type, transfer) => new root.defaultView.ClipboardEvent(type, {
      clipboardData: transfer, bubbles: true, cancelable: true,
    });
    const hasPrivateData = (transfer) =>
      transfer.getData('application/x-markdown-live-editor+json').length > 0;
    const tableFixture = [
      'Before table',
      '',
      '| H1 | H2 | H3 |',
      '| --- | --- | --- |',
      '| TABLE_SOURCE | B | C |',
      '| D | E | F |',
      '| G | H | I |',
      '',
      'After table',
    ].join('\\n');
    const documentSource = 'DOCUMENT_SOURCE';
    const documentFixture = [documentSource, '', 'Document tail'].join('\\n');

    const runTableModeMove = async (mode) => {
      await reset(tableFixture);
      root.documentElement.dataset.mlrtDefaultCopyMode = mode;
      root.documentElement.dataset.mlrtDefaultPasteMode = 'auto';
      let wrapper = firstWrapper();
      const source = bodyCell(wrapper, 0, 0);
      const sourceText = source.innerText.trim();
      await selectCell(source);
      const transfer = new root.defaultView.DataTransfer();
      wrapper.dispatchEvent(clipboardEvent('cut', transfer));
      wrapper = firstWrapper();
      await selectCell(bodyCell(wrapper, 1, 1));
      wrapper.dispatchEvent(clipboardEvent('paste', transfer));
      await wait();
      wrapper = firstWrapper();
      return {
        privateData: hasPrivateData(transfer),
        moved:
          bodyCell(wrapper, 0, 0).innerText.trim() === '' &&
          bodyCell(wrapper, 1, 1).innerText.trim() === sourceText,
      };
    };

    const runDocumentModeMove = async (mode) => {
      await reset(documentFixture);
      root.documentElement.dataset.mlrtDefaultCopyMode = mode;
      root.documentElement.dataset.mlrtDefaultPasteMode = 'auto';
      view.focus();
      view.dispatch({ selection: { anchor: 0, head: documentSource.length } });
      await wait();
      const transfer = new root.defaultView.DataTransfer();
      view.contentDOM.dispatchEvent(clipboardEvent('cut', transfer));
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      view.contentDOM.dispatchEvent(clipboardEvent('paste', transfer));
      await wait();
      const after = view.state.doc.toString();
      return {
        privateData: hasPrivateData(transfer),
        moved: !after.startsWith(documentSource) && after.endsWith(documentSource),
      };
    };

    try {
      root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
        data: {
          type: 'setEditorOptions',
          editorOptions: {
            lineWrapping: !originalLineWrapping,
            scrollBeyondLastLine: !originalScrollBeyondLastLine,
            clipboardDocumentToken: originalDocumentToken,
            defaultCopyMode: 'plain',
            defaultPasteMode: 'markdown',
          },
        },
      }));
      await wait();
      results.editorOptionsMessageApplied =
        view.contentDOM.classList.contains('cm-lineWrapping') !== originalLineWrapping &&
        scrollBeyondLastLineEnabled() !== originalScrollBeyondLastLine &&
        root.documentElement.dataset.mlrtDefaultCopyMode === 'plain' &&
        root.documentElement.dataset.mlrtDefaultPasteMode === 'markdown';
      await reset(originalDocument);
      results.documentSyncPreservesEditorOptions =
        view.contentDOM.classList.contains('cm-lineWrapping') !== originalLineWrapping &&
        scrollBeyondLastLineEnabled() !== originalScrollBeyondLastLine &&
        root.documentElement.dataset.mlrtDocumentToken === originalDocumentToken &&
        root.documentElement.dataset.mlrtDefaultCopyMode === 'plain' &&
        root.documentElement.dataset.mlrtDefaultPasteMode === 'markdown';
      root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
        data: {
          type: 'setEditorOptions',
          editorOptions: {
            lineWrapping: originalLineWrapping,
            scrollBeyondLastLine: originalScrollBeyondLastLine,
            clipboardDocumentToken: originalDocumentToken,
            defaultCopyMode: originalCopyMode,
            defaultPasteMode: originalPasteMode,
          },
        },
      }));
      await wait();

      const tablePlain = await runTableModeMove('plain');
      const tableMarkdown = await runTableModeMove('markdown');
      const documentPlain = await runDocumentModeMove('plain');
      const documentMarkdown = await runDocumentModeMove('markdown');
      results.tablePlainCutHasPrivateData = tablePlain.privateData;
      results.tablePlainCutMoves = tablePlain.moved;
      results.tableMarkdownCutHasPrivateData = tableMarkdown.privateData;
      results.tableMarkdownCutMoves = tableMarkdown.moved;
      results.documentPlainCutHasPrivateData = documentPlain.privateData;
      results.documentPlainCutMoves = documentPlain.moved;
      results.documentMarkdownCutHasPrivateData = documentMarkdown.privateData;
      results.documentMarkdownCutMoves = documentMarkdown.moved;

      await reset(tableFixture);
      root.documentElement.dataset.mlrtDefaultCopyMode = 'smart';
      root.documentElement.dataset.mlrtDefaultPasteMode = 'auto';
      let wrapper = firstWrapper();
      const escapeSource = bodyCell(wrapper, 0, 0);
      const escapeSourceText = escapeSource.innerText.trim();
      await selectCell(escapeSource);
      const escapeTransfer = new root.defaultView.DataTransfer();
      wrapper.dispatchEvent(clipboardEvent('cut', escapeTransfer));
      wrapper = firstWrapper();
      await selectCell(bodyCell(wrapper, 1, 1));
      const escapePrevented = !key(wrapper, 'Escape');
      await wait();
      const escapeClearedPendingVisual =
        !root.querySelector('.mlrt-table-cut-source-pending') &&
        !root.querySelector('.mlrt-table-cut-source');
      wrapper = firstWrapper();
      wrapper.dispatchEvent(clipboardEvent('paste', escapeTransfer));
      await wait();
      wrapper = firstWrapper();
      results.escapeAfterDestinationCanceled =
        escapePrevented &&
        escapeClearedPendingVisual &&
        bodyCell(wrapper, 0, 0).innerText.trim() === escapeSourceText &&
        bodyCell(wrapper, 1, 1).innerText.trim() === escapeSourceText;

      await reset(tableFixture);
      wrapper = firstWrapper();
      const oversizedSource = bodyCell(wrapper, 0, 0);
      await selectCell(oversizedSource);
      const oversizedTransfer = new root.defaultView.DataTransfer();
      wrapper.dispatchEvent(clipboardEvent('cut', oversizedTransfer));
      wrapper = firstWrapper();
      await selectCell(bodyCell(wrapper, 1, 1));
      key(wrapper, 'ArrowRight', { shiftKey: true });
      key(wrapper, 'ArrowDown', { shiftKey: true });
      await wait();
      const beforeOversizedPaste = view.state.doc.toString();
      const oversizedPaste = clipboardEvent('paste', oversizedTransfer);
      wrapper.dispatchEvent(oversizedPaste);
      await wait();
      results.oversizedMoveRejected =
        oversizedPaste.defaultPrevented &&
        view.state.doc.toString() === beforeOversizedPaste;
      results.oversizedMoveKeepsPendingVisual = Boolean(
        root.querySelector('.mlrt-table-cut-source-pending .mlrt-table-cut-source')
      );
      wrapper = firstWrapper();
      wrapper.dispatchEvent(clipboardEvent('copy', new root.defaultView.DataTransfer()));
      await wait();

      const exactTable = [
        '|Left|Right|',
        '|:---|---:|',
        '|**MOVE_LEFT**|MOVE_RIGHT|',
      ].join('\\n');
      const tableToDocumentFixture = ['Lead', '', exactTable, '', 'TARGET'].join('\\n');
      await reset(tableToDocumentFixture);
      wrapper = firstWrapper();
      const sourceTableFrom = Number(wrapper.dataset.srcFrom);
      await selectCell(headerCell(wrapper, 0));
      key(wrapper, 'ArrowRight', { shiftKey: true });
      key(wrapper, 'ArrowDown', { shiftKey: true });
      await wait();
      const tableToDocumentTransfer = new root.defaultView.DataTransfer();
      wrapper.dispatchEvent(clipboardEvent('cut', tableToDocumentTransfer));
      const targetFrom = view.state.doc.toString().lastIndexOf('TARGET');
      view.focus();
      view.dispatch({ selection: { anchor: targetFrom, head: targetFrom + 'TARGET'.length } });
      await wait();
      view.contentDOM.dispatchEvent(clipboardEvent('paste', tableToDocumentTransfer));
      await wait();
      const afterTableToDocument = view.state.doc.toString();
      const sourceWrapper = Array.from(root.querySelectorAll('.mlrt-table-widget')).find(
        (candidate) => Number(candidate.dataset.srcFrom) === sourceTableFrom
      );
      const sourceCleared = Boolean(sourceWrapper) &&
        Array.from(sourceWrapper.querySelectorAll('.mlrt-table-cell'))
          .every((cell) => cell.innerText.trim() === '');
      results.tableToDocumentMoveCompleted = sourceCleared && !afterTableToDocument.includes('TARGET');
      results.tableToDocumentPreservedExactMarkdown = afterTableToDocument.endsWith(exactTable);

      const documentToTableSource = 'DOCUMENT_TO_TABLE';
      const documentToTableFixture = [
        documentToTableSource,
        '',
        '| H1 | H2 |',
        '| --- | --- |',
        '| old | stay |',
      ].join('\\n');
      await reset(documentToTableFixture);
      view.focus();
      view.dispatch({ selection: { anchor: 0, head: documentToTableSource.length } });
      await wait();
      const documentToTableTransfer = new root.defaultView.DataTransfer();
      view.contentDOM.dispatchEvent(clipboardEvent('cut', documentToTableTransfer));
      wrapper = firstWrapper();
      const focusedDocumentDestination = bodyCell(wrapper, 0, 0);
      const focusedDocumentSiblingBefore = bodyCell(wrapper, 0, 1).innerText.trim();
      focusedDocumentDestination.focus();
      await wait();
      results.focusedDocumentDestinationHasNoRange =
        wrapper.querySelectorAll('.mlrt-table-cell-selected').length === 0;
      const focusedDocumentPaste = clipboardEvent('paste', documentToTableTransfer);
      focusedDocumentDestination.dispatchEvent(focusedDocumentPaste);
      await wait();
      wrapper = firstWrapper();
      results.documentToTableMoveCompleted =
        !view.state.doc.toString().startsWith(documentToTableSource) &&
        bodyCell(wrapper, 0, 0).innerText.trim() === documentToTableSource;
      results.focusedDocumentPastePrevented = focusedDocumentPaste.defaultPrevented;
      results.focusedDocumentSiblingPreserved =
        focusedDocumentSiblingBefore === 'stay' &&
        bodyCell(wrapper, 0, 1).innerText.trim() === focusedDocumentSiblingBefore;
      results.focusedDocumentPendingCleared =
        !view.dom.classList.contains('mlrt-document-cut-pending');

      await reset(tableFixture);
      wrapper = firstWrapper();
      await selectCell(bodyCell(wrapper, 0, 0));
      const beforeMissingTableMime = view.state.doc.toString();
      const missingTableMimeTransfer = new root.defaultView.DataTransfer();
      missingTableMimeTransfer.setData('application/octet-stream', 'opaque');
      wrapper.dispatchEvent(clipboardEvent('paste', missingTableMimeTransfer));
      await wait();
      results.tableMissingMimePreservesDocument =
        view.state.doc.toString() === beforeMissingTableMime &&
        wrapper.querySelectorAll('.mlrt-table-cell-selected').length === 1;

      await reset(documentFixture);
      view.focus();
      view.dispatch({ selection: { anchor: 0, head: documentSource.length } });
      await wait();
      const beforeMissingDocumentMime = view.state.doc.toString();
      const selectionBeforeMissingDocumentMime = JSON.stringify(view.state.selection.main.toJSON());
      const missingDocumentMimeTransfer = new root.defaultView.DataTransfer();
      missingDocumentMimeTransfer.setData('application/octet-stream', 'opaque');
      const missingDocumentMimePaste = clipboardEvent('paste', missingDocumentMimeTransfer);
      view.contentDOM.dispatchEvent(missingDocumentMimePaste);
      await wait();
      results.documentMissingMimePreservesDocument =
        view.state.doc.toString() === beforeMissingDocumentMime;
      results.documentMissingMimePreservesSelection =
        JSON.stringify(view.state.selection.main.toJSON()) === selectionBeforeMissingDocumentMime;
      results.documentMissingMimePastePrevented =
        missingDocumentMimePaste.defaultPrevented;

      await reset(tableFixture);
      wrapper = firstWrapper();
      const changedSource = bodyCell(wrapper, 0, 0);
      const changedSourceText = changedSource.innerText.trim();
      await selectCell(changedSource);
      const changedSourceTransfer = new root.defaultView.DataTransfer();
      wrapper.dispatchEvent(clipboardEvent('cut', changedSourceTransfer));
      view.dispatch({
        changes: {
          from: 0,
          insert: 'prefix added after cut' + String.fromCharCode(10),
        },
      });
      await wait();
      const documentChangeClearedPendingVisual =
        !root.querySelector('.mlrt-table-cut-source-pending') &&
        !root.querySelector('.mlrt-table-cut-source') &&
        !root.querySelector('.mlrt-table-cut-pending');
      wrapper = firstWrapper();
      await selectCell(bodyCell(wrapper, 1, 1));
      wrapper.dispatchEvent(clipboardEvent('paste', changedSourceTransfer));
      await wait();
      wrapper = firstWrapper();
      results.documentChangeCancelsPendingMove =
        documentChangeClearedPendingVisual &&
        bodyCell(wrapper, 0, 0).innerText.trim() === changedSourceText &&
        bodyCell(wrapper, 1, 1).innerText.trim() === changedSourceText;

      await reset(tableFixture);
      wrapper = firstWrapper();
      const nativeCell = bodyCell(wrapper, 0, 0);
      nativeCell.focus();
      const nativeTextNode = required(nativeCell.firstChild, 'native cell text');
      const nativeText = nativeTextNode.textContent ?? '';
      const nativeStart = nativeText.indexOf('SOURCE');
      if (nativeStart < 0) throw new Error('missing native substring');
      const nativeRange = root.createRange();
      nativeRange.setStart(nativeTextNode, nativeStart);
      nativeRange.setEnd(nativeTextNode, nativeStart + 'SOURCE'.length);
      const nativeSelection = root.defaultView.getSelection();
      nativeSelection.removeAllRanges();
      nativeSelection.addRange(nativeRange);
      let nativeCutEventSeen = false;
      root.addEventListener('cut', () => { nativeCutEventSeen = true; }, { once: true });
      const nativeRect = nativeCell.getBoundingClientRect();
      nativeCell.dispatchEvent(new root.defaultView.MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: nativeRect.left + 8,
        clientY: nativeRect.top + 8,
      }));
      const nativeMenu = root.querySelector('.mlrt-clipboard-menu');
      const nativeCutButton = nativeMenu?.querySelector('button[data-action="cut"]');
      const nativeMenuUsesTextCut = nativeCutButton?.textContent === 'Cut selected text';
      const nativeMenuHidesTablePaste =
        !nativeMenu?.querySelector('button[data-action^="paste"]');
      nativeCutButton?.click();
      await wait();
      wrapper = firstWrapper();
      results.nativeSubstringContextCutWorks =
        nativeMenuUsesTextCut &&
        nativeMenuHidesTablePaste &&
        nativeCutEventSeen &&
        !bodyCell(wrapper, 0, 0).innerText.includes('SOURCE');
    } catch (error) {
      results.ok = false;
      results.reason = String(error instanceof Error ? error.message : error);
    } finally {
      if (view.state.doc.length > 0) {
        view.focus();
        view.dispatch({ selection: { anchor: 0, head: 1 } });
        await wait();
        view.contentDOM.dispatchEvent(clipboardEvent(
          'copy',
          new root.defaultView.DataTransfer(),
        ));
      }
      root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
        data: {
          type: 'setEditorOptions',
          editorOptions: {
            lineWrapping: originalLineWrapping,
            scrollBeyondLastLine: originalScrollBeyondLastLine,
            clipboardDocumentToken: originalDocumentToken,
            defaultCopyMode: originalCopyMode,
            defaultPasteMode: originalPasteMode,
          },
        },
      }));
      await wait();
      await reset(originalDocument);
      results.restoredDocument = view.state.doc.toString() === originalDocument;
      results.restoredCopyMode =
        root.documentElement.dataset.mlrtDefaultCopyMode === originalCopyMode;
      results.restoredPasteMode =
        root.documentElement.dataset.mlrtDefaultPasteMode === originalPasteMode;
      results.restoredLineWrapping =
        view.contentDOM.classList.contains('cm-lineWrapping') === originalLineWrapping;
      results.restoredScrollBeyondLastLine =
        scrollBeyondLastLineEnabled() === originalScrollBeyondLastLine;
    }
    return JSON.stringify(results);
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

function assertDocumentEndScroll(result) {
  if (!result?.ok) {
    throw new Error(
      `Document end scroll check failed: ${JSON.stringify(result)}`,
    );
  }
  const scrollDelta = Math.abs(result.scrollTop - result.maxScrollTop);
  const finalLineDelta = Math.abs(result.finalLineViewportTop ?? Infinity);
  const expectedPadding = result.clientHeight - result.lineHeight;
  const paddingDelta = Math.abs(result.paddingBottom - expectedPadding);
  if (
    result.maxScrollTop <= 0 ||
    scrollDelta > 1 ||
    finalLineDelta > 1 ||
    paddingDelta > 1
  ) {
    throw new Error(
      `Document end scroll check failed: ${JSON.stringify({
        ...result,
        scrollDelta,
        finalLineDelta,
        expectedPadding,
        paddingDelta,
      })}`,
    );
  }
}

function assertTestHostIsolation(result, expectedIsolated) {
  if (
    !result?.ok ||
    result.isolated !== expectedIsolated ||
    result.resyncPending ||
    !result.matchesFixture
  ) {
    throw new Error(
      `Test host isolation ${expectedIsolated ? "enable" : "resync"} failed: ${JSON.stringify(result)}`,
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
    !result.selectionSuppressesActiveLine ||
    !result.selectedArrowUpEscaped ||
    !result.selectedArrowDownEscaped ||
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
    !result.restoredDoc ||
    result.multiCellCutSelectedCount !== 2 ||
    !result.multiCellCutOverlayPreserved ||
    result.multiCellCutInteriorRailCount !== 1 ||
    !result.multiCellCutGridVisible ||
    !result.multiCellCutFrameDashed ||
    !result.multiCellCutSourcePseudoSuppressed
  ) {
    throw new Error(
      `Table clipboard selection check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableSelectionGeometry(result) {
  const geometryPasses = (geometry) =>
    geometry?.ok &&
    geometry.overlayBoundsAligned &&
    geometry.oneOverlay &&
    geometry.oneGrid &&
    geometry.oneFrame &&
    geometry.framePaintedLast &&
    geometry.frameStroke !== "none" &&
    geometry.frameStroke !== "rgba(0, 0, 0, 0)" &&
    Number.parseFloat(geometry.frameStrokeWidth) === 1 &&
    geometry.frameCoordinatesAligned &&
    geometry.railsAligned &&
    geometry.railCount === 3 &&
    geometry.railsTrimmedInsideFrame &&
    geometry.railEndpointsExact &&
    Number.parseFloat(geometry.gridStrokeWidth) === 1 &&
    geometry.gridStrokeLinecap === "butt" &&
    geometry.gridVectorEffect === "non-scaling-stroke" &&
    geometry.gridShapeRendering.toLowerCase() === "crispedges" &&
    geometry.frameStrokeLinejoin === "miter" &&
    geometry.frameVectorEffect === "non-scaling-stroke" &&
    geometry.frameShapeRendering.toLowerCase() === "crispedges" &&
    geometry.noCellInsetShadows &&
    geometry.selectedBordersTransparent;
  if (
    !result?.ok ||
    !geometryPasses(result.baseline) ||
    !geometryPasses(result.restored) ||
    !result.restoredStable ||
    !result.repeatedResizeAligned ||
    !result.resizeCausedRealReflow ||
    !result.horizontalScrollCase?.ok ||
    !result.horizontalScrollCase.overflowed ||
    !result.horizontalScrollCase.scrolled ||
    !result.horizontalScrollCase.geometryAligned ||
    !result.horizontalScrollCase.sourceLineStayedSticky ||
    !result.horizontalScrollCase.selectionIntersectsGutter ||
    !result.horizontalScrollCase.gutterPaintsAboveSelection ||
    !result.horizontalScrollCase.gutterBackgroundOpaque ||
    !result.rightNeighborAligned ||
    !result.bottomNeighborAligned
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

function assertProseCharacterSelectionSetup(result) {
  if (
    !result?.ok ||
    !Number.isFinite(result.anchor?.x) ||
    !Number.isFinite(result.anchor?.y) ||
    !Number.isInteger(result.anchor?.pos) ||
    result.heads?.length !== 7 ||
    !result.heads.every((point) =>
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      Number.isInteger(point.pos),
    )
  ) {
    throw new Error(
      `Prose character selection setup failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertProseCharacterSelection(result, expectedAnchor, point) {
  if (
    !result?.ok ||
    result.anchor !== expectedAnchor ||
    result.head !== point.pos ||
    result.selectedText !== point.expectedText ||
    result.markCount < 1 ||
    result.markBoxCount < 1 ||
    !Number.isFinite(result.leftDelta) ||
    !Number.isFinite(result.rightDelta) ||
    result.leftDelta > pixelTolerance ||
    result.rightDelta > pixelTolerance ||
    !result.markFillVisible ||
    result.selectionFillBlanketLineCount !== 0 ||
    result.blanketLineCount !== 0 ||
    result.visibleCodeMirrorBoxCount !== 0 ||
    result.selectedCellCount !== 0
  ) {
    throw new Error(
      `Prose character selection check failed: ${JSON.stringify({ result, expectedAnchor, point })}`,
    );
  }
}

function assertProseSelectionColorConsistency(focused, unfocused) {
  const focusedBackgrounds = focused?.markBackgrounds ?? [];
  const unfocusedBackgrounds = unfocused?.markBackgrounds ?? [];
  if (
    focusedBackgrounds.length < 1 ||
    focusedBackgrounds.some(selectionColorIsTransparent) ||
    JSON.stringify(focusedBackgrounds) !== JSON.stringify(unfocusedBackgrounds)
  ) {
    throw new Error(
      `Focused/unfocused prose selection color mismatch: ${JSON.stringify({ focused, unfocused })}`,
    );
  }
}

function assertTextSelectionColorTreatment(prose, cell) {
  const proseBackgrounds = prose?.markBackgrounds ?? [];
  const proseAlpha = selectionColorAlpha(proseBackgrounds[0]);
  const cellAlpha = selectionColorAlpha(cell?.nativeSelectionBackground);
  if (
    proseBackgrounds.length < 1 ||
    proseBackgrounds.some(selectionColorIsTransparent) ||
    selectionColorIsTransparent(cell?.nativeSelectionBackground) ||
    !Number.isFinite(proseAlpha) ||
    !Number.isFinite(cellAlpha) ||
    proseAlpha >= cellAlpha
  ) {
    throw new Error(
      `Prose selection should remain visible but slightly softer than native cell selection: ${JSON.stringify({ prose, cell })}`,
    );
  }
}

function selectionColorAlpha(value) {
  if (typeof value !== "string") return Number.NaN;
  const slashMatch = value.match(/\/\s*([0-9.]+)\s*\)$/);
  if (slashMatch) return Number.parseFloat(slashMatch[1]);
  const rgbaMatch = value.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([0-9.]+)\)$/);
  return rgbaMatch ? Number.parseFloat(rgbaMatch[1]) : 1;
}

function assertMultilineProseSelection(setup, result) {
  const details = result?.details ?? [];
  if (
    !setup?.ok ||
    !result?.ok ||
    result.selectedText !== setup.expectedText ||
    details.length !== 4 ||
    !details[0].continuesToNext ||
    details[0].continuesFromPrevious ||
    !details[0].connectsBottomLeft ||
    !details.at(-1).continuesFromPrevious ||
    details.at(-1).continuesToNext ||
    !details.at(-1).connectsTopLeft ||
    !details.slice(1, -1).every((detail) =>
      detail.continuesFromPrevious && detail.continuesToNext &&
      detail.connectsTopLeft && detail.connectsBottomLeft
    ) ||
    details.some((detail) => selectionColorIsTransparent(detail.background)) ||
    details.slice(0, -1).some((detail, index) =>
      Math.abs(detail.paintedBottom - details[index + 1].paintedTop) > pixelTolerance
    ) ||
    details.some((detail) =>
      detail.connectsTopLeft !== (detail.borderTopLeftRadius === "0px") ||
      detail.connectsTopRight !== (detail.borderTopRightRadius === "0px") ||
      detail.connectsBottomLeft !== (detail.borderBottomLeftRadius === "0px") ||
      detail.connectsBottomRight !== (detail.borderBottomRightRadius === "0px")
    )
  ) {
    throw new Error(
      `Multiline prose selection did not form a continuous shape: ${JSON.stringify({ setup, result })}`,
    );
  }
}

function assertWrappedDownwardSelectionSetup(result) {
  if (
    !result?.ok ||
    ![
      result.startX,
      result.startY,
      result.endX,
      result.endY,
      result.anchor,
      result.head,
    ].every(Number.isFinite) ||
    result.head <= result.anchor ||
    typeof result.expectedText !== "string" ||
    result.expectedAddresses?.length !== 10
  ) {
    throw new Error(
      `Wrapped downward selection setup failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertWrappedDownwardSelection(setup, result) {
  if (
    !result?.ok ||
    result.anchor !== setup.anchor ||
    result.head !== setup.head ||
    result.selectedText !== setup.expectedText ||
    JSON.stringify(result.selectedAddresses) !==
      JSON.stringify(setup.expectedAddresses) ||
    result.markCount < 2 ||
    result.fragmentCount < result.markCount ||
    result.wrapRowCount < 4 ||
    !result.everyFragmentUsesDirectFill ||
    !result.pseudoHighlightsDisabled ||
    result.visibleCodeMirrorBoxCount !== 0 ||
    result.overlayCount !== 1
  ) {
    throw new Error(
      `Wrapped downward selection check failed: ${JSON.stringify({ setup, result })}`,
    );
  }
}

function assertBlankLineProseSelection(setup, result) {
  if (
    !setup?.ok ||
    !result?.ok ||
    result.selectedText !== setup.expectedText ||
    result.markerCount !== 3 ||
    result.details?.length !== 3 ||
    result.details[0].continuesFromPrevious ||
    !result.details[0].continuesToNext ||
    !result.details[1].continuesFromPrevious ||
    !result.details[1].continuesToNext ||
    !result.details[2].continuesFromPrevious ||
    result.details[2].continuesToNext ||
    result.details.some((detail) =>
      !Number.isFinite(Number.parseFloat(detail.width)) ||
      Number.parseFloat(detail.width) <= 0 ||
      !Number.isFinite(Number.parseFloat(detail.height)) ||
      Number.parseFloat(detail.height) <= 0 ||
      selectionColorIsTransparent(detail.background)
    ) ||
    result.details[0].borderTopLeftRadius !== "1px" ||
    result.details[0].borderBottomLeftRadius !== "0px" ||
    result.details[2].borderTopLeftRadius !== "0px" ||
    result.details[2].borderBottomLeftRadius !== "1px"
  ) {
    throw new Error(
      `Selected blank prose line was not visibly marked: ${JSON.stringify({ setup, result })}`,
    );
  }
}

function assertDocumentEndSelectionSetup(result) {
  if (
    !result?.ok ||
    !Number.isFinite(result.anchor?.x) ||
    !Number.isFinite(result.anchor?.y) ||
    !Number.isFinite(result.blankX) ||
    !Number.isFinite(result.blankY) ||
    !Number.isInteger(result.docLength)
  ) {
    throw new Error(
      `Document-end selection setup failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertDocumentEndSelection(result) {
  if (
    !result?.ok ||
    result.anchor !== 6 ||
    result.head !== result.docLength ||
    result.selectedText !== "beta gamma\nfinal yz" ||
    result.maxMarkBottom === null ||
    result.finalLineBottom === null ||
    result.finalLineMarkCount < 1 ||
    result.maxMarkBottom > result.finalLineBottom + pixelTolerance ||
    !Number.isFinite(result.finalRightDelta) ||
    result.finalRightDelta > pixelTolerance ||
    result.blankLineSelectionCount !== 0 ||
    result.visibleCodeMirrorBoxCount !== 0 ||
    result.selectedCellCount !== 0
  ) {
    throw new Error(
      `Document-end selection bounds failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertDocumentEndTableSelection(result) {
  if (
    !result?.ok ||
    result.anchor !== 6 ||
    result.head !== result.docLength ||
    result.selectedCellCount < 1 ||
    result.selectedCellCount !== result.totalCellCount ||
    result.selectedBottom === null ||
    result.finalTableBottom === null ||
    Math.abs(result.selectedBottom - result.finalTableBottom) > pixelTolerance ||
    !result.overlayBoundsFinalRow ||
    result.maxSelectionBottom === null ||
    result.maxSelectionBottom > result.finalTableBottom + pixelTolerance ||
    result.visibleCodeMirrorBoxCount !== 0 ||
    result.visibleStructureIndicatorCount !== 0
  ) {
    throw new Error(
      `Document-end table selection bounds failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertCellFocusIsolationSetup(result) {
  if (
    !result?.ok ||
    !Number.isFinite(result.x) ||
    !Number.isFinite(result.y) ||
    result.preselectedCells < 1 ||
    result.preselectedMarks < 1
  ) {
    throw new Error(
      `Cell focus isolation setup failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertCellFocusIsolation(result) {
  if (
    !result?.ok ||
    !result.editorSelectionEmpty ||
    !result.activeIsCell ||
    !result.nativeSelectionCollapsed ||
    !result.nativeCaretInsideCell ||
    result.documentSelectedCells !== 0 ||
    result.tableSelectedCells !== 0 ||
    result.proseSelectionMarks !== 0 ||
    result.overlayCount !== 0
  ) {
    throw new Error(
      `Cell focus isolation check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertSameCellNativeSelectionSetup(result) {
  if (
    !result?.ok ||
    ![result.start?.x, result.start?.y, result.end?.x, result.end?.y].every(
      Number.isFinite,
    ) ||
    typeof result.expectedText !== "string" ||
    result.expectedText.length < 1
  ) {
    throw new Error(
      `Same-cell native selection setup failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertSameCellNativeSelection(result, expectedText) {
  if (
    !result?.ok ||
    result.selectedText !== expectedText ||
    result.nativeSelectionCollapsed ||
    !result.nativeRangeInsideCell ||
    !result.activeIsCell ||
    !result.editorSelectionEmpty ||
    result.tableSelectedCells !== 0 ||
    result.documentSelectedCells !== 0 ||
    result.proseSelectionMarks !== 0 ||
    result.overlayCount !== 0 ||
    selectionColorIsTransparent(result.nativeSelectionBackground)
  ) {
    throw new Error(
      `Same-cell native character selection failed: ${JSON.stringify({ result, expectedText })}`,
    );
  }
}

async function runTrustedTableEditingReliabilityCheck(client) {
  const afterSetup = await evaluateJson(
    client,
    tableBoundaryDeleteSetupExpression("after"),
  );
  assertReliabilitySetup("after-table Backspace", afterSetup);
  await dispatchTrustedEditingKey(client, {
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
  });
  const afterResult = await evaluateJson(
    client,
    tableBoundaryDeleteResultExpression(),
  );
  assertBoundaryDeleteProtected("after-table Backspace", afterResult);

  const beforeSetup = await evaluateJson(
    client,
    tableBoundaryDeleteSetupExpression("before"),
  );
  assertReliabilitySetup("before-table Delete", beforeSetup);
  await dispatchTrustedEditingKey(client, {
    key: "Delete",
    code: "Delete",
    windowsVirtualKeyCode: 46,
  });
  const beforeResult = await evaluateJson(
    client,
    tableBoundaryDeleteResultExpression(),
  );
  assertBoundaryDeleteProtected("before-table Delete", beforeResult);

  const graphemeSetup = await evaluateJson(
    client,
    tableGraphemeDeleteSetupExpression(),
  );
  assertReliabilitySetup("grapheme Backspace", graphemeSetup);
  await dispatchTrustedEditingKey(client, {
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
  });
  const graphemeResult = await evaluateJson(
    client,
    tableGraphemeDeleteResultExpression(),
  );
  if (
    !graphemeResult?.ok ||
    graphemeResult.cellText !== "AB" ||
    !graphemeResult.sourceContainsAB ||
    !graphemeResult.shapePreserved ||
    !graphemeResult.neighborPreserved ||
    graphemeResult.hasUnpairedSurrogate ||
    graphemeResult.lastInputType !== "deleteContentBackward"
  ) {
    throw new Error(
      `Trusted grapheme Backspace failed: ${JSON.stringify(graphemeResult)}`,
    );
  }

  const crossCellSetup = await evaluateJson(
    client,
    tableCrossCellDeleteSetupExpression(),
  );
  assertReliabilitySetup("cross-cell Backspace", crossCellSetup);
  await dispatchTrustedEditingKey(client, {
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
  });
  const crossCellResult = await evaluateJson(
    client,
    tableCrossCellDeleteResultExpression(),
  );
  if (
    !crossCellResult?.ok ||
    !crossCellResult.sourcePreserved ||
    !crossCellResult.domShapePreserved
  ) {
    throw new Error(
      `Cross-cell destructive edit guard failed: ${JSON.stringify(crossCellResult)}`,
    );
  }

  const wordStartSetup = await evaluateJson(
    client,
    tableWordDeleteSetupExpression("start"),
  );
  assertReliabilitySetup("word Backspace at cell start", wordStartSetup);
  await dispatchTrustedEditingKey(client, {
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    modifiers: 1,
  });
  const wordStartResult = await evaluateJson(
    client,
    tableWordDeleteResultExpression(),
  );
  if (
    !wordStartResult?.ok ||
    !wordStartResult.sourcePreserved ||
    !wordStartResult.shapePreserved ||
    !wordStartResult.neighborPreserved
  ) {
    throw new Error(
      `Word Backspace crossed the cell boundary: ${JSON.stringify(wordStartResult)}`,
    );
  }

  const wordEndSetup = await evaluateJson(
    client,
    tableWordDeleteSetupExpression("end"),
  );
  assertReliabilitySetup("word Backspace within cell", wordEndSetup);
  await dispatchTrustedEditingKey(client, {
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    modifiers: 1,
  });
  const wordEndResult = await evaluateJson(
    client,
    tableWordDeleteResultExpression(),
  );
  if (
    !wordEndResult?.ok ||
    wordEndResult.sourcePreserved ||
    wordEndResult.cellText === "alpha beta" ||
    !wordEndResult.cellText?.startsWith("alpha") ||
    !wordEndResult.shapePreserved ||
    !wordEndResult.neighborPreserved ||
    wordEndResult.hasUnpairedSurrogate
  ) {
    throw new Error(
      `Word Backspace inside a cell failed: ${JSON.stringify(wordEndResult)}`,
    );
  }

  console.log("TRUSTED TABLE EDITING RELIABILITY CHECK:", {
    afterResult,
    beforeResult,
    graphemeResult,
    crossCellResult,
    wordStartResult,
    wordEndResult,
  });
}

async function dispatchTrustedEditingKey(client, options) {
  const modifiers = options.modifiers ?? 0;
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    modifiers,
    key: options.key,
    code: options.code,
    windowsVirtualKeyCode: options.windowsVirtualKeyCode,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers,
    key: options.key,
    code: options.code,
    windowsVirtualKeyCode: options.windowsVirtualKeyCode,
  });
  await sleep(180);
}

function assertReliabilitySetup(label, result) {
  if (!result?.ok) {
    throw new Error(`${label} setup failed: ${JSON.stringify(result)}`);
  }
}

function assertBoundaryDeleteProtected(label, result) {
  if (
    !result?.ok ||
    !result.sourcePreserved ||
    !result.shapePreserved ||
    result.postChangeDelta !== 0
  ) {
    throw new Error(`${label} was not blocked: ${JSON.stringify(result)}`);
  }
}

function tableBoundaryDeleteSetupExpression(side) {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mlrt-table-widget')) ?? document;
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    const wrapper = root.querySelector('.mlrt-table-widget');
    if (!view || !wrapper) {
      return JSON.stringify({ ok: false, reason: 'missing boundary targets' });
    }
    const tableFrom = Number(wrapper.dataset.srcFrom);
    const tableTo = Number(wrapper.dataset.srcTo);
    const position = ${JSON.stringify(side)} === 'after' ? tableTo + 1 : tableFrom - 1;
    const source = view.state.doc.toString();
    const separator = ${JSON.stringify(side)} === 'after'
      ? source.slice(tableTo, tableTo + 1)
      : source.slice(tableFrom - 1, tableFrom);
    const rowCount = wrapper.querySelectorAll('tr').length;
    const cellCount = wrapper.querySelectorAll('.mlrt-table-cell').length;
    const postChangeCount = (root.defaultView.__MLRT_DEBUG_EVENTS__ ?? [])
      .filter((event) => event.event === 'post-change').length;
    root.defaultView.__MLRT_EDITING_RELIABILITY_STATE__ = {
      source,
      tableFrom,
      rowCount,
      cellCount,
      postChangeCount,
    };
    view.focus();
    view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
    return JSON.stringify({
      ok: separator === '\\n',
      position,
      separator,
      side: ${JSON.stringify(side)},
    });
  })()`;
}

function tableBoundaryDeleteResultExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mlrt-table-widget')) ?? document;
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    const state = root.defaultView.__MLRT_EDITING_RELIABILITY_STATE__;
    const wrapper = Array.from(root.querySelectorAll('.mlrt-table-widget'))
      .find((candidate) => Number(candidate.dataset.srcFrom) === state?.tableFrom);
    if (!view || !state || !wrapper) {
      return JSON.stringify({ ok: false, reason: 'missing boundary result state' });
    }
    const postChangeCount = (root.defaultView.__MLRT_DEBUG_EVENTS__ ?? [])
      .filter((event) => event.event === 'post-change').length;
    return JSON.stringify({
      ok: true,
      sourcePreserved: view.state.doc.toString() === state.source,
      shapePreserved:
        wrapper.querySelectorAll('tr').length === state.rowCount &&
        wrapper.querySelectorAll('.mlrt-table-cell').length === state.cellCount,
      postChangeDelta: postChangeCount - state.postChangeCount,
    });
  })()`;
}

function tableGraphemeDeleteSetupExpression() {
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mlrt-table-widget')) ?? document;
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    const wrapper = root.querySelector('.mlrt-table-widget');
    let cell = wrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="0"]');
    const neighbor = wrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="1"]');
    if (!view || !wrapper || !cell || !neighbor) {
      return JSON.stringify({ ok: false, reason: 'missing grapheme targets' });
    }
    const inputTypes = [];
    wrapper.addEventListener('beforeinput', (event) => inputTypes.push(event.inputType), true);
    root.defaultView.__MLRT_RELIABILITY_INPUT_TYPES__ = inputTypes;
    cell.focus();
    const replace = root.createRange();
    replace.selectNodeContents(cell);
    const selection = root.defaultView.getSelection();
    selection.removeAllRanges();
    selection.addRange(replace);
    cell.dispatchEvent(new root.defaultView.InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: 'A😀B',
    }));
    await new Promise((done) => root.defaultView.requestAnimationFrame(() => root.defaultView.requestAnimationFrame(done)));
    cell = root.querySelector('.mlrt-table-widget .mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="0"]');
    if (!cell || !cell.firstChild) {
      return JSON.stringify({ ok: false, reason: 'missing grapheme cell after setup' });
    }
    cell.focus();
    const caret = root.createRange();
    caret.setStart(cell.firstChild, 3);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);
    root.defaultView.__MLRT_EDITING_RELIABILITY_STATE__ = {
      source: view.state.doc.toString(),
      tableFrom: Number(wrapper.dataset.srcFrom),
      rowCount: wrapper.querySelectorAll('tr').length,
      cellCount: wrapper.querySelectorAll('.mlrt-table-cell').length,
      neighborText: neighbor.textContent,
    };
    inputTypes.length = 0;
    return JSON.stringify({ ok: cell.textContent === 'A😀B' });
  })()`;
}

function tableGraphemeDeleteResultExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mlrt-table-widget')) ?? document;
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    const state = root.defaultView.__MLRT_EDITING_RELIABILITY_STATE__;
    const wrapper = Array.from(root.querySelectorAll('.mlrt-table-widget'))
      .find((candidate) => Number(candidate.dataset.srcFrom) === state?.tableFrom);
    const cell = wrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="0"]');
    const neighbor = wrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="1"]');
    if (!view || !state || !wrapper || !cell || !neighbor) {
      return JSON.stringify({ ok: false, reason: 'missing grapheme result targets' });
    }
    const sourceFrom = Number(cell.dataset.sourceFrom);
    const sourceLine = Number.isFinite(sourceFrom) ? view.state.doc.lineAt(sourceFrom).text : '';
    const hasUnpairedSurrogate = (value) => {
      for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code >= 0xD800 && code <= 0xDBFF) {
          const next = value.charCodeAt(index + 1);
          if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
          index++;
        } else if (code >= 0xDC00 && code <= 0xDFFF) {
          return true;
        }
      }
      return false;
    };
    const inputTypes = root.defaultView.__MLRT_RELIABILITY_INPUT_TYPES__ ?? [];
    return JSON.stringify({
      ok: true,
      cellText: cell.textContent,
      sourceContainsAB: sourceLine.includes('AB'),
      shapePreserved:
        wrapper.querySelectorAll('tr').length === state.rowCount &&
        wrapper.querySelectorAll('.mlrt-table-cell').length === state.cellCount,
      neighborPreserved: neighbor.textContent === state.neighborText,
      hasUnpairedSurrogate: hasUnpairedSurrogate(view.state.doc.toString()),
      lastInputType: inputTypes.at(-1) ?? null,
    });
  })()`;
}

function tableCrossCellDeleteSetupExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mlrt-table-widget')) ?? document;
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    const wrapper = root.querySelector('.mlrt-table-widget');
    const first = wrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="0"]');
    const second = wrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="1"]');
    if (!view || !wrapper || !first?.firstChild || !second?.firstChild) {
      return JSON.stringify({ ok: false, reason: 'missing cross-cell targets' });
    }
    first.focus();
    const range = root.createRange();
    range.setStart(first.firstChild, 0);
    range.setEnd(second.firstChild, second.firstChild.textContent.length);
    const selection = root.defaultView.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    root.defaultView.__MLRT_EDITING_RELIABILITY_STATE__ = {
      source: view.state.doc.toString(),
      tableFrom: Number(wrapper.dataset.srcFrom),
      rowCount: wrapper.querySelectorAll('tr').length,
      cellCount: wrapper.querySelectorAll('.mlrt-table-cell').length,
    };
    return JSON.stringify({ ok: !selection.isCollapsed });
  })()`;
}

function tableCrossCellDeleteResultExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mlrt-table-widget')) ?? document;
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    const state = root.defaultView.__MLRT_EDITING_RELIABILITY_STATE__;
    const wrapper = Array.from(root.querySelectorAll('.mlrt-table-widget'))
      .find((candidate) => Number(candidate.dataset.srcFrom) === state?.tableFrom);
    if (!view || !state || !wrapper) {
      return JSON.stringify({ ok: false, reason: 'missing cross-cell result state' });
    }
    return JSON.stringify({
      ok: true,
      sourcePreserved: view.state.doc.toString() === state.source,
      domShapePreserved:
        wrapper.querySelectorAll('tr').length === state.rowCount &&
        wrapper.querySelectorAll('.mlrt-table-cell').length === state.cellCount,
    });
  })()`;
}

function tableWordDeleteSetupExpression(position) {
  return `(async () => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mlrt-table-widget')) ?? document;
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    const wrapper = root.querySelector('.mlrt-table-widget');
    let cell = wrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="0"]');
    const neighbor = wrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="1"]');
    if (!view || !wrapper || !cell || !neighbor) {
      return JSON.stringify({ ok: false, reason: 'missing word-delete targets' });
    }
    cell.focus();
    const replace = root.createRange();
    replace.selectNodeContents(cell);
    const selection = root.defaultView.getSelection();
    selection.removeAllRanges();
    selection.addRange(replace);
    cell.dispatchEvent(new root.defaultView.InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: 'alpha beta',
    }));
    await new Promise((done) => root.defaultView.requestAnimationFrame(() => root.defaultView.requestAnimationFrame(done)));
    cell = root.querySelector('.mlrt-table-widget .mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="0"]');
    if (!cell?.firstChild) {
      return JSON.stringify({ ok: false, reason: 'missing word-delete cell after setup' });
    }
    cell.focus();
    const caret = root.createRange();
    const offset = ${JSON.stringify(position)} === 'start' ? 0 : cell.firstChild.textContent.length;
    caret.setStart(cell.firstChild, offset);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);
    root.defaultView.__MLRT_EDITING_RELIABILITY_STATE__ = {
      source: view.state.doc.toString(),
      tableFrom: Number(wrapper.dataset.srcFrom),
      rowCount: wrapper.querySelectorAll('tr').length,
      cellCount: wrapper.querySelectorAll('.mlrt-table-cell').length,
      neighborText: neighbor.textContent,
    };
    return JSON.stringify({ ok: cell.textContent === 'alpha beta', offset });
  })()`;
}

function tableWordDeleteResultExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mlrt-table-widget')) ?? document;
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    const state = root.defaultView.__MLRT_EDITING_RELIABILITY_STATE__;
    const wrapper = Array.from(root.querySelectorAll('.mlrt-table-widget'))
      .find((candidate) => Number(candidate.dataset.srcFrom) === state?.tableFrom);
    const cell = wrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="0"]');
    const neighbor = wrapper?.querySelector('.mlrt-table-cell[data-row-kind="body"][data-row-index="0"][data-column="1"]');
    if (!view || !state || !wrapper || !cell || !neighbor) {
      return JSON.stringify({ ok: false, reason: 'missing word-delete result targets' });
    }
    const hasUnpairedSurrogate = (value) => {
      for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code >= 0xD800 && code <= 0xDBFF) {
          const next = value.charCodeAt(index + 1);
          if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
          index++;
        } else if (code >= 0xDC00 && code <= 0xDFFF) {
          return true;
        }
      }
      return false;
    };
    return JSON.stringify({
      ok: true,
      sourcePreserved: view.state.doc.toString() === state.source,
      cellText: cell.textContent,
      shapePreserved:
        wrapper.querySelectorAll('tr').length === state.rowCount &&
        wrapper.querySelectorAll('.mlrt-table-cell').length === state.cellCount,
      neighborPreserved: neighbor.textContent === state.neighborText,
      hasUnpairedSurrogate: hasUnpairedSurrogate(view.state.doc.toString()),
    });
  })()`;
}

async function runTableOriginMixedPasteCase(
  client,
  direction,
  payloadKind,
  revision,
) {
  const setup = await evaluateJson(
    client,
    tablePointerSelectionSetupExpression(),
  );
  assertTablePointerSelectionSetup(setup);
  const point = direction === "above"
    ? setup.aboveHeads.at(-1)
    : setup.belowHeads.at(-1);
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: setup.startX,
    y: setup.startY,
    button: "left",
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: setup.insideX,
    y: setup.insideY,
    button: "left",
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    button: "left",
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(80);
  const selection = await evaluateJson(
    client,
    tablePointerSelectionResultExpression(),
  );
  const addresses = direction === "above"
    ? ["0:0", "0:1", "0:2", "1:0", "1:1", "1:2", "2:0", "2:1", "2:2"]
    : ["2:0", "2:1", "2:2", "3:0", "3:1", "3:2", "4:0", "4:1", "4:2"];
  assertTablePointerProseEndpoint(
    selection,
    addresses,
    direction === "above" ? setup.tableTo : setup.tableFrom,
    point,
  );
  return evaluateJson(
    client,
    tableOriginMixedPasteExpression(direction, payloadKind, revision),
  );
}

async function runMixedTypedInputUndoCheck(client) {
  await establishPartialMixedSelection(client);
  const expectedText = "TYPED_REPLACEMENT";
  const insert = await client.send("Input.insertText", { text: expectedText });
  if (insert.error) {
    throw new Error(
      `Mixed input dispatch failed: ${JSON.stringify(insert.error)}`,
    );
  }
  const replacement = await evaluateJson(
    client,
    mixedInputReplacementResultExpression(expectedText, 999055, false),
  );
  assertMixedInputReplacement(replacement, false);
  await dispatchTrustedUndo(client);
  const undo = await evaluateJson(
    client,
    mixedInputUndoResultExpression(999056),
  );
  assertMixedInputUndo(undo);
  console.log("MIXED TYPED REPLACEMENT/UNDO CHECK:", {
    ...replacement,
    ...undo,
  });
}

async function runMixedImeImmediateUndoCheck(client) {
  await establishPartialMixedSelection(client);
  const firstComposition = await client.send("Input.imeSetComposition", {
    text: "に",
    selectionStart: 1,
    selectionEnd: 1,
  });
  const secondComposition = await client.send("Input.imeSetComposition", {
    text: "日本",
    selectionStart: 2,
    selectionEnd: 2,
  });
  const commit = await client.send("Input.insertText", { text: "日本" });
  if (firstComposition.error || secondComposition.error || commit.error) {
    throw new Error(
      `Immediate mixed IME dispatch failed: ${JSON.stringify({
        firstComposition,
        secondComposition,
        commit,
      })}`,
    );
  }

  // Deliberately do not wait for a timer, animation frame, or Runtime.evaluate
  // round trip here. Undo must serialize the pending composition to the VS
  // Code host before it asks the host to reverse that edit.
  await dispatchTrustedUndo(client);
  const undo = await evaluateJson(
    client,
    mixedInputUndoResultExpression(999060, "日本"),
  );
  assertMixedInputUndo(undo);
  console.log("MIXED IME IMMEDIATE-UNDO RACE CHECK:", undo);
}

async function runMixedImeQueuedCommandFifoCheck(client) {
  await establishPartialMixedSelection(client);
  const composition = await client.send("Input.imeSetComposition", {
    text: "に",
    selectionStart: 1,
    selectionEnd: 1,
  });
  if (composition.error) {
    throw new Error(
      `Mixed IME queued-command setup failed: ${JSON.stringify(composition.error)}`,
    );
  }
  const armed = await evaluateJson(
    client,
    armMixedImeQueuedCommandFifoExpression(),
  );
  if (
    !armed?.ok ||
    !armed.composing ||
    !armed.redoPrevented ||
    JSON.stringify(armed.deferredCommands) !== JSON.stringify(["redo"])
  ) {
    throw new Error(
      `Mixed IME queued-command arm failed: ${JSON.stringify(armed)}`,
    );
  }
  const commit = await client.send("Input.insertText", { text: "日本" });
  if (commit.error) {
    throw new Error(
      `Mixed IME queued-command commit failed: ${JSON.stringify(commit.error)}`,
    );
  }
  await sleep(180);
  const result = await evaluateJson(
    client,
    mixedImeQueuedCommandFifoResultExpression(),
  );
  if (
    !result?.ok ||
    JSON.stringify(result.commands) !== JSON.stringify(["redo", "undo"]) ||
    JSON.stringify(result.deferredCommands) !== JSON.stringify(["redo"]) ||
    !result.compositionPublished ||
    !result.sourceRestored ||
    !result.compositionTextRemoved ||
    result.composing
  ) {
    throw new Error(
      `Mixed IME queued-command FIFO failed: ${JSON.stringify(result)}`,
    );
  }
  console.log("MIXED IME QUEUED-COMMAND FIFO CHECK:", result);
}

async function runMixedImeInputUndoCheck(client) {
  await establishPartialMixedSelection(client);
  const firstComposition = await client.send("Input.imeSetComposition", {
    text: "に",
    selectionStart: 1,
    selectionEnd: 1,
  });
  await sleep(60);
  const firstSnapshot = await evaluateJson(
    client,
    mixedCompositionSnapshotExpression("に", ""),
  );
  assertMixedCompositionSnapshot(firstSnapshot);
  const secondComposition = await client.send("Input.imeSetComposition", {
    text: "日本",
    selectionStart: 2,
    selectionEnd: 2,
  });
  await sleep(60);
  const secondSnapshot = await evaluateJson(
    client,
    mixedCompositionSnapshotExpression("日本", "に"),
  );
  assertMixedCompositionSnapshot(secondSnapshot);
  if (firstComposition.error || secondComposition.error) {
    throw new Error(
      `Mixed IME dispatch failed: ${JSON.stringify({ firstComposition, secondComposition })}`,
    );
  }
  const commit = await client.send("Input.insertText", { text: "日本" });
  if (commit.error) {
    throw new Error(
      `Mixed IME commit failed: ${JSON.stringify(commit.error)}`,
    );
  }
  await sleep(60);
  const replacement = await evaluateJson(
    client,
    mixedInputReplacementResultExpression("日本", 999058, false),
  );
  assertMixedInputReplacement(replacement, false);
  await dispatchTrustedUndo(client);
  const undo = await evaluateJson(
    client,
    mixedInputUndoResultExpression(999059),
  );
  assertMixedInputUndo(undo);
  console.log("MIXED IME REPLACEMENT/UNDO CHECK:", {
    ...replacement,
    ...undo,
    firstCompositionSnapshot: firstSnapshot,
    secondCompositionSnapshot: secondSnapshot,
  });
}

async function runMixedImeHostConflictCheck(client) {
  await establishPartialMixedSelection(client);
  const composition = await client.send("Input.imeSetComposition", {
    text: "に",
    selectionStart: 1,
    selectionEnd: 1,
  });
  if (composition.error) {
    throw new Error(
      `Mixed IME host-conflict setup failed: ${JSON.stringify(composition.error)}`,
    );
  }
  const authoritativeText = "# HOST_AUTHORITATIVE\n\nremote edit\n";
  const hostApply = await evaluateJson(
    client,
    injectHostDocumentDuringCompositionExpression(
      authoritativeText,
      999061,
    ),
  );
  if (
    !hostApply?.ok ||
    !hostApply.composing
  ) {
    throw new Error(
      `Mixed IME host-conflict apply failed: ${JSON.stringify(hostApply)}`,
    );
  }
  const trailingCommit = await client.send("Input.insertText", { text: "日本" });
  if (trailingCommit.error) {
    throw new Error(
      `Mixed IME host-conflict commit failed: ${JSON.stringify(trailingCommit.error)}`,
    );
  }
  await sleep(100);
  const result = await evaluateJson(
    client,
    mixedImeHostConflictResultExpression(authoritativeText, 999062),
  );
  if (
    !result?.ok ||
    !result.authoritativeTextPreserved ||
    !result.trailingCandidateAbsent ||
    !result.projectionCleared ||
    !result.restoredDoc
  ) {
    throw new Error(
      `Mixed IME host-conflict reconciliation failed: ${JSON.stringify(result)}`,
    );
  }
  console.log("MIXED IME/HOST CONFLICT RECONCILIATION CHECK:", {
    ...hostApply,
    ...result,
  });
}

async function dispatchTrustedUndo(client) {
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    modifiers: 4,
    key: "z",
    code: "KeyZ",
    windowsVirtualKeyCode: 90,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: 4,
    key: "z",
    code: "KeyZ",
    windowsVirtualKeyCode: 90,
  });
  await sleep(120);
}

async function establishPartialMixedSelection(client) {
  const setup = await evaluateJson(
    client,
    documentToTableDragSetupExpression(),
  );
  assertDocumentToTableDragSetup(setup);
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: setup.startX,
    y: setup.startY,
    button: "left",
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: setup.finalX,
    y: setup.finalY,
    button: "left",
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: setup.finalX,
    y: setup.finalY,
    button: "left",
    clickCount: 1,
  });
  await sleep(80);
  const selection = await evaluateJson(
    client,
    documentToTableDragResultExpression(),
  );
  assertDocumentToTableDragResult(selection, [
    "0:0", "0:1", "1:0", "1:1", "2:0", "2:1",
  ], true);
  if (!selection.editorHasFocus || selection.activeIsCell) {
    throw new Error(
      `Mixed selection focus failed: ${JSON.stringify(selection)}`,
    );
  }
  return setup;
}

function assertTablePointerSelectionSetup(result) {
  if (
    !result?.ok ||
    ![
      result.startX,
      result.startY,
      result.insideX,
      result.insideY,
      result.horizontalX,
      result.horizontalY,
      result.reentryX,
      result.reentryY,
      result.tableFrom,
      result.tableTo,
    ].every(Number.isFinite) ||
    result.belowHeads?.length !== 3 ||
    result.aboveHeads?.length !== 2 ||
    ![...result.belowHeads, ...result.aboveHeads].every((point) =>
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      Number.isInteger(point.pos) &&
      typeof point.expectedText === "string"
    )
  ) {
    throw new Error(
      `Table pointer selection setup failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableGutterSelectionSetup(result) {
  if (
    !result?.ok ||
    ![
      result.gutterX,
      result.gutterY,
      result.insideX,
      result.insideY,
      result.cellX,
      result.cellY,
      result.leftX,
      result.wrappedGutterX,
      result.wrappedGutterY,
      result.gutterSourceTo,
      result.tableFrom,
      result.tableTo,
    ].every(Number.isFinite) ||
    !Number.isFinite(result.above?.x) ||
    !Number.isFinite(result.above?.y) ||
    !Number.isInteger(result.above?.pos) ||
    typeof result.above?.expectedText !== "string" ||
    result.wrapperUserSelect !== "none" ||
    result.cellUserSelect !== "text" ||
    result.gutterUserSelect !== "none" ||
    result.wrappedGutterHeight <= result.ordinaryGutterHeight
  ) {
    throw new Error(
      `Table gutter selection setup failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertProseToGutterSelection(result, setup) {
  const expectedAddresses = [
    "0:0", "0:1", "0:2", "1:0", "1:1", "1:2", "2:0", "2:1", "2:2",
  ];
  assertTablePointerSelection(result, "document", expectedAddresses, true);
  if (
    result.anchor !== setup.above.pos ||
    result.head !== setup.gutterSourceTo ||
    result.selectedText !==
      setup.above.expectedText.slice(0, setup.gutterSourceTo - setup.above.pos)
  ) {
    throw new Error(
      `Prose-to-gutter selection failed: ${JSON.stringify({ result, setup })}`,
    );
  }
}

function assertWrappedGutterSelection(result) {
  if (
    !result?.ok ||
    !result.editorSelectionEmpty ||
    JSON.stringify(result.tableAddresses) !== JSON.stringify(["1:0", "1:1"]) ||
    result.documentAddresses?.length !== 0 ||
    !result.nativeSelectionCollapsed ||
    result.activeIsCell ||
    result.overlayCount !== 1
  ) {
    throw new Error(
      `Wrapped gutter row selection failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTablePointerSelection(
  result,
  mode,
  expectedAddresses,
  allowNativeEditorRange = false,
) {
  const actual = mode === "table"
    ? result?.tableAddresses
    : result?.documentAddresses;
  const inactive = mode === "table"
    ? result?.documentAddresses
    : result?.tableAddresses;
  if (
    !result?.ok ||
    JSON.stringify(actual) !== JSON.stringify(expectedAddresses) ||
    inactive?.length !== 0 ||
    result.editorSelectionEmpty !== (mode === "table") ||
    (mode === "table"
      ? result.proseSelectionMarkCount !== 0
      : result.proseSelectionMarkCount < 1) ||
    (!result.nativeSelectionCollapsed &&
      (!allowNativeEditorRange ||
        !result.nativeSelectionInsideEditor ||
        !selectionColorIsTransparent(result.nativeTableSelectionBackground))) ||
    result.activeIsCell ||
    result.overlapCellCount !== 0 ||
    result.overlayCount !== 1 ||
    !result.overlayBoundsAligned ||
    result.legacyOutlineCount !== 0 ||
    !result.selectedCellsHaveNoShadow ||
    !result.selectedCellStylesMatch ||
    !result.selectedCellsHaveNoVisiblePseudo ||
    !result.selectedCellStylesMatch ||
    result.visibleStructureIndicatorCount !== 0 ||
    result.visibleCodeMirrorBoxCount !== 0 ||
    !selectionStyleIsValid(result.selectionStyle)
  ) {
    throw new Error(
      `Table pointer selection ${mode} check failed: ${JSON.stringify({ result, expectedAddresses })}`,
    );
  }
}

function assertTablePointerProseEndpoint(
  result,
  expectedAddresses,
  expectedAnchor,
  point,
  allowNativeEditorRange = false,
) {
  assertTablePointerSelection(
    result,
    "document",
    expectedAddresses,
    allowNativeEditorRange,
  );
  if (
    result.anchor !== expectedAnchor ||
    result.head !== point.pos ||
    result.selectedText !== point.expectedText ||
    result.proseHeadLineMarkCount < 1 ||
    !Number.isFinite(result.proseHeadEdgeDelta) ||
    result.proseHeadEdgeDelta > pixelTolerance
  ) {
    throw new Error(
      `Table-origin prose character endpoint failed: ${JSON.stringify({ result, expectedAnchor, point })}`,
    );
  }
}

function assertTableOriginMixedPaste(result) {
  const expectedWrapperDelta = result?.payloadKind === "table" ? 1 : 0;
  if (
    !result?.ok ||
    !result.pastePrevented ||
    !result.retainedTableParses ||
    !result.selectedCellsCleared ||
    !result.outsideCellsPreserved ||
    !result.selectedProseRemoved ||
    !result.markerIsSeparateBlock ||
    !result.payloadAppearsExactlyOnce ||
    !result.payloadOnAnchorSide ||
    result.wrapperCountDelta !== expectedWrapperDelta ||
    !result.pastedTableParses ||
    !result.unsafeJoinAbsent ||
    !result.projectionCleared ||
    !result.restoredDoc
  ) {
    throw new Error(
      `Table-origin mixed paste failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertSelectionStyleParity(pureStyle, mixedStyle) {
  if (
    !selectionStyleIsValid(pureStyle) ||
    !selectionStyleIsValid(mixedStyle) ||
    JSON.stringify(pureStyle) !== JSON.stringify(mixedStyle)
  ) {
    throw new Error(
      `Pure/mixed table selection style mismatch: ${JSON.stringify({ pureStyle, mixedStyle })}`,
    );
  }
}

function selectionColorIsTransparent(value) {
  return (
    typeof value !== "string" ||
    value === "transparent" ||
    /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(value) ||
    /\/\s*0(?:\.0+)?\s*\)$/.test(value)
  );
}

function selectionStyleIsValid(style) {
  if (!style) return false;
  return (
    !selectionColorIsTransparent(style.backgroundColor) &&
    [
      style.borderTopColor,
      style.borderRightColor,
      style.borderBottomColor,
      style.borderLeftColor,
    ].every(selectionColorIsTransparent) &&
    !selectionColorIsTransparent(style.gridStroke) &&
    !selectionColorIsTransparent(style.frameStroke) &&
    style.gridStrokeWidth === "1px" &&
    style.frameStrokeWidth === "1px" &&
    style.boxShadow === "none"
  );
}

function assertSelectionArtifactCleanup(result) {
  if (
    result.activeIsCell ||
    result.wrapperOutlineStyle !== "none" ||
    result.visibleFocusIndicatorCount !== 0 ||
    result.visibleStructureIndicatorCount !== 0 ||
    result.frameStrokeIsWhite ||
    result.legacyOutlineCount !== 0 ||
    result.overlapCellCount !== 0 ||
    !result.nativeSelectionCollapsed ||
    !result.selectedCellsHaveNoShadow ||
    !result.selectedCellsHaveNoVisiblePseudo ||
    !result.overlayBoundsAligned
  ) {
    throw new Error(
      `Selection artifact cleanup failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertReverseDocumentTableDragSetup(result) {
  if (
    !result?.ok ||
    ![
      result.startX,
      result.startY,
      result.cellX,
      result.cellY,
      result.startPosition,
      result.partialHead,
    ].every(Number.isFinite) ||
    typeof result.partialExpectedText !== "string" ||
    result.aboveHeads?.length !== 2 ||
    !result.aboveHeads.every((point) =>
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      Number.isInteger(point.pos) &&
      typeof point.expectedText === "string"
    )
  ) {
    throw new Error(
      `Reverse document/table drag setup failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertReverseDocumentTableDrag(
  result,
  expectedAddresses,
  expectedAnchor,
  expectedHead,
  expectedText,
  full,
  requireNativeRange = false,
) {
  if (
    !result?.ok ||
    JSON.stringify(result.selectedAddresses) !== JSON.stringify(expectedAddresses) ||
    result.selectionEmpty ||
    result.anchor !== expectedAnchor ||
    result.head !== expectedHead ||
    result.selectedText !== expectedText ||
    result.proseSelectionMarkCount < 1 ||
    (requireNativeRange && (
      result.nativeSelectionCollapsed ||
      !result.nativeSelectionInsideEditor
    )) ||
    !selectionColorIsTransparent(result.nativeTableSelectionBackground) ||
    !selectionColorIsTransparent(result.nativeProseSelectionBackground) ||
    result.rectangularCellCount !== 0 ||
    result.visibleCodeMirrorSelectionBoxCount !== 0 ||
    result.blanketProseLineCount !== 0 ||
    result.activeIsCell ||
    result.overlayCount !== 1 ||
    !result.overlayBoundsAligned ||
    !result.selectedCellsHaveNoVisiblePseudo ||
    !result.selectedCellStylesMatch ||
    result.visibleStructureIndicatorCount !== 0 ||
    !selectionStyleIsValid(result.selectionStyle) ||
    (result.selectedCellCount === result.totalCellCount) !== full ||
    (full && (
      result.proseHeadLineMarkCount < 1 ||
      !Number.isFinite(result.proseHeadEdgeDelta) ||
      result.proseHeadEdgeDelta > pixelTolerance
    ))
  ) {
    throw new Error(
      `Reverse document/table drag check failed: ${JSON.stringify({ result, expectedAddresses, full })}`,
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

function assertTableCrossBoundaryDrag(result, stage) {
  const expected = stage === "prose"
    ? [["1:0", "1:1"]]
    : [["1:0", "1:1"], ["0:0", "0:1", "1:0", "1:1"]];
  const actual = result?.selectedByTable?.map((table) => table.addresses) ?? [];
  if (
    !result?.ok ||
    result.selectionEmpty ||
    result.selectionFrom > result.tableFrom ||
    result.selectionTo <= result.tableFrom ||
    result.selectedDocumentCells < 1 ||
    JSON.stringify(actual) !== JSON.stringify(expected) ||
    result.selectedDocumentTables !== expected.length ||
    result.completelySelectedDocumentTables !== 0 ||
    result.documentSelectionOverlayCount !== expected.length ||
    !result.documentSelectionOverlaysComplete ||
    !result.documentSelectionHasNoInsetShadows ||
    result.selectedRangeCells !== 0 ||
    result.selectedProseLineCount < 1 ||
    result.proseSelectionMarkCount < 1 ||
    result.selectionBoxCount !== 0 ||
    result.proseLinesWithSelectionBox !== 0 ||
    result.blanketProseLineCount !== 0
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
      || result.belowHeads?.length !== 3
      || !result.belowHeads.every((point) =>
        Number.isFinite(point.x) &&
        Number.isFinite(point.y) &&
        Number.isInteger(point.pos) &&
        typeof point.expectedText === "string"
      )
  ) {
    throw new Error(
      `Document-to-table drag setup failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertDocumentToTableDragResult(
  result,
  expectedAddresses,
  requireNativeRange = false,
) {
  if (
    !result?.ok ||
    result.selectionEmpty ||
    result.totalCellCount < 1 ||
    JSON.stringify(result.selectedAddresses) !== JSON.stringify(expectedAddresses) ||
    result.selectedCellCount !== expectedAddresses.length ||
    result.rectangularCellCount !== 0 ||
    (requireNativeRange && (
      result.nativeSelectionCollapsed ||
      !result.nativeSelectionInsideEditor
    )) ||
    !selectionColorIsTransparent(result.nativeTableSelectionBackground) ||
    !selectionColorIsTransparent(result.nativeProseSelectionBackground) ||
    result.proseSelectionMarkCount < 1 ||
    result.visibleCodeMirrorSelectionBoxCount !== 0 ||
    result.blanketProseLineCount !== 0 ||
    result.activeIsCell ||
    result.overlayCount !== 1 ||
    !result.overlayBoundsAligned ||
    !result.selectedCellsHaveNoVisiblePseudo ||
    result.visibleStructureIndicatorCount !== 0 ||
    !selectionStyleIsValid(result.selectionStyle)
  ) {
    throw new Error(
      `Document-to-table drag check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertDocumentThroughTableDragResult(
  result,
  expectedAnchor,
  point,
  expectedAddresses,
) {
  assertDocumentToTableDragResult(result, expectedAddresses);
  if (
    result.anchor !== expectedAnchor ||
    result.head !== point.pos ||
    result.selectedText !== point.expectedText ||
    !Number.isFinite(result.proseHeadRightDelta) ||
    result.proseHeadRightDelta > pixelTolerance ||
    result.selectedCellCount !== result.totalCellCount
  ) {
    throw new Error(
      `Forward document/table/document drag check failed: ${JSON.stringify({ result, expectedAnchor, point })}`,
    );
  }
}

function assertPartialMixedSelectionCopy(result) {
  if (
    !result?.ok ||
    result.privateKind !== "document" ||
    !result.markdown.includes("Short") ||
    !result.markdown.includes("short cell.") ||
    !result.plainHasSelectedShort ||
    !result.plainHasTabs ||
    !result.htmlHasTable ||
    !result.excludesUnselectedTest ||
    !result.excludesUnselectedThirdColumn ||
    !result.selectionStillPartial
  ) {
    throw new Error(
      `Partial mixed-selection copy failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertPartialMixedSelectionPaste(result) {
  if (
    !result?.ok ||
    !result.pastePrevented ||
    !result.insertedAtAnchor ||
    !result.targetTableRemains ||
    !result.clearedVisibleCells ||
    !result.unselectedTestPreserved ||
    !result.projectionCleared
  ) {
    throw new Error(
      `Partial mixed-selection paste failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertMixedInputReplacement(result, expectsRestore) {
  if (
    !result?.ok ||
    !result.docChanged ||
    !result.insertedExactlyOnce ||
    !result.selectedProseRemoved ||
    !result.targetTableRemains ||
    !result.selectedCellsCleared ||
    !result.unselectedTestPreserved ||
    !result.unselectedCellsUnchanged ||
    result.composing !== false ||
    !result.selectionCollapsed ||
    !result.projectionCleared ||
    (expectsRestore && !result.restoredDoc)
  ) {
    throw new Error(
      `Mixed selection input replacement failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertMixedCompositionSnapshot(result) {
  if (
    !result?.ok ||
    !result.composing ||
    !result.currentCandidateExactlyOnce ||
    !result.selectedProseRemoved ||
    !result.previousCandidateAbsent ||
    !result.selectedCellsCleared ||
    !result.unselectedCellsUnchanged ||
    !result.projectionCleared ||
    !result.targetTableParses
  ) {
    throw new Error(
      `Mixed composition update failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertMixedInputUndo(result) {
  if (
    !result?.ok ||
    !result.oneUndoRestoredSource ||
    !result.composedTextRemoved ||
    !result.originalTableRestored ||
    !result.selectionCollapsed ||
    !result.restoredDoc
  ) {
    throw new Error(
      `Mixed selection composition undo failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertPartialMixedContextMenu(result) {
  if (
    !result?.ok ||
    !result.selectedPointerPrevented ||
    !result.selectedContextPrevented ||
    result.selectedDocumentMenuCount !== 1 ||
    result.selectedTableMenuCount !== 0 ||
    !result.selectedProjectionPreserved ||
    !result.unselectedPointerPrevented ||
    !result.unselectedContextPrevented ||
    !result.unselectedUsesTableMenu ||
    !result.unselectedDidNotUseDocumentMenu ||
    !result.unselectedCellSelected ||
    !result.projectionCleared ||
    !result.menuClosedBeforeRestore ||
    !result.restoredDoc
  ) {
    throw new Error(
      `Partial mixed context-menu routing failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertMixedDragOwnershipLoss(result) {
  if (
    !result?.ok ||
    result.capturedBefore?.length !== 1 ||
    result.capturedAfter?.length !== 0 ||
    !result.staleTargetFound ||
    JSON.stringify(result.addressesBefore) !== JSON.stringify([
      "0:0", "0:1", "1:0", "1:1", "2:0", "2:1",
    ]) ||
    !result.selectionFinalized ||
    !result.staleMoveIgnored
  ) {
    throw new Error(
      `Mixed drag ownership cleanup failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertMixedDragSuccessiveGesture(result) {
  const first = ["0:0"];
  const final = ["0:0", "0:1", "1:0", "1:1", "2:0", "2:1"];
  if (
    !result?.ok ||
    JSON.stringify(result.afterStaleLoss) !== JSON.stringify(first) ||
    JSON.stringify(result.afterOldTimer) !== JSON.stringify(final) ||
    JSON.stringify(result.afterRelease) !== JSON.stringify(final) ||
    result.finalRange?.anchor === result.finalRange?.head
  ) {
    throw new Error(
      `Mixed successive-gesture ownership failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableDragOwnershipLoss(result) {
  if (
    !result?.ok ||
    result.capturedBefore?.length !== 1 ||
    result.capturedAfter?.length !== 0 ||
    !result.staleTargetFound ||
    JSON.stringify(result.addressesBefore) !== JSON.stringify([
      "2:0", "2:1", "3:0", "3:1",
    ]) ||
    !result.selectionFinalized ||
    !result.staleMoveIgnored
  ) {
    throw new Error(
      `Table drag ownership cleanup failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableMouseFallbackRecovery(result) {
  const firstExpected = ["2:0", "2:1", "3:0", "3:1"];
  const secondExpected = ["0:1", "0:2", "1:1", "1:2"];
  if (
    !result?.ok ||
    JSON.stringify(result.firstAddresses) !== JSON.stringify(firstExpected) ||
    JSON.stringify(result.secondAddresses) !== JSON.stringify(secondExpected) ||
    JSON.stringify(result.finalAddresses) !== JSON.stringify(secondExpected) ||
    !result.editorSelectionEmpty
  ) {
    throw new Error(
      `Table mouse fallback recovery failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableActiveDragDisposal(result) {
  if (
    !result?.ok ||
    !result.dragWasActive ||
    !result.replacementApplied ||
    !result.wrapperDisconnected ||
    !result.staleRangeNotRestored ||
    result.errors?.length !== 0 ||
    !result.restoredDoc ||
    result.tableCountAfterRestore < 2
  ) {
    throw new Error(
      `Table active-drag disposal failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertPartialMixedSelectionMoveToTable(result) {
  if (
    !result?.ok ||
    result.payloadKind !== "document" ||
    !result.hasCutToken ||
    !result.rejectedMoveKeptPending ||
    !result.focusedDestinationHasNoRange ||
    !result.focusedDestinationPastePrevented ||
    !result.destinationContainsComposite ||
    !result.destinationSiblingPreserved ||
    !result.sourceCellsCleared ||
    !result.sourceProseMoved ||
    !result.sourceTableRemains ||
    !result.unselectedTestPreserved ||
    !result.pendingVisualCleared ||
    !result.restoredDoc
  ) {
    throw new Error(
      `Partial mixed-selection move-to-table failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertDocumentToTableDelete(result) {
  if (
    !result?.ok ||
    !result.docChanged ||
    !result.targetTableRemains ||
    !result.clearedVisibleCells ||
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

function assertTableRichCopyFallback(result) {
  if (
    !result?.ok ||
    result.writeCalls !== 1 ||
    !result.types.includes('text/plain') ||
    !result.types.includes('text/html') ||
    !result.htmlHasTable ||
    !result.htmlHasRichFormatting ||
    !result.mixedLinkLabelPreserved ||
    !result.mixedLinkIsInline ||
    !result.mixedLinkTargetPreserved ||
    !result.htmlHasAnchor ||
    !result.plainHasTabs ||
    result.status !== 'Copied as Rich.'
  ) {
    throw new Error(
      `Table rich copy fallback check failed: ${JSON.stringify(result)}`,
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
    !result.smartUsesDocumentLayout ||
    !result.smartOnlyMarkdownTablesAreTables ||
    !result.smartProseOutsideTables ||
    result.smartBlankLinesBetween17And20 !== 2 ||
    result.smartPlainBlankLinesBetween17And20 !== 2 ||
    !result.smartContainsNestedList ||
    result.smartContainsRichCellMarkup ||
    !result.richUsesDocumentLayout ||
    !result.richUsesBlackBorders ||
    !result.richPreservesSupportedFormatting ||
    !result.richPreservesLinkLabel ||
    !result.richUsesInlineLink ||
    !result.richPreservesMixedLinkTarget ||
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

function assertClipboardMoveRegressions(result) {
  if (
    !result?.ok ||
    !result.editorOptionsMessageApplied ||
    !result.documentSyncPreservesEditorOptions ||
    !result.tablePlainCutHasPrivateData ||
    !result.tablePlainCutMoves ||
    !result.tableMarkdownCutHasPrivateData ||
    !result.tableMarkdownCutMoves ||
    !result.documentPlainCutHasPrivateData ||
    !result.documentPlainCutMoves ||
    !result.documentMarkdownCutHasPrivateData ||
    !result.documentMarkdownCutMoves ||
    !result.escapeAfterDestinationCanceled ||
    !result.oversizedMoveRejected ||
    !result.oversizedMoveKeepsPendingVisual ||
    !result.tableToDocumentMoveCompleted ||
    !result.tableToDocumentPreservedExactMarkdown ||
    !result.documentToTableMoveCompleted ||
    !result.focusedDocumentDestinationHasNoRange ||
    !result.focusedDocumentPastePrevented ||
    !result.focusedDocumentSiblingPreserved ||
    !result.focusedDocumentPendingCleared ||
    !result.tableMissingMimePreservesDocument ||
    !result.documentMissingMimePreservesDocument ||
    !result.documentMissingMimePreservesSelection ||
    !result.documentMissingMimePastePrevented ||
    !result.documentChangeCancelsPendingMove ||
    !result.nativeSubstringContextCutWorks ||
    !result.restoredDocument ||
    !result.restoredCopyMode ||
    !result.restoredPasteMode ||
    !result.restoredLineWrapping ||
    !result.restoredScrollBeyondLastLine
  ) {
    throw new Error(
      `Clipboard move regression check failed: ${JSON.stringify(result)}`,
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
    result.afterUndoText !== "base" ||
    !result.selectionCollapsed ||
    !result.afterDocIncludesBase ||
    !result.afterDocMatchesBefore
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
	    result.sourceEditCount < 1 ||
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
