#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const args = process.argv.slice(2);
const wantsScreenshot = args.includes("--screenshot");
const wantsDebug = args.includes("--debug");
const lineWrapping = !args.includes("--no-wrap");
const windowSizeArg = args.find((arg) => arg.startsWith("--window-size="));
const windowSize = windowSizeArg?.slice("--window-size=".length) ?? "1800,1200";
const fixtureArg =
  args.find((arg) => !arg.startsWith("--")) ??
  "standard-markdown-in-table-fixture.md";

const fixturePath = path.resolve(repoRoot, fixtureArg);
const bundlePath = path.join(repoRoot, "media", "liveEditor.js");
const stylePath = path.join(repoRoot, "media", "liveEditor.css");
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
const sharedCss = await readFile(stylePath, "utf8");
await mkdir(qaDir, { recursive: true });
await writeFile(
  htmlPath,
  renderHarnessHtml({
    fixtureName: path.relative(repoRoot, fixturePath),
    fixtureText,
    sharedCss,
    debug: wantsDebug,
    lineWrapping,
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
      `--window-size=${windowSize}`,
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

function renderHarnessHtml({
  fixtureName,
  fixtureText,
  sharedCss,
  debug,
  lineWrapping,
  scriptUrl,
}) {
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
      --mlrt-editor-font-family: var(--vscode-editor-font-family);
      --mlrt-editor-font-size: var(--vscode-editor-font-size);
      --mlrt-editor-font-weight: normal;
      --mlrt-editor-line-height: calc(var(--mlrt-editor-font-size) * 1.5);
      --mlrt-editor-letter-spacing: 0px;
      --mlrt-editor-cursor-width: 1px;
      --mlrt-editor-top-padding: 4px;
      --mlrt-editor-gutter-left-padding: 18px;
      --mlrt-editor-line-number-width: 22px;
      --mlrt-editor-gutter-right-padding: 26px;
      --mlrt-editor-right-padding: var(--mlrt-editor-gutter-right-padding);
      --mlrt-editor-gutter-width: calc(var(--mlrt-editor-gutter-left-padding) + var(--mlrt-editor-line-number-width) + var(--mlrt-editor-gutter-right-padding));
      --mlrt-live-content-width: calc(100vw - var(--mlrt-editor-right-padding));
      --mlrt-live-gutter-width: var(--mlrt-editor-gutter-width);
      --vscode-editorCursor-foreground: #aeafad;
      --vscode-editor-lineHighlightBackground: #2a2d2e;
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

${sharedCss}
  </style>
</head>
<body>
  <div id="app"></div>
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
    window.__MLRT_DEBUG__ = ${debug ? "true" : "false"};
    window.__MLRT_INITIAL_DOCUMENT__ = ${serializedText};
    window.__MLRT_EDITOR_OPTIONS__ = ${JSON.stringify({ lineWrapping })};
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
