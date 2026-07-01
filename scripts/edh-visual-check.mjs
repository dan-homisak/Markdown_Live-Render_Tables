#!/usr/bin/env node
// Launch an isolated VS Code Extension Development Host, open TestTable.md,
// toggle the Markdown Live Editor, then screenshot + measure the rendered table
// inside the webview via the Electron DevTools (CDP) endpoint.
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
const port = 9444;
const userDataDir = mkdtempSync(path.join(os.tmpdir(), "mlrt-edh-"));
const qaDir = path.join(repoRoot, "qa");
await mkdir(qaDir, { recursive: true });

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
  { stdio: "ignore", env: { ...process.env, ELECTRON_NO_ATTACH_CONSOLE: "1" } },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const targets = await listTargets().catch(() => []);
    workbench = targets.find(
      (t) => t.type === "page" && /workbench\.html/.test(t.url),
    );
    if (workbench) break;
  }
  if (!workbench) throw new Error("Workbench target not found.");

  const wb = connect(workbench.webSocketDebuggerUrl);
  await wb.ready;
  await wb.send("Runtime.enable");
  await wb.send("Page.enable");

  // Give the editor time to open the file, then trigger the toggle command.
  await sleep(4000);
  const runCmd = async (commandId) => {
    const expr = `(async () => {
      // Access VS Code command service through the global require if present.
      try {
        const evt = new KeyboardEvent('keydown');
        // Fallback: use the exposed monaco/vscode command via keybinding is unreliable.
      } catch {}
      return document.title;
    })()`;
    return wb.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
  };

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

  // Screenshot the whole workbench.
  const shot = await wb.send("Page.captureScreenshot", { format: "png" });
  if (shot.result?.data) {
    await writeFile(
      path.join(qaDir, "edh-live.png"),
      Buffer.from(shot.result.data, "base64"),
    );
    console.log("Saved qa/edh-live.png");
  }

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

  for (const wv of webviewTargets) {
    try {
      const c = connect(wv.webSocketDebuggerUrl);
      await c.ready;
      await c.send("Runtime.enable");
      const r = await c.send("Runtime.evaluate", {
        expression: `(() => {
          const t = document.querySelector('.mm-live-v4-table');
          const s = document.querySelector('.cm-scroller');
          if (!t || !s) return null;
          return JSON.stringify({
            url: location.href.slice(0,60),
            scrollerClientWidth: s.clientWidth,
            scrollerScrollWidth: s.scrollWidth,
            tableWidth: Math.round(t.getBoundingClientRect().width),
            tableLeft: Math.round(t.getBoundingClientRect().left),
            overflow: s.scrollWidth > s.clientWidth + 1,
          });
        })()`,
        returnByValue: true,
      });
      if (r.result?.result?.value) {
        console.log("TABLE METRICS:", r.result.result.value);
      }
      c.ws.close();
    } catch {}
  }

  wb.ws.close();
} finally {
  await sleep(500);
  child.kill("SIGTERM");
}
