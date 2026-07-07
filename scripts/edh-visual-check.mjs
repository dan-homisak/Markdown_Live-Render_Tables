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
  const editShortcuts = await evaluateJson(
    liveClient,
    tableCellEditShortcutsExpression(),
  );
  assertTableCellEditShortcuts(editShortcuts);
  console.log("TABLE CELL EDIT SHORTCUTS CHECK:", editShortcuts);
  const trustedUndoSetup = await evaluateJson(
    liveClient,
    tableTrustedUndoSetupExpression(),
  );
  assertTableTrustedUndoSetup(trustedUndoSetup);
  await liveClient.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
  });
  await liveClient.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
  });
  await sleep(100);
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
  const value = result.result?.result?.value;
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
      const table = root.querySelector('.mm-live-v4-table');
      if (!scroller || !table) continue;
      const gutter = root.querySelector('.cm-gutters');
      const lineNumber = root.querySelector('.cm-lineNumbers .cm-gutterElement:not([style*="visibility: hidden"])');
      const line = root.querySelector('.cm-line');
      const activeLine = root.querySelector('.cm-activeLine');
      const activeLineGutter = root.querySelector('.cm-activeLineGutter');
      const tableScroll = root.querySelector('.mm-live-v4-table-scroll');
      const tableScrollbar = root.querySelector('.mm-live-v4-table-scrollbar');
      const sourceLine = root.querySelector('.mm-live-v4-table-source-line');
      const tableCell = root.querySelector('.mm-live-v4-table-cell');
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
    const root = roots.find((candidate) => candidate.querySelector('.mm-live-v4-table-scroll'));
    if (!root) {
      return JSON.stringify({ ok: false, reason: 'missing live root' });
    }
    const scroller = root.querySelector('.cm-scroller');
    const tableScroll = root.querySelector('.mm-live-v4-table-scroll');
    const tableScrollbar = root.querySelector('.mm-live-v4-table-scrollbar');
    const sourceLine = root.querySelector('.mm-live-v4-table-source-line');
    const tableCell = root.querySelector('.mm-live-v4-table-cell');
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
    const root = roots.find((candidate) => candidate.querySelector('.mm-live-v4-table-scroll'));
    const tableScroll = root?.querySelector('.mm-live-v4-table-scroll');
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
    const root = roots.find((candidate) => candidate.querySelector('.mm-live-v4-table-scroll'));
    const tableScroll = root?.querySelector('.mm-live-v4-table-scroll');
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
  return `new Promise((resolve) => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try {
        return frame.contentDocument;
      } catch {
        return null;
      }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mm-live-v4-table-widget'));
    if (!root) {
      resolve(JSON.stringify({ ok: false, reason: 'missing live root' }));
      return;
    }
    const widgets = Array.from(root.querySelectorAll('.mm-live-v4-table-widget'));
    const widget = widgets[widgets.length - 1];
    const table = widget?.querySelector('.mm-live-v4-table');
    const cell = widget?.querySelector('.mm-live-v4-table-cell[data-row-kind="body"][data-column="1"]');
    const columns = Array.from(widget?.querySelectorAll('.mm-live-v4-table-sized-col') ?? []);
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    if (!widget || !table || !cell || columns.length < 2 || !view) {
      resolve(JSON.stringify({
        ok: false,
        reason: 'missing live resize targets',
        hasWidget: Boolean(widget),
        hasTable: Boolean(table),
        hasCell: Boolean(cell),
        columnCount: columns.length,
        hasView: Boolean(view),
      }));
      return;
    }

    const beforeDoc = view.state.doc.toString();
	    const beforeWidth = columns[1].getBoundingClientRect().width;
	    const beforeTableWidth = table.getBoundingClientRect().width;
	    cell.focus();
	    cell.textContent = 'short cell with enough live typed text to expand the value column immediately';
	    cell.dispatchEvent(new root.defaultView.InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: ' immediately',
	    }));
	    root.defaultView.requestAnimationFrame(() => {
	      root.defaultView.requestAnimationFrame(() => {
	        const currentWidgets = Array.from(root.querySelectorAll('.mm-live-v4-table-widget'));
	        const currentWidget = currentWidgets[currentWidgets.length - 1];
	        const currentTable = currentWidget?.querySelector('.mm-live-v4-table');
	        const currentColumns = Array.from(currentWidget?.querySelectorAll('.mm-live-v4-table-sized-col') ?? []);
	        const currentCell = currentWidget?.querySelector('.mm-live-v4-table-cell[data-row-kind="body"][data-column="1"]');
	        const afterWidth = currentColumns[1]?.getBoundingClientRect().width ?? 0;
	        const afterTableWidth = currentTable?.getBoundingClientRect().width ?? 0;
	        const afterDoc = view.state.doc.toString();
	        root.defaultView.dispatchEvent(new root.defaultView.MessageEvent('message', {
	          data: {
	            type: 'setDocument',
	            text: beforeDoc,
	            revision: 999000,
	            debug: false,
	          },
	        }));
	        root.defaultView.requestAnimationFrame(() => {
	          root.defaultView.requestAnimationFrame(() => {
	            resolve(JSON.stringify({
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
	            }));
	          });
	        });
	      });
	    });
	  })`;
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
    const root = roots.find((candidate) => candidate.querySelector('.mm-live-v4-table-widget'));
    if (!root) {
      return JSON.stringify({ ok: false, reason: 'missing live root' });
    }
    const queryCell = () => {
      const widgets = Array.from(root.querySelectorAll('.mm-live-v4-table-widget'));
      const widget = widgets[widgets.length - 1];
      return widget?.querySelector('.mm-live-v4-table-cell[data-row-kind="body"][data-column="1"]');
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
    root.execCommand('insertText', false, 'base');
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
    root.execCommand('delete');
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
    root.execCommand('insertLineBreak');
    await waitForRender();
    cell = queryCell();
    if (cell) {
      setCaretAtCellEnd(cell);
    }
    root.execCommand('insertText', false, 'next');
    await waitForRender();
    cell = queryCell();
    const afterShiftEnterText = cell?.innerText ?? null;
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
      afterDeleteText,
      afterUndoText,
      undoSelectionCollapsed,
      afterShiftEnterText,
      hasLineBreak: /\\n/.test(afterShiftEnterText ?? ''),
      docChanged: afterDoc !== beforeDoc,
      restoredDoc: view.state.doc.toString() === beforeDoc,
    });
  })()`;
}

function tableTrustedUndoSetupExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try {
        return frame.contentDocument;
      } catch {
        return null;
      }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mm-live-v4-table-widget'));
    if (!root) {
      return JSON.stringify({ ok: false, reason: 'missing live root' });
    }
    const widgets = Array.from(root.querySelectorAll('.mm-live-v4-table-widget'));
    const widget = widgets[widgets.length - 1];
    const cell = widget?.querySelector('.mm-live-v4-table-cell[data-row-kind="body"][data-column="1"]');
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    if (!cell || !view) {
      return JSON.stringify({
        ok: false,
        reason: 'missing trusted undo targets',
        hasCell: Boolean(cell),
        hasView: Boolean(view),
      });
    }

    const selectCellContents = () => {
      const range = root.createRange();
      range.selectNodeContents(cell);
      const selection = root.defaultView.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const setCaretAtCellEnd = () => {
      const range = root.createRange();
      range.selectNodeContents(cell);
      range.collapse(false);
      const selection = root.defaultView.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const originalText = cell.textContent ?? '';
    cell.focus();
    selectCellContents();
    root.execCommand('insertText', false, 'base');
    setCaretAtCellEnd();
    root.defaultView.__MLRT_TRUSTED_UNDO_STATE__ = {
      originalText,
      beforeDoc: view.state.doc.toString(),
    };
    return JSON.stringify({
      ok: true,
      beforeText: cell.innerText,
      activeElementClass: root.activeElement?.className ?? null,
    });
  })()`;
}

