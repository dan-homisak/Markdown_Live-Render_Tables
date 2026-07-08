import * as fs from "fs";
import * as vscode from "vscode";
import {
  mapNormalizedDocumentChangesToHost,
  normalizeDocumentText,
} from "./shared/documentChangeMapping";

const LIVE_EDITOR_VIEW_TYPE = "markdownLiveRenderTables.liveEditor";
const DEBUG_SETTING = "debug";
const REOPEN_ACTIVE_EDITOR_WITH_COMMAND = "reopenActiveEditorWith";
const DEFAULT_EDITOR_ID = "default";

let debugOutputChannel: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const provider = new MarkdownLiveEditorProvider(context);
  debugOutputChannel = vscode.window.createOutputChannel(
    "Markdown Live Editor",
  );

  context.subscriptions.push(
    debugOutputChannel,
    vscode.window.registerCustomEditorProvider(
      LIVE_EDITOR_VIEW_TYPE,
      provider,
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      },
    ),
    vscode.commands.registerCommand(
      "markdownLiveRenderTables.toggleEditor",
      async (uri?: vscode.Uri) => {
        await toggleEditor(uri, provider);
      },
    ),
    vscode.commands.registerCommand(
      "markdownLiveRenderTables.showDebugLog",
      () => {
        debugOutputChannel?.show(true);
      },
    ),
  );
}

export function deactivate(): void {}

class MarkdownLiveEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly panelsByDocument = new Map<string, vscode.WebviewPanel>();
  private readonly mediaTextByFileName = new Map<string, string>();
  private activeLiveDocumentUri: vscode.Uri | undefined;

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public getActiveDocumentUri(): vscode.Uri | undefined {
    return this.activeLiveDocumentUri;
  }

  public getViewColumn(uri: vscode.Uri): vscode.ViewColumn | undefined {
    return this.panelsByDocument.get(uri.toString())?.viewColumn;
  }

  public resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
  ): void {
    const webview = webviewPanel.webview;
    const scriptText = this.readMediaText("liveEditor.js");
    const styleText = this.readMediaText("liveEditor.css");
    const documentKey = document.uri.toString();

    this.panelsByDocument.set(documentKey, webviewPanel);
    if (webviewPanel.active) {
      this.activeLiveDocumentUri = document.uri;
    }

    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };
    webviewPanel.title = document.fileName.split(/[\\/]/).pop() ?? "Markdown";

    let applyingFromWebview = false;
    let applyQueue: Promise<void> = Promise.resolve();
    let documentRevision = 0;

    const postDocument = (
      source: HostSetDocumentMessage["source"] = "host",
      ackId?: number,
    ): void => {
      documentRevision++;
      void webview.postMessage({
        type: "setDocument",
        text: document.getText(),
        revision: documentRevision,
        debug: isDebugEnabled(),
        source,
        ackId,
      } satisfies HostSetDocumentMessage);
    };

    const applyFromWebview = (message: ChangeMessage): void => {
      applyQueue = applyQueue
        .then(async () => {
          applyingFromWebview = true;
          try {
            if (message.changeGroups?.length) {
              logDebug(
                `apply ${message.changeGroups.length} sequential change group(s) from webview at revision ${message.baseRevision}`,
              );
              for (const changeGroup of message.changeGroups) {
                await applyDocumentChanges(document, changeGroup);
              }
            } else if (message.changes?.length) {
              logDebug(
                `apply ${message.changes.length} change(s) from webview at revision ${message.baseRevision}`,
              );
              await applyDocumentChanges(document, message.changes);
            } else {
              vscode.window.showWarningMessage(
                "Markdown live editor ignored a change without source ranges.",
              );
              logDebug("ignored change message without source ranges");
            }
          } finally {
            applyingFromWebview = false;
          }

          if (normalizeDocumentText(document.getText()) !== message.text) {
            vscode.window.showWarningMessage(
              "Markdown live editor changes were applied, but the editor document is out of sync.",
            );
          }
          postDocument("webviewAck", message.changeId);
        })
        .catch((error: unknown) => {
          applyingFromWebview = false;
          vscode.window.showErrorMessage(
            `Markdown live editor could not apply changes: ${String(error)}`,
          );
          // Resync the webview with the authoritative document state so an
          // apply failure cannot leave the two sides silently diverged.
          postDocument();
        });
    };

    const disposables: vscode.Disposable[] = [];
    disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (
          event.document.uri.toString() === documentKey &&
          !applyingFromWebview
        ) {
          postDocument();
        }
      }),
      webviewPanel.onDidChangeViewState((event) => {
        if (event.webviewPanel.active) {
          this.activeLiveDocumentUri = document.uri;
        }
      }),
      webview.onDidReceiveMessage((message: unknown) => {
        if (isReadyMessage(message)) {
          postDocument();
          return;
        }

        if (isDebugMessage(message)) {
          logDebug(`${message.event}: ${JSON.stringify(message.details)}`);
          return;
        }

        if (isEditorCommandMessage(message)) {
          logDebug(`editor command requested: ${message.command}`);
          applyQueue = applyQueue
            .then(async () => {
              await vscode.commands.executeCommand(message.command);
            })
            .catch((error: unknown) => {
              vscode.window.showErrorMessage(
                `Markdown live editor could not run ${message.command}: ${String(error)}`,
              );
            });
          return;
        }

        if (
          isChangeMessage(message) &&
          message.baseRevision <= documentRevision
        ) {
          if (message.text === document.getText()) {
            // Nothing to apply, but the webview still expects its optimistic
            // change to be acknowledged so it can settle its echo queue.
            postDocument("webviewAck", message.changeId);
            return;
          }
          applyFromWebview(message);
        }
      }),
    );

    webview.html = getEditorHtml(
      webview,
      scriptText,
      styleText,
      document.getText(),
      document.uri,
    );

    webviewPanel.onDidDispose(() => {
      this.panelsByDocument.delete(documentKey);
      if (this.activeLiveDocumentUri?.toString() === documentKey) {
        this.activeLiveDocumentUri = undefined;
      }
      vscode.Disposable.from(...disposables).dispose();
    });
  }

  private readMediaText(fileName: string): string {
    const cached = this.mediaTextByFileName.get(fileName);
    if (cached !== undefined) {
      return cached;
    }

    const fileUri = vscode.Uri.joinPath(
      this.context.extensionUri,
      "media",
      fileName,
    );
    const text = fs.readFileSync(fileUri.fsPath, "utf8");
    this.mediaTextByFileName.set(fileName, text);
    return text;
  }
}

