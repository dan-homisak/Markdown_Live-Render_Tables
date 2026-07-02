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
  for (const wv of webviewTargets) {
    try {
      const c = connect(wv.webSocketDebuggerUrl);
      await c.ready;
      await c.send("Runtime.enable");
      const metrics = await evaluateJson(c, liveMetricsExpression());
      if (metrics) {
        liveMetrics = metrics;
        console.log("LIVE METRICS:", liveMetrics);
      }
      c.ws.close();
      if (liveMetrics) {
        break;
      }
    } catch {}
  }

  assertPixelParity(stockMetrics, liveMetrics);
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
        table: box(table),
        sourceLine: box(sourceLine),
        sourceLineText: textBox(root, sourceLine),
        tableCell: box(tableCell),
        tableCellText: textBox(root, tableCell),
        lineFontFamily: lineStyle?.fontFamily ?? null,
        lineFontSize: lineStyle?.fontSize ?? null,
        lineLineHeight: lineStyle?.lineHeight ?? null,
        cssLiveGutterWidth: getComputedStyle(scroller).getPropertyValue('--mlrt-live-gutter-width').trim(),
      });
    }
    return null;
  })()`;
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
      parseFloat(live.lineLineHeight),
    ),
  ];
  const failures = checks.filter((check) => !check.pass);

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