function tableTrustedUndoResultExpression() {
  return `(() => {
    const roots = [document, ...Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try {
        return frame.contentDocument;
      } catch {
        return null;
      }
    }).filter(Boolean)];
    const root = roots.find((candidate) => candidate.querySelector('.mm-live-v4-table-widget'));
    const widgets = Array.from(root?.querySelectorAll('.mm-live-v4-table-widget') ?? []);
    const widget = widgets[widgets.length - 1];
    const cell = widget?.querySelector('.mm-live-v4-table-cell[data-row-kind="body"][data-column="1"]');
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
    cell.textContent = state.originalText;
    cell.dispatchEvent(new root.defaultView.InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertReplacementText',
      data: state.originalText,
    }));
    delete root.defaultView.__MLRT_TRUSTED_UNDO_STATE__;
    return JSON.stringify({
      ok: true,
      afterUndoText,
      selectionCollapsed,
      docChanged: afterDoc !== state.beforeDoc,
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
    const root = roots.find((candidate) => candidate.querySelector('.mm-live-v4-table-widget'));
    if (!root) {
      resolve(JSON.stringify({ ok: false, reason: 'missing live root' }));
      return;
    }
    const widgets = Array.from(root.querySelectorAll('.mm-live-v4-table-widget'));
    const widget = widgets[widgets.length - 1];
    const cell = widget?.querySelector('.mm-live-v4-table-cell[data-row-kind="body"][data-column="1"]');
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
    root.execCommand('delete');
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
          const currentWidgets = Array.from(root.querySelectorAll('.mm-live-v4-table-widget'));
          const currentWidget = currentWidgets[currentWidgets.length - 1];
          const restoredCell = currentWidget?.querySelector('.mm-live-v4-table-cell[data-row-kind="body"][data-column="1"]');
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
    const root = roots.find((candidate) => candidate.querySelector('.mm-live-v4-table-widget'));
    if (!root) {
      return JSON.stringify({ ok: false, reason: 'missing live root' });
    }
    const readCurrentShortCell = () => {
      const currentWidgets = Array.from(root.querySelectorAll('.mm-live-v4-table-widget'));
      const currentWidget = currentWidgets[currentWidgets.length - 1];
      return currentWidget?.querySelector('.mm-live-v4-table-cell[data-row-kind="body"][data-column="1"]');
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
      root.execCommand('insertText', false, character);
      await waitForRender();
      cell = readCurrentShortCell();
      docsAfterType.push(view.state.doc.toString());
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
    const afterFirstUndoCaret = caretOffsetForCell(undoCell);
    const afterFirstUndoActive = root.activeElement === undoCell;

    sendHostDocument(docsAfterType[0], 999202);
    await waitForRender();
    undoCell = readCurrentShortCell();
    const afterSecondUndoText = undoCell?.innerText ?? null;
    const afterSecondUndoCaret = caretOffsetForCell(undoCell);
    const afterSecondUndoActive = root.activeElement === undoCell;

    sendHostDocument(beforeDoc, 999203);
    await waitForRender();
    undoCell = readCurrentShortCell();
    const afterThirdUndoText = undoCell?.innerText ?? null;
    const afterThirdUndoCaret = caretOffsetForCell(undoCell);
    const afterThirdUndoActive = root.activeElement === undoCell;

    return JSON.stringify({
      ok: true,
      beforeText,
      afterTypeText,
      textsAfterType,
      finalDocChanged: finalDoc !== beforeDoc,
      sourceEditCount: postChangeCountAfter - postChangeCountBefore,
      afterFirstUndoText,
      afterFirstUndoCaret,
      afterFirstUndoActive,
      afterSecondUndoText,
      afterSecondUndoCaret,
      afterSecondUndoActive,
      afterThirdUndoText,
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
    const root = roots.find((candidate) => candidate.querySelector('.mm-live-v4-table-widget'));
    if (!root) {
      resolve(JSON.stringify({ ok: false, reason: 'missing live root' }));
      return;
    }
    const widgets = Array.from(root.querySelectorAll('.mm-live-v4-table-widget'));
    const widget = widgets[widgets.length - 1];
    const cell = widget?.querySelector('.mm-live-v4-table-cell[data-row-kind="body"][data-column="1"]');
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
    root.execCommand('delete');
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
            const currentWidgets = Array.from(root.querySelectorAll('.mm-live-v4-table-widget'));
            const currentWidget = currentWidgets[currentWidgets.length - 1];
            const restoredCell = currentWidget?.querySelector('.mm-live-v4-table-cell[data-row-kind="body"][data-column="1"]');
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
      return roots.find((candidate) => candidate.querySelector('.mm-live-v4-table'));
    }

    return new Promise((resolve) => {
      const root = findLiveRoot();
      if (!root) {
        resolve(JSON.stringify({ ok: false, reason: 'missing live root' }));
        return;
      }
      const cell = root.querySelector('.mm-live-v4-table-cell[data-row-kind="body"][data-column="1"]');
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
          editorHasTableFocusClass: editor.classList.contains('mm-live-v4-table-cell-focused'),
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
      return roots.find((candidate) => candidate.querySelector('.mm-live-v4-table'));
    }

    return new Promise((resolve) => {
      const root = findLiveRoot();
      if (!root) {
        resolve(JSON.stringify({ ok: false, reason: 'missing live root' }));
        return;
      }
      const view = root.defaultView.__MLRT_EDITOR_VIEW__;
      const widget = root.querySelector('.mm-live-v4-table-widget');
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
    const root = roots.find((candidate) => candidate.querySelector('.mm-live-v4-table-cell[data-row-kind="body"][data-column="1"]'));
    if (!root) {
      resolve(JSON.stringify({ ok: false, reason: 'missing table cell' }));
      return;
    }
    const cell = root.querySelector('.mm-live-v4-table-cell[data-row-kind="body"][data-column="1"]');
    const wrapper = root.querySelector('.mm-live-v4-table-widget');
    const view = root.defaultView.__MLRT_EDITOR_VIEW__;
    const expectedActiveLineGutterText =
      wrapper && view
        ? String(view.state.doc.lineAt(Number(wrapper.getAttribute('data-src-to'))).number)
        : null;
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
      const table = root.querySelector('.mm-live-v4-table');
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
    const root = roots.find((candidate) => candidate.querySelector('.mm-live-v4-table'));
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
      if (!(active instanceof root.defaultView.HTMLElement) || !active.classList.contains('mm-live-v4-table-cell')) {
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
    const wrapper = root.querySelector('.mm-live-v4-table-widget');
    const firstSourceLine = root.querySelector('.mm-live-v4-table-source-line');
    const tableHeaderLineNumber = Number(firstSourceLine?.getAttribute('data-source-line') ?? 0);
    const beforeTableLineNumber = Math.max(1, tableHeaderLineNumber - 1);
    const afterTableLineNumber = wrapper
      ? view.state.doc.lineAt(Number(wrapper.getAttribute('data-src-to'))).number
      : tableHeaderLineNumber + 3;
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
          const afterDownLine = view.state.doc.line(afterTableLineNumber);
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
            afterDownLineEnd: afterDownLine.to,
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

function assertTableLiveResize(result) {
	  if (
	    !result?.ok ||
	    !result.docChanged ||
	    !result.restoredDoc ||
	    result.widthDelta <= pixelTolerance ||
	    result.tableWidthDelta <= pixelTolerance
	  ) {
    throw new Error(
      `Table live resize check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableCellEditShortcuts(result) {
	  if (
	    !result?.ok ||
		    !result.selectedForDelete ||
	    result.undoDefaultAllowed ||
	    !result.shiftEnterDefaultAllowed ||
	    result.afterDeleteText !== "bas" ||
	    result.afterUndoText !== "base" ||
	    !result.undoSelectionCollapsed ||
	    !result.hasLineBreak ||
	    !result.afterShiftEnterText.includes("next") ||
	    !result.docChanged ||
	    !result.restoredDoc
	  ) {
    throw new Error(
      `Table cell edit shortcuts check failed: ${JSON.stringify(result)}`,
    );
  }
}

function assertTableTrustedUndoSetup(result) {
  if (!result?.ok || result.beforeText !== "base") {
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
    result.docChanged
  ) {
    throw new Error(`Table trusted undo check failed: ${JSON.stringify(result)}`);
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
    result.afterDownSelectionHead !== result.afterDownLineEnd ||
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