async function toggleEditor(
  uri: vscode.Uri | undefined,
  provider: MarkdownLiveEditorProvider,
): Promise<void> {
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const activeInput = activeTab?.input;

  if (
    activeInput instanceof vscode.TabInputCustom &&
    isLiveEditorViewType(activeInput.viewType)
  ) {
    await openSourceEditor(uri ?? activeInput.uri, provider, activeTab);
    return;
  }

  if (activeInput instanceof vscode.TabInputText) {
    await openLiveEditor(uri ?? activeInput.uri, provider, activeTab);
    return;
  }

  const activeTextUri = vscode.window.activeTextEditor?.document.uri;
  const activeLiveUri = provider.getActiveDocumentUri();
  if (activeTextUri) {
    await openLiveEditor(
      uri ?? activeTextUri,
      provider,
      vscode.window.tabGroups.activeTabGroup.activeTab,
    );
    return;
  }
  await openSourceEditor(
    uri ?? activeLiveUri,
    provider,
    vscode.window.tabGroups.activeTabGroup.activeTab,
  );
}

function isLiveEditorViewType(viewType: string): boolean {
  return viewType === LIVE_EDITOR_VIEW_TYPE;
}

async function openLiveEditor(
  uri: vscode.Uri | undefined,
  provider: MarkdownLiveEditorProvider,
  tabToClose?: vscode.Tab,
): Promise<void> {
  const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!targetUri) {
    vscode.window.showWarningMessage(
      "Open a markdown file before opening the live editor.",
    );
    return;
  }

  const viewColumn =
    vscode.window.activeTextEditor?.viewColumn ??
    provider.getViewColumn(targetUri) ??
    vscode.ViewColumn.Active;

  if (tabToClose && tabMatchesUri(tabToClose, targetUri)) {
    await reopenActiveEditorWith(LIVE_EDITOR_VIEW_TYPE);
    return;
  }

  await vscode.commands.executeCommand(
    "vscode.openWith",
    targetUri,
    LIVE_EDITOR_VIEW_TYPE,
    {
      viewColumn,
      preserveFocus: false,
    },
  );
}

async function openSourceEditor(
  uri: vscode.Uri | undefined,
  provider: MarkdownLiveEditorProvider,
  tabToClose?: vscode.Tab,
): Promise<void> {
  const targetUri =
    uri ??
    provider.getActiveDocumentUri() ??
    vscode.window.activeTextEditor?.document.uri;
  if (!targetUri) {
    vscode.window.showWarningMessage(
      "Open a live markdown editor before returning to source.",
    );
    return;
  }

  if (tabToClose && tabMatchesUri(tabToClose, targetUri)) {
    await reopenActiveEditorWith(DEFAULT_EDITOR_ID);
    return;
  }

  await vscode.window.showTextDocument(targetUri, {
    viewColumn: provider.getViewColumn(targetUri) ?? vscode.ViewColumn.Active,
    preview: false,
    preserveFocus: false,
  });
}

