#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const wantsScreenshot = args.includes("--screenshot");
const fixtureArg =
  args.find((arg) => !arg.startsWith("--")) ??
  "standard-markdown-in-table-fixture.md";

const fixturePath = path.resolve(repoRoot, fixtureArg);
const bundlePath = path.join(repoRoot, "media", "liveEditor.js");
const qaDir = path.join(repoRoot, "qa");
const htmlPath = path.join(qaDir, "live-editor-harness.html");
const screenshotPath = path.join(qaDir, "live-editor-harness.png");

if (!existsSync(fixturePath)) {
  console.error(`Fixture not found: ${fixturePath}`);
  process.exit(1);
}

if (!existsSync(bundlePath)) {
  console.error("Missing media/liveEditor.js. Run npm run compile first.");
  process.exit(1);
}

const fixtureText = await readFile(fixturePath, "utf8");
await mkdir(qaDir, { recursive: true });
await writeFile(
  htmlPath,
  renderHarnessHtml({
    fixtureName: path.relative(repoRoot, fixturePath),
    fixtureText,
    scriptUrl: pathToFileURL(bundlePath).href,
  }),
);

const htmlUrl = pathToFileURL(htmlPath).href;
console.log(`Live editor harness: ${htmlUrl}`);

if (wantsScreenshot) {
  const chrome = findChrome();
  if (!chrome) {
    console.error("Could not find Chrome or Chromium for --screenshot.");
    process.exit(1);
  }

  const result = spawnSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--allow-file-access-from-files",
      "--virtual-time-budget=3000",
      "--window-size=1800,1200",
      `--screenshot=${screenshotPath}`,
      htmlUrl,
    ],
    { stdio: "inherit" },
  );

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  console.log(`Live editor screenshot: ${screenshotPath}`);
}

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && !existsSync(candidate)) {
      continue;
    }

    const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (!result.error && result.status === 0) {
      return candidate;
    }
  }

  return undefined;
}

function renderHarnessHtml({ fixtureName, fixtureText, scriptUrl }) {
  const serializedText = JSON.stringify(fixtureText).replace(
    /<\/script/gi,
    "<\\/script",
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Markdown Live Editor Harness - ${escapeHtml(fixtureName)}</title>
  <style>
    :root {
      --vscode-editor-background: #1e1e1e;
      --vscode-editor-foreground: #d4d4d4;
      --vscode-editor-font-family: Menlo, Monaco, Consolas, "Courier New", monospace;
      --vscode-editor-font-size: 13px;
      --vscode-editorCursor-foreground: #aeafad;
      --vscode-editorGutter-background: #1e1e1e;
      --vscode-editorGutter-border: #2b2b2b;
      --vscode-editorLineNumber-foreground: #858585;
      --vscode-editorLineNumber-activeForeground: #c6c6c6;
      --vscode-editorWidget-background: #252526;
      --vscode-editorWidget-border: #3c3c3c;
      --vscode-focusBorder: #007fd4;
      --vscode-list-activeSelectionBackground: #094771;
      --vscode-list-activeSelectionForeground: #ffffff;
      --vscode-descriptionForeground: #cccccc;
      --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --vscode-errorForeground: #f48771;
    }

    html,
    body,
    #app {
      height: 100%;
      margin: 0;
      padding: 0;
      overflow: hidden;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
    }

    .mm-live-v4-shell {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      overflow: hidden;
    }

    .mm-live-v4-toolbar {
      display: flex;
      align-items: center;
      flex: 0 0 auto;
      min-height: 28px;
      padding: 0.2rem 0.5rem;
      border-bottom: 1px solid var(--vscode-editorWidget-border);
      background: var(--vscode-editorWidget-background);
    }

    .mm-live-v4-status {
      flex: 1 1 auto;
      min-width: 0;
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-font-family);
      font-size: 12px;
      line-height: 1.4;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      user-select: text;
    }

    .mm-live-v4-editor-mount {
      flex: 1 1 auto;
      min-height: 0;
      overflow: hidden;
    }

    .cm-editor {
      height: 100%;
      min-height: 0;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
    }

    .cm-scroller {
      overflow: auto !important;
      height: 100%;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 1.5;
    }

    .mm-live-v4-table-widget {
      display: block;
      max-width: 100%;
      margin: 0;
      padding: 0.35rem 0;
      overflow-x: auto;
      overflow-y: hidden;
      color: var(--vscode-editor-foreground);
    }

    .mm-live-v4-table {
      width: max-content;
      max-width: 100%;
      border-collapse: collapse;
      table-layout: auto;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
    }

    .mm-live-v4-table th,
    .mm-live-v4-table td {
      min-width: 7rem;
      max-width: 24rem;
      padding: 0.25rem 0.45rem;
      border: 1px solid var(--vscode-editorWidget-border);
      vertical-align: top;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    .mm-live-v4-table th {
      background: var(--vscode-editorWidget-background);
      font-weight: 600;
    }

    .mm-live-v4-table-cell[contenteditable="true"] {
      outline: none;
    }

    .mm-live-v4-table-cell[contenteditable="true"]:focus {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
      box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
    }

    .mm-live-v4-loading {
      padding: 1rem;
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-font-family);
    }
  </style>
</head>
<body>
  <div id="app"><div class="mm-live-v4-loading">Loading Markdown live editor...</div></div>
  <script>
    window.__MLRT_MESSAGES__ = [];
    window.acquireVsCodeApi = function acquireVsCodeApi() {
      return {
        postMessage(message) {
          window.__MLRT_MESSAGES__.push(message);
          console.log("[VS Code API shim]", message);
        }
      };
    };
    window.__MLRT_INITIAL_DOCUMENT__ = ${serializedText};
  </script>
  <script src="${scriptUrl}"></script>
</body>
</html>
`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