function tabMatchesUri(tab: vscode.Tab, uri: vscode.Uri): boolean {
  const input = tab.input;
  return (
    (input instanceof vscode.TabInputText &&
      input.uri.toString() === uri.toString()) ||
    (input instanceof vscode.TabInputCustom &&
      input.uri.toString() === uri.toString())
  );
}

async function applyDocumentChanges(
  document: vscode.TextDocument,
  changes: readonly DocumentChange[],
): Promise<void> {
  if (changes.length === 0) {
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  for (const change of mapNormalizedDocumentChangesToHost(
    document.getText(),
    changes,
  )) {
    edit.replace(
      document.uri,
      new vscode.Range(
        new vscode.Position(change.from.line, change.from.character),
        new vscode.Position(change.to.line, change.to.character),
      ),
      change.text,
    );
  }

  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    vscode.window.showWarningMessage(
      "Markdown live editor could not apply changes.",
    );
  }
}

interface ReadyMessage {
  type: "ready";
}

interface DocumentChange {
  from: number;
  to: number;
  text: string;
}

interface ChangeMessage {
  type: "change";
  changeId?: number;
  text: string;
  changes?: DocumentChange[];
  changeGroups?: DocumentChange[][];
  baseRevision: number;
}

interface DebugMessage {
  type: "debug";
  event: string;
  details: unknown;
}

interface EditorCommandMessage {
  type: "editorCommand";
  command: "undo" | "redo";
}

interface HostSetDocumentMessage {
  type: "setDocument";
  text: string;
  revision: number;
  debug: boolean;
  source?: "host" | "webviewAck";
  ackId?: number;
}

function isReadyMessage(message: unknown): message is ReadyMessage {
  return isMessageRecord(message) && message.type === "ready";
}

function isChangeMessage(message: unknown): message is ChangeMessage {
  return (
    isMessageRecord(message) &&
    message.type === "change" &&
    (message.changeId === undefined ||
      (typeof message.changeId === "number" &&
        Number.isInteger(message.changeId) &&
        message.changeId > 0)) &&
    typeof message.text === "string" &&
    (message.changes === undefined ||
      (Array.isArray(message.changes) &&
        message.changes.every(isDocumentChange))) &&
    (message.changeGroups === undefined ||
      (Array.isArray(message.changeGroups) &&
        message.changeGroups.every(
          (changeGroup) =>
            Array.isArray(changeGroup) && changeGroup.every(isDocumentChange),
        ))) &&
    typeof message.baseRevision === "number"
  );
}

function isDocumentChange(change: unknown): change is DocumentChange {
  if (!isMessageRecord(change)) {
    return false;
  }

  const from = change.from;
  const to = change.to;
  return (
    typeof from === "number" &&
    Number.isInteger(from) &&
    from >= 0 &&
    typeof to === "number" &&
    Number.isInteger(to) &&
    to >= from &&
    typeof change.text === "string"
  );
}

function isDebugMessage(message: unknown): message is DebugMessage {
  return (
    isMessageRecord(message) &&
    message.type === "debug" &&
    typeof message.event === "string" &&
    "details" in message
  );
}

function isEditorCommandMessage(
  message: unknown,
): message is EditorCommandMessage {
  return (
    isMessageRecord(message) &&
    message.type === "editorCommand" &&
    (message.command === "undo" || message.command === "redo")
  );
}

function isMessageRecord(message: unknown): message is Record<string, unknown> {
  return Boolean(message) && typeof message === "object";
}

function isDebugEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("markdownLiveRenderTables")
    .get<boolean>(DEBUG_SETTING, false);
}

function logDebug(message: string): void {
  if (!isDebugEnabled()) {
    return;
  }

  debugOutputChannel?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

async function reopenActiveEditorWith(editorId: string): Promise<void> {
  await vscode.commands.executeCommand(
    REOPEN_ACTIVE_EDITOR_WITH_COMMAND,
    editorId,
  );
}

function getEditorHtml(
  webview: vscode.Webview,
  scriptText: string,
  styleText: string,
  initialText: string,
  documentUri: vscode.Uri,
): string {
  const nonce = getNonce();
  const initialDocumentScript = JSON.stringify(initialText).replace(
    /<\/script/gi,
    "<\\/script",
  );
  const editorMetricsCss = getEditorMetricsCss(documentUri);
  const editorOptionsScript = JSON.stringify(getEditorOptions(documentUri));
  const inlineScript = scriptText.replace(/<\/script/gi, "<\\/script");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};"
  >
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
${editorMetricsCss}
    }
${styleText}
  </style>
  <title>Markdown Live Editor</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}">
    window.__MLRT_INITIAL_DOCUMENT__ = ${initialDocumentScript};
    window.__MLRT_EDITOR_OPTIONS__ = ${editorOptionsScript};
  </script>
  <script nonce="${nonce}">
${inlineScript}
  </script>
</body>
</html>`;
}

function getEditorMetricsCss(documentUri: vscode.Uri): string {
  const editorConfig = vscode.workspace.getConfiguration("editor", documentUri);
  const fontSize = clampNumber(
    editorConfig.get<number>("fontSize", 14),
    6,
    100,
  );
  const configuredLineHeight = clampNumber(
    editorConfig.get<number>("lineHeight", 0),
    0,
    300,
  );
  const cursorWidth = clampNumber(
    editorConfig.get<number>("cursorWidth", 1),
    1,
    10,
  );
  const letterSpacing = clampNumber(
    editorConfig.get<number>("letterSpacing", 0),
    -10,
    20,
  );
  const padding = editorConfig.get<{ top?: number; bottom?: number }>(
    "padding",
    {},
  );
  const paddingTop = clampNumber(padding.top ?? 0, 0, 200);
  const paddingBottom = clampNumber(padding.bottom ?? 0, 0, 200);
  const fontFamily = sanitizeCssValue(
    editorConfig.get<string>("fontFamily", "monospace"),
    "monospace",
  );
  const fontWeight = sanitizeCssValue(
    editorConfig.get<string>("fontWeight", "normal"),
    "normal",
  );
  const fontFeatureSettings = getFontFeatureSettings(editorConfig);
  const fontVariationSettings = getFontVariationSettings(editorConfig);
  const lineHeightRatio =
    configuredLineHeight > 0 ? configuredLineHeight / fontSize : 1.5;

  return [
    `      --mlrt-editor-font-family: var(--vscode-editor-font-family, ${fontFamily});`,
    `      --mlrt-editor-font-size: var(--vscode-editor-font-size, ${fontSize}px);`,
    `      --mlrt-editor-font-weight: var(--vscode-editor-font-weight, ${fontWeight});`,
    `      --mlrt-editor-line-height: calc(var(--mlrt-editor-font-size) * ${lineHeightRatio.toFixed(4)});`,
    `      --mlrt-editor-letter-spacing: ${letterSpacing}px;`,
    `      --mlrt-editor-font-feature-settings: ${fontFeatureSettings};`,
    `      --mlrt-editor-font-variation-settings: ${fontVariationSettings};`,
    `      --mlrt-editor-cursor-width: ${cursorWidth}px;`,
    `      --mlrt-editor-top-padding: ${paddingTop}px;`,
    `      --mlrt-editor-bottom-padding: ${paddingBottom}px;`,
    `      --mlrt-editor-gutter-left-padding: 18px;`,
    `      --mlrt-editor-line-number-width: 22px;`,
    `      --mlrt-editor-gutter-right-padding: 26px;`,
    `      --mlrt-editor-right-padding: var(--mlrt-editor-gutter-right-padding);`,
    `      --mlrt-editor-gutter-width: calc(var(--mlrt-editor-gutter-left-padding) + var(--mlrt-editor-line-number-width) + var(--mlrt-editor-gutter-right-padding));`,
    `      --mlrt-live-content-width: calc(100vw - var(--mlrt-editor-right-padding));`,
    `      --mlrt-live-gutter-width: var(--mlrt-editor-gutter-width);`,
  ].join("\n");
}

/**
 * Line wrapping in the live editor follows the effective `editor.wordWrap`
 * for markdown files (VS Code defaults markdown to "on"), so the webview
 * matches what the stock editor would do for the same document.
 */
function getEditorOptions(documentUri: vscode.Uri): { lineWrapping: boolean } {
  const editorConfig = vscode.workspace.getConfiguration("editor", {
    uri: documentUri,
    languageId: "markdown",
  });
  const wordWrap = editorConfig.get<string>("wordWrap", "on");
  return {
    lineWrapping: wordWrap !== "off",
  };
}

function getFontFeatureSettings(
  editorConfig: vscode.WorkspaceConfiguration,
): string {
  const fontLigatures = editorConfig.get<boolean | string>(
    "fontLigatures",
    false,
  );
  if (typeof fontLigatures === "string") {
    return sanitizeCssValue(fontLigatures, "normal");
  }

  return fontLigatures ? '"liga" on, "calt" on' : "normal";
}

function getFontVariationSettings(
  editorConfig: vscode.WorkspaceConfiguration,
): string {
  const fontVariations = editorConfig.get<boolean | string>(
    "fontVariations",
    false,
  );
  if (typeof fontVariations === "string") {
    return sanitizeCssValue(fontVariations, "normal");
  }

  return fontVariations ? "normal" : "normal";
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }

  return Math.min(maximum, Math.max(minimum, value));
}

function sanitizeCssValue(value: string, fallback: string): string {
  const cleaned = value.replace(/[;{}<>]/g, "").trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let index = 0; index < 32; index++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
